/**
 * HTTP-level contract tests: error envelope, internal auth, input validation.
 * The full C5 pipeline needs live MCP/policy/ledger/chain-gateway services and
 * a real browser for Playwright discovery, so it is exercised manually via
 * C16's rehearsed runs, not here — this file stays offline so CI is green
 * without that stack running.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

const TOKEN = "test-internal-token";

function auth(extra: Record<string, string> = {}) {
  return { "x-internal-token": TOKEN, ...extra };
}

describe("agent-orchestrator app", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ internalToken: TOKEN });
  });

  describe("GET /health", () => {
    it("returns { ok: true } without the internal token", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });
  });

  describe("internal auth (§0)", () => {
    it("401s POST /run with no token", async () => {
      const res = await app.inject({ method: "POST", url: "/run", payload: {} });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });
  });

  describe("POST /run validation", () => {
    it("400s a missing field", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/run",
        headers: auth(),
        payload: { instruction: "buy a bottle", mandateId: "0x7f3a" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("BAD_REQUEST");
    });

    it("400s an unknown fixture name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/run",
        headers: auth(),
        payload: { instruction: "buy a bottle", mandateId: "0x7f3a", agentId: "shopper-1", fixture: "nope" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /run/:requestId/events", () => {
    it("404s an unknown run", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/run/does-not-exist/events",
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("RUN_NOT_FOUND");
    });
  });

  describe("GET /runs and GET /run/:requestId (dashboard backing, C11-C12)", () => {
    it("lists a just-started run with its meta, before the pipeline needs live services", async () => {
      const started = await app.inject({
        method: "POST",
        url: "/run",
        headers: auth(),
        payload: { instruction: "buy a bottle", mandateId: "0x7f3a", agentId: "shopper-1", fixture: "clean" },
      });
      expect(started.statusCode).toBe(202);
      const { requestId } = started.json() as { requestId: string };

      const list = await app.inject({ method: "GET", url: "/runs", headers: auth() });
      expect(list.statusCode).toBe(200);
      const runs = list.json() as Array<{ requestId: string; meta: { fixture: string } }>;
      expect(runs.some((r) => r.requestId === requestId && r.meta.fixture === "clean")).toBe(true);

      const detail = await app.inject({ method: "GET", url: `/run/${requestId}`, headers: auth() });
      expect(detail.statusCode).toBe(200);
      const record = detail.json() as { requestId: string; meta: { mandateId: string }; state: string };
      expect(record.requestId).toBe(requestId);
      expect(record.meta.mandateId).toBe("0x7f3a");
      expect(["RUNNING", "FAILED"]).toContain(record.state);
    });

    it("404s GET /run/:requestId for an unknown run", async () => {
      const res = await app.inject({ method: "GET", url: "/run/does-not-exist", headers: auth() });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("RUN_NOT_FOUND");
    });
  });

  describe("POST /checkout/assert validation", () => {
    it("400s a missing currentUrl", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/checkout/assert",
        headers: auth(),
        payload: { requestId: "abc" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("404s a run with no discovered item yet", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/checkout/assert",
        headers: auth(),
        payload: { requestId: "does-not-exist", currentUrl: "https://shop.example/checkout/xyz" },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
