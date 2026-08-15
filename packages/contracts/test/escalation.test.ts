/**
 * The canonical escalation message is a wire contract shared with the dashboard.
 * These tests pin the exact bytes: if the format drifts, the dashboard's
 * signature stops verifying and every human approval fails with no obvious
 * cause. Pinning it here makes the drift a failing test instead.
 */

import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildEscalationMessage,
  verifyEscalationSignature,
} from "../src/escalation";
import type { Hex } from "../src/types";

const PRIVATE_KEY = `0x${"7".padStart(64, "0")}` as `0x${string}`;
const owner = privateKeyToAccount(PRIVATE_KEY);

const INPUT = {
  requestId: "3f6c8b2e-0000-4000-8000-000000000001",
  mandateId: `0x${"7f3a".padStart(64, "0")}` as Hex,
  decision: "approve" as const,
};

describe("buildEscalationMessage", () => {
  it("produces the exact canonical string", () => {
    expect(buildEscalationMessage(INPUT)).toBe(
      [
        "straitsx-888 escalation decision",
        "requestId: 3f6c8b2e-0000-4000-8000-000000000001",
        `mandateId: 0x${"7f3a".padStart(64, "0")}`,
        "decision: approve",
      ].join("\n"),
    );
  });

  it("lowercases the mandateId so casing cannot split the signature", () => {
    const upper = buildEscalationMessage({
      ...INPUT,
      mandateId: INPUT.mandateId.toUpperCase().replace("0X", "0x") as Hex,
    });
    expect(upper).toBe(buildEscalationMessage(INPUT));
  });

  it("differs between approve and deny", () => {
    // Without this, a captured approval could be replayed as a denial.
    expect(buildEscalationMessage({ ...INPUT, decision: "deny" })).not.toBe(
      buildEscalationMessage(INPUT),
    );
  });
});

describe("verifyEscalationSignature", () => {
  it("accepts a signature from the mandate owner", async () => {
    const signature = (await owner.signMessage({
      message: buildEscalationMessage(INPUT),
    })) as Hex;
    const result = await verifyEscalationSignature({
      input: INPUT,
      signature,
      expectedSigner: owner.address,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a signature from someone who is not the owner", async () => {
    const other = privateKeyToAccount(`0x${"8".padStart(64, "0")}`);
    const signature = (await other.signMessage({
      message: buildEscalationMessage(INPUT),
    })) as Hex;
    const result = await verifyEscalationSignature({
      input: INPUT,
      signature,
      expectedSigner: owner.address,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an approval replayed as a denial", async () => {
    // The human signed "approve". Submitting that signature with decision
    // "deny" must not verify, or the decision field is unauthenticated.
    const signature = (await owner.signMessage({
      message: buildEscalationMessage(INPUT),
    })) as Hex;
    const result = await verifyEscalationSignature({
      input: { ...INPUT, decision: "deny" },
      signature,
      expectedSigner: owner.address,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an approval replayed against a different requestId", async () => {
    const signature = (await owner.signMessage({
      message: buildEscalationMessage(INPUT),
    })) as Hex;
    const result = await verifyEscalationSignature({
      input: { ...INPUT, requestId: "some-other-request" },
      signature,
      expectedSigner: owner.address,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an approval replayed against a different mandate", async () => {
    const signature = (await owner.signMessage({
      message: buildEscalationMessage(INPUT),
    })) as Hex;
    const result = await verifyEscalationSignature({
      input: { ...INPUT, mandateId: `0x${"beef".padStart(64, "0")}` as Hex },
      signature,
      expectedSigner: owner.address,
    });
    expect(result.ok).toBe(false);
  });

  it("returns a reason rather than throwing on a malformed signature", async () => {
    const result = await verifyEscalationSignature({
      input: INPUT,
      signature: "0xnothex" as Hex,
      expectedSigner: owner.address,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/hex/i);
  });

  it("returns a reason rather than throwing on a truncated signature", async () => {
    const result = await verifyEscalationSignature({
      input: INPUT,
      signature: "0xdeadbeef" as Hex,
      expectedSigner: owner.address,
    });
    expect(result.ok).toBe(false);
  });
});
