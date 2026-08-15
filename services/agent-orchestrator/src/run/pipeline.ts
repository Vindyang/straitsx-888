/**
 * C5 — the run pipeline. Sequence, exactly (owner-c-tasks.md C5):
 *
 *   createIntent -> discovery -> card-gateway.getCard -> attachChallenge ->
 *   policy-service -> retry cardapi with header -> chain-gateway
 *   .confirmSettlement -> render card -> assertCheckoutDomain ->
 *   captureSpendAttestation
 *
 * The intent is created BEFORE the challenge is fetched — check 8 depends on
 * that ordering. Holds no key, makes no decisions: every refusal/escalation
 * comes back from policy-service, this module only routes to it.
 */

import { randomUUID } from "node:crypto";
import { getCard, payAndIssue, viewCard } from "../card-gateway/index";
import * as chainGateway from "../clients/chain-gateway-client";
import * as ledger from "../clients/ledger-client";
import * as policy from "../clients/policy-client";
import { discoverProduct } from "../discovery/discover";
import { assertCheckoutDomain } from "../post-issuance/assert-checkout-domain";
import { captureSpendAttestation } from "../post-issuance/capture-spend-attestation";
import { createRun, emitEvent, setDiscoveredItem, setOutcome, setRunState } from "./store";

const PAYING_WALLET_ADDRESS = process.env["PAYING_WALLET_ADDRESS"] ?? "";
const DEFAULT_CARDHOLDER_NAME = "StraitsX Shopper";
const FIXTURE_BASE_URL = process.env["FIXTURE_BASE_URL"] ?? "http://localhost:4010";
const AMOUNT_MIN_SGD = 5;
const AMOUNT_MAX_SGD = 30;

export type RunFixture = "clean" | "poisoned-recipient" | "poisoned-amount" | "wrong-item";

export const RUN_FIXTURES: readonly RunFixture[] = [
  "clean",
  "poisoned-recipient",
  "poisoned-amount",
  "wrong-item",
];

export type RunInput = {
  instruction: string;
  mandateId: string;
  agentId: string;
  fixture: RunFixture;
  cardholderName?: string | undefined;
};

export type StartRunResult = { requestId: string; state: "RUNNING"; streamUrl: string };

/** api-contracts.md §8 `POST /run` — returns immediately; the pipeline runs in
 *  the background and is observed via GET /run/:requestId/events (C8). */
function fixtureProductUrl(fixture: RunFixture): string {
  return `${FIXTURE_BASE_URL}/fixtures/${fixture}`;
}

export function startRun(input: RunInput): StartRunResult {
  const requestId = randomUUID();
  createRun(requestId, {
    instruction: input.instruction,
    mandateId: input.mandateId,
    agentId: input.agentId,
    fixture: input.fixture,
    productUrl: fixtureProductUrl(input.fixture),
  });
  void executeRun(requestId, input).catch((err) => {
    setRunState(requestId, "FAILED");
    setOutcome(requestId, { status: "failed", message: err instanceof Error ? err.message : String(err) });
    // eslint-disable-next-line no-console
    console.error(`run ${requestId} failed`, err);
  });
  return { requestId, state: "RUNNING", streamUrl: `/run/${requestId}/events` };
}

