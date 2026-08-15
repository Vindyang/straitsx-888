import { describe, expect, it } from "vitest";
import type { ResolvedItem } from "@straitsx/contracts";
import { check9_intent_match, type Check9Context } from "../src/checks/check9-intent-match.js";
import { heuristicIntentMatcher } from "../src/matcher.js";

const resolvedItem: ResolvedItem = {
  title: "Black Running Sneakers Size 42",
  sku: "SNK-42-BLK",
  price: "80000000",
  merchantDomain: "shop.example",
  checkoutUrl: "https://shop.example/checkout/xyz",
};

function makeCtx(overrides: Partial<Check9Context> = {}): Check9Context {
  return {
    resolvedItem,
    intentConstraint: "black sneakers, size 42, <= $120",
    merchantAllowlist: ["shop.example"],
    hasStandingApproval: false,
    ...overrides,
  };
}

describe("heuristicIntentMatcher", () => {
  it("matches when resolved title overlaps the constraint", () => {
    expect(heuristicIntentMatcher(resolvedItem, "black sneakers, size 42, <= $120")).toBe("match");
  });

  it("is uncertain for an unrelated item", () => {
    expect(heuristicIntentMatcher(resolvedItem, "a blue kitchen blender")).toBe("uncertain");
  });

  it("never claims a confident match on empty input (fails toward escalation, not signing)", () => {
    expect(heuristicIntentMatcher({ ...resolvedItem, title: "" }, "")).toBe("uncertain");
  });
});

describe("check9_intent_match", () => {
  it("passes (returns null) on a confident match within the allowlist", () => {
    expect(check9_intent_match(makeCtx())).toBeNull();
  });

  it("escalates on an off-allowlist merchant domain, even with a matching title", () => {
    const ctx = makeCtx({ resolvedItem: { ...resolvedItem, merchantDomain: "attacker.example" } });
    expect(check9_intent_match(ctx)).toMatchObject({ outcome: "escalate", check: "check9_intent_match", reason: "INTENT_MISMATCH" });
  });

  it("escalates on an unrelated resolved item (honest-mistake case)", () => {
    const ctx = makeCtx({ intentConstraint: "a 4-slice toaster" });
    expect(check9_intent_match(ctx)).toMatchObject({ outcome: "escalate", reason: "INTENT_MISMATCH" });
  });

  it("skips both the domain and matcher checks when a standing approval covers this request", () => {
    const ctx = makeCtx({ hasStandingApproval: true, resolvedItem: { ...resolvedItem, merchantDomain: "attacker.example" } });
    expect(check9_intent_match(ctx)).toBeNull();
  });

  it("passes with an empty allowlist (advisory only) as long as the matcher is confident", () => {
    const ctx = makeCtx({ merchantAllowlist: [] });
    expect(check9_intent_match(ctx)).toBeNull();
  });

  it("never returns a refusal outcome — a bypassed matcher can only escalate, never refuse or sign silently", () => {
    const ctx = makeCtx({ intentConstraint: "totally different item" });
    const result = check9_intent_match(ctx);
    expect(result === null || result.outcome === "escalate").toBe(true);
  });
});
