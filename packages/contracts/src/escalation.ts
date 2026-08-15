/**
 * The canonical EIP-191 escalation decision — the human's approval, signed.
 *
 * Check 9 escalates instead of refusing, and a human approves or denies. That
 * approval must be cryptographically bound to the mandate owner, or "the human
 * approved it" is just a field in a request body that anyone who can reach
 * policy-service may set.
 *
 * ONE DEFINITION, BOTH SIDES. The dashboard builds this string and asks the
 * wallet to `personal_sign` it; policy-service rebuilds the identical string and
 * recovers the signer. If the two ever drift, every approval fails to verify —
 * so neither side may hand-roll the format. Import `buildEscalationMessage`.
 *
 * WHAT THE MESSAGE BINDS, and why each field is in it:
 *
 *   requestId  — without it, an approval for one purchase replays on another
 *   mandateId  — without it, an approval crosses mandates
 *   decision   — without it, an "approve" signature is indistinguishable from
 *                a "deny" signature, so a captured approval could be replayed
 *                as a denial or vice versa
 *
 * The message is deliberately human-readable: the wallet shows these bytes to
 * the person signing, and "approve spending against mandate X for request Y" is
 * something they can actually check. An opaque hash would be worse UX and no
 * more secure.
 */

import { verifyMessage } from "viem";
import type { Address, Hex } from "./types";

export type EscalationDecision = "approve" | "deny";

export type EscalationMessageInput = {
  requestId: string;
  mandateId: Hex;
  decision: EscalationDecision;
};

/**
 * Build the exact string the human signs. Newline-separated, no trailing
 * newline, fields in this order. Changing any byte of this invalidates every
 * signature produced against the old form.
 */
export function buildEscalationMessage(input: EscalationMessageInput): string {
  return [
    "straitsx-888 escalation decision",
    `requestId: ${input.requestId}`,
    `mandateId: ${input.mandateId.toLowerCase()}`,
    `decision: ${input.decision}`,
  ].join("\n");
}

/**
 * Verify an EIP-191 `personal_sign` signature over the canonical message and
 * confirm it was produced by `expectedSigner` (the mandate owner).
 *
 * Returns a result rather than throwing so the caller maps it to the right HTTP
 * status: a bad signature is a 403, not a 500.
 *
 * Addresses compare lowercased (§0). `verifyMessage` handles the EIP-191
 * prefixing, so callers pass the raw message, never a pre-hashed value.
 */
export async function verifyEscalationSignature(args: {
  input: EscalationMessageInput;
  signature: Hex;
  expectedSigner: Address;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const message = buildEscalationMessage(args.input);

  if (!/^0x[0-9a-fA-F]+$/.test(args.signature)) {
    return { ok: false, reason: "signature is not 0x-prefixed hex" };
  }

  let valid: boolean;
  try {
    valid = await verifyMessage({
      address: args.expectedSigner as `0x${string}`,
      message,
      signature: args.signature as `0x${string}`,
    });
  } catch (err) {
    // A malformed signature makes viem throw rather than return false. That is
    // still a failed verification, not a server fault.
    return {
      ok: false,
      reason: `signature could not be verified: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!valid) {
    return {
      ok: false,
      reason: `signature does not recover to the mandate owner ${args.expectedSigner}`,
    };
  }
  return { ok: true };
}
