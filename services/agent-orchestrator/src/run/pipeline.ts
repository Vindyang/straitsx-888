/** Resumable, fail-closed Module C run state machine. */
import { randomUUID } from "node:crypto";
import { AppError, type Address, type ResolvedItem, type X402Requirements } from "@straitsx/contracts";
import { getCard, payAndIssue, viewCard } from "../card-gateway/index";
import type { GetCardResult } from "../card-gateway/types";
import { getMerchantProfile, type MerchantProfile } from "../checkout/merchant-profiles";
import { runCheckout } from "../checkout/checkout-worker";
import { completeUcpCheckout } from "../checkout/ucp-checkout";
import * as chainGateway from "../clients/chain-gateway-client";
import * as ledger from "../clients/ledger-client";
import * as policy from "../clients/policy-client";
import { discoverMerchantProduct, discoverProduct, discoverShopifyCheckout, type ShopifyUcpCheckout, type SimulatedCompromise } from "../discovery/discover";
import { createRun, emitEvent, getRun, setDiscoveredItem, setOutcome, setRunState } from "./store";

const PAYING_WALLET_ADDRESS = (process.env["PAYING_WALLET_ADDRESS"] ?? "") as Address;
const DEFAULT_CARDHOLDER_NAME = "StraitsX Shopper";
const FIXTURE_BASE_URL = process.env["FIXTURE_BASE_URL"] ?? "http://localhost:4010";
const MIN_BASE_UNITS = 5_000_000n;
const MAX_BASE_UNITS = 30_000_000n;

export type RunFixture = "clean" | "poisoned-recipient" | "poisoned-amount" | "wrong-item";
export const RUN_FIXTURES: readonly RunFixture[] = ["clean", "poisoned-recipient", "poisoned-amount", "wrong-item"];
export type RunSource =
  | { kind: "fixture"; name: RunFixture }
  | { kind: "merchant"; profileId: string }
  | { kind: "shopify"; checkout: ShopifyUcpCheckout };
export type RunInput = { instruction: string; mandateId: string; agentId: string; source: RunSource; cardholderName?: string };
export type StartRunResult = { requestId: string; state: "RUNNING"; streamUrl: string };

type PendingContext = {
  input: RunInput;
  resolvedItem: ResolvedItem;
  cardResult: GetCardResult;
  amountSgd: number;
  profile: MerchantProfile;
};
const pendingEscalations = new Map<string, PendingContext>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function fixtureProductUrl(name: RunFixture): string { return `${FIXTURE_BASE_URL}/fixtures/${name}`; }
function productUrl(source: RunSource): string {
  if (source.kind === "fixture") return fixtureProductUrl(source.name);
  if (source.kind === "merchant") return getMerchantProfile(source.profileId).productUrl;
  return `https://${source.checkout.storeDomain}/checkout-sessions/${source.checkout.checkoutSessionId}`;
}

/** Convert a base-unit decimal string to the MCP's SGD number without rounding or clamping. */
export function exactAmountSgd(priceBaseUnits: string): number {
  if (!/^\d+$/.test(priceBaseUnits)) throw new Error("price must be a base-unit decimal string");
  const units = BigInt(priceBaseUnits);
  if (units < MIN_BASE_UNITS || units > MAX_BASE_UNITS) throw new Error("price must be between 5 and 30 SGD");
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0");
  return Number(`${whole}.${fraction}`);
}

function safeFailure(requestId: string, message: string, freshRequestRequired = false): void {
  setOutcome(requestId, { status: "failed", message, ...(freshRequestRequired ? { freshRequestRequired: true } : {}) });
  setRunState(requestId, "FAILED");
}

export function startRun(input: RunInput): StartRunResult {
  const requestId = randomUUID();
  createRun(requestId, {
    instruction: input.instruction,
    mandateId: input.mandateId,
    agentId: input.agentId,
    source: input.source,
    ...(input.source.kind === "fixture" ? { fixture: input.source.name } : {}),
    ...(input.source.kind === "shopify" ? { checkoutSessionId: input.source.checkout.checkoutSessionId } : {}),
    productUrl: productUrl(input.source),
  });
  void executeRun(requestId, input).catch(() => safeFailure(requestId, "run failed closed before completion"));
  return { requestId, state: "RUNNING", streamUrl: `/run/${requestId}/events` };
}

