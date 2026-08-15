import type { Mandate, X402Requirements } from "@straitsx/contracts";

// Mirrors ledger-service's real behavior closely enough for pipeline integration tests,
// without needing a live HTTP server. Substituted in for ../src/clients/ledgerClient.js via
// vi.mock in test files — see pipeline.test.ts. Exports both the client-shaped functions
// app.ts calls AND the seed*/get* helpers tests use to set up and inspect state, all backed
// by the same module-level Maps (an ES module is a singleton, so both call sites share state).

type IntentRecord = {
  requestId: string;
  mandateId: string;
  instruction: string;
  createdAt: string;
  challenge?: X402Requirements;
  challengeAttachedAt?: string;
  nonce?: string;
  nonceReleased?: boolean;
  decision?: string;
  decidedAt?: string;
  policyHash?: string;
  validAfter?: number;
  validBefore?: number;
};

type PolicyRecord = { policy: Mandate; policyVersion: number };

type EscalationReason = "WINDOW_BUDGET_EXCEEDED" | "INTENT_MISMATCH";

type EscalationRecord = {
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

type DecisionEntry = {
  requestId: string;
  decision: "signed" | "refused" | "escalated";
  check?: string;
  detail?: string;
  decidedAt: string;
  policyHash?: string;
  validAfter?: number;
  validBefore?: number;
};

const intents = new Map<string, IntentRecord>();
const policies = new Map<string, PolicyRecord>();
const escalations = new Map<string, EscalationRecord>();
const standingApprovals = new Map<string, number>();
const decisions: DecisionEntry[] = [];

export function reset(): void {
  intents.clear();
  policies.clear();
  escalations.clear();
  standingApprovals.clear();
  decisions.length = 0;
}

// --- test helpers ---

export function seedIntent(intent: IntentRecord): void {
  intents.set(intent.requestId, intent);
}

export function seedPolicy(mandateId: string, policy: Mandate): void {
  policies.set(mandateId, { policy, policyVersion: 1 });
}

export function getDecisions(): DecisionEntry[] {
  return decisions;
}

export function getEscalationRecord(requestId: string): EscalationRecord | undefined {
  return escalations.get(requestId);
}

export function getIntentRecord(requestId: string): IntentRecord | undefined {
  return intents.get(requestId);
}

// --- client-shaped exports, matching src/clients/ledgerClient.ts exactly ---

export async function getIntent(requestId: string): Promise<IntentRecord | null> {
  return intents.get(requestId) ?? null;
}

export async function getPolicy(mandateId: string): Promise<PolicyRecord | null> {
  return policies.get(mandateId) ?? null;
}

export async function putPolicy(mandateId: string, policy: Mandate): Promise<{ mandateId: string; policyVersion: number }> {
  const existing = policies.get(mandateId);
  const policyVersion = (existing?.policyVersion ?? 0) + 1;
  policies.set(mandateId, { policy, policyVersion });
  return { mandateId, policyVersion };
}

export async function getWindowUsage(
  mandateId: string,
  windowSeconds: number,
  _maxPerWindow: string,
): Promise<{ spent: string; cardCount: number }> {
  const windowStartMs = Date.now() - windowSeconds * 1000;
  let spent = 0n;
  let cardCount = 0;
  for (const intent of intents.values()) {
    if (intent.mandateId !== mandateId) continue;
    if (intent.decision !== "signed" || !intent.decidedAt || !intent.challenge) continue;
    if (Date.parse(intent.decidedAt) < windowStartMs) continue;
    spent += BigInt(intent.challenge.amount);
    cardCount += 1;
  }
  return { spent: spent.toString(), cardCount };
}

export type ReserveNonceResult = { ok: true } | { ok: false; code: string };

export async function reserveNonce(requestId: string, nonce: string): Promise<ReserveNonceResult> {
  const intent = intents.get(requestId);
  if (!intent) return { ok: false, code: "INTENT_NOT_FOUND" };
  if (intent.nonce && !intent.nonceReleased) return { ok: false, code: "NONCE_ALREADY_RESERVED" };
  intent.nonce = nonce;
  intent.nonceReleased = false;
  return { ok: true };
}

export async function releaseNonce(requestId: string, _reason: string): Promise<void> {
  const intent = intents.get(requestId);
  if (intent) {
    intent.nonceReleased = true;
    intent.nonce = undefined;
  }
}

export async function recordDecision(entry: DecisionEntry): Promise<void> {
  decisions.push(entry);
  const intent = intents.get(entry.requestId);
  if (intent) {
    intent.decision = entry.decision;
    intent.decidedAt = entry.decidedAt;
    if (entry.decision === "signed") {
      intent.policyHash = entry.policyHash;
      intent.validAfter = entry.validAfter;
      intent.validBefore = entry.validBefore;
    }
  }
}

export async function createEscalation(entry: {
  requestId: string;
  mandateId: string;
  reason: EscalationReason;
  approvalUrl: string;
  ttlSeconds: number;
  merchantDomain?: string;
}): Promise<EscalationRecord> {
  const existing = escalations.get(entry.requestId);
  if (existing) return existing;
  const record: EscalationRecord = {
    ...entry,
    createdAt: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + entry.ttlSeconds,
    resolved: false,
  };
  escalations.set(entry.requestId, record);
  return record;
}

export async function getEscalation(requestId: string): Promise<EscalationRecord | null> {
  return escalations.get(requestId) ?? null;
}

export async function resolveEscalationStorage(
  requestId: string,
  decision: "approve" | "deny",
  approvedBy?: string,
): Promise<EscalationRecord> {
  const record = escalations.get(requestId);
  if (!record) throw new Error(`no escalation for ${requestId}`);
  record.resolved = true;
  record.decision = decision;
  record.approvedBy = approvedBy;
  record.resolvedAt = new Date().toISOString();
  return record;
}

export async function getStandingApproval(mandateId: string, merchantDomain: string): Promise<boolean> {
  const expiresAt = standingApprovals.get(`${mandateId}::${merchantDomain.toLowerCase()}`);
  return expiresAt !== undefined && expiresAt > Math.floor(Date.now() / 1000);
}

export async function setStandingApproval(mandateId: string, merchantDomain: string, expiresAt: number): Promise<void> {
  standingApprovals.set(`${mandateId}::${merchantDomain.toLowerCase()}`, expiresAt);
}