async function executeRun(requestId: string, input: RunInput): Promise<void> {
  const { instruction, mandateId, agentId, fixture } = input;
  const cardholderName = input.cardholderName ?? DEFAULT_CARDHOLDER_NAME;

  // Stage 1 — create the intent BEFORE fetching the challenge (check 8 ordering).
  await ledger.createIntent({ requestId, mandateId, agentId, instruction, createdAt: new Date().toISOString() });
  emitEvent(requestId, { stage: "INTENT_CREATED", status: "ok" });

  // Stage 2 — discovery. Every byte from the page is untrusted DATA, never
  // instruction: discoverProduct() only ever reads fixed data-* attributes.
  const productUrl = fixtureProductUrl(fixture);
  const { resolvedItem, simulatedCompromise } = await discoverProduct(productUrl);
  setDiscoveredItem(requestId, resolvedItem);
  emitEvent(requestId, { stage: "DISCOVERY_DONE", status: "ok" });

  // Stage 3 — card-gateway.getCard. amountSgd is derived from discovery,
  // clamped to the MCP tool's 5-30 SGD band (a cheap shortcut per
  // execution_plan.md §15 step 8 — out-of-band prices fail fast).
  const amountSgd = clampAmountSgd(resolvedItem.price);
  const { cardapiUrl, challenge, rawToolResultHash } = await getCard({
    walletAddress: PAYING_WALLET_ADDRESS,
    cardholderName,
    amountSgd,
  });
  void rawToolResultHash; // kept for the receipt once C13 exists; not logged.
  emitEvent(requestId, { stage: "CHALLENGE_RECEIVED", status: "ok" });
  await ledger.attachChallenge(requestId, challenge);

  // C7's poison harness: a compromised agent would submit a corrupted request
  // here instead of the true MCP challenge. `challenge` itself is NEVER
  // mutated by this — it's always exactly what getCard() returned from
  // StraitsX. Only the values sent to policy-service are corrupted, so the
  // real getCard()/challenge path stays provably untouched by page content,
  // and policy-service's check4/check5 have something real to refuse.
  const requestedChallenge = simulatedCompromise?.payToOverride
    ? { ...challenge, payTo: simulatedCompromise.payToOverride }
    : challenge;
  const requestedAmount = simulatedCompromise?.amountOverride ?? challenge.amount;

  // Stage 4 — the decision point.
  const decision = await policy.requestPayment({
    requestId,
    mandateId,
    requestedAmount,
    challenge: requestedChallenge,
    intent: instruction,
    resolvedItem,
  });

  if (decision.status === "refused") {
    emitEvent(requestId, { stage: "POLICY_DECISION", status: "refused", check: decision.check });
    setOutcome(requestId, {
      status: "refused",
      check: decision.check,
      checkIndex: decision.checkIndex,
      detail: decision.detail,
      humanExplanation: decision.humanExplanation,
    });
    setRunState(requestId, "REFUSED");
    return;
  }
  if (decision.status === "escalated") {
    emitEvent(requestId, { stage: "POLICY_DECISION", status: "escalated", check: decision.reason });
    setOutcome(requestId, {
      status: "escalated",
      reason: decision.reason,
      approvalUrl: decision.approvalUrl,
      expiresAt: decision.expiresAt,
      ttlSeconds: decision.ttlSeconds,
    });
    setRunState(requestId, "ESCALATED");
    return;
  }
  emitEvent(requestId, { stage: "POLICY_DECISION", status: "ok" });

  // Stage 5 — retry cardapi with the signed header. The header authorizes the
  // REAL challenge (payTo = StraitsX); a corrupted requestedChallenge never
  // reaches cardapi, because policy-service already refused it above.
  const issued = await payAndIssue({ cardapiUrl, header: decision.header, amountSgd, cardholderName });
  if (!issued.ok) {
    setOutcome(requestId, { status: "failed", message: "cardapi rejected the signed header (fresh 402 returned)" });
    setRunState(requestId, "FAILED");
    return;
  }
  emitEvent(requestId, { stage: "CARD_ISSUED", status: "ok" });

  // Stage 6 — verify settlement independently rather than trusting cardapi's claim.
  const confirmation = await chainGateway.confirmSettlement({
    txHash: issued.settlementTx,
    chainId: challenge.chainId,
    expect: { asset: challenge.asset, to: challenge.payTo, amount: challenge.amount },
  });
  await ledger.recordSettlement({
    requestId,
    settlementTx: issued.settlementTx,
    blockNumber: confirmation.blockNumber,
    cardOpaqueId: issued.cardOpaqueId,
  });
  emitEvent(requestId, { stage: "SETTLEMENT_CONFIRMED", status: confirmation.ok ? "ok" : "refused" });

  // Stage 7 — render card at the moment of checkout, never earlier. The
  // returned iframeUrl is deliberately never logged, persisted, or included
  // in an event payload (docs/conventions.md "Never" list).
  await viewCard({
    cardOpaqueId: issued.cardOpaqueId,
    settlementTx: issued.settlementTx,
    walletAddress: PAYING_WALLET_ADDRESS,
  });

  // Stage 8 — post-issuance controls (C9). This pipeline navigated straight to
  // the URL discovery resolved, so this call trivially matches by construction
  // — it's exercised here mainly to keep the stage in the event stream. The
  // REAL enforcement point is POST /checkout/assert (routes/checkout.ts),
  // called by whatever fills the card into the actual browser session at
  // checkout with the page it is ACTUALLY on; assertCheckoutDomain() itself is
  // unit-tested against a genuine mismatch in test/post-issuance.
  const assertion = assertCheckoutDomain({
    currentUrl: resolvedItem.checkoutUrl,
    matchedCheckoutUrl: resolvedItem.checkoutUrl,
    matchedDomain: resolvedItem.merchantDomain,
  });
  if (!assertion.allowed) {
    emitEvent(requestId, { stage: "CHECKOUT_ASSERTED", status: "refused", check: "DOMAIN_MISMATCH" });
    setOutcome(requestId, {
      status: "refused",
      check: "DOMAIN_MISMATCH",
      checkIndex: null,
      detail: `current page did not match the discovered checkout URL ${assertion.matchedAgainst}`,
      humanExplanation: "The card was not filled in because the page did not match where the item was found.",
    });
    setRunState(requestId, "REFUSED");
    return;
  }
  emitEvent(requestId, { stage: "CHECKOUT_ASSERTED", status: "ok" });

  const spend = await captureSpendAttestation(requestId, resolvedItem);
  await ledger.recordSpend(spend);
  emitEvent(requestId, { stage: "SPEND_RECORDED", status: "ok" });

  setOutcome(requestId, { status: "signed", settlementTx: issued.settlementTx, cardOpaqueId: issued.cardOpaqueId });
  setRunState(requestId, "DONE");
}

function clampAmountSgd(priceBaseUnits: string): number {
  const dollars = Number(BigInt(priceBaseUnits)) / 1_000_000;
  const rounded = Math.round(dollars);
  return Math.min(AMOUNT_MAX_SGD, Math.max(AMOUNT_MIN_SGD, rounded));
}
