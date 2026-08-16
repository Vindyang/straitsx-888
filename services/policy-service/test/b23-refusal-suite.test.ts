import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/clients/ledgerClient.js", () => import("./fakes/fakeLedger.js"));
vi.mock("../src/clients/chainGatewayClient.js", () => import("./fakes/fakeChainGateway.js"));
vi.mock("../src/clients/signerClient.js", () => import("./fakes/fakeSigner.js"));

import { hashPolicy, type Mandate, type X402Requirements } from "@straitsx/contracts";
import { buildApp } from "../src/app.js";
import * as fakeChainGateway from "./fakes/fakeChainGateway.js";
import * as fakeLedger from "./fakes/fakeLedger.js";
import * as fakeSigner from "./fakes/fakeSigner.js";

/**
 * B23 — the refusal test suite. Case numbers/wording follow owner-b-tasks.md's own list
 * verbatim so it's traceable back to the task board. Runs against `buildApp()` with the real
 * pipeline wiring (B10) and the three HTTP clients swapped for in-memory fakes (test/fakes/) —
 * no live network dependency, but every check, the nonce lifecycle, and the escalation
 * lifecycle are exercised through the actual route handlers, not just the pure check functions
 * (those already have their own isolated unit tests in checks.test.ts / check9.test.ts).
 */

const TOKEN = "dev-secret";
const app = buildApp({ internalToken: TOKEN, maxSaneValiditySeconds: 300, escalationTtlSeconds: 300 });

function auth() {
  return { "x-internal-token": TOKEN, "content-type": "application/json" };
}

const mandate: Mandate = {
  mandateId: "0x7f3a000000000000000000000000000000000000000000000000000000000000",
  owner: "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7",
  agentId: "shopper-1",
  chainId: 43113,
  asset: "0xd769410dc8772695a7f55a304d2125320a65c2a5",
  settlementRecipient: "0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8",
  maxPerCard: "30000000",
  maxPerWindow: "60000000",
  maxCardsPerWindow: 2,
  windowSeconds: 86400,
  maxAuthValiditySeconds: 120,
  expiresAt: 4_000_000_000,
  revoked: false,
  intentConstraint: "black sneakers, size 42, <= $120",
  merchantAllowlist: ["shop.example"],
  policyVersion: 1,
};

const challenge: X402Requirements = {
  x402Version: 1,
  scheme: "exact",
  network: "eip155:43113",
  chainId: 43113,
  amount: "5000000",
  asset: mandate.asset,
  payTo: mandate.settlementRecipient,
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "eip3009", name: "XSGD", version: "2" },
};

const matchingResolvedItem = {
  title: "Black Running Sneakers Size 42",
  sku: "SNK-42-BLK",
  price: "5000000",
  merchantDomain: "shop.example",
  checkoutUrl: "https://shop.example/checkout/sneakers",
};

function seedMandate(overrides: Partial<Mandate> = {}) {
  const m: Mandate = { ...mandate, ...overrides };
  fakeLedger.seedPolicy("m1", m);
  fakeChainGateway.seed("m1", { owner: m.owner, policyHash: hashPolicy(m), expiresAt: m.expiresAt, revoked: m.revoked });
  return m;
}

function seedIntent(
  requestId: string,
  challengeOverrides: Partial<X402Requirements> = {},
  opts: { createdAt?: string; challengeAttachedAt?: string | null } = {},
) {
  fakeLedger.seedIntent({
    requestId,
    mandateId: "m1",
    instruction: "buy sneakers",
    instructionHash: "0x6ee31b84b68935428c7fc50e1236c8918ad2860145a57933e008dc95db791449",
    createdAt: opts.createdAt ?? "2026-08-15T06:00:00Z",
    challenge: { ...challenge, ...challengeOverrides },
    challengeAttachedAt: opts.challengeAttachedAt === null ? undefined : (opts.challengeAttachedAt ?? "2026-08-15T06:01:00Z"),
  });
}

function paymentRequest(
  requestId: string,
  overrides: Partial<{ requestedAmount: string; challenge: X402Requirements; resolvedItem: unknown }> = {},
) {
  return app.inject({
    method: "POST",
    url: "/payment/request",
    headers: auth(),
    payload: {
      requestId,
      mandateId: "m1",
      requestedAmount: overrides.requestedAmount ?? challenge.amount,
      challenge: overrides.challenge ?? challenge,
      resolvedItem: overrides.resolvedItem ?? matchingResolvedItem,
    },
  });
}

beforeEach(() => {
  fakeLedger.reset();
  fakeChainGateway.reset();
  fakeSigner.reset();
  seedMandate();
});

