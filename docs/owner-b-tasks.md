# Owner B — Task Board: Decisions and Records

**Scope:** policy-service · ledger-service
**Interfaces:** [api-contracts.md §5–§6](api-contracts.md) · **Checks:** [execution_plan.md §8](execution_plan.md)

**policy-service is the project.** Everything else moves money or draws pixels; you decide
whether money is allowed to move. The eight checks are the deliverable — not the happy path.

**Task ID format:** `B<n>`. ⛔ marks tasks that block someone else.

---

## Dependency map

```
B1 stubs ⛔ ─────────────► unblocks Owner C's orchestrator
B2 hashPolicy ⛔ ────────► Owner C's dashboard (check 2 fails forever if this drifts)
B3–B9 ledger ───────────► B10+ policy
B10–B19 the 8 checks ───► CHECKPOINT 4 (the demo)
B20 escalation ─────────► Run 4 (stretch)
```

**You consume from Owner A:** `chain-gateway` (4004), `signer-service` (4003).
**You consume from Owner C:** the parsed `challenge` and `resolvedItem`.
**You publish:** `POST /payment/request` — the single decision endpoint the whole demo hangs on.

---

# Phase 0 — Hour 0–1

### B1 ⛔ Stub ledger-service and policy-service
**Estimate:** 45 min · **Blocks:** Owner C

- [ ] `ledger-service` on **4001** — in-memory `Map`, real routes, real response shapes
- [ ] `policy-service` on **4002** — `POST /payment/request` always returns
      `{ status: "signed", header: "stub", nonce: "0x00…" }`
- [ ] Both `GET /health`
- [ ] Announce: *"stubs up — 4001 ledger, 4002 policy"*

### B2 ⛔ `hashPolicy` in `packages/contracts/mandate.ts`
**Estimate:** 1 h · **Blocks:** Owner C's dashboard · **Do this on hour one**

- [ ] Implement `serialise(mandate)` and `hashPolicy(mandate)`
- [ ] **Agree key order, number encoding and string casing ONCE.** Write them down in the file.
- [ ] Include `intentConstraint` and `merchantAllowlist` in the hashed body
- [ ] Write a **round-trip test**: dashboard-shaped input → same hash as policy-service
- [ ] Nobody reimplements this. Not in the dashboard, not anywhere.

> **This is the classic integration bug.** If the dashboard serialises a mandate differently
> from how you hash it, **check 2 fails permanently and looks like a contract problem for
> hours** ([execution_plan.md §13](execution_plan.md)). One hour now saves four on Sunday.

---

# Phase 1 — ledger-service (storage and write constraints only, no validation logic)

### B3 `POST /intent` + `GET /intent/:requestId`
**Estimate:** 1 h

- [ ] Write `{ requestId, mandateId, agentId, instruction, createdAt }`
- [ ] Compute and store `instructionHash`
- [ ] **Append-only:** duplicate `requestId` → `409 INTENT_EXISTS`, never an update
- [ ] Nothing may edit an instruction after write — **including the agent**

### B4 `POST /intent/:requestId/challenge`
**Estimate:** 30 min · **Depends on:** B3

- [ ] Attach the parsed `X402Requirements`, record `challengeAttachedAt`
- [ ] `409 CHALLENGE_EXISTS` if already attached
- [ ] **Reject attaching to a non-existent intent** — this is what makes check 8 enforceable

### B5 `POST /intent/:requestId/nonce` — the replay boundary
**Estimate:** 1 h · **Depends on:** B3 · **Source: [§10](execution_plan.md)**

- [ ] **Real conditional write** — DynamoDB `attribute_not_exists` or a Postgres unique index
- [ ] **Not** a read-then-write. A race here is a double settlement.
- [ ] Second reservation → `409 NONCE_ALREADY_RESERVED`
- [ ] Test it **concurrently**, not sequentially

### B6 `POST /intent/:requestId/release-nonce`
**Estimate:** 45 min · **Depends on:** B5 · **Source: [§10](execution_plan.md)**

