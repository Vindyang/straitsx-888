# Owner A — Task Board: Chain, Keys, Signing

**Scope:** mandate-registry (Solidity) · chain-gateway · signer-service
**Interfaces:** [api-contracts.md §2–§4](api-contracts.md) · **Facts:** [execution_plan.md §19](execution_plan.md)

You own everything that touches money and key material. Two other people are blocked on your
first two deliverables — ship the stubs before you ship anything good.

**Task ID format:** `A<n>`. Work top to bottom; tasks marked ⛔ block someone else.

---

## Dependency map

```
A1 stubs ⛔ ──────────────────► unblocks B and C entirely
A2 registry deploy ⛔ ────────► B3 (check 1/2), C10 (dashboard)
A3 KMS custody check ⛔ ──────► every signature that will ever settle
A4–A6 chain-gateway ─────────► B4 (policy reads)
A7–A11 signer ───────────────► CHECKPOINT 2
A12 network isolation ⛔ ─────► the security claim + the deck
```

---

# Phase 0 — Hour 0–1 (do not skip, everything waits on this)

### A1 ⛔ Stub signer-service and chain-gateway

**Estimate:** 45 min · **Blocks:** all of Owner B, all of Owner C

- [ ] `signer-service` on **4003**: `POST /sign` → fixed dummy `header`, random `nonce`,
      real response shape from [api-contracts.md §4](api-contracts.md)
- [ ] `chain-gateway` on **4004**: `GET /mandate/:id` → static live mandate;
      `GET /token/constants` → Fuji constants with `version: null`
- [ ] Both `GET /health` → `{ "ok": true }`
- [ ] Commit shared types to `packages/contracts/`
- [ ] Post in team channel: _"stubs up — 4003 signer, 4004 chain-gateway"_

**Done when:** Owner B can `curl` both and get shape-correct JSON.

---

# Phase 1 — mandate-registry

### A2 ⛔ Implement and deploy the registry

**Estimate:** 2 h · **Blocks:** B3, C10 · **Hard deadline: hour 2**

- [ ] Foundry project under `packages/contracts-sol/`
- [ ] Implement `IMandateRegistry` exactly as in [api-contracts.md §2](api-contracts.md)
- [ ] `createMandate(bytes32 mandateId, bytes32 policyHash, uint64 expiresAt)`
- [ ] `revoke(bytes32 mandateId)` — **owner-only, NO timelock** (instant revoke is demo Run 3)
- [ ] `get(bytes32)` → `(owner, policyHash, expiresAt, revoked)`
- [ ] Emit `MandateCreated` and `MandateRevoked`
- [ ] Revert on `createMandate` for an existing id — no silent overwrite

**Done when:** `forge test` green and the contract is deployed to Fuji.

### A3 Write the registry test suite

**Estimate:** 45 min · **Depends on:** A2

- [ ] non-owner `revoke` → reverts
- [ ] revoked mandate reads `revoked == true`
- [ ] expired mandate: `expiresAt` respected by callers
- [ ] duplicate `createMandate` → reverts
- [ ] unknown id → `owner == address(0)`

### A4 ⛔ Publish `registry.json`

**Estimate:** 20 min · **Depends on:** A2 · **Blocks:** B3, C10

- [ ] Commit `packages/contracts/registry.json`:
      `{ addresses: { "43113": …, "43114": … }, abi: […], deployBlock: { … } }`
- [ ] Announce the address in the team channel

### A5 Deploy the registry to **mainnet 43114** as well

**Estimate:** 30 min · **Depends on:** A2 · **Do this Saturday, not Sunday**

- [ ] Deploy to 43114 (you have 0.2 AVAX there; a deploy is a fraction of it)
- [ ] Add the address to `registry.json`

> **Why this is not optional.** The hard event requirement is XSGD on **mainnet 43114**
> ([project_outline.md:12](project_outline.md)). If production card clearance never arrives,
> a mainnet registry + a real mainnet XSGD movement is the fallback that keeps the submission
> compliant. This is unrecoverable if left late.

---

# Phase 2 — chain-gateway

The **only** component that opens an RPC connection. No policy logic. No signing.

### A6 `GET /token/constants`

**Estimate:** 45 min · **Depends on:** A1

- [ ] Read `name()` and `decimals()` on-chain
- [ ] **Return `version: null` always** — see the warning below
- [ ] Return `versionSource: "x402-challenge-only"`
- [ ] **Assert `decimals === 6` at boot; refuse to serve if not**
- [ ] Cache in memory, 15-minute TTL

