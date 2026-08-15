import "server-only";

const AGENT_ORCHESTRATOR_URL = process.env["AGENT_ORCHESTRATOR_URL"] ?? "http://localhost:4005";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${AGENT_ORCHESTRATOR_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN, ...init?.headers },
  });
}

export type RunOutcome =
  | { status: "refused"; check: string; checkIndex: number | null; detail: string; humanExplanation: string }
  | { status: "escalated"; reason: string; approvalUrl: string; expiresAt: number; ttlSeconds: number }
  | { status: "checkout-pending"; settlementTx: string; cardOpaqueId: string }
  | { status: "signed"; settlementTx: string | null; cardOpaqueId: string | null }
  | { status: "failed"; message: string };

export type RunSummary = {
  requestId: string;
  meta: { instruction: string; mandateId: string; agentId: string; source: { kind: string; name?: string; profileId?: string }; fixture?: string; productUrl: string };
  createdAt: string;
  state: "RUNNING" | "AWAITING_CHECKOUT" | "DONE" | "REFUSED" | "ESCALATED" | "FAILED";
  resolvedItem?: { title: string; sku: string; price: string; merchantDomain: string; checkoutUrl: string };
  outcome?: RunOutcome;
};

/** GET /runs (C12 run list). */
export async function listRuns(): Promise<RunSummary[]> {
  const res = await call("/runs");
  if (!res.ok) throw new Error(`orchestrator listRuns ${res.status}`);
  return res.json() as Promise<RunSummary[]>;
}

export type RunEvent = { seq: number; stage: string; status?: string; check?: string; at: string };

export type RunRecord = RunSummary & { events: RunEvent[] };

/** GET /run/:requestId (C12 refusal panel backing). */
export async function getRun(requestId: string): Promise<RunRecord | null> {
  const res = await call(`/run/${requestId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`orchestrator getRun ${res.status}`);
  return res.json() as Promise<RunRecord>;
}
