/**
 * Canonical mandate serialisation and policy hashing (owner-b-tasks.md B2).
 *
 * The `Mandate`, `Address`, `Hex` and `Uint` types live in ./types — this module
 * owns only the encoding. Nobody reimplements `serialise`; the dashboard and
 * policy-service both import it from here, or check 2 fails permanently and
 * looks like a contract bug for hours (api-contracts.md §10.1).
 */

import { keccak256, toBytes } from "viem";
import type { Hex, Mandate } from "./types";

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
