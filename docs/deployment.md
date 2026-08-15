# Deployment — A/B into Module C's account

**Status:** the topology and per-service configuration are verified locally as independent
processes (2026-08-15). **A/B is not deployed to AWS.** Module C is deployed and running; this
document is the plan for joining it. The verification section is evidence that the
configuration is sound, not that the deployment exists.

Companion docs: [conventions.md §2](conventions.md) who may call whom ·
[api-contracts.md §0](api-contracts.md) wire shapes · [owner-a-tasks.md A15](owner-a-tasks.md)
the isolation requirement · `module-c-aws-integration-handover.md` for the Module C side.

---

## 1. Two decisions, and why

### A/B deploys into Module C's account

| | Account |
| --- | --- |
| Module C (deployed) | **`732031180826`** |
| A/B tooling so far (IAM roles, KMS key) | `808198486011` |

Module C's handover §6.2 asks A/B to allow ingress **from its security groups**
(`sg-03f663099bc55d0a6`, `sg-0458716c037c17d08`). **Security-group references only resolve
within one account and VPC.** Cross-account would need PrivateLink or peering plus Route 53
Resolver, and the `*.internal` names could not simply register in C's namespace — C's own
handover says exactly this.

So A/B joins C's account and VPC (`vpc-0cfa8cb7a1dfe244f`). `scripts/setup-security-groups.sh`
pre-flights this and fails with the real reason if run in the wrong account.

### The KMS key stays in `808198486011`

Creating a fresh key inside C's account is the obvious move and the wrong one. **A new key
derives a new address**, which would invalidate the A11 custody proof, strand the 20 XSGD at
`0x0F6DdD…7CA7`, and orphan both settled transactions.

Instead the existing key grants access to the signer role in C's account. Cross-account KMS
needs **both halves**, and missing either produces an `AccessDenied` that looks like the other:

```
scripts/grant-kms-cross-account.sh --account 732031180826 --apply   # in 808198486011
scripts/setup-iam-roles.sh --apply --kms-key-arn <arn>              # in 732031180826
```

---

## 2. CORRECTION: ECS/Fargate, not EC2

An earlier version of this document recommended EC2 with plain node, on the reasoning that
A15 only needs two network positions and that the repo is source-first with no build step.
**That was right for a standalone A/B and is wrong now.**

Module C reaches A/B at `ledger.internal`, `policy.internal`, `chain-gateway.internal`. Those
names come from **AWS Cloud Map** (namespace `ns-vmmsgsfyqtdfae6k`, name `internal`), and ECS
service discovery registers and de-registers them automatically as tasks come and go. On EC2
you would have to call the Cloud Map API by hand and keep it correct through every restart —
service discovery that silently goes stale is worse than none.

Since C already runs ECS/Fargate in this cluster, A/B joins it.

**Consequence: A/B needs Dockerfiles and none exist.** `services/{ledger,policy,signer,chain-gateway}`
have no container build today. C's `services/dashboard/Dockerfile` and
`services/agent-orchestrator/Dockerfile` are the reference for the house style (non-root,
read-only, digest-pinned).

---

## 3. Topology

| Service | Port | Owner | Cloud Map name | Security group |
| --- | --- | --- | --- | --- |
| ledger-service | 4001 | B | `ledger.internal` | from orchestrator + dashboard |
| policy-service | 4002 | B | `policy.internal` | from orchestrator + dashboard |
| **signer-service** | **4003** | A | `signer.internal` | **from policy ONLY** |
| chain-gateway | 4004 | A | `chain-gateway.internal` | from orchestrator + dashboard |
| agent-orchestrator | 4005 | C | — | **no path to 4003** |
| dashboard | 3000 | C | — | public via CloudFront |

Ports come from `SERVICE_PORTS` in `packages/contracts/src/constants.ts`. Never hardcode one.

---

## 4. Per-service configuration

Each service needs only its own variables. This table is the decoupling made visible.

| Service | Required env |
| --- | --- |
| ledger-service | `INTERNAL_TOKEN` |
| chain-gateway | `INTERNAL_TOKEN`, `CHAIN_IDS`, `RPC_URL_43113` |
| signer-service | `INTERNAL_TOKEN`, `KMS_KEY_ID`, `AWS_REGION`, `EXPECTED_SIGNER_ADDRESS`, `SIGNER_CHAIN_ID`, `PINNED_MANDATES`, `SIGNER_KEY_SOURCE=kms` |
| policy-service | `INTERNAL_TOKEN`, `SIGNER_URL`, `LEDGER_URL`, `CHAIN_GATEWAY_URL` |