> ⚠️ **Do not call `version()`.** It **reverts on both chains**, as do `DOMAIN_SEPARATOR()`
> and `eip712Domain()` ([execution_plan.md §19.2](execution_plan.md)). The original spec said
> "read `name()`, `version()` and `decimals()` at startup" — that spec **crashes your service
> before it can sign anything**. It was corrected in [§9](execution_plan.md). Callers take
> `version` from `challenge.extra.version`.

### A7 `GET /mandate/:mandateId`

**Estimate:** 30 min · **Depends on:** A4

- [ ] Read the registry via the published ABI
- [ ] Map `owner == address(0)` → `404 MANDATE_NOT_FOUND`
- [ ] Include `readAtBlock` in the response

### A8 `POST /settlement/confirm`

**Estimate:** 1 h · **Depends on:** A1

- [ ] Fetch the receipt by `txHash`
- [ ] **Decode the `Transfer` log and match `{ asset, to, amount }` against `expect`**
- [ ] A `status: 1` receipt whose log does **not** match → `ok: false, transferMatched: false`
- [ ] Return `blockNumber`, `confirmations`, `logIndex`

**Done when:** a deliberately mismatched `expect` returns `ok: false`. This is what makes the
receipt trustworthy rather than decorative.

### A9 `GET /balance` and `POST /tx/build-revoke`

**Estimate:** 45 min

- [ ] `/balance`: XSGD via `balanceOf`, AVAX via `eth_getBalance`, both as base-unit strings
- [ ] `/tx/build-revoke`: return an **unsigned** tx `{ to, data, value, chainId, gasLimit }`
- [ ] **chain-gateway never signs.** The human signs in their own wallet from the dashboard.

### A10 RPC failure handling

**Estimate:** 30 min

- [ ] Every RPC error → `502` with `retryable: true`
- [ ] Timeout → `504`
- [ ] **Never let an RPC timeout surface as a policy refusal** — a judge will read that as a
      false security claim

---

# Phase 3 — signer-service (CHECKPOINT 2 — highest risk in the project)

### A11 ⛔ KMS key + custody proof

**Estimate:** 1 h · **Blocks:** every signature that will ever settle · **Do this first**

- [ ] Create an AWS KMS **asymmetric secp256k1** key
- [ ] IAM: only `signer-service`'s execution role may call `Sign`
- [ ] Derive the Ethereum address from the KMS public key at boot
- [ ] Expose it as `derivedAddress` on `GET /health`
- [ ] **Assert `derivedAddress == EXPECTED_SIGNER_ADDRESS`** (env; replaces the literal, see §19.5)

> **This is the custody proof.** A fresh KMS key derives its own address. The 30 XSGD must
> be transferred from the funding-origin wallet (`0x9f6B…1bF7`) to the KMS-derived address
> (Fuji first, mainnet only after Fuji lands). On-chain reads prove the address is funded;
> they cannot prove we hold the key. This boot assertion is the proof, and it never touches
> key material. **If it mismatches, stop and tell the team** — you are signing from an
> account with no money and no signature will ever settle.

### A12 EIP-3009 typed data construction

**Estimate:** 1 h · **Depends on:** A11

- [ ] Build `TransferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)`
- [ ] Domain fields sourced per [execution_plan.md §9](execution_plan.md):
      `name` ← `challenge.extra.name` · `version` ← `challenge.extra.version` ·
      `chainId` ← `challenge.chainId` · `verifyingContract` ← `challenge.asset`
- [ ] **Assert the live challenge matches the expected constants; refuse on mismatch**
- [ ] `value` is a base-unit string at **6 decimals** — `"5000000"` is 5 XSGD

### A13 KMS signature normalisation — budget real time for this

**Estimate:** 1–2 h · **Depends on:** A12 · **The classic KMS bug**

- [ ] Parse the DER signature KMS returns into `r` and `s`
- [ ] **Normalise `s` to the lower half of the curve order** (`s > n/2` → `s = n - s`)
- [ ] Recover `v` by trying both parities and matching against `derivedAddress`
- [ ] Encode the base64 `PAYMENT-SIGNATURE` header value
- [ ] Test against a known vector **before** touching cardapi

> A high-`s` signature is rejected by most verifiers. The symptom is a `402` that never
> clears and it looks exactly like a wrong-domain bug. Do this offline first.

### A14 Signer hard-invariant rail

**Estimate:** 1 h · **Depends on:** A12 · **Source: [§12b 2.2](execution_plan.md)**

- [ ] Load an **immutable map from env at boot**, never from the request:
      `mandateId → { settlementRecipient, hardMaxTotal }`
- [ ] Refuse with `403` + code:

