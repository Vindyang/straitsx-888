import type { FastifyInstance } from "fastify";

/** A1: `GET /health` -> `{ "ok": true }`. Nothing more is contractually
 *  required of chain-gateway; the richer health shape is signer-only. */
export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => ({ ok: true }));
}