- [ ] Permitted **only before a signature exists** (after reserve, before signer returns)
- [ ] Use for pre-signing failures: signer call errored, conditional-write conflict
- [ ] **After a signature exists → `409 NONCE_BURNED`.** The intent is terminal.
- [ ] `getWindowUsage` must **never** count a released nonce as spent

> A signed EIP-3009 authorization is **live even if never submitted**. If the cardapi retry
> fails *after* signing, do not reuse the intent or the nonce — the orchestrator rotates to a
> **fresh `requestId`**. Two live signatures for the same amount would both settle.

### B7 `GET /window/:mandateId`
**Estimate:** 45 min

- [ ] Return `{ windowSeconds, windowStartedAt, spent, cardCount, remaining }`
- [ ] Rolling window keyed on `mandateId`
- [ ] Exclude released nonces (B6)

### B8 `POST /decision`
**Estimate:** 30 min

- [ ] Append `{ requestId, decision, check?, detail?, decidedAt }`, return a `sequence`
- [ ] **Record every outcome — refusals included.** Refusals are the demo.

### B9 `POST /intent/:requestId/settlement`, `/spend`, `GET /receipt/:requestId`
**Estimate:** 1.5 h

- [ ] `/settlement`: `{ settlementTx, blockNumber, cardOpaqueId }`
- [ ] `/spend` *(stretch, checkpoint 6)*: `{ merchantDomain, orderTotal, itemSku, orderId, observedAt }`
- [ ] `/receipt`: assemble the full receipt per [api-contracts.md §5](api-contracts.md)
- [ ] `spendLeg.proof` is **always `"none"`** — do not label an observation as proof
- [ ] `authorization` is a **sibling of** `challenge`, not nested inside it

> **Schema correction.** The original receipt put `validAfter`/`validBefore` inside
> `challenge`. The real 402 contains **neither** — only `maxTimeoutSeconds`
> ([execution_plan.md §19.3](execution_plan.md)). The window is *our* choice, so it belongs
> under `authorization`.

---

# Phase 2 — policy-service: the eight checks

Each check is a **pure function** `(ctx) => null | { check, detail }`, unit-tested in
isolation. Order matters: cheapest and most damning first.

### B10 Wire the decision pipeline
**Estimate:** 1.5 h · **Depends on:** B3–B8

- [ ] Order of operations, exactly:
      precondition → parse challenge → load policy + window usage → read registry →
      checks 1–8 → intent-match gate (9) → compute + reserve nonce → call signer →
      record decision
- [ ] Every path writes a `POST /decision`
- [ ] Refusal → `422`, escalation → `202`, signed → `200`

> ### ⚠️ NONCE — changed 2026-08-15 (A17 decided). Action required here.
>
> **policy-service computes the nonce. It is no longer random.**
>
> ```ts
> intentHash = keccak256(utf8(verbatimHumanInstruction))
> nonce = keccak256(concat([
>   keccak256(utf8(requestId)),
>   policyHash,
>   intentHash,
>   keccak256(utf8(merchantDomain)),
> ]))
> ```
>
> Pass it in the `POST /sign` request as before — the signer treats `nonce` as opaque
> `bytes32` and is unchanged by this. **One line on your side, none on Owner A's.**
>
> **Why it matters if you miss it:** with a random nonce the settlement is still replay-safe,
> but the link between the on-chain transfer and the human's intent exists *only in our
> database*. With the commitment, anyone holding the receipt can recompute the nonce and check
> it against the `nonce` in the settled `transferWithAuthorization` — the chain itself proves
> which mandate and which intent authorised that payment. That verifiability is the point of
> the receipt, and a random nonce silently forfeits it while everything still appears to work.
>
> **Reservation is unchanged.** The commitment makes the nonce *meaningful*, not
> *unique-by-construction*: the same `requestId` deliberately recomputes the same nonce, so
> the conditional-write reservation (B5) is still what stops a second live authorisation. A
> retry with the same `requestId` is idempotent by design; a post-signature failure rotates to
> a **fresh `intentId`**, which yields a genuinely different nonce
> ([execution_plan.md §10](execution_plan.md)).
>
> Full rationale: [execution_plan.md §10](execution_plan.md) "Nonce strategy — RESOLVED".

