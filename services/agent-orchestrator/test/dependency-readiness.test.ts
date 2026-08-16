import { describe, expect, it, vi } from "vitest";
import { createDependencyReadinessCheck } from "../src/dependency-readiness";

const URLS = {
  ledgerUrl: "http://ledger.internal:4001",
  policyUrl: "http://policy.internal:4002",
  chainGatewayUrl: "http://chain.internal:4004",
};

describe("dependency readiness", () => {
  it("is ready only when every dependency health endpoint succeeds", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ ok: true }));
    const check = createDependencyReadinessCheck({
      ...URLS,
      internalToken: "secret",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(check()).resolves.toEqual({
      ready: true,
      dependencies: { ledger: "ready", policy: "ready", chainGateway: "ready" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/\/health$/);
      expect(init?.headers).toEqual({ "x-internal-token": "secret" });
    }
  });

  it("redacts transport details and reports unavailable when one dependency fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("policy.internal")) throw new Error("getaddrinfo ENOTFOUND policy.internal");
      return Response.json({ ok: true });
    });
    const check = createDependencyReadinessCheck({ ...URLS, fetchImpl: fetchMock as unknown as typeof fetch });

    const result = await check();
    expect(result).toEqual({
      ready: false,
      dependencies: { ledger: "ready", policy: "unavailable", chainGateway: "ready" },
    });
    expect(JSON.stringify(result)).not.toContain("ENOTFOUND");
    expect(JSON.stringify(result)).not.toContain("policy.internal");
  });

  it("rejects a 200 response that does not satisfy the health contract", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input).includes("ledger.internal") ? Response.json({ status: "up" }) : Response.json({ ok: true }));
    const check = createDependencyReadinessCheck({ ...URLS, fetchImpl: fetchMock as unknown as typeof fetch });

    await expect(check()).resolves.toEqual({
      ready: false,
      dependencies: { ledger: "unavailable", policy: "ready", chainGateway: "ready" },
    });
  });
});
