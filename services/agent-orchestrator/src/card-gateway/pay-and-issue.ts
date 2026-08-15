/**
 * C4 — retry the cardapi with the signed PAYMENT-SIGNATURE header. Settlement
 * PRECEDES issuance: a 200 here means XSGD has already moved.
 *
 * The upstream response may contain card_html, but it is discarded here and
 * never crosses this boundary. Card display exclusively uses viewCard().
 */

import { AppError, ErrorCode, parseX402Challenge } from "@straitsx/contracts";
import type { PayAndIssueParams, PayAndIssueResult } from "./types";

type CardapiSuccessBody = {
  card_opaque_id: string;
  settlement_tx: string;
  issued_at?: string;
};

export async function payAndIssue(params: PayAndIssueParams): Promise<PayAndIssueResult> {
  const res = await fetch(params.cardapiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "PAYMENT-SIGNATURE": params.header,
    },
    body: JSON.stringify({
      cardholder_name: params.cardholderName,
      amount_sgd: params.amountSgd,
    }),
    signal: AbortSignal.timeout(20_000),
  });

  // On 402, the header was rejected — return the fresh challenge for diagnosis
  // rather than throwing, since the caller may retry with a new signature.
  if (res.status === 402) {
    const body: unknown = await res.json();
    return { ok: false, status: 402, challenge: parseX402Challenge(body) };
  }
  if (!res.ok) {
    throw new AppError(502, ErrorCode.CARDAPI_FAILED, `cardapi payAndIssue failed: ${res.status}`, true);
  }

  const body = (await res.json()) as CardapiSuccessBody;
  if (typeof body.card_opaque_id !== "string" || typeof body.settlement_tx !== "string") {
    throw new AppError(502, ErrorCode.CARDAPI_FAILED, "cardapi success response was malformed");
  }
  return {
    ok: true,
    cardOpaqueId: body.card_opaque_id,
    settlementTx: body.settlement_tx,
    issuedAt: body.issued_at ?? new Date().toISOString(),
  };
}
