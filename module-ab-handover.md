# Module A/B handover — chain, keys, signing, policy

Generated: 2026-08-15 · Branch `module-a` · AWS account `808198486011` (ap-southeast-1)
Counterpart: `module-c-aws-integration-handover.md` (account `732031180826`)

## 1. Scope and honest status

Module A/B is **functionally complete and proven on Fuji, and not deployed to AWS.**

The distinction matters. A real signature was produced by a real KMS key and settled on chain
twice; the hard-invariant rail refuses out-of-envelope requests over HTTP; the custody proof
holds in both directions. None of that runs on AWS yet — everything below was executed
locally against live Fuji and live AWS KMS.

Do not describe this as a deployed system. Do describe checkpoint 2 as passed: it is, with
on-chain evidence.

| | State |
| --- | --- |
| A11 custody | **Complete** — key created, address derived and independently verified, 30 XSGD moved, `kms:Sign` scoped to one key |
| A12 typed data | Complete, domain assertion verified against the live challenge |
| A13 signature normalisation | Complete, 3 offline vectors + 10 header tests |
| A14 hard-invariant rail | Complete, 7 refusals unit-tested and verified over HTTP |
| A15 isolation | IAM applied; security groups scripted **not applied**; screenshot outstanding |
| **A16 CHECKPOINT 2** | **PASSED** — two real settlements on Fuji |
| A17 nonce decision | Decided (commitment); **not switched on**, see §7 |
| A18 production 402 | Script written; blocked on organiser clearance |
| A5 mainnet registry | **Not done.** Last item blocked on nobody |
| B checks 1–9 | Complete |
| B escalation auth | Complete — EIP-191 signature verification, added this session |

Verification at handover: `pnpm typecheck` exit 0 · `pnpm test` **195 passed, 6 skipped** ·
`forge test` **16 passed**.

## 2. Identifiers

| Thing | Value |
| --- | --- |
| KMS key | `arn:aws:kms:ap-southeast-1:808198486011:key/cac122f0-97a4-4907-ae8a-f1d39f24b03f` |
| Key spec | `ECC_SECG_P256K1` / `SIGN_VERIFY` / Enabled |
| **Paying wallet (KMS-derived)** | **`0x0F6DdD6fC1Fb06B3E91a77Cb1597aCAc8A037CA7`** |
| Funding-origin wallet | `0x9f6B4A5DE73CE365238F27236ea04A747E691bF7` |
| IAM roles | `straitsx-888-signer-service` (Sign), `-policy-service` (DENY Sign), `-agent-orchestrator` (DENY kms:*) |
| MandateRegistry Fuji | `0x47b9b484944d95bc04888e40ad585462a06e7c6d` @ block 57773961 |
| MandateRegistry mainnet | **not deployed** |

### Balances at handover

| | Fuji 43113 | Mainnet 43114 |
| --- | --- | --- |
| Paying wallet | **20 XSGD**, 0 AVAX | 0 |
| Funding origin | 0 XSGD, 0.001 AVAX | **30 XSGD**, 0.2 AVAX |

**20 XSGD is 4 cards** at the 5 XSGD minimum, and there is no faucet. Demo runs consume them.
Use `scripts/probe-checkpoint2.ts` with no flags (free, creates nothing) for anything that
does not require a real signature.

The paying wallet holds **0 AVAX and needs none, permanently**. EIP-3009 is a pull mechanism:
it only ever signs authorisations and the facilitator submits and pays gas.

## 3. Checkpoint 2 evidence

