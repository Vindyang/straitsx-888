import { hashIntentInstruction, type Mandate, type X402Requirements } from "@straitsx/contracts";

export type IntentState =
  | "INTENT_CREATED"
  | "CHALLENGE_ATTACHED"
  | "NONCE_RESERVED"
  | "SIGNED"
  | "SETTLED"
  | "CAPTURED";

export type IntentRecord = {
  requestId: string;
  mandateId: string;
  agentId: string;
  instruction: string;
  instructionHash: string;
  createdAt: string;
  challenge?: X402Requirements | undefined;
  challengeAttachedAt?: string | undefined;
  nonce?: string | undefined;
  nonceReservedAt?: string | undefined;
  nonceReleased?: boolean | undefined;
  decision?: "signed" | "refused" | "escalated" | undefined;
  decidedAt?: string | undefined;
  // Only policy-service knows these at the moment it signs — carried in via POST /decision
  // (a deliberate extension beyond api-contracts.md §5's documented body) so the receipt can
  // report them instead of null.
  policyHash?: string | undefined;
  /** Domain committed into the signed authorization nonce. */
  merchantDomain?: string | undefined;
  validAfter?: number | undefined;
  validBefore?: number | undefined;
  settlement?:
    | {
        settlementTx: string;
        blockNumber: number;
        cardOpaqueId: string;
        /** keccak256 of the MCP tool result. The HASH only — never the body,
         *  which carries a live prompt injection (execution_plan.md §19.6).
         *  Optional: settlements predating card-gateway supplying it stay valid. */
        rawToolResultHash?: string | undefined;
      }
    | undefined;
  spend?: {
    merchantDomain: string;
    orderTotal: string;
    itemSku: string;
    orderId: string;
    observedAt: string;
  };
  /** Capture-time settlement finalization (card issuer settlement). Recorded only
   *  AFTER the on-chain transfer has been independently verified; until then the
   *  intent stays SETTLED and the run is not DONE. */
  capture?:
    | {
        orderId: string;
        capturedAt: string;
        settlementTx: string;
        blockNumber: number;
      }
    | undefined;
  state: IntentState;
};

export type DecisionLogEntry = {
  sequence: number;
  requestId: string;
  decision: "signed" | "refused" | "escalated";
  check?: string | undefined;
  detail?: string | undefined;
  decidedAt: string;
};

export type PolicyRecord = {
  policy: Mandate;
  policyVersion: number;
};

export type EscalationReason = "WINDOW_BUDGET_EXCEEDED" | "INTENT_MISMATCH";

export type EscalationRecord = {
  requestId: string;
  mandateId: string;
  reason: EscalationReason;
  approvalUrl: string;
  createdAt: string;
  expiresAt: number; // unix seconds
  ttlSeconds: number;
  resolved: boolean;
  decision?: "approve" | "deny" | undefined;
  approvedBy?: string | undefined;
  resolvedAt?: string | undefined;
  // Only set for check9 (INTENT_MISMATCH) escalations — lets "approve this merchant for this
  // window" (B21) turn into a standing approval without the caller re-sending it at resolve time.
  merchantDomain?: string | undefined;
};

// In-memory Map per B1. A Postgres/DynamoDB swap lands later without changing the routes.
export const intents = new Map<string, IntentRecord>();
export const decisionLog: DecisionLogEntry[] = [];
// Raw storage only — no hash-drift validation here. That belongs in policy-service (B22);
// "storage logic in policy-service" and "validation logic in ledger-service" are both listed
// as Never in owner-b-tasks.md.
export const policies = new Map<string, PolicyRecord>();
export const escalations = new Map<string, EscalationRecord>();
// key: `${mandateId}::${merchantDomain.toLowerCase()}`, value: expiresAt (unix seconds)
export const standingApprovals = new Map<string, number>();

// ---- Live transparency feed (append-only append-bus) -----------------------------
// Every mutation broadcasts an "append" event; the dashboard proxies the ledger's
// `GET /ledger/events` SSE stream to the user so each payment step is visible in
// real time (docs/api-contracts.md §5).
import { EventEmitter } from "node:events";

export type LedgerEventKind =
  | "intent.created"
  | "challenge.attached"
  | "nonce.reserved"
  | "nonce.released"
  | "decision.recorded"
  | "settlement.recorded"
  | "spend.recorded"
  | "capture.recorded"
  | "escalation.created"
  | "escalation.resolved"
  | "policy.put"
  | "standing_approval.set";

export type LedgerAppendEvent = {
  seq: number;
  kind: LedgerEventKind;
  at: string;
  requestId?: string;
  mandateId?: string;
  state?: string;
  /** The touched intent, view-shaped, when the event concerns an intent. */
  intent?: IntentView;
  detail?: Record<string, unknown>;
};

export const ledgerEvents = new EventEmitter();
let ledgerEventSeq = 0;
export function nextLedgerEventSeq(): number {
  return ++ledgerEventSeq;
}

/** Public, read-only view of an intent for transparency pages. */
export type IntentView = {
  requestId: string;
  mandateId: string;
  agentId: string;
  instruction: string;
  instructionHash: string;
  createdAt: string;
  state: IntentState;
  decision?: "signed" | "refused" | "escalated" | undefined;
  decidedAt?: string | undefined;
  check?: string | undefined;
  detail?: string | undefined;
  policyHash?: string | undefined;
  merchantDomain?: string | undefined;
  challenge?:
    | { payTo: string; asset: string; chainId: number; amount: string }
    | undefined;
  nonce?: string | undefined;
  nonceReserved?: boolean | undefined;
  settlement?:
    | { settlementTx: string; blockNumber: number; cardOpaqueId: string }
    | undefined;
  spend?: {
    merchantDomain: string;
    orderTotal: string;
    itemSku: string;
    orderId: string;
    observedAt: string;
  };
  capture?:
    | { orderId: string; capturedAt: string; settlementTx: string; blockNumber: number }
    | undefined;
};

export function intentViewOf(intent: IntentRecord): IntentView {
  return {
    requestId: intent.requestId,
    mandateId: intent.mandateId,
    agentId: intent.agentId,
    instruction: intent.instruction,
    instructionHash: intent.instructionHash,
    createdAt: intent.createdAt,
    state: intent.state,
    ...(intent.decision ? { decision: intent.decision } : {}),
    ...(intent.decidedAt ? { decidedAt: intent.decidedAt } : {}),
    ...(intent.policyHash ? { policyHash: intent.policyHash } : {}),
    ...(intent.merchantDomain ? { merchantDomain: intent.merchantDomain } : {}),
    challenge: intent.challenge
      ? {
          payTo: intent.challenge.payTo,
          asset: intent.challenge.asset,
          chainId: intent.challenge.chainId,
          amount: intent.challenge.amount,
        }
      : undefined,
    nonce: intent.nonce,
    nonceReserved: intent.nonce !== undefined && !intent.nonceReleased,
    ...(intent.settlement
      ? {
          settlement: {
            settlementTx: intent.settlement.settlementTx,
            blockNumber: intent.settlement.blockNumber,
            cardOpaqueId: intent.settlement.cardOpaqueId,
          },
        }
      : {}),
    ...(intent.spend ? { spend: intent.spend } : {}),
    ...(intent.capture ? { capture: intent.capture } : {}),
  };
}

/** Test-only: wipe all in-memory state between test cases. */
export function resetStore(): void {
  intents.clear();
  policies.clear();
  decisionLog.length = 0;
  escalations.clear();
  standingApprovals.clear();
}

export function instructionHashOf(instruction: string): string {
  return hashIntentInstruction(instruction);
}
