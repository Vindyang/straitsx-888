/**
 * chain-gateway — A1 stub shape, real routes filled in Phase 2 (A6–A10).
 *
 * The ONLY component that opens an RPC connection. No policy logic. No signing.
 */

import Fastify, { type FastifyInstance } from "fastify";
import {
  registerErrorHandler,
  registerInternalAuth,
} from "@straitsx/contracts";
import { registerHealthRoute } from "./routes/health";
import { registerTokenConstantsRoute } from "./routes/token-constants";
import { registerMandateRoute } from "./routes/mandate";
import { registerSettlementRoute } from "./routes/settlement";
import { registerBalanceRoute } from "./routes/balance";
import { registerBuildRevokeRoute } from "./routes/build-revoke";

export type BuildAppOptions = {
  internalToken: string | undefined;
  logger?: boolean;
};

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    // requestId is the idempotency key across every service (§0).
    requestIdHeader: "x-request-id",
  });

  registerErrorHandler(app);
  registerInternalAuth(app, opts.internalToken);

  registerHealthRoute(app);
  registerTokenConstantsRoute(app);
  registerMandateRoute(app);
  registerSettlementRoute(app);
  registerBalanceRoute(app);
  registerBuildRevokeRoute(app);

  return app;
}
