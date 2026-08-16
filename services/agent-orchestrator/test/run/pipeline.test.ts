import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ErrorCode } from "@straitsx/contracts";

const mocks = vi.hoisted(() => ({
  decision: undefined as unknown,
  resolution: undefined as unknown,
  confirmation: { ok: true, transferMatched: true, blockNumber: 42, confirmations: 2, logIndex: 0 },
  recordSettlement: vi.fn(), recordSpend: vi.fn(), recordCapture: vi.fn(), checkout: vi.fn(), payAndIssue: vi.fn(), resolveEscalation: vi.fn(), ucpCheckout: vi.fn(),
}));

const challenge = {
  x402Version: 1, scheme: "exact", network: "eip155:43113", chainId: 43113, amount: "15000000",
  asset: "0x1111111111111111111111111111111111111111", payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: "XSGD", version: "2" },
} as const;
const resolvedItem = { title: "Bottle", sku: "BTL-500-SS", price: "15000000", merchantDomain: "localhost", checkoutUrl: "http://localhost:4010/checkout/xyz" };

vi.mock("../../src/card-gateway/index", () => ({
  getCard: vi.fn(async () => ({ cardapiUrl: "https://card.straitsx.ai/sandbox/cardapi/issue_card", challenge, rawToolResultHash: "0xabc" })),
  payAndIssue: mocks.payAndIssue,
  viewCard: vi.fn(async () => ({ iframeUrl: "https://card.straitsx.ai/sandbox/view/one-time/x", expiresInSeconds: 60, singleUse: true })),
}));
vi.mock("../../src/checkout/ucp-checkout", () => ({
  completeUcpCheckout: vi.fn(async (input: { onDomainAsserted?: () => void }) => {
    input.onDomainAsserted?.(); mocks.ucpCheckout();
    return { requestId: "x", merchantDomain: "water.example", orderTotal: "15000000", itemSku: "BTL-500-SS", orderId: "SO-UCP-1", observedAt: "2026-08-15T00:00:00Z", proof: "ucp" };
  }),
}));
vi.mock("../../src/discovery/discover", () => {
  const base = { discoverProduct: vi.fn(async () => ({ resolvedItem, simulatedCompromise: null })), discoverMerchantProduct: vi.fn() };
  return {
    ...base,
    discoverShopifyCheckout: vi.fn(async () => ({ resolvedItem, simulatedCompromise: null })),
  };
});
vi.mock("../../src/clients/ledger-client", () => ({
  createIntent: vi.fn(), attachChallenge: vi.fn(), recordSettlement: mocks.recordSettlement, recordSpend: mocks.recordSpend, recordCapture: mocks.recordCapture,
}));
vi.mock("../../src/clients/policy-client", () => ({
  requestPayment: vi.fn(async () => mocks.decision), resolveEscalation: mocks.resolveEscalation,
}));
vi.mock("../../src/clients/chain-gateway-client", () => ({ confirmSettlement: vi.fn(async () => mocks.confirmation) }));
vi.mock("../../src/checkout/checkout-worker", () => ({
  runCheckout: vi.fn(async (input: { onDomainAsserted?: () => void }) => {
    input.onDomainAsserted?.(); mocks.checkout();
    return { requestId: "x", merchantDomain: "localhost", orderTotal: "15000000", itemSku: "BTL-500-SS", orderId: "SO-1", observedAt: "2026-08-15T00:00:00Z", proof: "none" };
  }),
}));

import { resolveRunEscalation, startRun } from "../../src/run/pipeline";
import { getRun } from "../../src/run/store";

async function waitFor(requestId: string, state: string) {
  for (let i = 0; i < 100; i += 1) {
    if (getRun(requestId)?.state === state) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`run did not reach ${state}; was ${getRun(requestId)?.state}`);
}

const signed = { status: "signed", header: "do-not-log", nonce: "0x01", validAfter: 1, validBefore: 2, checksPassed: [] };
const input = { instruction: "buy bottle from localhost", mandateId: "0x01", agentId: "shopper", source: { kind: "fixture", name: "clean" } } as const;

