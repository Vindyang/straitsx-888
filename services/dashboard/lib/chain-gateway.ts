/**
 * Server-only. The browser never calls chain-gateway directly
 * (docs/conventions.md §3) — every function here runs inside a Next.js route
 * handler / server component, never in client code.
 */

import "server-only";

const CHAIN_GATEWAY_URL = process.env["CHAIN_GATEWAY_URL"] ?? "http://localhost:4004";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CHAIN_GATEWAY_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN, ...init?.headers },
  });
}

export type OnChainMandate = {
  mandateId: string;
  owner: string;
  policyHash: string;
  expiresAt: number;
  revoked: boolean;
  readAtBlock: number;
};

/** api-contracts.md §3 GET /mandate/:mandateId. 404 (owner == address(0)) maps to `null`. */
export async function getOnChainMandate(mandateId: string, chainId: number): Promise<OnChainMandate | null> {
  const res = await call(`/mandate/${mandateId}?chainId=${chainId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`chain-gateway getMandate ${res.status}`);
  return res.json() as Promise<OnChainMandate>;
}

export type UnsignedTx = {
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit: string;
};

/** api-contracts.md §3 POST /tx/build-revoke. Unsigned — the human signs in their wallet. */
export async function buildRevokeTx(entry: {
  mandateId: string;
  chainId: number;
  from: string;
}): Promise<UnsignedTx> {
  const res = await call("/tx/build-revoke", { method: "POST", body: JSON.stringify(entry) });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `chain-gateway buildRevokeTx ${res.status}`);
  }
  return res.json() as Promise<UnsignedTx>;
}
