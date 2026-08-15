import { buildCommitmentNonce, type Hex, type Mandate, type X402Requirements } from "@straitsx/contracts";
import * as ledger from "./clients/ledgerClient.js";
import * as signer from "./clients/signerClient.js";
import { buildTypedData } from "./typedData.js";

export type SigningOutcome =
  | { ok: true; header: string; nonce: string; validAfter: number; validBefore: number }
  | { ok: false; statusCode: number; code: string; message: string; retryable: boolean };

export type SigningCommitment = {
  policyHash: Hex;
  intentHash: Hex;
  merchantDomain: string;
};

/**
 * The tail end of B10's pipeline: reserve nonce -> compute validity window -> sign.
 * Shared between the main POST /payment/request flow and POST /escalation/:id/resolve (B21),
 * since an approved escalation resumes at exactly this point.
 */
export async function performSigning(
  requestId: string,
  mandateId: string,
  mandate: Mandate,
  challenge: X402Requirements,
  amount: string,
  now: number,
  /**
   * The resource being paid for — the cardapi URL from the 402 exchange.
   *
   * TODO(owner-c-plumbing): this should arrive with the challenge. `get_card_sandbox`
   * returns `{ cardapiUrl, challenge }` (execution_plan §6), but `cardapiUrl` is
   * currently dropped before it reaches policy-service, so callers pass the
   * sandbox constant. Thread it through the intent record and this parameter
   * becomes the real value instead of an assumption.
   */
  resource: string,
  commitment: SigningCommitment,
): Promise<SigningOutcome> {
  const nonce = buildCommitmentNonce({ requestId, ...commitment });
  const reserved = await ledger.reserveNonce(requestId, nonce);
  if (!reserved.ok) {
    return { ok: false, statusCode: 409, code: reserved.code, message: `nonce reservation failed for ${requestId}`, retryable: false };
  }

  const window = Math.min(mandate.maxAuthValiditySeconds, challenge.maxTimeoutSeconds);
  const validAfter = now - 5;
  const validBefore = validAfter + window;
  const typedData = buildTypedData(mandate, challenge, amount, validAfter, validBefore, nonce);

  // `accepted` is the challenge minus its top-level x402Version — the entry the
  // payment satisfies. Derived here rather than asked of every caller, since the
  // challenge already carries every field.
  const { x402Version: _x402Version, ...accepted } = challenge;

  const signResult = await signer.sign(
    requestId,
    mandateId,
    typedData,
    accepted,
    resource,
  );
  if (!signResult.ok) {
    // Pre-signature failure: release the nonce so a retry with a fresh nonce can succeed (B6).
    await ledger.releaseNonce(requestId, signResult.code);
    // Pass through the signer's actual status: a 403 from its hard-invariant rail
    // (execution_plan.md §12b 2.2) is a definitive refusal, not a transient upstream failure —
    // only a 5xx from the signer is genuinely retryable.
    return {
      ok: false,
      statusCode: signResult.status,
      code: signResult.code,
      message: signResult.message,
      retryable: signResult.status >= 500,
    };
  }

  return { ok: true, header: signResult.header, nonce, validAfter, validBefore };
}
