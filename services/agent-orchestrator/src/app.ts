/**
 * agent-orchestrator — holds no key, makes no decisions (api-contracts.md §8).
 * Must not be able to reach signer-service; verified by
 * scripts/verify-signer-isolation.sh (C10), not by anything in this process —
 * a code check would only prove the port was reachable.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { registerErrorHandler, registerInternalAuth } from "@straitsx/contracts";
import { registerCheckoutRoutes } from "./routes/checkout";
import { registerHealthRoute } from "./routes/health";
import { registerRunRoutes } from "./routes/run";
import {
  dependencyReadinessFromEnvironment,
  type DependencyReadinessCheck,
} from "./dependency-readiness";

export type BuildAppOptions = {
  internalToken: string | undefined;
  logger?: boolean;
  dependencyReadiness?: DependencyReadinessCheck | undefined;
};

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    requestIdHeader: "x-request-id",
  });

  registerErrorHandler(app);
  registerInternalAuth(app, opts.internalToken);

  const dependencyReadiness = opts.dependencyReadiness ?? dependencyReadinessFromEnvironment(opts.internalToken);
  registerHealthRoute(app, dependencyReadiness);
  registerRunRoutes(app, dependencyReadiness);
  registerCheckoutRoutes(app);

  return app;
}
