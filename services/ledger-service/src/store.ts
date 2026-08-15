import { hashIntentInstruction, type Mandate, type X402Requirements } from "@straitsx/contracts";

export type IntentState =
  | "INTENT_CREATED"
  | "CHALLENGE_ATTACHED"
  | "NONCE_RESERVED"
  | "SIGNED"
  | "SETTLED";

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
