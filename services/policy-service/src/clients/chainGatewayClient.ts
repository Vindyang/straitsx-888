import type { RegistryMandate } from "../checks/types.js";

const CHAIN_GATEWAY_URL = process.env.CHAIN_GATEWAY_URL ?? "http://localhost:4004";
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? "dev-secret";

/** api-contracts.md §3 GET /mandate/:mandateId. 404 (owner == address(0)) maps to `null`. */
export async function getMandate(mandateId: string, chainId: number): Promise<RegistryMandate | null> {
  const res = await fetch(`${CHAIN_GATEWAY_URL}/mandate/${mandateId}?chainId=${chainId}`, {
    headers: { "x-internal-token": INTERNAL_TOKEN },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`chain-gateway getMandate ${res.status}`);
  const body = (await res.json()) as { owner: string; policyHash: string; expiresAt: number; revoked: boolean };
  return { owner: body.owner, policyHash: body.policyHash, expiresAt: body.expiresAt, revoked: body.revoked };
}
