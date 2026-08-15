import "server-only";
import type { Mandate } from "@straitsx/contracts";

const POLICY_URL = process.env["POLICY_URL"] ?? "http://localhost:4002";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${POLICY_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN, ...init?.headers },
  });
}

export type PolicyRecord = {
  mandateId: string;
  policy: Mandate;
  policyHash: string;
  policyVersion: number;
  onChainHash: string | null;
  inSync: boolean;
};

/** api-contracts.md §6 GET /policy/:mandateId. */
export async function getPolicy(mandateId: string): Promise<PolicyRecord | null> {
  const res = await call(`/policy/${mandateId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`policy-service getPolicy ${res.status}`);
  return res.json() as Promise<PolicyRecord>;
}

export type PutPolicyResult =
  | { ok: true; mandateId: string; policyVersion: number; policyHash: string; onChainHash: string; inSync: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * api-contracts.md §6 PUT /policy/:mandateId. Only succeeds once the mandate
 * is live on-chain (policy-service checks the hash against the registry) —
 * call this AFTER the createMandate transaction has been mined, never before.
 */
export async function putPolicy(mandateId: string, policy: Mandate): Promise<PutPolicyResult> {
  const res = await call(`/policy/${mandateId}`, { method: "PUT", body: JSON.stringify({ policy }) });
  if (res.ok) {
    const body = (await res.json()) as {
      mandateId: string;
      policyVersion: number;
      policyHash: string;
      onChainHash: string;
      inSync: true;
    };
    return { ok: true, ...body };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return { ok: false, status: res.status, code: body.error?.code ?? "UNKNOWN", message: body.error?.message ?? res.statusText };
}

export type ResolveEscalationResult =
  | { status: "signed"; header: string; nonce: string }
  | { status: "refused"; check: string; detail: string }
  | { error: { code: string; message: string } };

/** api-contracts.md §6 POST /escalation/:requestId/resolve (C15). */
export async function resolveEscalation(
  requestId: string,
  body: { decision: "approve" | "deny"; approvedBy?: string; standingApproval?: { scope: "once" | "merchant-window" } },
): Promise<ResolveEscalationResult> {
  const res = await call(`/escalation/${requestId}/resolve`, { method: "POST", body: JSON.stringify(body) });
  return res.json() as Promise<ResolveEscalationResult>;
}