### B11 Precondition — `precondition_intent_exists`
**Estimate:** 20 min

- [ ] An intent record exists for `requestId`
- [ ] Needs **no on-chain data and no policy body** — runs first to short-circuit the common
      orphan-signature case (the cheap half of check 8)

### B12 Check 1 — `check1_mandate_live`
**Estimate:** 30 min · **Depends on:** A7

- [ ] Exists · `revoked == false` **on-chain** · `now < expiresAt`
- [ ] Read through chain-gateway every time — **never cache revocation state.** Run 3 depends
      on a revoke landing within one block.

### B13 Check 2 — `check2_policy_hash`
**Estimate:** 30 min · **Depends on:** B2

- [ ] `hashPolicy(localPolicy) === registry.policyHash`
- [ ] Defeats a tampered local copy, **including a tampered `intentConstraint`**

### B14 Check 3 — `check3_chain_asset`
**Estimate:** 20 min

- [ ] `challenge.chainId === mandate.chainId`
- [ ] `challenge.asset === mandate.asset` (compare **lowercased**)

### B15 Check 4 — `check4_recipient_pinned` — **THE IMPORTANT ONE**
**Estimate:** 30 min · **This is demo Run 2**

- [ ] `challenge.payTo === mandate.settlementRecipient` (lowercased compare)
- [ ] `detail` must name **both** addresses — the refusal panel shows it to the judge
- [ ] Write `humanExplanation` in plain language

> Defeats a compromised agent substituting a different challenge — a spoofed cardapi URL or a
> constructed challenge naming an attacker address. **Framing to keep honest:** a product page
> cannot rewrite the MCP response; what it can do is make the agent *ask for a different
> payment*, and check 4 catches that.

### B16 Check 5 — `check5_amount_bounds`
**Estimate:** 30 min

- [ ] `5 XSGD <= amount <= min(maxPerCard, 30 XSGD)` — the **security boundary**
- [ ] `challenge.amount === requestedAmount` — a **consistency** check that detects a
      mid-flight rewrite, not a malicious agent
- [ ] Compare as base-unit strings/BigInt. **6 decimals** — `"5000000"` is 5 XSGD.

### B17 Check 6 — `check6_window_budget` → **escalates, does not refuse**
**Estimate:** 45 min · **Depends on:** B7

- [ ] `spent + amount <= maxPerWindow` **and** `cardCount < maxCardsPerWindow`
- [ ] On failure return `202 escalated` with `reason: "WINDOW_BUDGET_EXCEEDED"` — **not a refusal**

### B18 Check 7 — `check7_validity_sane`
**Estimate:** 45 min · **Needs A16's latency measurement**

- [ ] Compute the window: `min(mandate.maxAuthValiditySeconds, challenge.maxTimeoutSeconds)`
- [ ] Set `validAfter = now - 5`, `validBefore = validAfter + window`
- [ ] Set `maxAuthValiditySeconds` from **Owner A's measured `202`→settlement latency**, not a
      round number

> **You compute this window — you do not read it.** The 402 has no `validAfter`/`validBefore`.
> Check 7 validates your own choice. A long window is a signed cheque left lying around.

### B19 Check 8 — `check8_intent_bound`
**Estimate:** 20 min · **Depends on:** B4

- [ ] Intent `createdAt` is **strictly before** `challengeAttachedAt`
- [ ] No orphan signatures

---

# Phase 3 — Escalation (check 9 and the human loop)

### B20 Check 9 — `check9_intent_match` *(stretch — Run 4)*
**Estimate:** 2 h · **Source: [§12b 2.3](execution_plan.md)**

