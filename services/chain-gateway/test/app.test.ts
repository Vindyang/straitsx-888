/**
 * HTTP-level contract tests: the error envelope, internal auth, and input
 * validation. These are the shapes Owner B and Owner C parse, so they are part
 * of the interface, not incidental.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

const TOKEN = "test-internal-token";
const MANDATE_ID = `0x${"7f3a".padStart(64, "0")}`;

function auth(extra: Record<string, string> = {}) {
  return { "x-internal-token": TOKEN, ...extra };
}

describe("chain-gateway app", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ internalToken: TOKEN });
  });

  describe("GET /health", () => {
    it("returns { ok: true }", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    /**
     * Health must answer WITHOUT the internal token. A15's isolation test
     * asserts the orchestrator's connection to the signer is REFUSED — if
     * /health returned 401 instead of connecting, a reachable port would look
     * like a blocked one and the security claim would be untested.
     */
    it("does not require the internal token", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("internal auth (§0)", () => {
    it("401s a request with no token", async () => {
      const res = await app.inject({ method: "GET", url: "/balance" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHORIZED");
    });

    it("401s a request with a wrong token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/balance",
        headers: { "x-internal-token": "wrong" },
      });
      expect(res.statusCode).toBe(401);
    });

    /** Fail closed: an unconfigured service must not become an open one. */
    it("401s everything when the service has no token configured", async () => {
      const openApp = buildApp({ internalToken: undefined });
      const res = await openApp.inject({
        method: "GET",
        url: "/balance",
        headers: { "x-internal-token": "anything" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("error envelope (§0)", () => {
    it("has code, message, requestId and retryable on every non-2xx", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/mandate/not-hex?chainId=43113",
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toHaveProperty("error.code");
      expect(body).toHaveProperty("error.message");
      expect(body).toHaveProperty("error.requestId");
      expect(typeof body.error.retryable).toBe("boolean");
    });

    it("echoes the caller's x-request-id as the idempotency key", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/mandate/not-hex?chainId=43113",
        headers: auth({ "x-request-id": "3f6c8b2e-echo-me" }),
      });
      expect(res.json().error.requestId).toBe("3f6c8b2e-echo-me");
    });

    it("404s an unknown route in the same envelope", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/nope",
        headers: auth(),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toHaveProperty("error.code");
    });
  });

  describe("chainId validation", () => {
    it("400s a missing chainId", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/mandate/${MANDATE_ID}`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("BAD_REQUEST");
    });

    it("400s UNSUPPORTED_CHAIN for a chain we do not serve", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/mandate/${MANDATE_ID}?chainId=1`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("UNSUPPORTED_CHAIN");
    });
  });

  describe("GET /mandate/:mandateId", () => {
    it("400s a mandateId that is not 32-byte hex", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/mandate/0x1234?chainId=43113",
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    });

    /**
     * The registry is not deployed yet, so registry.json holds null. A null must
     * make the caller REFUSE, never default to some address — the same rule as
     * `mainnet.settlementRecipient`.
     */
    it("refuses rather than defaulting when the registry address is null", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/mandate/${MANDATE_ID}?chainId=43113`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("CHAIN_NOT_CONFIGURED");
    });
  });

  describe("POST /settlement/confirm validation", () => {
    it("400s a txHash that is not 32-byte hex", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/settlement/confirm",
        headers: auth(),
        payload: {
          txHash: "0xdead",
          chainId: 43113,
          expect: { asset: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}`, amount: "5000000" },
        },
      });
      expect(res.statusCode).toBe(400);
    });

    /** Money is a base-unit decimal STRING, never a JSON number (§0). */
    it("400s a numeric amount", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/settlement/confirm",
        headers: auth(),
        payload: {
          txHash: `0x${"d".repeat(64)}`,
          chainId: 43113,
          expect: { asset: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}`, amount: 5000000 },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/base-unit decimal string/);
    });
  });

  describe("GET /balance validation", () => {
    it("400s a malformed address", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/balance?address=nope&chainId=43113",
        headers: auth(),
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
