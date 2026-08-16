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

/**
 * Canonical commitment to the exact human instruction stored by ledger-service.
 * The bytes are UTF-8 exactly as received: no trimming, case folding, or Unicode
 * normalization. Changing any byte means a different intent.
 */
export function hashIntentInstruction(instruction: string): Hex {
  return keccak256(toBytes(instruction));
}

/**
 * The EIP-3009 authorization nonce (A17, decided 2026-08-15 — execution_plan §10).
 *
 * The nonce is a COMMITMENT to the human's intent, not a random value. It makes
 * the on-chain settlement itself carry the authorisation context: anyone with
 * the receipt can recompute this and check it against the `nonce` in the settled
 * `transferWithAuthorization`, so the receipt is verifiable from chain data
 * rather than trusted from our database.
 *
 * ENCODING — this is a wire contract; changing it invalidates every prior
 * receipt, so it is defined precisely:
 *
 *   keccak256( keccak256(utf8 requestId)
 *            ‖ policyHash
 *            ‖ intentHash
 *            ‖ keccak256(utf8 merchantDomain) )
 *
 * The two variable-length strings are hashed to 32 bytes FIRST, then all four
 * fixed-width words are concatenated. Concatenating the raw strings instead
 * would be ambiguous — ("ab","c") and ("a","bc") would produce identical bytes
 * and therefore identical nonces for different intents, which is a collision an
 * attacker chooses rather than finds.
 *
 * policy-service computes this and passes it into POST /sign; the signer treats
 * `nonce` as opaque bytes32 (owner-b-tasks.md B10).
 */
export function buildCommitmentNonce(input: {
  requestId: string;
  policyHash: Hex;
  intentHash: Hex;
  merchantDomain: string;
}): Hex {
  const strip = (h: Hex): string => {
    const bare = h.toLowerCase().replace(/^0x/, "");
    if (bare.length !== 64) {
      throw new Error(
        `expected a 32-byte hex value, got ${h.length} chars: ${h}`,
      );
    }
    return bare;
  };

  const requestIdHash = strip(keccak256(toBytes(input.requestId)));
  const merchantHash = strip(keccak256(toBytes(input.merchantDomain)));

  return keccak256(
    `0x${requestIdHash}${strip(input.policyHash)}${strip(input.intentHash)}${merchantHash}`,
  );
}
