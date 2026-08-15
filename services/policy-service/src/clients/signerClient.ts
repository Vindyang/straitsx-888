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

/** api-contracts.md §4 POST /sign. `mandateId` accompanies typedData for the hard-invariant rail. */
export async function sign(requestId: string, mandateId: string, typedData: TypedData): Promise<SignResult> {
  const res = await fetch(`${SIGNER_URL}/sign`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify({ requestId, mandateId, typedData }),
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
