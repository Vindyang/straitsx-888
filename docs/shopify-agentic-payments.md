# Shopify Agentic Commerce — compatibility & seamless StraitsX card settlement

Status: proposed (shaping) · Date: 2026-08-16 · Owners: Module C (orchestrator/dashboard), A (signer/chain), B (policy/ledger)

This document records the research on Shopify's agentic-payment protocol, how the
StraitsX pipeline is shaped to be compatible with it, and the seamless card-issuer
settlement design that was implemented. It supersedes the Amazon-oriented framing
(discovery by scraping, checkout by Playwright auto-fill) for agentic merchants;
fixture and merchant-profile sources stay supported for the local demo.

## 1. Research: how Shopify does agentic payments

### 1.1 Universal Commerce Protocol (UCP) — the negotiation layer

Shopify's agentic commerce is built on **UCP (Universal Commerce Protocol)**,
co-developed with Google and specified at `ucp.dev` (versions date-stamped, e.g.
`2026-04-08`). Key mechanics:

- **Profiles and negotiation.** The merchant publishes a business profile at
  `{shop}.myshopify.com/.well-known/ucp`; the agent platform publishes a profile
  at its own HTTPS URL and sends it in `meta.ucp-agent.profile` on every request.
  Negotiation is server-selects: the business intersects its services/capabilities
  with the platform's (capability names, versions, `extends` pruning) and the
  active set is returned.
- **Shopping as UCP-shaped MCP tools.** Catalog search/lookup (Catalog API — open,
  API-key only, no approval), Universal Cart, carts → checkouts, order webhooks +
  `get_order` for monitoring. Missing carts/checkouts can escalate to a human
  ("dynamic handoff").
- **Payment handlers are negotiated, not prescribed.** The merchant advertises
  `payment.handlers` (e.g. `dev.shopify.shop_pay`, `google_pay`); custom handlers
  are an open extension point ("any payment processor, any wallet").

### 1.2 Shop Pay handler spec (`dev.shopify.shop_pay`, dated 2026-04-08)

- Merchant config: `{ shop_id }`. Shopify merchants get all handlers auto-advertised.
- Platform token acquisition:
  - **Path A — one-time**: platform registers for a `client_id`, builds a payment
    request (totals, fulfillment, line items, currency/locale), hands it to the
    buyer through the Shop Pay interface; a **single-use, checkout-scoped,
    time-limited token** comes back.
  - **Path B — identity-linked**: UCP Identity Linking; durable token scoped to the
    buyer's Shop identity, reusable across checkouts (autonomous mode).
- **Submission** — the payment instrument is posted as `payment_data` to the
  merchant's `complete` endpoint:

  ```
  POST /checkout-sessions/{checkout_id}/complete
  UCP-Platform: profile="https://.../platform-profile.json"
  { "payment_data": { "id", "handler_id", "type": "shop_pay", "selected": true,
      "credential": { "type": "shop_token", "token": "shop_..." } } }
  ```

  Merchant validates handler, extracts token, processes, returns completed
  checkout state with an `order_id`.

### 1.3 AP2 (Agent Payments Protocol v0.2, Google) — the authorization layer

AP2 is explicitly "designed to be compatible with UCP" and is what converts a
checkout into *evidence*:

- Two SD-JWT mandates per purchase: a **Checkout Mandate** (merchant proof the
  agent may buy this checkout — bound to the merchant-signed checkout JWT by hash)
  and a **Payment Mandate** (credential-provider/network/PSP proof the agent may
  pay — bound to the same checkout hash). ECDSA (non-deterministic) signing is
  required for the checkout JWT to prevent rainbow attacks.
- Roles: User, Shopping Agent, Trusted Surface, Credential Provider, Network,
  Merchant Payment Processor.
- Modes: **Direct** (human present: user signs closed mandates on a trusted
  surface) and **Autonomous** (human not present: user signs *open* mandates with a
  `cnf` agent key; the agent closes them). Our single-click confirmation at the
  product card is the Direct-mode analogue; a standing approval is the
  Autonomous-mode analogue.
- Dispute evidence: Checkout Mandate + Receipt + Payment Mandate + Receipt bind to
  one hash chain. Extension points: arbitrary checkout objects, payment instrument
  types, VDC formats.

### 1.4 Where this repo fits

| UCP/AP2 role | StraitsX component |
|---|---|
| Shopping Agent (negotiation, cart, checkout) | StarNote agent (upstream repo — outside this repo) |
| Trusted Surface (single-click confirm, mandate display) | StarNote chat/product card + dashboard |
| Credential Provider (verifies Payment Mandate, issues card credential) | **This repo**: policy-service (9 checks), signer-service (KMS EIP-3009), card-gateway (cardapi) |
| Payment instrument (network-token virtual card) | StraitsX virtual card (sandbox cardapi; Visa/Mastercard network token in prod) |
| Settlement rails | Card network (issuer → PSP); EIP-3009 funding leg from the mandate |
| Receipt/record | ledger-service (intent, settlement, capture, spend) + dashboard receipt |

The merchant side (storefront `/.well-known/ucp`, checkout JWT signing by the
merchant, PSP processing) is Shopify's domain — we are the platform/credential side.

## 2. Architecture shaping for compatibility

### 2.1 Source model

`POST /api/run` (dashboard proxy → orchestrator `POST /run`) now accepts a third
source kind:

```
"source": {
  "kind": "shopify",
  "checkout": {
    "storeDomain": "water.example",        # policy pins this (checks 1–2)
    "checkoutSessionId": "cs_abc123XYZ456",# UCP session the agent opened
    "title": "500ml Stainless Steel Water Bottle",
    "sku": "BTL-500-SS",
    "totalBaseUnits": "15000000",          # merchant-signed UCP total (SGD)
    "currency": "SGD",
    "checkoutJwt": "<merchant-signed UCP checkout JWT, optional in sandbox>"  # AP2 binding
  }
}
```

