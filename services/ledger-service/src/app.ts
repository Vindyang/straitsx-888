import Fastify, { type FastifyInstance } from "fastify";
import type { Mandate, X402Requirements } from "@straitsx/contracts";
import { sendError } from "./errors.js";
import {
  decisionLog,
  escalations,
  instructionHashOf,
  intents,
  intentViewOf,
  ledgerEvents,
  nextLedgerEventSeq,
  policies,
  standingApprovals,
  type EscalationReason,
  type IntentRecord,
  type LedgerEventKind,
} from "./store.js";

function appendEvent(kind: LedgerEventKind, payload: Record<string, unknown> = {}): void {
  const at = new Date().toISOString();
  ledgerEvents.emit("append", { seq: nextLedgerEventSeq(), kind, at, ...payload });
}

export function buildApp(
  internalToken = process.env.INTERNAL_TOKEN ?? "dev-secret",
  options: { logger?: boolean } = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") return;
    if (request.headers["x-internal-token"] !== internalToken) {
      sendError(reply, 401, "UNAUTHORIZED", "missing or invalid X-Internal-Token", "n/a");
    }
  });

  app.get("/health", async () => ({ ok: true }));

  // B3 — append-only intent creation
  app.post("/intent", async (request, reply) => {
    const body = request.body as Partial<
      Pick<IntentRecord, "requestId" | "mandateId" | "agentId" | "instruction" | "createdAt">
    >;
    const { requestId, mandateId, agentId, instruction, createdAt } = body;
    if (!requestId || !mandateId || !agentId || !instruction || !createdAt) {
      return sendError(reply, 400, "INVALID_BODY", "requestId, mandateId, agentId, instruction, createdAt are required", requestId ?? "n/a");
    }
    // Existence check and write happen with no `await` between them, so the Map mutation is
    // atomic under Node's single-threaded event loop — this is what makes it a real
    // conditional write rather than read-then-write, without needing a database yet.
    if (intents.has(requestId)) {
      return sendError(reply, 409, "INTENT_EXISTS", `intent ${requestId} already exists`, requestId, false);
    }
    const instructionHash = instructionHashOf(instruction);
    intents.set(requestId, {
      requestId,
      mandateId,
      agentId,
      instruction,
      instructionHash,
      createdAt,
      state: "INTENT_CREATED",
    });
    appendEvent("intent.created", { requestId, mandateId, agentId, state: "INTENT_CREATED", intent: intentViewOf(intents.get(requestId)!) });
    reply.code(201).send({ requestId, state: "INTENT_CREATED", instructionHash, immutable: true });
  });

  app.get("/intent/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    reply.send(intent);
  });

  // Transparency: full append-only ledger, newest first, view-shaped.
  app.get("/intents", async (_request, reply) => {
    const views = [...intents.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(intentViewOf);
    reply.send({ intents: views });
  });

  // Transparency: live append-only feed. Every mutation emits an "append" event;
  // a fresh "snapshot" of the whole ledger is sent first so clients can rebuild state.
  app.get("/ledger/events", async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("snapshot", { intents: [...intents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(intentViewOf) });
    const onAppend = (event: unknown): void => send("append", event);
    ledgerEvents.on("append", onAppend);
    const heartbeat = setInterval(() => reply.raw.write(": hb\n\n"), 15_000);
    reply.raw.on("close", () => {
      ledgerEvents.off("append", onAppend);
      clearInterval(heartbeat);
    });
  });

  // B4 — a challenge may only attach to an intent that already exists (makes check 8 enforceable)
  app.post("/intent/:requestId/challenge", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const { challenge } = request.body as { challenge?: X402Requirements };
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    if (!challenge) {
      return sendError(reply, 400, "INVALID_BODY", "challenge is required", requestId);
    }
    if (intent.challenge) {
      return sendError(reply, 409, "CHALLENGE_EXISTS", `challenge already attached to ${requestId}`, requestId);
    }
    const attachedAt = new Date().toISOString();
    intent.challenge = challenge;
    intent.challengeAttachedAt = attachedAt;
    intent.state = "CHALLENGE_ATTACHED";
    appendEvent("challenge.attached", { requestId, mandateId: intent.mandateId, state: "CHALLENGE_ATTACHED", intent: intentViewOf(intent) });
    reply.send({ requestId, state: "CHALLENGE_ATTACHED", attachedAt });
  });

  // B5 — the replay boundary. Real conditional write: no await between the check and the set.
  app.post("/intent/:requestId/nonce", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const { nonce } = request.body as { nonce?: string };
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    if (!nonce) {
      return sendError(reply, 400, "INVALID_BODY", "nonce is required", requestId);
    }
    if (intent.nonce && !intent.nonceReleased) {
      return sendError(reply, 409, "NONCE_ALREADY_RESERVED", `a nonce is already reserved for ${requestId}`, requestId);
    }
    const reservedAt = new Date().toISOString();
    intent.nonce = nonce;
    intent.nonceReservedAt = reservedAt;
    intent.nonceReleased = false;
    intent.state = "NONCE_RESERVED";
    appendEvent("nonce.reserved", { requestId, mandateId: intent.mandateId, state: "NONCE_RESERVED", intent: intentViewOf(intent) });
    reply.send({ requestId, nonce, reserved: true, reservedAt });
  });

  // B6 — only legal before a signature exists.
  app.post("/intent/:requestId/release-nonce", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    if (intent.decision === "signed") {
      return sendError(reply, 409, "NONCE_BURNED", `intent ${requestId} is already signed; the nonce is terminal`, requestId);
    }
    if (!intent.nonce || intent.nonceReleased) {
      return sendError(reply, 400, "NONCE_NOT_RESERVED", `no reserved nonce to release for ${requestId}`, requestId);
    }
    intent.nonceReleased = true;
    intent.nonce = undefined;
    intent.nonceReservedAt = undefined;
    intent.state = "CHALLENGE_ATTACHED";
    appendEvent("nonce.released", { requestId, mandateId: intent.mandateId, state: "CHALLENGE_ATTACHED", intent: intentViewOf(intent) });
    reply.send({ requestId, released: true });
  });

  // B7 — rolling window. maxPerWindow is policy-owned, so it's an optional query param here;
  // without it `remaining` is omitted rather than guessed.
  app.get("/window/:mandateId", async (request, reply) => {
    const { mandateId } = request.params as { mandateId: string };
    const query = request.query as { windowSeconds?: string; maxPerWindow?: string };
    const windowSeconds = Number(query.windowSeconds ?? 86400);
    const windowStartedAtMs = Date.now() - windowSeconds * 1000;

    let spent = 0n;
    let cardCount = 0;
    for (const intent of intents.values()) {
      if (intent.mandateId !== mandateId) continue;
      if (intent.decision !== "signed" || !intent.decidedAt || !intent.challenge) continue;
      if (Date.parse(intent.decidedAt) < windowStartedAtMs) continue;
      spent += BigInt(intent.challenge.amount);
      cardCount += 1;
    }

    const response: Record<string, unknown> = {
      mandateId,
      windowSeconds,
      windowStartedAt: new Date(windowStartedAtMs).toISOString(),
      spent: spent.toString(),
      cardCount,
    };
    if (query.maxPerWindow) {
      const remaining = BigInt(query.maxPerWindow) - spent;
      response.remaining = (remaining > 0n ? remaining : 0n).toString();
    }
    reply.send(response);
  });

  // Raw policy storage backing B22's GET/PUT /policy/:mandateId on policy-service. Nothing else
  // touches storage directly, so hash-drift validation happens on the policy-service side of
  // this — this route just persists whatever body it's given.
  app.get("/policy/:mandateId", async (request, reply) => {
    const { mandateId } = request.params as { mandateId: string };
    const record = policies.get(mandateId);
    if (!record) {
      return sendError(reply, 404, "POLICY_NOT_FOUND", `no policy on file for ${mandateId}`, mandateId);
    }
    reply.send(record);
  });

  app.put("/policy/:mandateId", async (request, reply) => {
    const { mandateId } = request.params as { mandateId: string };
    const { policy } = request.body as { policy?: Mandate };
    if (!policy) {
      return sendError(reply, 400, "INVALID_BODY", "policy is required", mandateId);
    }
    const existing = policies.get(mandateId);
    const policyVersion = (existing?.policyVersion ?? 0) + 1;
    policies.set(mandateId, { policy, policyVersion });
    appendEvent("policy.put", { mandateId, policyVersion: Number(policyVersion) });
    reply.send({ mandateId, policyVersion });
  });

  // B21 — pending escalation storage. TTL enforcement and re-running the sign tail on approval
  // live on policy-service; this is raw persistence only.
  app.post("/escalation", async (request, reply) => {
    const body = request.body as Partial<{
      requestId: string;
      mandateId: string;
      reason: EscalationReason;
      approvalUrl: string;
      ttlSeconds: number;
      merchantDomain: string;
    }>;
    const { requestId, mandateId, reason, approvalUrl, ttlSeconds, merchantDomain } = body;
    if (!requestId || !mandateId || !reason || !approvalUrl || !ttlSeconds) {
      return sendError(reply, 400, "INVALID_BODY", "requestId, mandateId, reason, approvalUrl, ttlSeconds are required", requestId ?? "n/a");
    }
    const existing = escalations.get(requestId);
    if (existing) {
      return reply.code(200).send(existing);
    }
    const createdAt = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const record = { requestId, mandateId, reason, approvalUrl, createdAt, expiresAt, ttlSeconds, resolved: false, merchantDomain };
    escalations.set(requestId, record);
    appendEvent("escalation.created", { requestId, mandateId, reason, expiresAt, detail: { approvalUrl, ttlSeconds } });
    reply.code(201).send(record);
  });

  app.get("/escalation/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const record = escalations.get(requestId);
    if (!record) {
      return sendError(reply, 404, "ESCALATION_NOT_FOUND", `no escalation for ${requestId}`, requestId);
    }
    reply.send(record);
  });

  app.put("/escalation/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const record = escalations.get(requestId);
    if (!record) {
      return sendError(reply, 404, "ESCALATION_NOT_FOUND", `no escalation for ${requestId}`, requestId);
    }
    const { decision, approvedBy } = request.body as { decision?: "approve" | "deny"; approvedBy?: string };
    if (!decision) {
      return sendError(reply, 400, "INVALID_BODY", "decision is required", requestId);
    }
    record.resolved = true;
    record.decision = decision;
    record.approvedBy = approvedBy;
    record.resolvedAt = new Date().toISOString();
    appendEvent("escalation.resolved", { requestId, mandateId: record.mandateId, decision, resolvedAt: record.resolvedAt });
    reply.send(record);
  });

  // Standing pre-approvals (B21): "approve this merchant for this window" — a future check 9
  // for the same mandate + merchant domain, within `expiresAt`, is a match without escalating.
  app.post("/standing-approval", async (request, reply) => {
    const { mandateId, merchantDomain, expiresAt } = request.body as {
      mandateId?: string;
      merchantDomain?: string;
      expiresAt?: number;
    };
    if (!mandateId || !merchantDomain || !expiresAt) {
      return sendError(reply, 400, "INVALID_BODY", "mandateId, merchantDomain, expiresAt are required", mandateId ?? "n/a");
    }
    standingApprovals.set(`${mandateId}::${merchantDomain.toLowerCase()}`, expiresAt);
    appendEvent("standing_approval.set", { mandateId, merchantDomain, expiresAt });
    reply.send({ mandateId, merchantDomain, expiresAt });
  });

  app.get("/standing-approval", async (request, reply) => {
    const { mandateId, merchantDomain } = request.query as { mandateId?: string; merchantDomain?: string };
    if (!mandateId || !merchantDomain) {
      return sendError(reply, 400, "INVALID_BODY", "mandateId and merchantDomain query params are required", "n/a");
    }
    const expiresAt = standingApprovals.get(`${mandateId}::${merchantDomain.toLowerCase()}`);
    const active = expiresAt !== undefined && expiresAt > Math.floor(Date.now() / 1000);
    reply.send({ active, expiresAt: expiresAt ?? null });
  });

  // B8 — every outcome is recorded, refusals included.
  app.post("/decision", async (request, reply) => {
    const body = request.body as {
      requestId?: string;
      decision?: "signed" | "refused" | "escalated";
      check?: string;
      detail?: string;
      decidedAt?: string;
      // Only meaningful (and only ever sent) alongside decision:"signed" — see IntentRecord.
      policyHash?: string;
      merchantDomain?: string;
      validAfter?: number;
      validBefore?: number;
    };
    const { requestId, decision, check, detail, decidedAt, policyHash, merchantDomain, validAfter, validBefore } = body;
    if (!requestId || !decision || !decidedAt) {
      return sendError(reply, 400, "INVALID_BODY", "requestId, decision, decidedAt are required", requestId ?? "n/a");
    }
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    const sequence = decisionLog.length + 1;
    decisionLog.push({ sequence, requestId, decision, check, detail, decidedAt });
    intent.decision = decision;
    intent.decidedAt = decidedAt;
    if (decision === "signed") {
      intent.state = "SIGNED";
      intent.policyHash = policyHash;
      intent.merchantDomain = merchantDomain;
      intent.validAfter = validAfter;
      intent.validBefore = validBefore;
    }
    appendEvent("decision.recorded", { requestId, mandateId: intent.mandateId, decision, check, detail, state: intent.state, intent: intentViewOf(intent) });
    reply.send({ recorded: true, sequence });
  });

  // B9 — settlement, spend (stretch), receipt
  app.post("/intent/:requestId/settlement", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const { settlementTx, blockNumber, cardOpaqueId, rawToolResultHash } = request.body as {
      settlementTx?: string;
      blockNumber?: number;
      cardOpaqueId?: string;
      rawToolResultHash?: string;
    };
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    if (!settlementTx || blockNumber === undefined || !cardOpaqueId) {
      return sendError(reply, 400, "INVALID_BODY", "settlementTx, blockNumber, cardOpaqueId are required", requestId);
    }
    // `rawToolResultHash` is a hash of the MCP tool result, NOT the result
    // itself. The body carries a live prompt injection (execution_plan.md
    // §19.6) and card-gateway drops every free-text key before forwarding, so
    // the receipt records that a specific tool result was seen without ever
    // storing its text. Optional: the field is a migration, and settlements
    // recorded before card-gateway supplied it stay valid.
    if (rawToolResultHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(rawToolResultHash)) {
      return sendError(reply, 400, "INVALID_BODY", "rawToolResultHash must be a 32-byte 0x hex hash when present", requestId);
    }
    intent.settlement = { settlementTx, blockNumber, cardOpaqueId, rawToolResultHash };
    intent.state = "SETTLED";
    appendEvent("settlement.recorded", { requestId, mandateId: intent.mandateId, state: "SETTLED", settlementTx, blockNumber, intent: intentViewOf(intent) });
    reply.send({ requestId, state: "SETTLED", settlementTx });
  });

  // B9b — capture-time settlement finalization (seamless issuer settlement). The
  // merchant captures the card payment at checkout; the orchestrator then verifies
  // the on-chain transfer independently and only after that records the capture.
  app.post("/intent/:requestId/capture", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const { orderId, capturedAt, settlementTx, blockNumber } = request.body as {
      orderId?: string;
      capturedAt?: string;
      settlementTx?: string;
      blockNumber?: number;
    };
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    if (!orderId || !capturedAt) {
      return sendError(reply, 400, "INVALID_BODY", "orderId, capturedAt are required", requestId);
    }
    if (intent.capture) {
      return sendError(reply, 409, "CAPTURE_EXISTS", `capture already recorded for ${requestId}`, requestId);
    }
    if (!intent.settlement) {
      return sendError(reply, 409, "SETTLEMENT_NOT_RECORDED", `settlement must precede capture for ${requestId}`, requestId);
    }
    if (settlementTx && intent.settlement.settlementTx !== settlementTx) {
      return sendError(reply, 409, "SETTLEMENT_MISMATCH", "capture settlementTx does not match the recorded settlement", requestId);
    }
    intent.capture = {
      orderId,
      capturedAt,
      settlementTx: intent.settlement.settlementTx,
      blockNumber: blockNumber ?? intent.settlement.blockNumber,
    };
    intent.state = "CAPTURED";
    appendEvent("capture.recorded", { requestId, mandateId: intent.mandateId, state: "CAPTURED", orderId, settlementTx: intent.settlement.settlementTx, intent: intentViewOf(intent) });
    reply.send({ requestId, state: "CAPTURED", orderId, settlementTx: intent.settlement.settlementTx });
  });

  app.post("/intent/:requestId/spend", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const { merchantDomain, orderTotal, itemSku, orderId, observedAt } = request.body as {
      merchantDomain?: string;
      orderTotal?: string;
      itemSku?: string;
      orderId?: string;
      observedAt?: string;
    };
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    if (!merchantDomain || !orderTotal || !itemSku || !orderId || !observedAt) {
      return sendError(reply, 400, "INVALID_BODY", "merchantDomain, orderTotal, itemSku, orderId, observedAt are required", requestId);
    }
    intent.spend = { merchantDomain, orderTotal, itemSku, orderId, observedAt };
    // proof is always "none" until a merchant-signed attestation exists — never label an
    // observation as proof.
    appendEvent("spend.recorded", { requestId, mandateId: intent.mandateId, orderId, orderTotal, merchantDomain, intent: intentViewOf(intent) });
    reply.send({ recorded: true, spendLeg: { status: "observed", proof: "none" } });
  });

  app.get("/receipt/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const intent = intents.get(requestId);
    if (!intent) {
      return sendError(reply, 404, "INTENT_NOT_FOUND", `no intent for ${requestId}`, requestId);
    }
    reply.send({
      requestId: intent.requestId,
      mandateId: intent.mandateId,
      policyHash: intent.policyHash ?? null,
      intent: intent.instruction,
      intentHash: intent.instructionHash,
      merchantDomain: intent.merchantDomain ?? null,
      challenge: intent.challenge
        ? {
            payTo: intent.challenge.payTo,
            asset: intent.challenge.asset,
            chainId: intent.challenge.chainId,
            amount: intent.challenge.amount,
          }
        : null,
      authorization: intent.nonce
        ? { validAfter: intent.validAfter ?? null, validBefore: intent.validBefore ?? null, nonce: intent.nonce }
        : null,
      settlementTx: intent.settlement?.settlementTx ?? null,
      blockNumber: intent.settlement?.blockNumber ?? null,
      cardOpaqueId: intent.settlement?.cardOpaqueId ?? null,
      // The evidence that a specific MCP tool result produced this purchase,
      // without carrying the injected text into anything that reads receipts.
      rawToolResultHash: intent.settlement?.rawToolResultHash ?? null,
      decision: intent.decision ?? null,
      decidedAt: intent.decidedAt ?? null,
      spendLeg: intent.spend
        ? { status: "observed", merchantDomain: intent.spend.merchantDomain, orderTotal: intent.spend.orderTotal, proof: "none" }
        : { status: "absent", proof: "none" },
    });
  });

  return app;
}