describe("case 1 — clean purchase inside all limits", () => {
  it("signs with all checks passed and a deterministic intent commitment nonce", async () => {
    seedIntent("case1");
    const res = await paymentRequest("case1");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("signed");
    expect(body.checksPassed).toEqual([
      "check1_mandate_live",
      "check2_policy_hash",
      "check3_chain_asset",
      "check4_recipient_pinned",
      "check5_amount_bounds",
      "check6_window_budget",
      "check7_validity_sane",
      "check8_intent_bound",
      "check9_intent_match",
    ]);
    expect(body.nonce).toBe("0x01f3fd27d9290e2e95354538dc2eb3066d6e0ad8470bf82a95f00264e8ddadf9");
    expect(fakeSigner.getCalls()[0]?.typedData.message.nonce).toBe(body.nonce);

    // "receipt complete" — policyHash and the signed window are threaded through to the
    // ledger via POST /decision, not left null (the gap flagged after B1-B23's first pass).
    const intentRecord = fakeLedger.getIntentRecord("case1");
    expect(intentRecord?.policyHash).toBe(hashPolicy(mandate));
    expect(intentRecord?.merchantDomain).toBe("shop.example");
    expect(intentRecord?.validAfter).toEqual(expect.any(Number));
    expect(intentRecord?.validBefore).toEqual(expect.any(Number));
    expect(intentRecord!.validBefore!).toBeGreaterThan(intentRecord!.validAfter!);
  });
});

