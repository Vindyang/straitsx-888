import type { ResolvedItem, X402Requirements } from "@straitsx/contracts";

const POLICY_URL = process.env["POLICY_URL"] ?? "http://localhost:4002";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

export type PolicyDecision =
  | {
      status: "signed";
      header: string;
      nonce: string;
      validAfter: number;
      validBefore: number;
      checksPassed: string[];
    }
  | { status: "refused"; check: string; checkIndex: number | null; detail: string; humanExplanation: string }
  | { status: "escalated"; reason: string; approvalUrl: string; expiresAt: number; ttlSeconds: number; onTimeout: "DENY" };

/** api-contracts.md §6 `POST /payment/request`. The one call into the decision point. */
export async function requestPayment(body: {
  requestId: string;
  mandateId: string;
  requestedAmount: string;
  challenge: X402Requirements;
  intent: string;
  resolvedItem?: ResolvedItem | undefined;
}): Promise<PolicyDecision> {
  const res = await fetch(`${POLICY_URL}/payment/request`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify(body),
  });
  return (await res.json()) as PolicyDecision;
}