The agent (StarNote) does the UCP shopping leg (catalog → cart → checkout) and
hands the orchestrator the checkout snapshot; the pipeline never renders a page, so
the page-injection surface (`data-injection`, simulated compromise tests) does not
exist for this path at all.

### 2.2 Stage machine (implemented)

New stage set (`services/agent-orchestrator/src/run/store.ts`):

```
INTENT_CREATED → CHECKOUT_ACQUIRED* → CHALLENGE_RECEIVED → POLICY_DECISION
→ CARD_ISSUED → CHECKOUT_ASSERTED → SPEND_RECORDED → SETTLEMENT_FINALIZED
(* DISCOVERY_DONE for fixture/merchant sources)
```

- `CHECKOUT_ACQUIRED` — Shopify/UCP checkout snapshot accepted (no Playwright).
- `SETTLEMENT_FINALIZED` — capture-time settlement: replaces `SETTLEMENT_CONFIRMED`
  (which used to run *before* the card was issued and blocked checkout on it).

### 2.3 Checkout completion (UCP)

`services/agent-orchestrator/src/checkout/ucp-checkout.ts` submits the StraitsX
virtual card as a custom UCP payment instrument to the merchant's `complete`
endpoint (domain pinned to the policy-committed `storeDomain`, or an allowlisted
relay via `UCP_CHECKOUT_RELAY_HOSTS`):

```
POST https://{storeDomain}/checkout-sessions/{id}/complete
{ "payment_data": { "id": "instr_straitsx_{requestId}", "handler_id": "straitsx_card",
    "type": "straitsx_card", "selected": true,
    "credential": { "type": "card_network_token", "token": "tok_straitsx_{cardOpaqueId}",
                    "settlementTx": "0x…" } } }
```

Productization notes (not built): shop-level Playwright fallback still exists for
fixture/merchant demo sources; `UCP_CHECKOUT_API_URL`, `UCP_PLATFORM_PROFILE_URL`
(as the platform profile), Shop Pay Path A/B, and AP2 mandate assembly (SD-JWT +
checkout JWT hash binding, `checkoutJwt` field reserved above) are the next layer.

## 3. Seamless card-issuer settlement (implemented)

Design goal: the StraitsX virtual card must be **usable the instant the signed
authorization exists**, while settlement is **finalized and verified at capture
time** (when the merchant actually captures the card payment) — no blocking before
checkout, no manual top-ups.

### 3.1 Flow (orchestrator `continueSignedRun`)

1. **Card issued on signature, not on settlement.** `payAndIssue` returns the card +
   `settlementTx`; `CARD_ISSUED` is emitted immediately (previously the run blocked
   on `confirmSettlement` here). State → `AWAITING_CHECKOUT`, card is live.
2. **Checkout.** Fixture/merchant: Playwright (`runCheckout`). Shopify: UCP
   `completeUcpCheckout` with the network-token instrument. `CHECKOUT_ASSERTED`
   then `SPEND_RECORDED` as before.
3. **Capture-time finalization.** `chainGateway.confirmSettlement` independently
   verifies the EIP-3009 `Transfer` log (fails closed on mismatch). Only then:
   - ledger `recordSettlement` (settlementTx, blockNumber, cardOpaqueId, rawToolResultHash)
   - ledger `recordCapture` → new `POST /intent/:requestId/capture` (B9b)
   - `SETTLEMENT_FINALIZED` → `DONE`.
   A `TRANSFER_MISMATCH` emits `SETTLEMENT_FINALIZED` (refused) and the run FAILs
   closed with `freshRequestRequired` — the transfer is the money leg; the card
   spend already happened, so nothing is replayed.

### 3.2 Ledger

- `IntentState` gains `CAPTURED` — append-only after `SETTLED`.
- `POST /intent/:requestId/capture` (`{orderId, capturedAt, settlementTx?, blockNumber?}`):
  - `404` unknown intent; `400` missing orderId/capturedAt
  - `409 CAPTURE_EXISTS` (append-only)
  - `409 SETTLEMENT_NOT_RECORDED` (settlement must precede capture)
  - `409 SETTLEMENT_MISMATCH` (capture settlementTx ≠ recorded settlement)
- Receipt already exposes settlementTx/blockNumber/cardOpaqueId; `capture` is
  retrievable via `GET /intent/:requestId`.
- Transparency: the live Ledger page streams every step (`challenge.attached` →
  `decision.recorded` → `settlement.recorded` → `spend.recorded` → `capture.recorded`)
  via SSE (`GET /ledger/events`, proxied behind `GET /api/ledger/events`) so the
  capture-time finalization is visible to the user as it lands.

### 3.3 Why this is safe (unchanged invariants)

- The signature leg is unchanged: KMS-signed EIP-3009 `TransferWithAuthorization`,
  commitment nonce, nonce terminal after signature — nothing weaker.
- The card is only displayed/spent after a real signed header was accepted by
  cardapi; the money the card spends is funded by the same transfer.
- The run is **DONE only after** the transfer is independently verified (fail-closed
  moved from pre-checkout to capture-time). `REFUSED`/`FAILED` remain terminal.
- Seamlessness is opt-in per source: fixture/merchant runs behave unchanged except
  the settlement leg now finalizes post-checkout (same verification, later).

## 4. Removed

`infra/agent-service` (the duplicated StarNote Lambda agent service) was removed per
owner decision — the StarNote repo owns the agent service; this repo owns the
pipeline, dashboard, and card settlement layer.