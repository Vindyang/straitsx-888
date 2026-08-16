import { describe, expect, it } from "vitest";
import { exactAmountSgd } from "../../src/run/pipeline";
import { parsePolicyDecision } from "../../src/clients/policy-client";
import { dollarsToBaseUnits6 } from "../../src/discovery/discover";

describe("pre-network validation", () => {
  it("converts exact six-decimal prices without clamping or rounding", () => {
    expect(exactAmountSgd("5000001")).toBe(5.000001);
    expect(exactAmountSgd("30000000")).toBe(30);
    expect(() => exactAmountSgd("4999999")).toThrow(/between 5 and 30/);
    expect(() => exactAmountSgd("30000001")).toThrow(/between 5 and 30/);
  });

  it("rejects malformed or over-precise merchant prices", () => {
    expect(dollarsToBaseUnits6("15.123456")).toBe("15123456");
    expect(() => dollarsToBaseUnits6("15.1234567")).toThrow();
    expect(() => dollarsToBaseUnits6("15oops")).toThrow();
  });
});

describe("policy response validation", () => {
  it("accepts only explicit signed/refused/escalated shapes", () => {
    expect(parsePolicyDecision({ status: "signed", header: "secret", nonce: "0x01", validAfter: 1, validBefore: 2, checksPassed: [] }).status).toBe("signed");
    for (const malformed of [{}, { status: "ok" }, { status: "signed" }, { status: "refused", check: "x" }, { status: "escalated", onTimeout: "ALLOW" }]) {
      expect(() => parsePolicyDecision(malformed)).toThrow(/malformed/);
    }
  });
});