- [ ] **Structured extraction, never raw concatenation.** Parse both `resolvedItem` and
      `intentConstraint` into `{ title, sku, price, merchantDomain }` and compare
      **field-by-field**. Do not feed two blobs to one prompt.
- [ ] Domain check against `merchantAllowlist`
- [ ] The matcher has exactly **two** outputs: `match` → sign, `uncertain` → escalate
- [ ] **It can never produce "confident mismatch → sign."** A bypassed matcher degrades to
      more human interruptions, never more money moved.
- [ ] Checks 1–8 are deterministic and **never LLM-judged.** Nobody may replace a
      deterministic check with a fuzzy one — this is an invariant, not a preference.

### B21 Escalation lifecycle
**Estimate:** 1.5 h · **Source: [§12b 2.1](execution_plan.md)**

- [ ] `202` response carries `approvalUrl`, `expiresAt`, `ttlSeconds: 300`, `onTimeout: "DENY"`
- [ ] **TTL auto-deny is non-negotiable.** A stalled agent degrades to "stop," never "hang."
- [ ] `POST /escalation/:requestId/resolve` → `{ decision: "approve" | "deny" }`
- [ ] `410 ESCALATION_EXPIRED` after TTL, and the recorded decision is `denied`
- [ ] **Standing pre-approvals:** the human may pick "approve once" or "approve this merchant
      for this window"
- [ ] **Independent fetch:** hand the dashboard an independently fetched checkout URL — the
      human sees ground truth, **never the agent's self-report**

### B22 `GET`/`PUT /policy/:mandateId`
**Estimate:** 45 min · **Depends on:** B2

- [ ] Return `{ policy, policyHash, onChainHash, inSync }`
- [ ] `PUT` → `409 POLICY_HASH_DRIFT` with **both hashes** when the body would no longer match
      the registry — this is the failure that otherwise burns hours

---

# Phase 4 — Tests (write these FIRST; cases 2–10 are the demo)

### B23 The refusal test suite
**Estimate:** 2 h · **Source: [§17](execution_plan.md)**

- [ ] 1 · clean purchase inside all limits → **signed**, receipt complete
- [ ] 2 · `challenge.payTo` mutated → **refused, check 4**
- [ ] 3 · `challenge.amount != requestedAmount` → **refused, check 5**
- [ ] 4 · third card when `maxCardsPerWindow = 2` → **escalated, check 6**
- [ ] 5 · amount pushes window over budget → **escalated, NOT refused**
- [ ] 6 · mandate revoked mid-session → **refused, check 1, within one block**
- [ ] 7 · `validBefore - validAfter` of one hour → **refused, check 7**
- [ ] 8 · signature request with no intent record → **refused, precondition**
- [ ] 9 · nonce reuse → conditional write fails, **no second signature**
- [ ] 10 · policy body edited locally → **refused, check 2**
- [ ] 11 · `releaseNonce` before signing → retry with a new nonce succeeds
- [ ] 12 · post-signature cardapi failure → **no release**, fresh `requestId` required
- [ ] 13 · escalation unanswered past TTL → **auto-deny, no signature**
- [ ] 14 · compromised policy asks signer out-of-envelope → **signer refuses on the rail**
- [ ] 15 · matcher returns "uncertain" → **escalates**, never signs

---

## Definition of done

- [ ] All eight checks are pure functions with isolated unit tests
- [ ] `hashPolicy` round-trips between dashboard and policy-service
- [ ] Nonce reservation tested **concurrently**, not sequentially
- [ ] `releaseNonce` refuses after a signature exists
- [ ] Every decision path writes to the ledger, refusals included
- [ ] Escalation auto-denies on TTL expiry
- [ ] `GET /receipt/:requestId` returns a complete, chain-verifiable receipt
- [ ] Refusal `detail` strings name concrete values — a judge reads these on screen

## Never

- Cache on-chain revocation state
- Let an LLM judge checks 1–8
- Return `refused` for a budget-only failure — that path **escalates**
- Put validation logic in ledger-service, or storage logic in policy-service
- Let an escalation time out into anything but a **deny**