Two asymmetries worth noticing, because they are the architecture:

- **signer-service names no other service.** It calls nobody; it only answers.
- **policy-service needs no chain or KMS configuration.** It reaches both through URLs only.

### The URL trap

`SIGNER_URL`, `LEDGER_URL` and `CHAIN_GATEWAY_URL` **default to `localhost`** — correct on one
machine, wrong the moment services are separate tasks. In C's cluster they become
`http://signer.internal:4003` and so on. Leave them unset and policy-service quietly dials its
own loopback, fails, and the error looks exactly like signer-service being down.

Module C's `paying_wallet_address` tfvars value is currently the zero address, a placeholder
for the fail-closed deployment. Before integration it becomes
`0x0F6DdD6fC1Fb06B3E91a77Cb1597aCAc8A037CA7`.

---

## 5. Deploy A and B from ONE commit

`POST /sign` requires `accepted` and `resource` (x402 v2 — [api-contracts.md §4](api-contracts.md)),
so version skew breaks in both directions:

| Combination | Failure |
| --- | --- |
| new signer + old policy-service | `400`, `accepted` missing |
| old signer + new policy-service | pre-v2 header → a 402 that never clears |

The second is worse because it looks like a domain bug. Same git SHA and neither can happen.

---

## 6. Setup order

```
1. scripts/setup-iam-roles.sh --apply                       (in 732031180826)
2. scripts/grant-kms-cross-account.sh --account 732031180826 --apply   (in 808198486011)
3. scripts/setup-iam-roles.sh --apply --kms-key-arn <arn>   (in 732031180826)
4. build + push A/B images, register ECS services with Cloud Map names
5. scripts/setup-security-groups.sh --vpc vpc-0cfa8cb7a1dfe244f \
     --orchestrator-sg sg-03f663099bc55d0a6 \
     --dashboard-sg    sg-0458716c037c17d08 --apply
6. Module C's isolation probe (handover §6.4) from the orchestrator SG
```

Steps 1 and 3 are already applied in `808198486011` and must be repeated in C's account.

### Reading the isolation result

AWS security groups **drop** unauthorized packets rather than rejecting them, so a blocked
connection **times out** and never returns a TCP RST. A15 says "refused" but the observable
evidence on AWS is a hang.

**Use Module C's `scripts/isolation-probe.ts` as the C10 evidence.** It requires five facts in
one run: signer DNS resolves, policy/ledger/chain-gateway health all succeed, and signer 4003
fails. Our `scripts/test-isolation.sh` checks one target at a time and cannot prove the
positive controls; it is a quick local check, not the deliverable. It now reports a DNS
failure as **INCONCLUSIVE (exit 2)** rather than a pass, because an unresolvable name proves
the name is wrong, not that a firewall blocked anything.

---

## 7. Verification — how the configuration was checked

All four services booted locally as independent processes with **explicit** URLs rather than
the localhost defaults:

```
health          4001 4002 4003 4004 -> all ok
B-shaped /sign  -> 200, real KMS signature, v2 header, 65-byte signature
B -> chain-gateway /token/constants -> 200, decimals 6, version null
unauthenticated /sign -> 401
```

The hard-invariant rail was exercised **over the same HTTP boundary policy-service uses**:

```
403 SIGNER_WRONG_RECIPIENT     wrong recipient
403 SIGNER_CEILING             over hardMaxTotal
403 SIGNER_WINDOW              window > 600s
403 SIGNER_UNPINNED_MANDATE    mandateId not in the pinned map
200 (signed)                   first request
409 SIGNER_REPLAY              same requestId again
```

That is the claim that matters: the rail holds against a caller that has already reached the
signer, which is the compromised-policy-service scenario from
[execution_plan.md §12b 2.2](execution_plan.md).

---

## 8. Not yet done

- **No A/B Dockerfiles.** Blocks step 4 entirely.
- **A/B is not deployed.** Sections 3 and 6 are the plan, not a record.
- **The isolation screenshot is outstanding.** Needs a task in the orchestrator SG — not
  blocked on Module C being finished, only on A/B being reachable.
- **Escalation message format is unreconciled.** `buildEscalationMessage` in
  `packages/contracts` was defined without sight of C's dashboard. If C signs a different
  string, every approval returns `403 ESCALATION_SIGNATURE_INVALID`. Check at merge.
- **Mainnet is untouched.** `registry.json` has no 43114 address (A5), the production 402 is
  unread (A18), and `MAINNET.settlementRecipient` / `eip712Version` are still `null`, so every
  mainnet path refuses. That refusal is the safety property, not a gap to paper over.
