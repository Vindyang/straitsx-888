import type { FastifyInstance } from "fastify";
import {
  unavailableReadiness,
  type DependencyReadinessCheck,
} from "../dependency-readiness";

export function registerHealthRoute(app: FastifyInstance, checkReadiness: DependencyReadinessCheck): void {
  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async (_request, reply) => {
    try {
      const readiness = await checkReadiness();
      return reply.code(readiness.ready ? 200 : 503).send(readiness);
    } catch {
      return reply.code(503).send(unavailableReadiness());
    }
  });
}
