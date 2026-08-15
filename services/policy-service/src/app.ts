import Fastify, { type FastifyInstance } from "fastify";
import {
  CARDAPI_SANDBOX_ISSUE_CARD,
  hashPolicy,
  type Mandate,
  type ResolvedItem,
  type X402Requirements,
} from "@straitsx/contracts";
import * as chainGateway from "./clients/chainGatewayClient.js";
import * as ledger from "./clients/ledgerClient.js";
import {
  CHECK_INDEX,
  CHECKS,
  HUMAN_EXPLANATIONS,
  check9_intent_match,
  precondition_intent_exists,
  type CheckContext,
} from "./checks/index.js";
import { sendError } from "./errors.js";
import { performSigning } from "./signing.js";

export type BuildAppOptions = {
  internalToken?: string | undefined;
  maxSaneValiditySeconds?: number | undefined;
  escalationTtlSeconds?: number | undefined;
  dashboardUrl?: string | undefined;
  logger?: boolean | undefined;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const internalToken = options.internalToken ?? process.env.INTERNAL_TOKEN ?? "dev-secret";
  // Ceiling for check 7 until Owner A hands over the measured 202->settlement latency (A16).
  const maxSaneValiditySeconds = options.maxSaneValiditySeconds ?? Number(process.env.MAX_SANE_VALIDITY_SECONDS ?? 300);
  const escalationTtlSeconds = options.escalationTtlSeconds ?? Number(process.env.ESCALATION_TTL_SECONDS ?? 300);
  const dashboardUrl = options.dashboardUrl ?? process.env.DASHBOARD_URL ?? "http://localhost:3000";

  const app = Fastify({ logger: options.logger ?? false });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (request.headers["x-internal-token"] !== internalToken) {
      sendError(reply, 401, "UNAUTHORIZED", "missing or invalid X-Internal-Token", "n/a");
    }
  });

  app.get("/health", async () => ({ ok: true }));

  const nowIso = () => new Date().toISOString();
  const nowSec = () => Math.floor(Date.now() / 1000);

  type PaymentRequestBody = {
    requestId?: string | undefined;
    mandateId?: string | undefined;
    requestedAmount?: string | undefined;
    challenge?: X402Requirements | undefined;
    resolvedItem?: ResolvedItem | undefined;
  };

  app.post("/payment/request", async (request, reply) => {
    const body = request.body as PaymentRequestBody;
    const { requestId, mandateId, requestedAmount, challenge, resolvedItem } = body;
    if (!requestId || !mandateId || !requestedAmount || !challenge) {
      return sendError(reply, 400, "INVALID_BODY", "requestId, mandateId, requestedAmount, challenge are required", requestId ?? "n/a");
    }

    async function refuseAndRecord(check: string, detail: string, statusCode = 422) {
      await ledger.recordDecision({ requestId: requestId!, decision: "refused", check, detail, decidedAt: nowIso() });
      return reply.code(statusCode).send({
        status: "refused",
        requestId,
        check,
        checkIndex: CHECK_INDEX[check] ?? null,
        detail,
        humanExplanation: HUMAN_EXPLANATIONS[check] ?? detail,
        decidedAt: nowIso(),
      });
    }

    async function escalateAndRespond(
      check: string,
      reason: "WINDOW_BUDGET_EXCEEDED" | "INTENT_MISMATCH",
      detail: string,
      merchantDomain?: string,
    ) {
      const approvalUrl = `${dashboardUrl}/approve/${requestId}`;
      const escalation = await ledger.createEscalation({
        requestId: requestId!,
        mandateId: mandateId!,
        reason,
        approvalUrl,
        ttlSeconds: escalationTtlSeconds,
        merchantDomain,
      });
      await ledger.recordDecision({ requestId: requestId!, decision: "escalated", check, detail, decidedAt: nowIso() });
      return reply.code(202).send({
        status: "escalated",
        requestId,
        reason,
        approvalUrl: escalation.approvalUrl,
        expiresAt: escalation.expiresAt,
        ttlSeconds: escalation.ttlSeconds,
        onTimeout: "DENY",
      });
    }

    // B11 — precondition, no on-chain or policy load needed.
    const intentRecord = await ledger.getIntent(requestId);
    const preconditionFailure = precondition_intent_exists(intentRecord);
    if (preconditionFailure) {
      return refuseAndRecord(preconditionFailure.check, preconditionFailure.detail);
    }

    // B10 — load policy + window usage; read registry.
    const policyRecord = await ledger.getPolicy(mandateId);
    if (!policyRecord) {
      return sendError(reply, 404, "POLICY_NOT_FOUND", `no policy on file for mandate ${mandateId}`, requestId);
    }
    const { policy: mandate } = policyRecord;

    const windowUsage = await ledger.getWindowUsage(mandateId, mandate.windowSeconds, mandate.maxPerWindow);
    const registry = await chainGateway.getMandate(mandateId, mandate.chainId);

    const ctx: CheckContext = {
      now: nowSec(),
      mandate,
      registry,
      challenge,
      requestedAmount,
      windowUsage,
      intentCreatedAt: intentRecord!.createdAt,
      challengeAttachedAt: intentRecord!.challengeAttachedAt ?? null,
      maxSaneValiditySeconds,
    };

    // B10 — checks 1-8, cheapest and most damning first, short-circuit on first failure.
    const checksPassed: string[] = [];
    for (const [name, fn] of CHECKS) {
      const failure = fn(ctx);
      if (!failure) {
        checksPassed.push(name);
        continue;
      }
      if (failure.outcome === "escalate") {
        return escalateAndRespond(failure.check, failure.reason as "WINDOW_BUDGET_EXCEEDED", failure.detail);
      }
      return refuseAndRecord(failure.check, failure.detail);
    }

    // B20 — the intent-match gate. Only runs when discovery data is present; Runs 1-3 don't
    // depend on Owner C having wired resolvedItem yet.
    if (resolvedItem) {
      const hasStandingApproval = await ledger.getStandingApproval(mandateId, resolvedItem.merchantDomain);
      const c9 = check9_intent_match({
        resolvedItem,
        intentConstraint: mandate.intentConstraint,
        merchantAllowlist: mandate.merchantAllowlist,
        hasStandingApproval,
      });
      if (c9) {
        return escalateAndRespond(c9.check, c9.reason, c9.detail, resolvedItem.merchantDomain);
      }
      checksPassed.push("check9_intent_match");
    }

    // Checks passed. Reserve the nonce and sign.
    const signing = await performSigning(requestId, mandateId, mandate, challenge, requestedAmount, ctx.now, CARDAPI_SANDBOX_ISSUE_CARD);
    if (!signing.ok) {
      await ledger.recordDecision({ requestId, decision: "refused", check: "signer_refused", detail: signing.message, decidedAt: nowIso() });
      return sendError(reply, signing.statusCode, signing.code, signing.message, requestId, signing.retryable);
    }

    await ledger.recordDecision({
      requestId,
      decision: "signed",
      decidedAt: nowIso(),
      policyHash: hashPolicy(mandate),
      validAfter: signing.validAfter,
      validBefore: signing.validBefore,
    });
    reply.code(200).send({
      status: "signed",
      requestId,
      header: signing.header,
      nonce: signing.nonce,
      validAfter: signing.validAfter,
      validBefore: signing.validBefore,
      checksPassed,
      decidedAt: nowIso(),
    });
  });

  // B21 — escalation lifecycle. `signature` (cryptographic proof of `approvedBy`) is accepted
  // but not yet verified — a known gap, see the summary. `standingApproval` is a deliberate
  // extension beyond api-contracts.md §6's documented request body (which only shows
  // decision/approvedBy/signature) to support "approve this merchant for this window".
  app.post("/escalation/:requestId/resolve", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const { decision, approvedBy, standingApproval } = request.body as {
      decision?: "approve" | "deny" | undefined;
      approvedBy?: string | undefined;
      signature?: string | undefined;
      standingApproval?: { scope: "once" | "merchant-window" } | undefined;
    };
    if (!decision) {
      return sendError(reply, 400, "INVALID_BODY", "decision is required", requestId);
    }

    const escalation = await ledger.getEscalation(requestId);
    if (!escalation) {
      return sendError(reply, 404, "ESCALATION_NOT_FOUND", `no escalation for ${requestId}`, requestId);
    }
    if (escalation.resolved) {
      return sendError(reply, 409, "ESCALATION_ALREADY_RESOLVED", `escalation ${requestId} was already resolved`, requestId);
    }

    // TTL auto-deny is non-negotiable — an unanswered escalation must never become a signature.
    if (nowSec() > escalation.expiresAt) {
      await ledger.resolveEscalationStorage(requestId, "deny");
      await ledger.recordDecision({
        requestId,
        decision: "refused",
        check: "escalation_expired",
        detail: `escalation TTL of ${escalation.ttlSeconds}s elapsed with no response; auto-denied`,
        decidedAt: nowIso(),
      });
      return sendError(reply, 410, "ESCALATION_EXPIRED", `escalation ${requestId} expired`, requestId);
    }

    if (decision === "deny") {
      await ledger.resolveEscalationStorage(requestId, "deny", approvedBy);
      await ledger.recordDecision({
        requestId,
        decision: "refused",
        check: "escalation_denied",
        detail: "human denied the escalated request",
        decidedAt: nowIso(),
      });
      return reply.code(200).send({ status: "refused", requestId, check: "escalation_denied", detail: "human denied the escalated request" });
    }

    const policyRecord = await ledger.getPolicy(escalation.mandateId);
    if (!policyRecord) {
      return sendError(reply, 404, "POLICY_NOT_FOUND", `no policy on file for mandate ${escalation.mandateId}`, requestId);
    }
    const { policy: mandate } = policyRecord;

    // Minimal authorization: approvedBy must claim to be the mandate owner. No cryptographic
    // signature verification against `signature` yet — a known gap, not a security guarantee.
    if (!approvedBy || approvedBy.toLowerCase() !== mandate.owner.toLowerCase()) {
      return sendError(reply, 403, "NOT_MANDATE_OWNER", "approvedBy does not match mandate.owner", requestId);
    }

    const intentRecord = await ledger.getIntent(requestId);
    if (!intentRecord?.challenge) {
      return sendError(reply, 404, "CHALLENGE_NOT_FOUND", `no challenge attached to intent ${requestId}`, requestId);
    }

    const signing = await performSigning(requestId, escalation.mandateId, mandate, intentRecord.challenge, intentRecord.challenge.amount, nowSec(), CARDAPI_SANDBOX_ISSUE_CARD);
    if (!signing.ok) {
      await ledger.resolveEscalationStorage(requestId, "deny", approvedBy);
      await ledger.recordDecision({ requestId, decision: "refused", check: "signer_refused", detail: signing.message, decidedAt: nowIso() });
      return sendError(reply, signing.statusCode, signing.code, signing.message, requestId, signing.retryable);
    }

    await ledger.resolveEscalationStorage(requestId, "approve", approvedBy);
    await ledger.recordDecision({
      requestId,
      decision: "signed",
      decidedAt: nowIso(),
      policyHash: hashPolicy(mandate),
      validAfter: signing.validAfter,
      validBefore: signing.validBefore,
    });

    if (standingApproval?.scope === "merchant-window" && escalation.reason === "INTENT_MISMATCH" && escalation.merchantDomain) {
      await ledger.setStandingApproval(escalation.mandateId, escalation.merchantDomain, nowSec() + mandate.windowSeconds);
    }

    reply.code(200).send({ status: "signed", header: signing.header, nonce: signing.nonce });
  });

  // B22 — GET/PUT /policy/:mandateId. Raw storage lives on ledger-service; this is the
  // hash-drift validation layer, kept out of ledger per the "no validation logic in
  // ledger-service" rule.
  app.get("/policy/:mandateId", async (request, reply) => {
    const { mandateId } = request.params as { mandateId: string };
    const policyRecord = await ledger.getPolicy(mandateId);
    if (!policyRecord) {
      return sendError(reply, 404, "POLICY_NOT_FOUND", `no policy on file for ${mandateId}`, mandateId);
    }
    const { policy, policyVersion } = policyRecord;
    const policyHash = hashPolicy(policy);
    const registry = await chainGateway.getMandate(mandateId, policy.chainId);
    const onChainHash = registry?.policyHash ?? null;
    const inSync = onChainHash !== null && onChainHash.toLowerCase() === policyHash.toLowerCase();
    reply.send({ mandateId, policy, policyHash, policyVersion, onChainHash, inSync });
  });

  app.put("/policy/:mandateId", async (request, reply) => {
    const { mandateId } = request.params as { mandateId: string };
    const { policy } = request.body as { policy?: Mandate };
    if (!policy) {
      return sendError(reply, 400, "INVALID_BODY", "policy is required", mandateId);
    }
    const proposedHash = hashPolicy(policy);
    const registry = await chainGateway.getMandate(mandateId, policy.chainId);
    const onChainHash = registry?.policyHash ?? null;
    if (onChainHash === null) {
      return sendError(reply, 404, "MANDATE_NOT_FOUND", `mandate ${mandateId} not found on-chain`, mandateId);
    }
    if (proposedHash.toLowerCase() !== onChainHash.toLowerCase()) {
      return reply.code(409).send({
        error: {
          code: "POLICY_HASH_DRIFT",
          message: "the proposed policy body no longer matches the on-chain policyHash",
          requestId: mandateId,
          retryable: false,
        },
        policyHash: proposedHash,
        onChainHash,
      });
    }
    const result = await ledger.putPolicy(mandateId, policy);
    reply.send({ mandateId, policyVersion: result.policyVersion, policyHash: proposedHash, onChainHash, inSync: true });
  });

  return app;
}
