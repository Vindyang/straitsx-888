# Deployment — separate services, separate instances

**Status:** the topology and the per-service configuration are verified locally as independent
processes (2026-08-15). **Nothing has been deployed to AWS yet** — the scripts are written and
the IAM half is applied, but no instances exist. Treat the AWS sections as the plan, and the
verification section as evidence that the plan is sound.

Companion docs: [conventions.md §2](conventions.md) for who may call whom ·
[api-contracts.md §0](api-contracts.md) for wire shapes ·
[owner-a-tasks.md A15](owner-a-tasks.md) for the isolation requirement.

---

## 1. Why services deploy separately

Not a preference. [A15](owner-a-tasks.md) requires that **only policy-service may reach
signer-service on port 4003, enforced at the network layer**. A single deployment unit cannot
satisfy that: processes on one host share a loopback interface, so the port is reachable by
definition and the only way to "refuse" is a check in code — which A15 explicitly forbids,
because a code check proves the port was reachable and we chose not to answer. The claim is
that it is **not reachable**.

The IAM roles already applied encode the same split: `straitsx-888-signer-service` may call
`kms:Sign`, `straitsx-888-policy-service` is explicitly denied it, and
`straitsx-888-agent-orchestrator` is denied all of KMS. Different roles mean different
instance profiles, which means different instances.

---

## 2. Topology

| Instance | Service | Port | Owner | Security group |
| --- | --- | --- | --- | --- |
| 1 | signer-service | 4003 | A | signer SG — **ingress from policy SG only** |
| 2 | chain-gateway | 4004 | A | the only service that opens an RPC connection |
| 3 | ledger-service | 4001 | B | — |
| 4 | policy-service | 4002 | B | policy SG — the only SG allowed to reach 4003 |
| 5 | agent-orchestrator | 4005 | C | orchestrator SG — **no path to 4003** |
| 6 | dashboard | 3000 | C | public |

Ports come from `SERVICE_PORTS` in `packages/contracts/src/constants.ts`. Never hardcode one.

---

## 3. Per-service configuration

Each service needs only its own variables. This table is the decoupling made visible.

| Service | Required env |
| --- | --- |
| ledger-service | `INTERNAL_TOKEN` |
| chain-gateway | `INTERNAL_TOKEN`, `CHAIN_IDS`, `RPC_URL_43113` (`RPC_TIMEOUT_MS` optional) |
| signer-service | `INTERNAL_TOKEN`, `KMS_KEY_ID`, `AWS_REGION`, `EXPECTED_SIGNER_ADDRESS`, `SIGNER_CHAIN_ID`, `PINNED_MANDATES`, `SIGNER_KEY_SOURCE=kms` |
| policy-service | `INTERNAL_TOKEN`, `SIGNER_URL`, `LEDGER_URL`, `CHAIN_GATEWAY_URL` |

Two asymmetries worth noticing, because they are the architecture:

- **signer-service names no other service.** It calls nobody; it only answers. There is no
  outbound URL in its configuration at all.
- **policy-service needs no chain or KMS configuration.** It reaches both only through URLs.

### The URL trap

`SIGNER_URL`, `LEDGER_URL` and `CHAIN_GATEWAY_URL` **default to `localhost`**. That is correct
on one machine and wrong the moment services are on separate hosts. Leave them unset in a real
deployment and policy-service quietly dials its own loopback, fails to connect, and the error
looks exactly like signer-service being down.

Set them to **private** addresses. None of these should ever be publicly routable.

---

## 4. Deploy from ONE commit

`POST /sign` requires `accepted` and `resource` (the x402 v2 payload — see
[api-contracts.md §4](api-contracts.md)). That makes version skew break in both directions:

| Combination | Failure |
| --- | --- |
| new signer + old policy-service | `400` — `accepted` missing |
| old signer + new policy-service | signer ignores the extra fields and emits the pre-v2 header → a 402 that never clears |

The second is worse because it looks like a domain bug rather than a version mismatch. Deploy
both sides from the same git SHA and neither can happen. A rolling deploy would require making
`accepted` optional first; not worth it at this scale.

The monorepo is not an obstacle. The workspace is source-first with no build step
([conventions.md §1](conventions.md)), so each instance does:

```
git clone <repo> && cd straitsx-888
pnpm install
pnpm dev:<service>
```

Every instance clones the whole repo and runs one service. There is no artifact to publish.

---

## 5. AWS setup order

The scripts have a real dependency chain. Run them in this order.

```
1. scripts/setup-iam-roles.sh --apply
      creates 3 roles + instance profiles, prints the signer role ARN

2. bash scripts/setup-kms.sh
      creates the ECC_SECG_P256K1 key, derives the address, writes .env

3. scripts/setup-iam-roles.sh --apply --kms-key-arn <arn>
      narrows kms:Sign from "*" to that one key -- easy to skip, do not skip

4. scripts/setup-security-groups.sh --vpc <vpc-id> --apply
      one ingress rule: signer:4003 from the policy SG, sourced by GROUP not CIDR

5. attach instance profiles + SGs, deploy, set the URLs

6. scripts/test-isolation.sh --target <signer-private-ip>:4003 --expect blocked
      run FROM the orchestrator instance -- this is the A15 deliverable
```

Steps 1 and 3 are applied already. Steps 4–6 need instances.

### Reading the isolation result

AWS security groups **drop** unauthorized packets rather than rejecting them, so a blocked
connection **times out**; it never returns a TCP RST. A15 says "refused", but the observable
evidence on AWS is a hang. `test-isolation.sh` treats a timeout, a refusal and a DNS failure
all as passes, and treats **a completed HTTP exchange as the only failure**. It targets
`/health` deliberately: that path is exempt from the internal-token check, so a `401` cannot
masquerade as a refusal while the port is wide open.

---

## 6. Verification — how this was checked

Run locally, all four services as independent processes with **explicit** URLs rather than
relying on the localhost defaults:

```
health          4001 4002 4003 4004 -> all ok
B-shaped /sign  -> 200, real KMS signature, v2 header, 65-byte signature
B -> chain-gateway /token/constants -> 200, decimals 6, version null
unauthenticated /sign -> 401
```

The hard-invariant rail was exercised **over the same HTTP boundary policy-service uses**, not
just as pure functions:

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

To re-run: boot the four services with `PINNED_MANDATES` set for a test mandate, then POST a
`/sign` body with `from` = `EXPECTED_SIGNER_ADDRESS`, `to` = the pinned `settlementRecipient`,
and vary one field per request.

---

## 7. What is not yet proven

- **No AWS deployment exists.** Sections 2, 4 and 5 are the plan, not a record.
- **The isolation screenshot is outstanding** — it needs a host in the orchestrator SG, though
  not the orchestrator service itself, so it is not blocked on Owner C.
- **Mainnet is untouched.** `registry.json` has no 43114 address (A5), the production 402 has
  not been read (A18), and `MAINNET.settlementRecipient` / `eip712Version` are still `null`,
  so every mainnet path refuses. That refusal is the safety property, not a gap to paper over.
