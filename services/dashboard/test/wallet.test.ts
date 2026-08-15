import { afterEach, describe, expect, it, vi } from "vitest";
import { signEscalationDecision } from "../lib/wallet.js";

const OWNER = "0x9f6B4A5DE73CE365238F27236ea04A747E691bF7";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("signEscalationDecision", () => {
  it("asks the wallet to sign the canonical request, mandate, and decision message", async () => {
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_requestAccounts") return [OWNER];
      if (method === "personal_sign") return "0xsigned-proof";
      throw new Error(`unexpected wallet method ${method}`);
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { ethereum: { request } },
    });

    const result = await signEscalationDecision("request-123", "mandate-456", "approve");

    expect(result).toEqual({ approvedBy: OWNER, signature: "0xsigned-proof" });
    expect(request).toHaveBeenLastCalledWith({
      method: "personal_sign",
      params: [
        [
          "straitsx-888 escalation decision",
          "requestId: request-123",
          "mandateId: mandate-456",
          "decision: approve",
        ].join("\n"),
        OWNER,
      ],
    });
  });
});
