import type { X402Requirements, Mandate } from "@straitsx/contracts";

const LEDGER_URL = process.env.LEDGER_URL ?? "http://localhost:4001";
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? "dev-secret";

type IntentRecord = {
  requestId: string;
  mandateId: string;
  instruction: string;
  createdAt: string;
  challenge?: X402Requirements;
  challengeAttachedAt?: string;
  nonce?: string;
  decision?: string;
};

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${LEDGER_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-internal-token": INTERNAL_TOKEN,
      ...init?.headers,
    },
  });
}

export async function getIntent(requestId: string): Promise<IntentRecord | null> {
  const res = await call(`/intent/${requestId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ledger getIntent ${res.status}`);
  return res.json() as Promise<IntentRecord>;
}

export async function getPolicy(mandateId: string): Promise<{ policy: Mandate; policyVersion: number } | null> {
  const res = await call(`/policy/${mandateId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ledger getPolicy ${res.status}`);
  return res.json() as Promise<{ policy: Mandate; policyVersion: number }>;
}

export async function putPolicy(mandateId: string, policy: Mandate): Promise<{ mandateId: string; policyVersion: number }> {
  const res = await call(`/policy/${mandateId}`, { method: "PUT", body: JSON.stringify({ policy }) });
  if (!res.ok) throw new Error(`ledger putPolicy ${res.status}`);
  return res.json() as Promise<{ mandateId: string; policyVersion: number }>;
}

export async function getWindowUsage(
  mandateId: string,
  windowSeconds: number,
  maxPerWindow: string,
): Promise<{ spent: string; cardCount: number }> {
  const res = await call(`/window/${mandateId}?windowSeconds=${windowSeconds}&maxPerWindow=${maxPerWindow}`);
  if (!res.ok) throw new Error(`ledger getWindowUsage ${res.status}`);
  return res.json() as Promise<{ spent: string; cardCount: number }>;
}

export type ReserveNonceResult = { ok: true } | { ok: false; code: string };

export async function reserveNonce(requestId: string, nonce: string): Promise<ReserveNonceResult> {
  const res = await call(`/intent/${requestId}/nonce`, { method: "POST", body: JSON.stringify({ nonce }) });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
  return { ok: false, code: body.error?.code ?? "NONCE_RESERVE_FAILED" };
}

export async function releaseNonce(requestId: string, reason: string): Promise<void> {
  await call(`/intent/${requestId}/release-nonce`, { method: "POST", body: JSON.stringify({ reason }) });
}

export async function recordDecision(entry: {
  requestId: string;
  decision: "signed" | "refused" | "escalated";
  check?: string;
  detail?: string;
  decidedAt: string;
}): Promise<void> {
  const res = await call("/decision", { method: "POST", body: JSON.stringify(entry) });
  if (!res.ok) throw new Error(`ledger recordDecision ${res.status}`);
}

export type EscalationReason = "WINDOW_BUDGET_EXCEEDED" | "INTENT_MISMATCH";

export type EscalationRecord = {
  requestId: string;
  mandateId: string;
  reason: EscalationReason;
  approvalUrl: string;
  createdAt: string;
  expiresAt: number;
  ttlSeconds: number;
  resolved: boolean;
  decision?: "approve" | "deny";
  approvedBy?: string;
  resolvedAt?: string;
  merchantDomain?: string;
};

export async function createEscalation(entry: {
  requestId: string;
  mandateId: string;
  reason: EscalationReason;
  approvalUrl: string;
  ttlSeconds: number;
  merchantDomain?: string;
}): Promise<EscalationRecord> {
  const res = await call("/escalation", { method: "POST", body: JSON.stringify(entry) });
  if (!res.ok) throw new Error(`ledger createEscalation ${res.status}`);
  return res.json() as Promise<EscalationRecord>;
}

export async function getEscalation(requestId: string): Promise<EscalationRecord | null> {
  const res = await call(`/escalation/${requestId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ledger getEscalation ${res.status}`);
  return res.json() as Promise<EscalationRecord>;
}

export async function resolveEscalationStorage(
  requestId: string,
  decision: "approve" | "deny",
  approvedBy?: string,
): Promise<EscalationRecord> {
  const res = await call(`/escalation/${requestId}`, { method: "PUT", body: JSON.stringify({ decision, approvedBy }) });
  if (!res.ok) throw new Error(`ledger resolveEscalationStorage ${res.status}`);
  return res.json() as Promise<EscalationRecord>;
}

export async function getStandingApproval(mandateId: string, merchantDomain: string): Promise<boolean> {
  const res = await call(`/standing-approval?mandateId=${mandateId}&merchantDomain=${encodeURIComponent(merchantDomain)}`);
  if (!res.ok) throw new Error(`ledger getStandingApproval ${res.status}`);
  const body = (await res.json()) as { active: boolean };
  return body.active;
}

export async function setStandingApproval(mandateId: string, merchantDomain: string, expiresAt: number): Promise<void> {
  const res = await call("/standing-approval", { method: "POST", body: JSON.stringify({ mandateId, merchantDomain, expiresAt }) });
  if (!res.ok) throw new Error(`ledger setStandingApproval ${res.status}`);
}
