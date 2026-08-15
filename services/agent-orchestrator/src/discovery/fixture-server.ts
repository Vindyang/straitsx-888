/**
 * C7 — serve the poisoned-page fixtures locally so the demo never depends on
 * the venue wifi. A tiny standalone Fastify app, run separately from the
 * orchestrator (`pnpm --filter @straitsx/agent-orchestrator fixtures`).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

const FIXTURE_FILES: Record<string, string> = {
  clean: "clean.html",
  "poisoned-recipient": "poisoned-recipient.html",
  "poisoned-amount": "poisoned-amount.html",
  "wrong-item": "wrong-item.html",
};

export function buildFixtureServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/fixtures/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const file = FIXTURE_FILES[name];
    if (!file) return reply.code(404).send("unknown fixture");
    const html = await readFile(path.join(FIXTURES_DIR, file), "utf8");
    return reply.type("text/html").send(html);
  });

  // Every fixture's [data-checkout-url] points here — one shared order
  // confirmation page is enough for the C9 spend-attestation capture.
  app.get("/checkout/xyz", async (_request, reply) => {
    reply.type("text/html").send(
      '<!doctype html><html><body><h1>Order confirmed</h1>' +
        '<p data-order-id="SO-99213">Order SO-99213</p></body></html>',
    );
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildFixtureServer();
  const port = Number(process.env["FIXTURE_PORT"] ?? 4010);
  await app.listen({ port, host: "0.0.0.0" });
  app.log.info(`fixtures serving on :${port}`);
}
