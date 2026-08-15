import { describe, expect, it } from "vitest";
import { hashPolicy, type Mandate, type X402Requirements } from "@straitsx/contracts";
import {
  check1_mandate_live,
  check2_policy_hash,
  check3_chain_asset,
  check4_recipient_pinned,
  check5_amount_bounds,
  check6_window_budget,
  check7_validity_sane,
  check8_intent_bound,
  precondition_intent_exists,
  type CheckContext,
} from "../src/checks/index.js";

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

function makeCtx(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    now: 1_786_000_000,
    mandate,
    registry: { owner: mandate.owner, policyHash: hashPolicy(mandate), expiresAt: mandate.expiresAt, revoked: false },
    challenge,
    requestedAmount: "5000000",
    windowUsage: { spent: "0", cardCount: 0 },
    intentCreatedAt: "2026-08-15T06:00:00Z",
    challengeAttachedAt: "2026-08-15T06:01:00Z",
    maxSaneValiditySeconds: 300,
    ...overrides,
  };
}

describe("precondition_intent_exists", () => {
  it("refuses when no intent record exists", () => {
    expect(precondition_intent_exists(null)).toMatchObject({ check: "precondition_intent_exists" });
  });
  it("passes when an intent record exists", () => {
    expect(precondition_intent_exists({ requestId: "r1" })).toBeNull();
  });
});

describe("check1_mandate_live", () => {
  it("passes a live mandate", () => {
    expect(check1_mandate_live(makeCtx())).toBeNull();
  });
  it("refuses an absent mandate", () => {
    expect(check1_mandate_live(makeCtx({ registry: null }))).toMatchObject({ check: "check1_mandate_live" });
  });
  it("refuses a revoked mandate (Run 3)", () => {
    const ctx = makeCtx({ registry: { owner: mandate.owner, policyHash: hashPolicy(mandate), expiresAt: mandate.expiresAt, revoked: true } });
    expect(check1_mandate_live(ctx)).toMatchObject({ check: "check1_mandate_live" });
  });
  it("refuses an expired mandate", () => {
    const ctx = makeCtx({ registry: { owner: mandate.owner, policyHash: hashPolicy(mandate), expiresAt: 1_000, revoked: false } });
    expect(check1_mandate_live(ctx)).toMatchObject({ check: "check1_mandate_live" });
  });
});

describe("check2_policy_hash", () => {
  it("passes when local hash matches on-chain hash", () => {
    expect(check2_policy_hash(makeCtx())).toBeNull();
  });
  it("refuses a locally tampered policy body (case 10)", () => {
    const tampered = { ...mandate, intentConstraint: "anything goes" };
    const ctx = makeCtx({ mandate: tampered });
    expect(check2_policy_hash(ctx)).toMatchObject({ check: "check2_policy_hash" });
  });
});

describe("check3_chain_asset", () => {
  it("refuses a mismatched chainId", () => {
    const ctx = makeCtx({ challenge: { ...challenge, chainId: 43114 } });
    expect(check3_chain_asset(ctx)).toMatchObject({ check: "check3_chain_asset" });
  });
  it("refuses a mismatched asset", () => {
    const ctx = makeCtx({ challenge: { ...challenge, asset: "0xbad0000000000000000000000000000000dead" } });
    expect(check3_chain_asset(ctx)).toMatchObject({ check: "check3_chain_asset" });
  });
});

describe("check4_recipient_pinned", () => {
  it("passes when payTo matches settlementRecipient", () => {
    expect(check4_recipient_pinned(makeCtx())).toBeNull();
  });
  it("refuses a substituted payTo (Run 2, case 2)", () => {
    const ctx = makeCtx({ challenge: { ...challenge, payTo: "0xBAD0000000000000000000000000000000dEaD" } });
    const result = check4_recipient_pinned(ctx);
    expect(result).toMatchObject({ check: "check4_recipient_pinned" });
    expect((result as { detail: string }).detail).toContain("0xBAD0000000000000000000000000000000dEaD");
    expect((result as { detail: string }).detail).toContain(mandate.settlementRecipient);
  });
});

describe("check5_amount_bounds", () => {
  it("refuses below the 5 XSGD floor", () => {
    const ctx = makeCtx({ challenge: { ...challenge, amount: "1000000" }, requestedAmount: "1000000" });
    expect(check5_amount_bounds(ctx)).toMatchObject({ check: "check5_amount_bounds" });
  });
  it("refuses above min(maxPerCard, 30 XSGD)", () => {
    const ctx = makeCtx({ challenge: { ...challenge, amount: "31000000" }, requestedAmount: "31000000" });
    expect(check5_amount_bounds(ctx)).toMatchObject({ check: "check5_amount_bounds" });
  });
  it("refuses a mid-flight amount rewrite (case 3)", () => {
    const ctx = makeCtx({ requestedAmount: "6000000" }); // challenge still says 5000000
    expect(check5_amount_bounds(ctx)).toMatchObject({ check: "check5_amount_bounds" });
  });
});

describe("check6_window_budget", () => {
  it("passes within budget", () => {
    expect(check6_window_budget(makeCtx())).toBeNull();
  });
  it("escalates, never refuses, when spend would exceed the window (case 5)", () => {
    const ctx = makeCtx({ windowUsage: { spent: "58000000", cardCount: 0 } });
    expect(check6_window_budget(ctx)).toMatchObject({ outcome: "escalate", reason: "WINDOW_BUDGET_EXCEEDED" });
  });
  it("escalates on card count ceiling (case 4)", () => {
    const ctx = makeCtx({ windowUsage: { spent: "0", cardCount: 2 } });
    expect(check6_window_budget(ctx)).toMatchObject({ outcome: "escalate", reason: "WINDOW_BUDGET_EXCEEDED" });
  });
});

describe("check7_validity_sane", () => {
  it("passes a short computed window", () => {
    expect(check7_validity_sane(makeCtx())).toBeNull();
  });
  it("refuses a one-hour window (case 7)", () => {
    const ctx = makeCtx({ mandate: { ...mandate, maxAuthValiditySeconds: 3600 }, challenge: { ...challenge, maxTimeoutSeconds: 3600 } });
    expect(check7_validity_sane(ctx)).toMatchObject({ check: "check7_validity_sane" });
  });
});

describe("check8_intent_bound", () => {
  it("passes when intent strictly predates the challenge", () => {
    expect(check8_intent_bound(makeCtx())).toBeNull();
  });
  it("refuses when no challenge is attached (orphan signature, case 8)", () => {
    const ctx = makeCtx({ challengeAttachedAt: null });
    expect(check8_intent_bound(ctx)).toMatchObject({ check: "check8_intent_bound" });
  });
  it("refuses when the intent was created after the challenge", () => {
    const ctx = makeCtx({ intentCreatedAt: "2026-08-15T06:02:00Z", challengeAttachedAt: "2026-08-15T06:01:00Z" });
    expect(check8_intent_bound(ctx)).toMatchObject({ check: "check8_intent_bound" });
  });
});