async function executeRun(requestId: string, input: RunInput): Promise<void> {
  const cardholderName = input.cardholderName ?? DEFAULT_CARDHOLDER_NAME;
  await ledger.createIntent({ requestId, mandateId: input.mandateId, agentId: input.agentId, instruction: input.instruction, createdAt: new Date().toISOString() });
  emitEvent(requestId, { stage: "INTENT_CREATED", status: "ok" });

  // Discovery: fixture/merchant sources scrape a page (C6); a Shopify source takes
  // the merchant-signed UCP checkout snapshot directly — no page is ever rendered.
  const profile = getMerchantProfile(input.source.kind === "merchant" ? input.source.profileId : "local-fixture");
  let discovery;
  if (input.source.kind === "fixture") {
    discovery = await discoverProduct(fixtureProductUrl(input.source.name));
    emitEvent(requestId, { stage: "DISCOVERY_DONE", status: "ok" });
  } else if (input.source.kind === "merchant") {
    discovery = await discoverMerchantProduct(profile);
    emitEvent(requestId, { stage: "DISCOVERY_DONE", status: "ok" });
  } else {
    discovery = await discoverShopifyCheckout(input.source.checkout);
    emitEvent(requestId, { stage: "CHECKOUT_ACQUIRED", status: "ok" });
  }
  setDiscoveredItem(requestId, discovery.resolvedItem);

  // Validation happens before getCard and therefore before any MCP access.
  const amountSgd = exactAmountSgd(discovery.resolvedItem.price);
  const cardResult = await getCard({ walletAddress: PAYING_WALLET_ADDRESS, cardholderName, amountSgd });
  emitEvent(requestId, { stage: "CHALLENGE_RECEIVED", status: "ok" });
  await ledger.attachChallenge(requestId, cardResult.challenge);

  const decision = await policy.requestPayment({
    requestId,
    mandateId: input.mandateId,
    requestedAmount: discovery.simulatedCompromise?.amountOverride ?? cardResult.challenge.amount,
    challenge: requestedChallenge(cardResult.challenge, discovery.simulatedCompromise),
    intent: input.instruction,
    resolvedItem: discovery.resolvedItem,
  });
  const context = { input, resolvedItem: discovery.resolvedItem, cardResult, amountSgd, profile };
  await handleDecision(requestId, context, decision);
}

function requestedChallenge(challenge: X402Requirements, compromise: SimulatedCompromise | null): X402Requirements {
  return compromise?.payToOverride ? { ...challenge, payTo: compromise.payToOverride } : challenge;
}

async function handleDecision(requestId: string, context: PendingContext, decision: policy.PolicyDecision): Promise<void> {
  if (decision.status === "refused") {
    emitEvent(requestId, { stage: "POLICY_DECISION", status: "refused", check: decision.check });
    setOutcome(requestId, { status: "refused", check: decision.check, checkIndex: decision.checkIndex, detail: decision.detail, humanExplanation: decision.humanExplanation });
    setRunState(requestId, "REFUSED");
    return;
  }
  if (decision.status === "escalated") {
    emitEvent(requestId, { stage: "POLICY_DECISION", status: "escalated", check: decision.reason });
    setOutcome(requestId, { status: "escalated", reason: decision.reason, approvalUrl: decision.approvalUrl, expiresAt: decision.expiresAt, ttlSeconds: decision.ttlSeconds });
    setRunState(requestId, "ESCALATED");
    pendingEscalations.set(requestId, context);
    scheduleExpiry(requestId, decision.expiresAt);
    return;
  }
  emitEvent(requestId, { stage: "POLICY_DECISION", status: "ok" });
  await continueSignedRun(requestId, context, decision.header);
}

function scheduleExpiry(requestId: string, expiresAt: number): void {
  const delay = Math.max(0, expiresAt * 1000 - Date.now() + 250);
  const timer = setTimeout(() => { void expireEscalation(requestId); }, delay);
  expiryTimers.set(requestId, timer);
}

async function expireEscalation(requestId: string): Promise<void> {
  if (getRun(requestId)?.state !== "ESCALATED") return;
  try {
    await policy.resolveEscalation(requestId, { decision: "deny" });
  } catch (error) {
    // Policy records the TTL auto-denial before returning 410. Any other failure
    // means we cannot claim that the immutable denial evidence exists.
    if (!(error instanceof AppError) || error.statusCode !== 410) {
      pendingEscalations.delete(requestId);
      expiryTimers.delete(requestId);
      safeFailure(requestId, "policy-service could not record escalation expiry; run failed closed");
      return;
    }
  }
  finalizeExpiredEscalation(requestId);
}

function finalizeExpiredEscalation(requestId: string): void {
  pendingEscalations.delete(requestId);
  expiryTimers.delete(requestId);
  setOutcome(requestId, { status: "refused", check: "escalation_expired", checkIndex: null, detail: "approval deadline elapsed; policy-service auto-denied the escalation", humanExplanation: "The approval request expired. Nothing was signed and no money moved." });
  setRunState(requestId, "REFUSED");
}

