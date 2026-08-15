import { keccak256, toBytes } from "viem";

export type Address = string; // "0x" + 40 hex, EIP-55 checksummed in JSON, compare lowercased
export type Hex = string; // "0x" + even-length lowercase hex
export type Uint = string; // base-unit decimal string, e.g. "5000000" = 5 XSGD

export type Mandate = {
  mandateId: Hex;
  owner: Address;
  agentId: string;
  chainId: 43113 | 43114;
  asset: Address;
  settlementRecipient: Address;
  maxPerCard: Uint;
  maxPerWindow: Uint;
  maxCardsPerWindow: number;
  windowSeconds: number;
  maxAuthValiditySeconds: number;
  expiresAt: number; // unix seconds
  revoked: boolean;
  // api-contracts.md §1 omits this field; execution_plan.md §7's full schema requires it
  // and owner-b-tasks.md B2/B13 requires it be hashed. Included per the latter — a tampered
  // intentConstraint must fail check 2.
  intentConstraint: string;
  merchantAllowlist: string[]; // advisory
  policyVersion: number;
};

const FIELD_ORDER = [
  "mandateId",
  "owner",
  "agentId",
  "chainId",
  "asset",
  "settlementRecipient",
  "maxPerCard",
  "maxPerWindow",
  "maxCardsPerWindow",
  "windowSeconds",
  "maxAuthValiditySeconds",
  "expiresAt",
  "revoked",
  "intentConstraint",
  "merchantAllowlist",
  "policyVersion",
] as const satisfies readonly (keyof Mandate)[];

const ADDRESS_FIELDS: ReadonlySet<keyof Mandate> = new Set([
  "mandateId",
  "owner",
  "asset",
  "settlementRecipient",
]);

function encodeField<K extends keyof Mandate>(key: K, value: Mandate[K]): string {
  if (key === "merchantAllowlist") {
    return (value as string[]).map((domain) => domain.trim().toLowerCase()).join(",");
  }
  if (ADDRESS_FIELDS.has(key)) {
    return (value as string).toLowerCase();
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

/**
 * Canonical, deterministic serialisation of a Mandate: fixed key order, addresses and
 * merchant domains lowercased, booleans/numbers as plain strings, pipe-delimited (no JSON —
 * JSON key order and number formatting are not guaranteed stable across engines).
 *
 * This is the ONE place key order, number encoding and string casing are decided. Nobody
 * reimplements this — the dashboard and policy-service both import it directly.
 */
export function serialise(mandate: Mandate): string {
  return FIELD_ORDER.map((key) => `${key}=${encodeField(key, mandate[key])}`).join("|");
}

/** keccak256 over the canonical serialisation. Must equal registry.policyHash (check 2). */
export function hashPolicy(mandate: Mandate): Hex {
  return keccak256(toBytes(serialise(mandate)));
}