describe("case 2 — challenge.payTo mutated", () => {
  it("refuses on check 4", async () => {
    seedIntent("case2", { payTo: "0xBAD0000000000000000000000000000000dEaD" });
    const res = await paymentRequest("case2", { challenge: { ...challenge, payTo: "0xBAD0000000000000000000000000000000dEaD" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().check).toBe("check4_recipient_pinned");
  });
});

describe("case 3 — challenge.amount != requestedAmount", () => {
  it("refuses on check 5", async () => {
    seedIntent("case3");
    const res = await paymentRequest("case3", { requestedAmount: "6000000" });
    expect(res.statusCode).toBe(422);
    expect(res.json().check).toBe("check5_amount_bounds");
  });
});

describe("case 4 — third card when maxCardsPerWindow = 2", () => {
  it("escalates on check 6, does not refuse", async () => {
    seedIntent("case4a");
    seedIntent("case4b");
    expect((await paymentRequest("case4a")).statusCode).toBe(200);
    expect((await paymentRequest("case4b")).statusCode).toBe(200);

    seedIntent("case4c");
    const res = await paymentRequest("case4c");
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("escalated");
    expect(body.reason).toBe("WINDOW_BUDGET_EXCEEDED");
    expect(fakeLedger.getEscalationRecord("case4c")?.merchantDomain).toBe("shop.example");
  });
});

describe("commitment inputs", () => {
  it("refuses before reserving a nonce when resolvedItem.merchantDomain is missing", async () => {
    seedIntent("missing-domain");
    const { merchantDomain: _merchantDomain, ...withoutMerchantDomain } = matchingResolvedItem;
    const res = await paymentRequest("missing-domain", { resolvedItem: withoutMerchantDomain });

    expect(res.statusCode).toBe(422);
    expect(res.json().check).toBe("precondition_merchant_domain");
    expect(fakeLedger.getIntentRecord("missing-domain")?.nonce).toBeUndefined();
    expect(fakeSigner.getCalls()).toHaveLength(0);
  });
});

describe("case 5 — amount pushes window over budget", () => {
  it("escalates, never refuses", async () => {
    const m = seedMandate({ maxPerWindow: "6000000", maxCardsPerWindow: 10 });
    seedIntent("case5a");
    expect((await paymentRequest("case5a")).statusCode).toBe(200); // spends 5000000, 1000000 left

    seedIntent("case5b");
    const res = await paymentRequest("case5b"); // another 5000000 pushes spent to 10000000 > 6000000
    expect(res.statusCode).toBe(202);
    expect(res.json().reason).toBe("WINDOW_BUDGET_EXCEEDED");
    void m;
  });
});

describe("case 6 — mandate revoked mid-session", () => {
  it("refuses on check 1 as soon as the registry read reflects revocation", async () => {
    seedIntent("case6a");
    expect((await paymentRequest("case6a")).statusCode).toBe(200);

    fakeChainGateway.setRevoked("m1", true); // simulates a revoke landing on-chain
    seedIntent("case6b");
    const res = await paymentRequest("case6b");
    expect(res.statusCode).toBe(422);
    expect(res.json().check).toBe("check1_mandate_live");
  });
});

describe("case 7 — validBefore - validAfter of one hour", () => {
  it("refuses on check 7", async () => {
    seedMandate({ maxAuthValiditySeconds: 3600 });
    seedIntent("case7", {}, {});
    const res = await paymentRequest("case7", { challenge: { ...challenge, maxTimeoutSeconds: 3600 } });
    expect(res.statusCode).toBe(422);
    expect(res.json().check).toBe("check7_validity_sane");
  });
});

describe("case 8 — signature request with no intent record", () => {
  it("refuses on the precondition", async () => {
    const res = await paymentRequest("case8-never-created");
    expect(res.statusCode).toBe(422);
    expect(res.json().check).toBe("precondition_intent_exists");
  });
});

describe("case 9 — nonce reuse", () => {
  it("the conditional write fails on a repeat call for an already-signed requestId; no second signature", async () => {
    seedIntent("case9");
    const first = await paymentRequest("case9");
    expect(first.statusCode).toBe(200);
    expect(fakeSigner.getCalls()).toHaveLength(1);

    const second = await paymentRequest("case9");
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("NONCE_ALREADY_RESERVED");
    // No second call ever reached the signer.
    expect(fakeSigner.getCalls()).toHaveLength(1);
  });
});

describe("case 10 — policy body edited locally", () => {
  it("refuses on check 2", async () => {
    // Registry still has the hash for the original policy; ledger's copy is tampered.
    fakeLedger.seedPolicy("m1", { ...mandate, intentConstraint: "anything goes" });
    seedIntent("case10");
    const res = await paymentRequest("case10");
    expect(res.statusCode).toBe(422);
    expect(res.json().check).toBe("check2_policy_hash");
  });
});

describe("case 11 — releaseNonce before signing, retry with a new nonce succeeds", () => {
  it("a pre-signature signer failure releases the nonce and a retry signs cleanly", async () => {
    seedIntent("case11");
    fakeSigner.setNextResult({ ok: false, status: 502, code: "SIGNER_UNAVAILABLE", message: "temporarily unreachable" });

    const first = await paymentRequest("case11");
    expect(first.statusCode).toBe(502);
    expect(fakeLedger.getIntentRecord("case11")?.nonce).toBeUndefined(); // released

    const second = await paymentRequest("case11");
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe("signed");
  });
});

describe("case 12 — post-signature cardapi failure: no release, fresh requestId required", () => {
  it("the signed intent cannot be reused, but a fresh requestId proceeds independently", async () => {
    seedIntent("case12");
    expect((await paymentRequest("case12")).statusCode).toBe(200);

    // Simulating the orchestrator retrying the *same* requestId after a post-signature cardapi
    // failure — must not produce a second signature.
    const reuse = await paymentRequest("case12");
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error.code).toBe("NONCE_ALREADY_RESERVED");

    // The only correct recovery: rotate to a fresh requestId.
    seedIntent("case12-retry");
    const fresh = await paymentRequest("case12-retry");
    expect(fresh.statusCode).toBe(200);
  });
});

describe("case 13 — escalation unanswered past TTL", () => {
  it("auto-denies on resolve after expiry; no signature", async () => {
    const shortTtlApp = buildApp({ internalToken: TOKEN, escalationTtlSeconds: -5 }); // already expired
    seedMandate({ maxCardsPerWindow: 0 }); // guarantees an escalation on the very first request
    seedIntent("case13");

    const escalated = await shortTtlApp.inject({
      method: "POST",
      url: "/payment/request",
      headers: auth(),
      payload: { requestId: "case13", mandateId: "m1", requestedAmount: challenge.amount, challenge, resolvedItem: matchingResolvedItem },
    });
    expect(escalated.statusCode).toBe(202);

    const resolved = await shortTtlApp.inject({
      method: "POST",
      url: "/escalation/case13/resolve",
      headers: auth(),
      payload: { decision: "approve", approvedBy: mandate.owner },
    });
    expect(resolved.statusCode).toBe(410);
    expect(resolved.json().error.code).toBe("ESCALATION_EXPIRED");
    expect(fakeSigner.getCalls()).toHaveLength(0);
  });
});

describe("case 14 — compromised policy asks signer out-of-envelope", () => {
  it("the signer refuses on its hard-invariant rail and policy-service surfaces that refusal, never a signature", async () => {
    seedIntent("case14");
    fakeSigner.setNextResult({
      ok: false,
      status: 403,
      code: "SIGNER_WRONG_RECIPIENT",
      message: "message.to does not match the pinned settlementRecipient",
    });

    const res = await paymentRequest("case14");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("SIGNER_WRONG_RECIPIENT");
    expect(res.json().error.retryable).toBe(false); // a rail rejection is definitive, not transient

    const decisions = fakeLedger.getDecisions().filter((d) => d.requestId === "case14");
    expect(decisions.at(-1)).toMatchObject({ decision: "refused", check: "signer_refused" });
  });
});

describe("case 15 — matcher returns uncertain", () => {
  it("escalates, never signs", async () => {
    seedIntent("case15");
    const res = await paymentRequest("case15", {
      resolvedItem: {
        title: "4-Slice Toaster",
        sku: "TST-4",
        price: "5000000",
        merchantDomain: "shop.example",
        checkoutUrl: "https://shop.example/checkout/toaster",
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("escalated");
    expect(body.reason).toBe("INTENT_MISMATCH");
    expect(fakeSigner.getCalls()).toHaveLength(0);
  });
});
