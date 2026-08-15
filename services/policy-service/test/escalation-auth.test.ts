/**
 * Escalation approval is a SIGNATURE, not a claim.
 *
 * Check 9 escalates rather than refusing, and a human decides. Before this was
 * enforced, `approvedBy` was a plain field in the request body: anyone who could
 * reach policy-service could approve their own escalation by typing the mandate
 * owner's address. The escalation gate was decoration.
 *
 * These tests exercise the endpoint over HTTP with a real key, because the
 * previous single escalation-resolve test passed the expiry check first (410)
 * and never reached the authorization path at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/clients/ledgerClient.js", () => import("./fakes/fakeLedger.js"));
vi.mock("../src/clients/chainGatewayClient.js", () => import("./fakes/fakeChainGateway.js"));
vi.mock("../src/clients/signerClient.js", () => import("./fakes/fakeSigner.js"));

import { privateKeyToAccount } from "viem/accounts";
import {
  buildEscalationMessage,
  hashPolicy,
  type Mandate,
  type X402Requirements,
} from "@straitsx/contracts";
import { buildApp } from "../src/app.js";
import * as fakeChainGateway from "./fakes/fakeChainGateway.js";
import * as fakeLedger from "./fakes/fakeLedger.js";
import * as fakeSigner from "./fakes/fakeSigner.js";

const TOKEN = "dev-secret";
const app = buildApp({ internalToken: TOKEN, maxSaneValiditySeconds: 300, escalationTtlSeconds: 300 });

/** The human who owns the mandate — a key we can actually sign with. */
const owner = privateKeyToAccount(`0x${"a".padStart(64, "0")}`);
/** Anyone else. */
const attacker = privateKeyToAccount(`0x${"b".padStart(64, "0")}`);

function auth() {
  return { "x-internal-token": TOKEN, "content-type": "application/json" };
}

const challenge: X402Requirements = {
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

const mandate: Mandate = {
  mandateId: "0x7f3a000000000000000000000000000000000000000000000000000000000000",
  owner: owner.address,
  agentId: "shopper-1",
  chainId: 43113,
  asset: challenge.asset,
  settlementRecipient: challenge.payTo,
  maxPerCard: "30000000",
  maxPerWindow: "60000000",
  // 0 cards per window guarantees check 9 escalates on the first request.
  maxCardsPerWindow: 0,
  windowSeconds: 86400,
  maxAuthValiditySeconds: 120,
  expiresAt: 4_000_000_000,
  revoked: false,
  intentConstraint: "black sneakers, size 42",
  merchantAllowlist: ["shop.example"],
  policyVersion: 1,
};

/** Drive a request to the escalated state and return its requestId. */
async function escalate(requestId: string): Promise<void> {
  fakeLedger.seedPolicy("m1", mandate);
  fakeChainGateway.seed("m1", {
    owner: mandate.owner,
    policyHash: hashPolicy(mandate),
    expiresAt: mandate.expiresAt,
    revoked: mandate.revoked,
  });
  fakeLedger.seedIntent({
    requestId,
    mandateId: "m1",
    instruction: "buy sneakers",
    instructionHash: "0x6ee31b84b68935428c7fc50e1236c8918ad2860145a57933e008dc95db791449",
    createdAt: "2026-08-15T06:00:00Z",
    challenge,
    challengeAttachedAt: "2026-08-15T06:01:00Z",
  });
  const res = await app.inject({
    method: "POST",
    url: "/payment/request",
    headers: auth(),
    payload: {
      requestId,
      mandateId: "m1",
      requestedAmount: challenge.amount,
      challenge,
      resolvedItem: {
        title: "Black Running Sneakers Size 42",
        sku: "SNK-42-BLK",
        price: challenge.amount,
        merchantDomain: "shop.example",
        checkoutUrl: "https://shop.example/checkout/sneakers",
      },
    },
  });
  expect(res.statusCode).toBe(202);
}

function resolve(requestId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/escalation/${requestId}/resolve`,
    headers: auth(),
    payload,
  });
}

async function sign(requestId: string, decision: "approve" | "deny", account = owner) {
  return account.signMessage({
    message: buildEscalationMessage({ requestId, mandateId: "m1", decision }),
  });
}

beforeEach(() => {
  fakeLedger.reset?.();
  fakeChainGateway.reset?.();
  fakeSigner.reset?.();
});

describe("escalation resolve requires a valid owner signature", () => {
  it("refuses with no signature at all", async () => {
    await escalate("e1");
    const res = await resolve("e1", { decision: "approve", approvedBy: owner.address });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ESCALATION_SIGNATURE_REQUIRED");
    expect(fakeSigner.getCalls()).toHaveLength(0);
  });

  it("refuses a signature from someone who is not the mandate owner", async () => {
    await escalate("e2");
    // The attacker signs the correct message but with the wrong key, and
    // claims the owner's address in approvedBy.
    const signature = await sign("e2", "approve", attacker);
    const res = await resolve("e2", {
      decision: "approve",
      approvedBy: owner.address,
      signature,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("ESCALATION_SIGNATURE_INVALID");
    expect(fakeSigner.getCalls()).toHaveLength(0);
  });

  it("refuses an approval replayed onto a different requestId", async () => {
    await escalate("e3");
    // A genuine owner signature, but produced for another request.
    const signature = await sign("other-request", "approve");
    const res = await resolve("e3", {
      decision: "approve",
      approvedBy: owner.address,
      signature,
    });
    expect(res.statusCode).toBe(403);
    expect(fakeSigner.getCalls()).toHaveLength(0);
  });

  it("refuses an approval submitted as a denial", async () => {
    await escalate("e4");
    // Signed "approve", submitted as "deny". If the decision were outside the
    // signed message this would be accepted and the human would be recorded as
    // having denied something they approved.
    const signature = await sign("e4", "approve");
    const res = await resolve("e4", {
      decision: "deny",
      approvedBy: owner.address,
      signature,
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts a correct owner signature and proceeds to sign", async () => {
    await escalate("e5");
    const signature = await sign("e5", "approve");
    const res = await resolve("e5", {
      decision: "approve",
      approvedBy: owner.address,
      signature,
    });
    expect(res.statusCode).toBe(200);
    expect(fakeSigner.getCalls()).toHaveLength(1);
    expect(res.json().nonce).toBe("0xc0d327c63c90abbba4476b41da4e2e18ef1723dda77f0fdf6021b2bc15512b36");
  });

  it("fails closed if the stored escalation has no merchant domain", async () => {
    await escalate("e6");
    const escalation = fakeLedger.getEscalationRecord("e6");
    expect(escalation).toBeDefined();
    escalation!.merchantDomain = undefined;

    const signature = await sign("e6", "approve");
    const res = await resolve("e6", {
      decision: "approve",
      approvedBy: owner.address,
      signature,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("MERCHANT_DOMAIN_REQUIRED");
    expect(fakeSigner.getCalls()).toHaveLength(0);
    expect(fakeLedger.getEscalationRecord("e6")).toMatchObject({ resolved: true, decision: "deny" });
  });
});
