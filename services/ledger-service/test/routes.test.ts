import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { resetStore } from "../src/store.js";

const TOKEN = "dev-secret";
const app = buildApp(TOKEN);

function auth() {
  return { "x-internal-token": TOKEN, "content-type": "application/json" };
}

const baseIntent = {
  requestId: "r1",
  mandateId: "m1",
  agentId: "shopper-1",
  instruction: "buy bottle",
  createdAt: "2026-08-15T06:00:00Z",
};

const challenge = {
  x402Version: 1,
  scheme: "exact",
  network: "eip155:43113",
  chainId: 43113,
  amount: "5000000",
  asset: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  payTo: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "XSGD", version: "2" },
};

beforeEach(() => {
  resetStore();
});

describe("auth", () => {
  it("rejects requests without X-Internal-Token", async () => {
    const res = await app.inject({ method: "POST", url: "/intent", payload: baseIntent });
    expect(res.statusCode).toBe(401);
  });

  it("/health needs no token", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /intent", () => {
  it("creates an intent", async () => {
    const res = await app.inject({ method: "POST", url: "/intent", headers: auth(), payload: baseIntent });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ requestId: "r1", state: "INTENT_CREATED", immutable: true });
  });

  it("is append-only: a duplicate requestId returns 409 INTENT_EXISTS", async () => {
    await app.inject({ method: "POST", url: "/intent", headers: auth(), payload: baseIntent });
    const res = await app.inject({ method: "POST", url: "/intent", headers: auth(), payload: baseIntent });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("INTENT_EXISTS");
  });
});

describe("nonce lifecycle", () => {
  beforeEach(async () => {
    await app.inject({ method: "POST", url: "/intent", headers: auth(), payload: baseIntent });
    await app.inject({ method: "POST", url: "/intent/r1/challenge", headers: auth(), payload: { challenge } });
  });

  it("reserves a nonce and rejects a second reservation (replay boundary)", async () => {
    const first = await app.inject({ method: "POST", url: "/intent/r1/nonce", headers: auth(), payload: { nonce: "0xaaa" } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: "/intent/r1/nonce", headers: auth(), payload: { nonce: "0xbbb" } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("NONCE_ALREADY_RESERVED");
  });

  it("allows release before signing, then a fresh reservation succeeds (case 11)", async () => {
    await app.inject({ method: "POST", url: "/intent/r1/nonce", headers: auth(), payload: { nonce: "0xaaa" } });
    const released = await app.inject({ method: "POST", url: "/intent/r1/release-nonce", headers: auth(), payload: { reason: "test" } });
    expect(released.statusCode).toBe(200);
    const retried = await app.inject({ method: "POST", url: "/intent/r1/nonce", headers: auth(), payload: { nonce: "0xccc" } });
    expect(retried.statusCode).toBe(200);
  });

  it("refuses release after a signature exists (case 12, NONCE_BURNED)", async () => {
    await app.inject({ method: "POST", url: "/intent/r1/nonce", headers: auth(), payload: { nonce: "0xaaa" } });
    await app.inject({
      method: "POST",
      url: "/decision",
      headers: auth(),
      payload: { requestId: "r1", decision: "signed", decidedAt: "2026-08-15T06:01:50Z" },
    });
    const released = await app.inject({ method: "POST", url: "/intent/r1/release-nonce", headers: auth(), payload: { reason: "test" } });
    expect(released.statusCode).toBe(409);
    expect(released.json().error.code).toBe("NONCE_BURNED");
  });
});

describe("GET /window/:mandateId", () => {
  it("counts only signed intents within the window and excludes released nonces", async () => {
    await app.inject({ method: "POST", url: "/intent", headers: auth(), payload: baseIntent });
    await app.inject({ method: "POST", url: "/intent/r1/challenge", headers: auth(), payload: { challenge } });
    await app.inject({ method: "POST", url: "/intent/r1/nonce", headers: auth(), payload: { nonce: "0xaaa" } });
    await app.inject({
      method: "POST",
      url: "/decision",
      headers: auth(),
      payload: { requestId: "r1", decision: "signed", decidedAt: new Date().toISOString() },
    });

    const res = await app.inject({ method: "GET", url: "/window/m1?windowSeconds=86400&maxPerWindow=60000000", headers: auth() });
    const body = res.json();
    expect(body.spent).toBe("5000000");
    expect(body.cardCount).toBe(1);
    expect(body.remaining).toBe("55000000");
  });
});

describe("policy storage", () => {
  it("PUT then GET round-trips and increments policyVersion", async () => {
    const policy = { mandateId: "m1", note: "raw storage, no drift validation here" };
    const first = await app.inject({ method: "PUT", url: "/policy/m1", headers: auth(), payload: { policy } });
    expect(first.json()).toMatchObject({ mandateId: "m1", policyVersion: 1 });
    const second = await app.inject({ method: "PUT", url: "/policy/m1", headers: auth(), payload: { policy } });
    expect(second.json()).toMatchObject({ mandateId: "m1", policyVersion: 2 });
    const got = await app.inject({ method: "GET", url: "/policy/m1", headers: auth() });
    expect(got.json()).toMatchObject({ policy, policyVersion: 2 });
  });

  it("404s a mandate with no stored policy", async () => {
    const res = await app.inject({ method: "GET", url: "/policy/unknown", headers: auth() });
    expect(res.statusCode).toBe(404);
  });
});

describe("escalation storage", () => {
  const create = () =>
    app.inject({
      method: "POST",
      url: "/escalation",
      headers: auth(),
      payload: { requestId: "r1", mandateId: "m1", reason: "WINDOW_BUDGET_EXCEEDED", approvalUrl: "http://x/approve/r1", ttlSeconds: 300 },
    });

  it("creates a pending escalation and is idempotent on a repeat create", async () => {
    const first = await create();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ requestId: "r1", resolved: false });

    const second = await create();
    expect(second.statusCode).toBe(200);
    expect(second.json().requestId).toBe("r1");
  });

  it("GET 404s an unknown escalation", async () => {
    const res = await app.inject({ method: "GET", url: "/escalation/unknown", headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("PUT resolves an escalation", async () => {
    await create();
    const res = await app.inject({
      method: "PUT",
      url: "/escalation/r1",
      headers: auth(),
      payload: { decision: "approve", approvedBy: "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7" },
    });
    expect(res.json()).toMatchObject({ resolved: true, decision: "approve" });
  });
});

describe("standing approvals", () => {
  it("is inactive before it's set", async () => {
    const res = await app.inject({ method: "GET", url: "/standing-approval?mandateId=m1&merchantDomain=shop.example", headers: auth() });
    expect(res.json().active).toBe(false);
  });

  it("is active once set with a future expiry, and matches case-insensitively", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    await app.inject({
      method: "POST",
      url: "/standing-approval",
      headers: auth(),
      payload: { mandateId: "m1", merchantDomain: "Shop.Example", expiresAt },
    });
    const res = await app.inject({ method: "GET", url: "/standing-approval?mandateId=m1&merchantDomain=shop.EXAMPLE", headers: auth() });
    expect(res.json()).toMatchObject({ active: true, expiresAt });
  });

  it("is inactive once expired", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 10;
    await app.inject({
      method: "POST",
      url: "/standing-approval",
      headers: auth(),
      payload: { mandateId: "m1", merchantDomain: "shop.example", expiresAt },
    });
    const res = await app.inject({ method: "GET", url: "/standing-approval?mandateId=m1&merchantDomain=shop.example", headers: auth() });
    expect(res.json().active).toBe(false);
  });
});