| | |
| --- | --- |
| Settlement tx | [`0xe6dcb85e…`](https://testnet.snowtrace.io/tx/0xe6dcb85eb3880f9daff8ace963e60bba346d3a785411e19cd4e04972da6094c6) |
| Block | 57777207 |
| Moved | 5.000000 XSGD → `0x99a2B2962a6AC463FBe04664027Fdb3F68bd4Cc8` |
| Card | `01KASWWW33N045ABPJKFGSPTM1` |
| **Submitted by** | **`0x4b9e841a…7202` — not us** |
| `202` → settlement latency | **~11 s** (10.7–11.7; 1 s poll granularity — do not quote as precise) |

That "submitted by" row is the custody claim demonstrated rather than asserted: our address
has never sent a transaction and holds no gas, yet 5 XSGD moved under its authorisation.

**Hand the latency to Owner B** — it sets `maxAuthValiditySeconds` (check 7) from data. The
challenge allows 300 s, roughly 25× observed, so round up generously.

## 4. What cost the most time, so nobody repeats it

### The `PAYMENT-SIGNATURE` header was wrong three times

It shipped as `base64(JSON(typedData))` — the EIP-712 domain, types and message, **and no
signature at all**. The only test asserted `typeof header === "string"`, which that passes.

| Sent | Facilitator response |
| --- | --- |
| base64 of the typed data | carried no signature |
| v1 envelope `{x402Version, scheme, network, payload}` | `cannot parse payment amount: invalid atomic amount ""` |
| requirements under `paymentRequirements` or `accepts` (plural) | identical error |
| **x402 v2 `{x402Version, resource, accepted, payload, extensions}`** | **accepted** |

The key is **`accepted`, singular** — one entry of the challenge's `accepts[]`, and the only
place the facilitator reads the payment amount. Every failure above presents as a 402 that
never clears, which is indistinguishable at a glance from a domain bug. **Check the header
shape before touching the domain assertion.** Pinned by `signer-service/test/x402-header.test.ts`.

### `network` is CAIP-2

The live challenge returns `eip155:43113`, not a friendly name like `avalanche-fuji`. A guessed
constant was caught by the free challenge-only probe before any signature was sent, and then
deleted — the challenge's own `network` is authoritative.

### Other live-verified facts

`value`, `validAfter`, `validBefore` are **strings** inside `authorization`. The signature is a
**65-byte `r‖s‖v` hex string**, not an object, with `v` staying 27/28. `maxTimeoutSeconds` is
300 — tighter than the signer's 600 s ceiling, so honour the smaller.

## 5. Integration contract with Module C

### Two decisions already made

**A/B deploys into account `732031180826`.** C's §6.2 asks for ingress from its security
groups, and SG references only resolve within one account and VPC.

**The KMS key stays in `808198486011`.** A new key in C's account derives a **new address**,
which invalidates the custody proof, strands the 20 XSGD and orphans both settlements. Use
`scripts/grant-kms-cross-account.sh` instead. Cross-account KMS needs **both** the key policy
and the role's own IAM policy; missing either gives an `AccessDenied` that looks like the other.

**ECS/Fargate, not EC2.** An earlier recommendation said EC2. That was right standalone and
wrong now: `ledger.internal` and friends come from Cloud Map, which ECS registers
automatically and EC2 would require hand-maintaining.

### Ingress matrix (C handover §6.2)

| Target | Port | Source |
| --- | --- | --- |
| ledger | 4001 | orchestrator SG, dashboard SG |
| policy | 4002 | orchestrator SG, dashboard SG |
| chain-gateway | 4004 | orchestrator SG, dashboard SG |
| **signer** | **4003** | **policy SG ONLY** |

### Setup order

```
1. scripts/setup-iam-roles.sh --apply                                  (in 732031180826)
2. scripts/grant-kms-cross-account.sh --account 732031180826 --apply   (in 808198486011)
3. scripts/setup-iam-roles.sh --apply --kms-key-arn <arn>              (in 732031180826)
4. build/push A/B images, register ECS services with Cloud Map names
5. scripts/setup-security-groups.sh --vpc vpc-0cfa8cb7a1dfe244f \
     --orchestrator-sg sg-03f663099bc55d0a6 --dashboard-sg sg-0458716c037c17d08 --apply
6. Module C isolation-probe.ts from the orchestrator SG  <- the C10 deliverable
```

Steps 1 and 3 are applied in `808198486011` and must be repeated in C's account.
Full detail in [docs/deployment.md](docs/deployment.md).

## 6. What C must know about A/B

- **`POST /sign` requires `accepted` and `resource`.** Deploy A and B from the **same commit**;
  skew breaks in both directions and the old-signer case looks like a domain bug.
- **Set `paying_wallet_address`** from the zero-address placeholder to
  `0x0F6DdD6fC1Fb06B3E91a77Cb1597aCAc8A037CA7`.
- **`rawToolResultHash`** is accepted on settlement and returned on the receipt. Optional,
  validated as 32-byte hex. Send the **hash**, never the body.
- **Escalation approval is now a signature.** See §7 — this needs reconciling.

## 7. Open items, in priority order

**1. Escalation message format is unreconciled — will break every approval.**
`buildEscalationMessage` in `packages/contracts/src/escalation.ts` was defined without sight of
C's dashboard:

```
straitsx-888 escalation decision
requestId: <id>
mandateId: <id>
decision: approve|deny
```

If C signs a different string, every approval returns `403 ESCALATION_SIGNATURE_INVALID`. Both
sides must import this function rather than hand-rolling. **Check this first at merge.**

**2. A5 — deploy MandateRegistry to mainnet 43114.** The last definition-of-done item blocked
on nobody. Its own note calls leaving it late *"unrecoverable"*: if production card clearance
never arrives, a mainnet registry plus a real mainnet XSGD movement is the fallback that keeps
the submission compliant. 0.2 AVAX is already there.

**3. `intentHash` is undefined, so the commitment nonce is not switched on.** A17 chose
`keccak256(requestId ‖ policyHash ‖ intentHash ‖ merchantDomain)` and `buildCommitmentNonce`
is implemented and tested — but nothing defines a canonical hash over an intent record.
`policy-service/src/signing.ts` still generates a random nonce with a TODO. **Until this
lands, nonces are replay-safe but receipts are NOT chain-verifiable**, which is the property
A17 was chosen for. Decide alongside check 8 (B19), since they must agree.

**4. No A/B Dockerfiles were building at handover.** `Dockerfile` + `.dockerignore` exist at
the repo root, parameterised by `SERVICE_ENTRY`/`SERVICE_PORT`, and every path they reference
is verified present — but **the image has never been built**, because the Docker daemon was not
running. Build all four before trusting it.

**5. A15 screenshot** — needs A/B reachable in C's cluster. Use C's probe, not ours: ours
checks one target and cannot prove the positive controls.

**6. A18 production 402** — `scripts/probe-production-402.ts` refuses to run without an explicit
`--url` and `--cleared`. Until it runs, `MAINNET.settlementRecipient` and `eip712Version` stay
`null` and every mainnet path refuses. That refusal is the safety property.

## 8. Scripts

| Script | Purpose | Mutates? |
| --- | --- | --- |
| `setup-iam-roles.sh` | 3 roles, explicit KMS denies, instance profiles | `--apply` only |
| `setup-kms.sh` | Wizard: create the key, derive the address, write `.env` | prompts |
| `grant-kms-cross-account.sh` | Extend the key policy to another account | `--apply` only |
| `setup-security-groups.sh` | The §6.2 ingress matrix + 4 assertions | `--apply` only |
| `test-isolation.sh` | Quick local reachability check | no |
| `derive-kms-address.ts` | SPKI DER on stdin → address | no |
| `move-xsgd.ts` | **Unsigned** transfer; preflights the balance | no |
| `probe-checkpoint2.ts` | Challenge-only by default; `--settle` **spends 5 XSGD** | `--settle` |
| `probe-production-402.ts` | Read the mainnet 402 | no |

All `--apply` scripts are verify-only by default and re-runnable. None takes a private key.

## 9. Rules that are load-bearing, not stylistic

- **Never put a private key in this repo, an env file, or an agent context.** `move-xsgd.ts`
  emits unsigned transactions for exactly this reason.
- **Refuse, never default.** Mainnet constants are `null` and paths refuse. Do not paper over.
- **The rail runs before KMS**, so a refused request never touches the key.
- **`/health` is auth-exempt on purpose** — a `401` would let a reachable port look blocked.
- **Never log a full KMS key id, a signature, typed-data contents, or a PAN.**
- **A DNS failure is not isolation evidence.** No packet was sent; a firewall and a typo look
  identical.