describe("resumable run pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.decision = signed; mocks.resolution = { status: "signed", header: "resume-secret", nonce: "0x02" };
    mocks.resolveEscalation.mockImplementation(async () => mocks.resolution);
    mocks.confirmation = { ok: true, transferMatched: true, blockNumber: 42, confirmations: 2, logIndex: 0 };
    mocks.payAndIssue.mockResolvedValue({ ok: true, cardOpaqueId: "card-1", settlementTx: "0xtx", issuedAt: "now" });
  });

  it("emits the documented order and records settlement+capture evidence at capture time", async () => {
    const { requestId } = startRun(input);
    await waitFor(requestId, "DONE");
    expect(getRun(requestId)?.events.map((event) => event.stage)).toEqual([
      "INTENT_CREATED", "DISCOVERY_DONE", "CHALLENGE_RECEIVED", "POLICY_DECISION",
      "CARD_ISSUED", "CHECKOUT_ASSERTED", "SPEND_RECORDED", "SETTLEMENT_FINALIZED",
    ]);
    expect(mocks.recordSettlement).toHaveBeenCalledWith(expect.objectContaining({ rawToolResultHash: "0xabc" }));
    expect(mocks.recordCapture).toHaveBeenCalledWith(expect.objectContaining({ orderId: "SO-1", settlementTx: "0xtx", blockNumber: 42 }));
    expect((mocks.recordCapture.mock.invocationCallOrder[0] ?? 0)).toBeGreaterThan(mocks.recordSettlement.mock.invocationCallOrder[0] ?? 0);
  });

  it("fails closed at capture-time settlement verification; spend is recorded but never finalizes", async () => {
    mocks.confirmation = { ok: true, transferMatched: false, blockNumber: 42, confirmations: 2, logIndex: 0 };
    const { requestId } = startRun(input);
    await waitFor(requestId, "FAILED");
    expect(mocks.payAndIssue).toHaveBeenCalled();
    expect(mocks.checkout).toHaveBeenCalled();
    expect(mocks.recordSpend).toHaveBeenCalled();
    expect(mocks.recordSettlement).not.toHaveBeenCalled();
    expect(mocks.recordCapture).not.toHaveBeenCalled();
    const finalize = getRun(requestId)?.events.find((event) => event.stage === "SETTLEMENT_FINALIZED");
    expect(finalize).toMatchObject({ status: "refused", check: "TRANSFER_MISMATCH" });
    expect(getRun(requestId)?.state).toBe("FAILED");
  });

  it("acquires a Shopify UCP checkout and completes it with the StraitsX card instrument", async () => {
    const shopifyInput = {
      instruction: "buy bottle from water.example under S$20",
      mandateId: "0x01",
      agentId: "shopper",
      source: {
        kind: "shopify",
        checkout: {
          storeDomain: "water.example",
          checkoutSessionId: "cs_abc123XYZ456",
          title: "500ml Stainless Steel Water Bottle",
          sku: "BTL-500-SS",
          totalBaseUnits: "15000000",
          currency: "SGD",
        },
      },
    } as const;
    const { requestId } = startRun(shopifyInput as never);
    await waitFor(requestId, "DONE");
    const stages = getRun(requestId)?.events.map((event) => event.stage) ?? [];
    expect(stages).toContain("CHECKOUT_ACQUIRED");
    expect(stages).not.toContain("DISCOVERY_DONE");
    expect(mocks.ucpCheckout).toHaveBeenCalled();
    expect(mocks.checkout).not.toHaveBeenCalled();
    expect(mocks.recordCapture).toHaveBeenCalledWith(expect.objectContaining({ orderId: "SO-UCP-1" }));
  });

  it("treats refusal as terminal without signing", async () => {
    mocks.decision = { status: "refused", check: "check4_recipient_pinned", checkIndex: 4, detail: "mismatch", humanExplanation: "blocked" };
    const { requestId } = startRun(input);
    await waitFor(requestId, "REFUSED");
    expect(mocks.payAndIssue).not.toHaveBeenCalled();
  });

  it("resumes the same run after escalation approval", async () => {
    mocks.decision = { status: "escalated", reason: "INTENT_MISMATCH", approvalUrl: "/approve", expiresAt: Math.floor(Date.now() / 1000) + 30, ttlSeconds: 30, onTimeout: "DENY" };
    const { requestId } = startRun(input);
    await waitFor(requestId, "ESCALATED");
    await resolveRunEscalation(requestId, { decision: "approve", approvedBy: "0xowner", signature: "0xproof" });
    expect(mocks.resolveEscalation).toHaveBeenCalledWith(requestId, {
      decision: "approve",
      approvedBy: "0xowner",
      signature: "0xproof",
    });
    expect(getRun(requestId)?.requestId).toBe(requestId);
    expect(getRun(requestId)?.state).toBe("DONE");
  });

  it("terminates the same run after escalation denial", async () => {
    mocks.decision = { status: "escalated", reason: "INTENT_MISMATCH", approvalUrl: "/approve", expiresAt: Math.floor(Date.now() / 1000) + 30, ttlSeconds: 30, onTimeout: "DENY" };
    mocks.resolution = { status: "refused", check: "escalation_denied", checkIndex: null, detail: "human denied", humanExplanation: "Nothing moved." };
    const { requestId } = startRun(input);
    await waitFor(requestId, "ESCALATED");
    await resolveRunEscalation(requestId, { decision: "deny" });
    expect(getRun(requestId)?.state).toBe("REFUSED");
    expect(mocks.payAndIssue).not.toHaveBeenCalled();
  });

  it("records policy auto-denial before marking an expired escalation refused", async () => {
    mocks.decision = { status: "escalated", reason: "INTENT_MISMATCH", approvalUrl: "/approve", expiresAt: Math.floor(Date.now() / 1000), ttlSeconds: 0, onTimeout: "DENY" };
    mocks.resolveEscalation.mockRejectedValueOnce(new AppError(410, ErrorCode.INTERNAL, "expired"));
    const { requestId } = startRun(input);
    await waitFor(requestId, "REFUSED");
    expect(mocks.resolveEscalation).toHaveBeenCalledWith(requestId, { decision: "deny" });
    expect(mocks.payAndIssue).not.toHaveBeenCalled();
  });

  it("requires a fresh request after any post-signature failure", async () => {
    mocks.payAndIssue.mockRejectedValueOnce(new Error("secret-bearing transport failed"));
    const { requestId } = startRun(input);
    await waitFor(requestId, "FAILED");
    expect(getRun(requestId)?.outcome).toEqual(expect.objectContaining({ status: "failed", freshRequestRequired: true }));
    expect(JSON.stringify(getRun(requestId))).not.toContain("secret-bearing transport failed");
  });
});