| Condition                                    | `code`                    |
| -------------------------------------------- | ------------------------- |
| `mandateId` not in the pinned map            | `SIGNER_UNPINNED_MANDATE` |
| `message.to` != pinned `settlementRecipient` | `SIGNER_WRONG_RECIPIENT`  |
| `message.value` > pinned `hardMaxTotal`      | `SIGNER_CEILING`          |
| `message.from` != paying wallet              | `SIGNER_WRONG_FROM`       |
| `domain.chainId` != configured chain         | `SIGNER_WRONG_CHAIN`      |
| `validBefore - validAfter` > 600             | `SIGNER_WINDOW`           |
| `requestId` already signed                   | `SIGNER_REPLAY` (409)     |

- [ ] Unit-test all seven refusals

> **"Deliberately dumb" means no purchase decisions — not "signs arbitrary bytes."** These
> are fixed invariants, not judgments, so the signer stays dumb while ceasing to be suicidal.
> They hold **even if policy-service is fully compromised**, which is the entire point.

### A15 ⛔ Network isolation + the probe test

**Estimate:** 1 h · **Source: [§11](execution_plan.md)**

- [ ] Firewall / security group: **only policy-service may reach port 4003**
- [ ] Enforce at the **network layer**, not with an `if` in code
- [ ] Write a CI test asserting `agent-orchestrator` **cannot** reach `signer-service` —
      the connection must be **refused**
- [ ] **Screenshot the refused connection for the deck**
- [ ] Split IAM: policy-service and signer-service under **different roles**

> If agent-orchestrator can reach the signer, the entire security claim collapses and a judge
> will find it. This test is a deliverable, not hygiene.

### A16 CHECKPOINT 2 — first real signature

**Estimate:** 2 h · **Depends on:** A11–A14 · **Lead this personally**

- [ ] Fetch a live challenge (free, creates nothing):
      `curl -i -X POST https://card.straitsx.ai/sandbox/cardapi/issue_card -H 'content-type: application/json' -d '{"amount_sgd":5,"cardholder_name":"Test Probe"}'`
- [ ] Build typed data from that exact challenge
- [ ] Sign via KMS
- [ ] Retry with `PAYMENT-SIGNATURE` → expect `card_opaque_id`, `settlement_tx`
- [ ] Verify the settlement tx on Fuji with A8
- [ ] **Measure `202` → settlement latency and hand the number to Owner B** — it sets
      `maxAuthValiditySeconds` from data, not a guess (check 7)

**Nothing external blocks this.** Domain, asset, and the 30 XSGD balance are all resolved
([§19.4–19.5](execution_plan.md)).

---

# Phase 4 — Decisions and follow-through

### A17 Decide the nonce strategy — **before A16**

**Estimate:** 15 min discussion

- [ ] Choose: random-and-reserved (current plan) **or**
      `keccak256(requestId ‖ policyHash ‖ intentHash ‖ merchantDomain)`
- [ ] Tell Owner B — policy-service computes the nonce and passes it in, so this is one line
      on B's side and none on yours
- [ ] Record the decision in [execution_plan.md §10](execution_plan.md)

> The commitment variant makes the on-chain settlement itself commit to the human's intent,
> turning the receipt from a database claim into something anyone can verify from chain data.
> **Changing it after a signature exists means a new nonce and a new authorization** — so
> decide now.

### A18 Production 402 probe — unblocks the mainnet leg

**Estimate:** 20 min · **Ask the organisers about clearance first**

- [ ] Confirm with organisers that teams are cleared for `/production/sse`
- [ ] Once cleared: `POST /production/cardapi/issue_card` to read the **mainnet** 402
- [ ] Record mainnet `asset`, `payTo`, and **`extra.version`** into
      [execution_plan.md §19.7](execution_plan.md)
- [ ] **Do not inherit `version: "2"` from Fuji** — fetch it

---

## Definition of done

- [ ] `registry.json` committed with **both** chain addresses
- [ ] `forge test` green
- [ ] `/health` shows `derivedAddress == EXPECTED_SIGNER_ADDRESS` (env, KMS-derived — **not**
      the funding-origin wallet; see §19.5)
- [ ] A real signature accepted by cardapi; `settlementTx` exists on Fuji
- [ ] `confirmSettlement` verifies a real `Transfer` log and rejects a mismatched one
- [ ] Orchestrator→signer connection **demonstrably refused**, screenshotted
- [ ] All seven signer invariant refusals unit-tested
- [ ] `202`→settlement latency measured and handed to Owner B

## Never

- Put a raw private key in an env file — **KMS is not substitutable**, and a judge will ask
- Let signer-service evaluate policy
- Let chain-gateway sign anything
- Log a signature, a full KMS key id, or typed-data message contents
