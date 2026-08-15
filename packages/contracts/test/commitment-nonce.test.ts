/**
 * A17 commitment nonce — the encoding is a wire contract (execution_plan §10).
 *
 * Owner B computes it, the signer passes it through opaquely, and a judge
 * recomputes it from the receipt to verify the settlement against the chain.
 * If this encoding drifts, every previously issued receipt stops verifying, so
 * these tests pin it rather than merely exercising it.
 */

import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { buildCommitmentNonce } from "../src/mandate";
import type { Hex } from "../src/types";

const POLICY_HASH = `0x${"11".repeat(32)}` as Hex;
const INTENT_HASH = `0x${"22".repeat(32)}` as Hex;

const BASE = {
  requestId: "3f6c8b2e-0000-4000-8000-000000000001",
  policyHash: POLICY_HASH,
  intentHash: INTENT_HASH,
  merchantDomain: "card.straitsx.ai",
};

describe("buildCommitmentNonce", () => {
  it("returns a 32-byte hex value", () => {
    const nonce = buildCommitmentNonce(BASE);
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic — the same inputs always give the same nonce", () => {
    // This is load-bearing: an idempotent retry with the same requestId must
    // recompute the same nonce, or it becomes a second live authorization.
    expect(buildCommitmentNonce(BASE)).toBe(buildCommitmentNonce(BASE));
  });

  it("changes when any single input changes", () => {
    const base = buildCommitmentNonce(BASE);
    expect(buildCommitmentNonce({ ...BASE, requestId: "other" })).not.toBe(base);
    expect(
      buildCommitmentNonce({ ...BASE, policyHash: `0x${"33".repeat(32)}` }),
    ).not.toBe(base);
    expect(
      buildCommitmentNonce({ ...BASE, intentHash: `0x${"44".repeat(32)}` }),
    ).not.toBe(base);
    expect(
      buildCommitmentNonce({ ...BASE, merchantDomain: "evil.example" }),
    ).not.toBe(base);
  });

  it("is not ambiguous across the variable-length string boundary", () => {
    // Raw concatenation would make these two collide: "ab"+"c" == "a"+"bc".
    // Hashing each string to 32 bytes first is what prevents an attacker
    // CHOOSING a collision between two different intents.
    const a = buildCommitmentNonce({
      ...BASE,
      requestId: "ab",
      merchantDomain: "c",
    });
    const b = buildCommitmentNonce({
      ...BASE,
      requestId: "a",
      merchantDomain: "bc",
    });
    expect(a).not.toBe(b);
  });

  it("matches an independently computed reference implementation", () => {
    // Recomputed the way a verifier would, from the documented encoding.
    const rid = keccak256(toBytes(BASE.requestId)).slice(2);
    const mer = keccak256(toBytes(BASE.merchantDomain)).slice(2);
    const expected = keccak256(
      `0x${rid}${POLICY_HASH.slice(2)}${INTENT_HASH.slice(2)}${mer}`,
    );
    expect(buildCommitmentNonce(BASE)).toBe(expected);
  });

  it("rejects a policyHash that is not 32 bytes", () => {
    // A short hash would silently shift every following word left.
    expect(() =>
      buildCommitmentNonce({ ...BASE, policyHash: "0xdeadbeef" }),
    ).toThrow(/32-byte/);
  });
});
