import { AppError, ErrorCode, type ResolvedItem, type X402Requirements } from "@straitsx/contracts";

const POLICY_URL = process.env["POLICY_URL"] ?? "http://localhost:4002";
const INTERNAL_TOKEN = process.env["INTERNAL_TOKEN"] ?? "dev-secret";

export type PolicyDecision =
  | { status: "signed"; header: string; nonce: string; validAfter: number; validBefore: number; checksPassed: string[] }
  | { status: "refused"; check: string; checkIndex: number | null; detail: string; humanExplanation: string }
  | { status: "escalated"; reason: string; approvalUrl: string; expiresAt: number; ttlSeconds: number; onTimeout: "DENY" };
export type EscalationDecision =
  | { status: "signed"; header: string; nonce: string }
  | { status: "refused"; check: string; checkIndex: number | null; detail: string; humanExplanation: string };

function malformed(message: string): never {
  throw new AppError(502, ErrorCode.INTERNAL, `policy-service response malformed: ${message}`);
}

export function parsePolicyDecision(value: unknown): PolicyDecision {
  if (!value || typeof value !== "object") return malformed("expected an object");
  const body = value as Record<string, unknown>;
  if (body.status === "signed") {
    if (typeof body.header !== "string" || !body.header || typeof body.nonce !== "string" ||
        typeof body.validAfter !== "number" || typeof body.validBefore !== "number" || !Array.isArray(body.checksPassed)) {
      return malformed("invalid signed result");
    }
    return body as unknown as PolicyDecision;
  }
  if (body.status === "refused") {
    if (typeof body.check !== "string" || !(typeof body.checkIndex === "number" || body.checkIndex === null) ||
        typeof body.detail !== "string" || typeof body.humanExplanation !== "string") return malformed("invalid refused result");
    return body as unknown as PolicyDecision;
  }
  if (body.status === "escalated") {
    if (typeof body.reason !== "string" || typeof body.approvalUrl !== "string" || typeof body.expiresAt !== "number" ||
        typeof body.ttlSeconds !== "number" || body.onTimeout !== "DENY") return malformed("invalid escalated result");
    return body as unknown as PolicyDecision;
  }
  return malformed("unknown status");
}

async function post(path: string, body: unknown): Promise<PolicyDecision> {
  const res = await fetch(`${POLICY_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify(body),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = payload as { error?: { message?: string; retryable?: boolean } } | null;
    throw new AppError(res.status, ErrorCode.INTERNAL, envelope?.error?.message ?? `policy-service ${res.status}`, envelope?.error?.retryable ?? false);
  }
  return parsePolicyDecision(payload);
}

export function requestPayment(body: {
  requestId: string;
  mandateId: string;
  requestedAmount: string;
  challenge: X402Requirements;
  intent: string;
  resolvedItem?: ResolvedItem;
}): Promise<PolicyDecision> {
  return post("/payment/request", body);
}

export function resolveEscalation(requestId: string, body: {
  decision: "approve" | "deny";
  approvedBy?: string;
  signature?: string;
  standingApproval?: { scope: "once" | "merchant-window" };
}): Promise<EscalationDecision> {
  return fetch(`${POLICY_URL}/escalation/${requestId}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": INTERNAL_TOKEN },
    body: JSON.stringify(body),
  }).then(async (res) => {
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const envelope = payload as { error?: { message?: string; retryable?: boolean } } | null;
      throw new AppError(res.status, ErrorCode.INTERNAL, envelope?.error?.message ?? `policy-service ${res.status}`, envelope?.error?.retryable ?? false);
    }
    if (!payload || typeof payload !== "object") return malformed("invalid escalation result");
    const value = payload as Record<string, unknown>;
    if (value.status === "signed" && typeof value.header === "string" && value.header && typeof value.nonce === "string") {
      return value as unknown as EscalationDecision;
    }
    if (value.status === "refused" && typeof value.check === "string" && typeof value.detail === "string") {
      return {
        status: "refused",
        check: value.check,
        checkIndex: typeof value.checkIndex === "number" ? value.checkIndex : null,
        detail: value.detail,
        humanExplanation: typeof value.humanExplanation === "string" ? value.humanExplanation : "The escalation was denied. Nothing was signed and no money moved.",
      };
    }
    return malformed("invalid escalation result");
  });
}
