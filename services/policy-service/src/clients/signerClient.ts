const SIGNER_URL = process.env.SIGNER_URL ?? "http://localhost:4003";
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? "dev-secret";

export type TypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  primaryType: "TransferWithAuthorization";
  types: {
    TransferWithAuthorization: Array<{ name: string; type: string }>;
  };
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: number;
    validBefore: number;
    nonce: string;
  };
};

export type SignResult =
  | { ok: true; header: string; signerAddress: string; signedAt: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * The `accepts[]` entry from the 402 that this payment satisfies, passed
 * straight through to the signer. Nothing is computed here — it is the
 * challenge's own object.
 *
 * REQUIRED. The facilitator reads `accepted.amount` and has no other source for
 * it; omitting it produces `cannot parse payment amount: invalid atomic amount
 * ""` and the 402 never clears (confirmed at checkpoint 2, 2026-08-15).
 */
export type Accepted = {
  scheme: "exact";
  network: string;
  chainId: number;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { assetTransferMethod: "eip3009"; name: string; version: string };
};

/** api-contracts.md §4 POST /sign. `mandateId` accompanies typedData for the hard-invariant rail. */
export async function sign(
  requestId: string,
  mandateId: string,
  typedData: TypedData,
  accepted: Accepted,
  resource: string,
): Promise<SignResult> {
  const res = await fetch(`${SIGNER_URL}/sign`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify({ requestId, mandateId, typedData, accepted, resource }),
  });
  if (res.ok) {
    const body = (await res.json()) as { header: string; signerAddress: string; signedAt: string };
    return { ok: true, header: body.header, signerAddress: body.signerAddress, signedAt: body.signedAt };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return {
    ok: false,
    status: res.status,
    code: body.error?.code ?? "SIGNER_ERROR",
    message: body.error?.message ?? `signer-service returned ${res.status}`,
  };
}