export async function resolveRunEscalation(requestId: string, body: {
  decision: "approve" | "deny";
  approvedBy?: string;
  signature?: string;
  standingApproval?: { scope: "once" | "merchant-window" };
}): Promise<{ state: string }> {
  const context = pendingEscalations.get(requestId);
  if (!context || getRun(requestId)?.state !== "ESCALATED") throw new Error("run has no pending escalation");
  let decision: policy.EscalationDecision;
  try {
    decision = await policy.resolveEscalation(requestId, body);
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 410) {
      const timer = expiryTimers.get(requestId);
      if (timer) clearTimeout(timer);
      finalizeExpiredEscalation(requestId);
      return { state: "REFUSED" };
    }
    // Preserve the pending context and expiry timer so a transient policy error
    // cannot strand the run or silently bypass the deadline.
    throw error;
  }
  const timer = expiryTimers.get(requestId);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(requestId);
  pendingEscalations.delete(requestId);
  if (decision.status === "signed") {
    setRunState(requestId, "RUNNING");
    setOutcome(requestId, { status: "checkout-pending", settlementTx: "pending", cardOpaqueId: "pending" });
    await continueSignedRun(requestId, context, decision.header);
  } else if (decision.status === "refused") {
    setOutcome(requestId, { status: "refused", check: decision.check, checkIndex: decision.checkIndex, detail: decision.detail, humanExplanation: decision.humanExplanation });
    setRunState(requestId, "REFUSED");
  } else {
    throw new Error("policy-service returned a second escalation while resolving one");
  }
  return { state: getRun(requestId)?.state ?? "FAILED" };
}

async function continueSignedRun(requestId: string, context: PendingContext, header: string): Promise<void> {
  let signedHeader = header;
  try {
    // Seamless issuer settlement: the StraitsX virtual card is issued immediately on
    // the signed authorization (no blocking on on-chain confirmation), so it is live
    // for the merchant checkout at once. Settlement is FINALIZED at capture time,
    // after the card is spent: the on-chain transfer is then verified independently
    // and the capture recorded — the run is DONE only after that (fail-closed).
    const issued = await payAndIssue({ cardapiUrl: context.cardResult.cardapiUrl, header: signedHeader, amountSgd: context.amountSgd, cardholderName: context.input.cardholderName ?? DEFAULT_CARDHOLDER_NAME });
    signedHeader = "";
    if (!issued.ok) return safeFailure(requestId, "cardapi rejected the signed authorization; start a fresh request", true);
    emitEvent(requestId, { stage: "CARD_ISSUED", status: "ok" });

    setRunState(requestId, "AWAITING_CHECKOUT");
    setOutcome(requestId, { status: "checkout-pending", settlementTx: issued.settlementTx, cardOpaqueId: issued.cardOpaqueId });

    const spend = context.input.source.kind === "shopify"
      ? await completeUcpCheckout({
          requestId,
          checkout: context.input.source.checkout,
          cardOpaqueId: issued.cardOpaqueId,
          settlementTx: issued.settlementTx,
          onDomainAsserted: () => emitEvent(requestId, { stage: "CHECKOUT_ASSERTED", status: "ok" }),
        })
      : await runCheckout({
          requestId,
          profile: context.profile,
          resolvedItem: context.resolvedItem,
          cardOpaqueId: issued.cardOpaqueId,
          settlementTx: issued.settlementTx,
          walletAddress: PAYING_WALLET_ADDRESS,
          viewCard,
          onDomainAsserted: () => emitEvent(requestId, { stage: "CHECKOUT_ASSERTED", status: "ok" }),
        });
    await ledger.recordSpend(spend);
    emitEvent(requestId, { stage: "SPEND_RECORDED", status: "ok" });

    // Capture-time settlement finalization. Only after the transfer is independently
    // verified does the run reach DONE; a mismatch is terminal and must not be retried.
    const confirmation = await chainGateway.confirmSettlement({
      txHash: issued.settlementTx,
      chainId: context.cardResult.challenge.chainId,
      expect: { asset: context.cardResult.challenge.asset, to: context.cardResult.challenge.payTo, amount: context.cardResult.challenge.amount },
    });
    if (!confirmation.ok || !confirmation.transferMatched) {
      emitEvent(requestId, { stage: "SETTLEMENT_FINALIZED", status: "refused", check: "TRANSFER_MISMATCH" });
      return safeFailure(requestId, "capture-time settlement verification failed; the transfer did not match the signed authorization", true);
    }
    await ledger.recordSettlement({ requestId, settlementTx: issued.settlementTx, blockNumber: confirmation.blockNumber, cardOpaqueId: issued.cardOpaqueId, rawToolResultHash: context.cardResult.rawToolResultHash });
    await ledger.recordCapture({ requestId, orderId: spend.orderId, capturedAt: spend.observedAt, settlementTx: issued.settlementTx, blockNumber: confirmation.blockNumber });
    emitEvent(requestId, { stage: "SETTLEMENT_FINALIZED", status: "ok" });
    setOutcome(requestId, { status: "signed", settlementTx: issued.settlementTx, cardOpaqueId: issued.cardOpaqueId });
    setRunState(requestId, "DONE");
  } catch {
    signedHeader = "";
    safeFailure(requestId, "post-signature processing failed; start a fresh request", true);
  }
}
