import type { FastifyInstance } from "fastify";
import { AppError, ErrorCode } from "@straitsx/contracts";
import { MERCHANT_PROFILES } from "../checkout/merchant-profiles";
import type { DependencyReadinessCheck } from "../dependency-readiness";
import { RUN_FIXTURES, resolveRunEscalation, startRun, type RunFixture, type RunSource } from "../run/pipeline";
import { getRun, isTerminalRunState, listRuns, subscribe } from "../run/store";

type RunRequestBody = { instruction?: string; mandateId?: string; agentId?: string; fixture?: string; source?: { kind?: string; name?: string; profileId?: string }; cardholderName?: string };

function parseSource(body: RunRequestBody): RunSource {
  if (!body.source && body.fixture) return { kind: "fixture", name: body.fixture as RunFixture };
  if (body.source?.kind === "fixture" && body.source.name) return { kind: "fixture", name: body.source.name as RunFixture };
  if (body.source?.kind === "merchant" && body.source.profileId) return { kind: "merchant", profileId: body.source.profileId };
  throw AppError.badRequest("source must be {kind:'fixture',name} or {kind:'merchant',profileId}; fixture remains supported during migration");
}

export function registerRunRoutes(app: FastifyInstance, checkReadiness: DependencyReadinessCheck): void {
  app.post("/run", async (request, reply) => {
    const body = request.body as RunRequestBody;
    if (!body.instruction || !body.mandateId || !body.agentId) throw AppError.badRequest("instruction, mandateId and agentId are required");
    const source = parseSource(body);
    if (source.kind === "fixture" && !RUN_FIXTURES.includes(source.name)) throw AppError.badRequest(`fixture must be one of ${RUN_FIXTURES.join(", ")}`);
    if (source.kind === "merchant" && !MERCHANT_PROFILES[source.profileId]) throw AppError.badRequest("unknown merchant profileId");
    let dependenciesReady = false;
    try {
      dependenciesReady = (await checkReadiness()).ready;
    } catch {
      dependenciesReady = false;
    }
    if (!dependenciesReady) {
      throw new AppError(
        503,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        "payment dependencies are not ready",
        true,
      );
    }
    reply.code(202).send(startRun({ instruction: body.instruction, mandateId: body.mandateId, agentId: body.agentId, source, ...(body.cardholderName ? { cardholderName: body.cardholderName } : {}) }));
  });

  app.post("/run/:requestId/escalation", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const body = request.body as { decision?: "approve" | "deny"; approvedBy?: string; signature?: string; standingApproval?: { scope: "once" | "merchant-window" } };
    if (!getRun(requestId)) throw AppError.notFound(ErrorCode.RUN_NOT_FOUND, `no run for ${requestId}`);
    if (body.decision !== "approve" && body.decision !== "deny") throw AppError.badRequest("decision must be approve or deny");
    if (!body.signature || !body.approvedBy) throw AppError.badRequest("approvedBy and signature are required");
    reply.send(await resolveRunEscalation(requestId, { ...body, decision: body.decision }));
  });

  app.get("/runs", async (_request, reply) => reply.send(listRuns()));
  app.get("/run/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const run = getRun(requestId);
    if (!run) throw AppError.notFound(ErrorCode.RUN_NOT_FOUND, `no run for ${requestId}`);
    const { subscribers: _subscribers, ...record } = run;
    reply.send(record);
  });
  app.get("/run/:requestId/events", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const run = getRun(requestId);
    if (!run) throw AppError.notFound(ErrorCode.RUN_NOT_FOUND, `no run for ${requestId}`);
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const event of run.events) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    if (isTerminalRunState(run.state)) return void reply.raw.end();
    const unsubscribe = subscribe(requestId, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      const state = getRun(requestId)?.state;
      if (state && isTerminalRunState(state)) reply.raw.end();
    });
    request.raw.on("close", unsubscribe);
  });
}
