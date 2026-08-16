import type { ResolvedItem } from "@straitsx/contracts";

export type RunStage =
  | "INTENT_CREATED"
  | "DISCOVERY_DONE"
  | "CHECKOUT_ACQUIRED"
  | "CHALLENGE_RECEIVED"
  | "POLICY_DECISION"
  | "CARD_ISSUED"
  | "CHECKOUT_ASSERTED"
  | "SPEND_RECORDED"
  | "SETTLEMENT_FINALIZED";

export type RunEvent = {
  seq: number;
  stage: RunStage;
  status?: "ok" | "refused" | "escalated";
  check?: string;
  at: string;
};

export type RunState = "RUNNING" | "ESCALATED" | "AWAITING_CHECKOUT" | "DONE" | "REFUSED" | "FAILED";
export const isTerminalRunState = (state: RunState): boolean => state === "DONE" || state === "REFUSED" || state === "FAILED";

export type RunOutcome =
  | { status: "refused"; check: string; checkIndex: number | null; detail: string; humanExplanation: string }
  | { status: "escalated"; reason: string; approvalUrl: string; expiresAt: number; ttlSeconds: number }
  | { status: "checkout-pending"; settlementTx: string; cardOpaqueId: string }
  | { status: "signed"; settlementTx: string; cardOpaqueId: string }
  | { status: "failed"; message: string; freshRequestRequired?: boolean };

export type RunMeta = {
  instruction: string;
  mandateId: string;
  agentId: string;
  source: { kind: "fixture"; name: string } | { kind: "merchant"; profileId: string } | { kind: "shopify"; checkout: { storeDomain: string; checkoutSessionId: string } };
  /** Deprecated migration field. */
  fixture?: string;
  /** Shopify/UCP checkout session id (present for shopify sources). */
  checkoutSessionId?: string;
  productUrl: string;
};

export type RunRecord = {
  requestId: string;
  meta: RunMeta;
  createdAt: string;
  state: RunState;
  events: RunEvent[];
  resolvedItem: ResolvedItem | undefined;
  outcome: RunOutcome | undefined;
  subscribers: Set<(event: RunEvent) => void>;
};
export type RunSummary = Omit<RunRecord, "events" | "subscribers">;

const runs = new Map<string, RunRecord>();

export function createRun(requestId: string, meta: RunMeta): void {
  runs.set(requestId, { requestId, meta, createdAt: new Date().toISOString(), state: "RUNNING", events: [], resolvedItem: undefined, outcome: undefined, subscribers: new Set() });
}
export const getRun = (requestId: string): RunRecord | undefined => runs.get(requestId);
export function listRuns(): RunSummary[] {
  return [...runs.values()].map(({ events: _events, subscribers: _subscribers, ...summary }) => summary).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function setRunState(requestId: string, state: RunState): void { const run = runs.get(requestId); if (run) run.state = state; }
export function setDiscoveredItem(requestId: string, resolvedItem: ResolvedItem): void { const run = runs.get(requestId); if (run) run.resolvedItem = resolvedItem; }
export function setOutcome(requestId: string, outcome: RunOutcome): void { const run = runs.get(requestId); if (run) run.outcome = outcome; }
export function emitEvent(requestId: string, event: Omit<RunEvent, "seq" | "at">): RunEvent {
  const run = runs.get(requestId);
  if (!run) throw new Error(`no run for ${requestId}`);
  const full = { ...event, seq: run.events.length + 1, at: new Date().toISOString() };
  run.events.push(full);
  for (const subscriber of run.subscribers) subscriber(full);
  return full;
}
export function subscribe(requestId: string, onEvent: (event: RunEvent) => void): () => void {
  const run = runs.get(requestId);
  if (!run) throw new Error(`no run for ${requestId}`);
  run.subscribers.add(onEvent);
  return () => run.subscribers.delete(onEvent);
}
