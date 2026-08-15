# Child Tasks — signer-service Phase 3/4 (granular decomposition)

Each parent task (T12–T18) from [`queue_tasks.jsonl`](queue_tasks.jsonl) broken into
single-responsibility child tasks with blocking edges. T1–T11 are already complete
(typecheck + 164 tests green).

## Legend

- `⛔` blocks another owner or a later checkpoint.
- `👤` human-blocked (needs AWS credentials, the funding wallet, or organiser clearance).
- Child tasks are ordered top-to-bottom within each parent.

---

## T16 — Replace `0x9f6B…1bF7` with `EXPECTED_SIGNER_ADDRESS` in docs (IN PROGRESS)

- **T16.1** ✅ Update [`docs/owner-a-tasks.md`](docs/owner-a-tasks.md) A11 assertion + custody note (done).
- **T16.2** Update [`docs/api-contracts.md`](docs/api-contracts.md) §0 `payingWallet` to reference `EXPECTED_SIGNER_ADDRESS` (env) with a note that the literal is now the funding-origin wallet only.
- **T16.3** Update [`docs/api-contracts.md`](docs/api-contracts.md) §4 `/health` + `derivedAddress` description to say it equals `EXPECTED_SIGNER_ADDRESS`, not the literal.
- **T16.4** Update [`docs/execution_plan.md`](docs/execution_plan.md) §19.5 to record the custody change (fresh KMS key → transfer 30 XSGD Fuji-first; literal remains as funding origin).
- **T16.5** Update [`docs/execution_plan.md`](docs/execution_plan.md) §19.7/§20 to note the address constant is now env-driven.
- **T16.6** Announce the change to Owner B and Owner C (the literal no longer names the paying wallet at runtime).

---

## T13 — A15 docker-compose + isolation probe

- **T13.1** Create [`docker-compose.yml`](docker-compose.yml): `signer-service` on an internal network (`signer-net`) joined **only** by `policy-service`; `agent-orchestrator` on a separate network (`orchestrator-net`) with **no** route to `signer-net`.
- **T13.2** Add `signer-service` and `policy-service` service definitions (ports, env, `internal: true` network for signer).
- **T13.3** Write [`scripts/test-isolation.sh`](scripts/test-isolation.sh) (wired to `pnpm test:isolation`): bring up the compose networks, run a probe container on `orchestrator-net`, `curl` `signer:4003/health`, assert the connection is **refused** (exit non-zero / connection refused, not 401).
- **T13.4** Verify the probe fails _for the right reason_ (connection refused at the network layer, not a reachable-but-401 — a 401 would prove reachability).
- **T13.5** ⛔ Capture the refused-connection screenshot for the deck deliverable.
- **T13.6** Add a `README`/docs note on the AWS security-group equivalent (SG allowing only policy-service's SG to reach port 4003) + split IAM roles.

---

## T12 — A11 custody scripts (👤 human-blocked to _run_, not to write)

- **T12.1** Write [`scripts/derive-kms-address.ts`](scripts/derive-kms-address.ts) — SPKI DER (base64 or file or stdin) → EIP-55 address (self-contained, mirrors the service module).
- **T12.2** Write [`scripts/setup-kms.sh`](scripts/setup-kms.sh) — interactive wizard: check `aws` CLI, `sts get-caller-identity`, create `ECC_SECG_P256K1`/`SIGN_VERIFY` key, `get-public-key`, derive address via T12.1, print `.env` block.
- **T12.3** Write [`scripts/move-xsgd.ts`](scripts/move-xsgd.ts) — build an unsigned `transfer` tx from `FUNDING_ORIGIN_WALLET` to the KMS-derived address (Fuji first), print it for the human to sign in their wallet.
- **T12.4** 👤 Run `setup-kms.sh` once AWS credentials + IAM exist.
- **T12.5** 👤 Sign the XSGD transfer in the wallet (Fuji first; mainnet after Fuji lands).

---

## T14 — A16 checkpoint-2 probe (👤 human-blocked to _run_)

- **T14.1** Write [`scripts/probe-checkpoint2.ts`](scripts/probe-checkpoint2.ts): fetch the free sandbox challenge (`POST card.straitsx.ai/sandbox/cardapi/issue_card`, 402), build typed data, sign via the real KMS path, retry with `PAYMENT-SIGNATURE`, expect `card_opaque_id` + `settlement_tx`.
- **T14.2** ⛔ Resolve the open `PAYMENT-SIGNATURE` payload schema against the live 402 (the base64 JSON structure — currently a placeholder in [`pipeline.ts`](services/signer-service/src/sign/pipeline.ts)).
- **T14.3** Verify the settlement tx on Fuji via chain-gateway A8 (`POST /settlement/confirm`).
- **T14.4** ⛔ Measure `202 → settlement` latency and hand the number to Owner B (sets `maxAuthValiditySeconds`, check 7).
- **T14.5** 👤 Requires KMS key + funded `EXPECTED_SIGNER_ADDRESS`.

---

## T15 — A18 production 402 probe (👤 human-blocked)

- **T15.1** Write [`scripts/probe-production-402.ts`](scripts/probe-production-402.ts): read the **mainnet** 402 and record `asset`, `payTo`, `extra.version` into [`docs/execution_plan.md`](docs/execution_plan.md) §19.7.
- **T15.2** Enforce "do not inherit `version: "2"` from Fuji" — fetch, never default.
- **T15.3** 👤 Requires organiser clearance for `/production/sse`.

---

## T17 — A17 nonce decision (👤 human decision)

- **T17.1** Present the two options: random-and-reserved vs `keccak256(requestId ‖ policyHash ‖ intentHash ‖ merchantDomain)`.
- **T17.2** 👤 Human decides (recommended: commitment variant — chain-verifiable settlement).
- **T17.3** Record the decision in [`docs/execution_plan.md`](docs/execution_plan.md) §10.
- **T17.4** Tell Owner B (policy-service computes the nonce — one line on their side).
- **T17.5** ⛔ Must be decided **before** A16 (changing after a signature = new nonce + new authorization).

---

## T18 — code-review + commit-message block

- **T18.1** Run the full verification: `export PATH="$HOME/.foundry/bin:$PATH"; pnpm typecheck && LIVE_RPC=1 pnpm test && (cd packages/contracts-sol && forge test)`.
- **T18.2** Code-review against fixed point `3fac64e` (NOT `5851eb3` — excludes Owner B's ~2,900 lines).
- **T18.3** Address review findings.
- **T18.4** Write a copy-pasteable commit-message block (plain `-m`, no backticks/`$`/`!`/apostrophes — per the working agreement; do **not** run `git commit`).

---

## Blocking-edge summary

```
T16 (docs)  ──► independent
T13 (A15)   ──► independent of KMS; deliverable + deck screenshot
T12 (A11)   ──► unblocks T14 (needs the key + funded address)
T14 (A16)   ──► blocked on T12 + T17 (nonce) + PAYMENT-SIGNATURE schema
T15 (A18)   ──► independent; blocked on organiser clearance
T17 (nonce) ──► blocks T14
T18 (review) ──► after T13, T16, and any code-producing tasks land
```
