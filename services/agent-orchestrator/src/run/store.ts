/**
 * C8 — in-memory run state, SSE event log, and outcome detail. Mirrors
 * ledger-service's in-memory-map-for-the-weekend approach; nothing here is a
 * system of record — that's ledger-service's job (docs/conventions.md). This
 * store exists so the dashboard's refusal panel (C12) and run list have
 * something to read: `check`/`detail`/`humanExplanation` only ever arrive on
 * policy-service's direct HTTP response, so the pipeline captures them here
 * the moment it receives them.
 */

import type { ResolvedItem } from "@straitsx/contracts";

export type RunStage =
  | "INTENT_CREATED"
  | "DISCOVERY_DONE"
  | "CHALLENGE_RECEIVED"
  | "POLICY_DECISION"
  | "SETTLEMENT_CONFIRMED"
  | "CARD_ISSUED"
  | "CHECKOUT_ASSERTED"
  | "SPEND_RECORDED";

export type RunEvent = {
  seq: number;
  stage: RunStage;
  status?: "ok" | "refused" | "escalated" | undefined;
  check?: string | undefined;
  at: string;
};

export type RunState = "RUNNING" | "DONE" | "REFUSED" | "ESCALATED" | "FAILED";

export type RunOutcome =
  | { status: "refused"; check: string; checkIndex: number | null; detail: string; humanExplanation: string }
  | { status: "escalated"; reason: string; approvalUrl: string; expiresAt: number; ttlSeconds: number }
  | { status: "signed"; settlementTx: string | null; cardOpaqueId: string | null }
  | { status: "failed"; message: string };

export type RunMeta = {
  instruction: string;
  mandateId: string;
  agentId: string;
  fixture: string;
  /** The fixture page this run's discovery pass navigated to. Kept so the
   *  C15 escalation screen can independently re-fetch it — deliberately via a
   *  different code path than discoverProduct() (see dashboard's
   *  independent-check route), not the agent's cached resolvedItem. */
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
  runs.set(requestId, {
    requestId,
    meta,
    createdAt: new Date().toISOString(),
    state: "RUNNING",
    events: [],
    resolvedItem: undefined,
    outcome: undefined,
    subscribers: new Set(),
  });
}

export function getRun(requestId: string): RunRecord | undefined {
  return runs.get(requestId);
}

/** Newest first — that's what a run list wants to show. */
export function listRuns(): RunSummary[] {
  return [...runs.values()]
    .map(({ events: _events, subscribers: _subscribers, ...summary }) => summary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function setRunState(requestId: string, state: RunState): void {
  const run = runs.get(requestId);
  if (run) run.state = state;
}

export function setDiscoveredItem(requestId: string, resolvedItem: ResolvedItem): void {
  const run = runs.get(requestId);
  if (run) run.resolvedItem = resolvedItem;
}

export function setOutcome(requestId: string, outcome: RunOutcome): void {
  const run = runs.get(requestId);
  if (run) run.outcome = outcome;
}

export function emitEvent(requestId: string, event: Omit<RunEvent, "seq" | "at">): RunEvent {
  const run = runs.get(requestId);
  if (!run) throw new Error(`no run for ${requestId}`);
  const full: RunEvent = { ...event, seq: run.events.length + 1, at: new Date().toISOString() };
  run.events.push(full);
  for (const subscriber of run.subscribers) subscriber(full);
  return full;
}

/** Returns an unsubscribe function. */
export function subscribe(requestId: string, onEvent: (event: RunEvent) => void): () => void {
  const run = runs.get(requestId);
  if (!run) throw new Error(`no run for ${requestId}`);
  run.subscribers.add(onEvent);
  return () => run.subscribers.delete(onEvent);
}
