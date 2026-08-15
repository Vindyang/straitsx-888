import type { FastifyInstance } from "fastify";
import { AppError, ErrorCode } from "@straitsx/contracts";
import { RUN_FIXTURES, startRun, type RunFixture } from "../run/pipeline";
import { getRun, listRuns, subscribe } from "../run/store";

type RunRequestBody = {
  instruction?: string;
  mandateId?: string;
  agentId?: string;
  fixture?: string;
  cardholderName?: string;
};

export function registerRunRoutes(app: FastifyInstance): void {
  // api-contracts.md §8 POST /run — returns 202 immediately; the pipeline (C5)
  // runs in the background and reports itself via streamUrl (C8).
  app.post("/run", async (request, reply) => {
    const { instruction, mandateId, agentId, fixture, cardholderName } = request.body as RunRequestBody;
    if (!instruction || !mandateId || !agentId || !fixture) {
      throw AppError.badRequest("instruction, mandateId, agentId, fixture are required");
    }
    if (!RUN_FIXTURES.includes(fixture as RunFixture)) {
      throw AppError.badRequest(`fixture must be one of ${RUN_FIXTURES.join(", ")}`);
    }
    const result = startRun({ instruction, mandateId, agentId, fixture: fixture as RunFixture, cardholderName });
    reply.code(202).send(result);
  });

  // Run list for the dashboard (api-contracts.md §9 GET /api/runs proxies this).
  app.get("/runs", async (_request, reply) => {
    reply.send(listRuns());
  });

  // Single run detail, outcome included — this is what backs the C12 refusal
  // panel: `check`/`detail`/`humanExplanation` only ever arrive on
  // policy-service's direct response, captured into the run record by the
  // pipeline (run/pipeline.ts) the moment it receives them.
  app.get("/run/:requestId", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const run = getRun(requestId);
    if (!run) {
      throw AppError.notFound(ErrorCode.RUN_NOT_FOUND, `no run for ${requestId}`);
    }
    const { subscribers: _subscribers, ...record } = run;
    reply.send(record);
  });

  // C8 — SSE run events. Replays everything emitted so far, then streams live
  // updates until the run reaches a terminal state.
  app.get("/run/:requestId/events", async (request, reply) => {
    const { requestId } = request.params as { requestId: string };
    const run = getRun(requestId);
    if (!run) {
      throw AppError.notFound(ErrorCode.RUN_NOT_FOUND, `no run for ${requestId}`);
    }

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    for (const event of run.events) {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    if (run.state !== "RUNNING") {
      reply.raw.end();
      return;
    }

    const unsubscribe = subscribe(requestId, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      if (getRun(requestId)?.state !== "RUNNING") {
        reply.raw.end();
      }
    });
    request.raw.on("close", unsubscribe);
  });
}
