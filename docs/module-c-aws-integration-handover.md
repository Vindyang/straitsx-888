# Module C AWS deployment and Module A/B integration handover

Generated: 2026-08-15 23:14 SGT (`2026-08-15T15:14:16Z`)  
Repository: `straitsx-888`, branch `module-c`, HEAD `536de0465f5dd3fb678197a2ea794b5accdc28a8`  
AWS account/Region: `732031180826` / `ap-southeast-1`  
Public dashboard: <https://d3hhqtntf94o95.cloudfront.net>

## 1. Handover decision and scope

Module C is deployed independently of Modules A and B. Its dashboard, orchestrator, and
fixture services are running on ECS/Fargate, the dashboard is remotely reachable through
CloudFront, and Terraform reported **No changes** against AWS on 2026-08-15.

The deployment is intentionally **fail-closed, not end-to-end payment ready**. Because A/B
are not deployed, `/api/ready` returns `503`, the dashboard disables Start Run, and a valid
`POST /api/run` returns retryable `DEPENDENCY_UNAVAILABLE` without creating a run. This is
the correct standalone behavior. It must not be described as a successful signing,
settlement, card issuance, or merchant checkout deployment.

This handover covers:

- the exact deployed Module C topology and AWS identifiers;
- the complete standalone deployment procedure and checked-in deployment scripts;
- the contract, network rules, and evidence required from the A/B owner;
- the post-A/B isolation probe and functional acceptance procedure;
- rollback/roll-forward and the current AWS Well-Architected gaps.

Module C Terraform does not create, change, import, or destroy Module A/B resources. In
particular, it accepts no A/B security-group IDs and no signer endpoint. The A/B owner keeps
ownership of ledger, policy, signer, chain gateway, their data stores, and their ingress.

## 2. Current deployment status

Evidence was rechecked from AWS and the public route on 2026-08-15 between 23:14 and 23:18
SGT.

| Check | Current result | Interpretation |
|---|---|---|
| Terraform refresh/plan | `No changes` | Checked-in Module C configuration matches the deployed stack. |
| CloudFront | `E3IRPXH4XOCPBZ`, `Deployed`, enabled | AWS-managed HTTPS route is live. |
| Dashboard ECS | task definition `:2`, desired/running `2/2`, rollout `COMPLETED` | Service and both ALB targets are healthy. |
| Orchestrator ECS | task definition `:3`, desired/running `1/1`, rollout `COMPLETED` | One task by design while run state is process-local. |
| Fixture ECS | task definition `:3`, desired/running `1/1`, rollout `COMPLETED` | Local deterministic fixture is available to the orchestrator. |
| `GET /` | `200` | Dashboard is remotely viewable. |
| `GET /api/health` | `200`, `{"ok":true,"orchestrator":"reachable"}` | C process liveness and dashboard-to-orchestrator routing work. |
| `GET /api/ready` | `503`; ledger, policy, chain gateway unavailable | Expected until A/B registers the three contracts. |
| Valid `POST /api/run` | `503 DEPENDENCY_UNAVAILABLE`, `retryable: true` | Correct fail-closed admission; `/api/runs` remained `[]`. |
| ALB target health | two targets `healthy` | The application targets are not failing health checks. |
| Unhealthy-target alarm | `OK` | Target health alarm is clear. |
| ALB target-5xx alarm | **`ALARM`** | Two one-minute datapoints of 6 responses exceeded threshold 5. Intentional readiness/run `503` checks count as target 5xx, so the metric currently conflates expected fail-closed responses with faults. |
| Alarm delivery | **No SNS subscriptions** | No operator receives an alarm until a subscription is added and confirmed. |
| Full payment path | **Not run / blocked** | A/B live contracts, signer and settlement prerequisites are absent. |

The ECR publish gate checked the deployed Linux manifests and found zero critical/high
findings at publish time. The immutable deployed image references are in section 4. ECR
scan evidence is point-in-time; it does not replace continuous rescanning or patch cadence.

The working tree contains uncommitted Module C implementation/IaC changes. The images are
digest-pinned, but the integration owner should commit/tag the exact reviewed source before
calling this a reproducible release.

## 3. Deployed architecture

```mermaid
flowchart TB
  U[Remote browser] -->|HTTPS| CF[CloudFront<br/>E3IRPXH4XOCPBZ]
  CF -->|HTTP 80; CloudFront origin prefix list only| ALB[Public ALB<br/>2 public subnets / 2 AZs]
  ALB -->|TCP 3000; ALB SG only| D[Dashboard service<br/>2 private Fargate tasks]

  subgraph VPC[Module C VPC 10.20.0.0/16]
    D -->|TCP 4005; internal token| O[Agent orchestrator<br/>1 private Fargate task]
    O -->|TCP 4010| F[Fixture service<br/>1 private Fargate task]

    D -. readiness and views .->|4001 / 4002 / 4004| CONTRACTS[Stable A/B DNS contracts]
    O -. execution .->|4001 / 4002 / 4004| CONTRACTS

    CONTRACTS --> L[ledger.internal:4001<br/>Module B]
    CONTRACTS --> P[policy.internal:4002<br/>Module B]
    CONTRACTS --> G[chain-gateway.internal:4004<br/>Module A]
    P -->|4003; A/B-owned SG rule only| S[signer.internal:4003<br/>Module A]
    O -. no route, SG rule, environment, or secret .-x S

    O --> EP[VPC endpoints<br/>ECR API/DKR, S3, Logs,<br/>Secrets Manager, SSM, KMS]
    D --> EP
    F --> EP
    O -->|approved /32 HTTPS only| NAT[Single NAT gateway]
  end

  ALB --> LOGS[S3 ALB access logs<br/>90-day lifecycle]
  D --> CW[CloudWatch Logs<br/>KMS encrypted / 30 days]
  O --> CW
  F --> CW
  ALB --> ALARMS[CloudWatch alarms -> SNS<br/>currently no subscriber]
```

### Runtime and trust boundaries

1. The browser calls only dashboard `/api/*` routes. The dashboard injects the internal
   token server-side; it is never sent to browser JavaScript.
2. The dashboard reaches the orchestrator on `4005`. The orchestrator reaches the fixture
   on `4010` and the documented A/B contracts on `4001`, `4002`, and `4004`.
3. Port `4003` is deliberately absent from orchestrator and dashboard egress. Only the
   A/B-owned policy security group may reach signer `4003`.
4. Card data exists only transiently inside the isolated Playwright browser process during
   checkout. It must never be persisted, logged, traced, screenshotted, or recorded.
5. Signed authorization headers and one-time iframe URLs are transient and must not be
   stored or logged. Only non-secret resumable context may survive an escalation.
6. The current CloudFront viewer connection is HTTPS, but the CloudFront-to-ALB origin leg
   is HTTP. ALB ingress is restricted to AWS's CloudFront origin-facing managed prefix list.
   End-to-end TLS, a custom domain/certificate, WAF, and stronger origin authentication are
   production hardening items, not current claims.

### Intended transaction sequence after A/B integration

```mermaid
sequenceDiagram
  participant UI as Dashboard
  participant C as Orchestrator
  participant L as Ledger B
  participant P as Policy B
  participant A as Chain gateway A
  participant X as StraitsX card API
  participant M as Merchant

  UI->>C: POST /run
  C->>L: create immutable intent
  C->>C: discover fixture/merchant
  C->>X: MCP call -> allowlist only cardapiUrl
  C->>X: separate unsigned HTTP request -> parse 402 challenge
  C->>L: attach challenge
  C->>P: policy decision
  alt refused
    P-->>C: refused
    C-->>UI: refusal; no signature, settlement, card, or checkout
  else escalated
    P-->>C: escalated + expiry
    UI->>C: EIP-191 signed decision
    C->>P: resolve escalation
    P-->>C: signed / refused
  else signed
    P-->>C: signed header
  end
  C->>X: authorized card issuance
  C->>A: independently confirm settlement
  alt ok && transferMatched
    C->>L: settlement + rawToolResultHash
    C->>X: request one-time card iframe
    C->>M: isolated checkout and transient autofill
    C->>L: observed spend, proof = none
    C-->>UI: receipt and completed run
  else mismatch or error
    C-->>UI: failed closed; no settlement record/card view/spend
  end
```

## 4. AWS inventory and immutable artifacts

| Resource | Deployed value |
|---|---|
| VPC | `vpc-0cfa8cb7a1dfe244f` (`10.20.0.0/16`) |
| Public subnets | `subnet-09fa6d3c072477107` (`ap-southeast-1a`), `subnet-0858c7cd2cbe22e6d` (`ap-southeast-1b`) |
| Private subnets | `subnet-086b63d008b2172d8` (`ap-southeast-1a`), `subnet-0cf8f66cfa2757f6f` (`ap-southeast-1b`) |
| NAT gateway | `nat-011d98c903e0db4f3` (single-AZ dependency) |
| ECS cluster | `arn:aws:ecs:ap-southeast-1:732031180826:cluster/straitsx-module-c` |
| Cloud Map | namespace `ns-vmmsgsfyqtdfae6k`, name `internal` |
| ALB | `straitsx-module-c-1507042419.ap-southeast-1.elb.amazonaws.com` |
| CloudFront | `E3IRPXH4XOCPBZ`; `d3hhqtntf94o95.cloudfront.net` |
| Orchestrator SG | `sg-03f663099bc55d0a6` |
| Dashboard SG | `sg-0458716c037c17d08` |
| Fixture SG | `sg-0ca2d0e8f998bd4a5` |
| ALB SG | `sg-0d49a767d25df7d78` |
| Endpoint SG | `sg-0648e344b8c595884` |
| Execution role | `arn:aws:iam::732031180826:role/straitsx-module-c-execution` |
| Task role | `arn:aws:iam::732031180826:role/straitsx-module-c-task` |
| CloudWatch logs | `/ecs/straitsx-module-c` |
| Alarm topic | `arn:aws:sns:ap-southeast-1:732031180826:straitsx-module-c-alarms` |
| ALB log bucket | `straitsx-module-c-732031180826-ap-southeast-1-alb-logs` |
| Dashboard image | `732031180826.dkr.ecr.ap-southeast-1.amazonaws.com/straitsx/module-c-dashboard@sha256:476b4904ee999852d50152c15c02fcf33a0a75f4b29c61d2f463eb3cf218e215` |
| Orchestrator image | `732031180826.dkr.ecr.ap-southeast-1.amazonaws.com/straitsx/module-c-orchestrator@sha256:24eed0a9683a29b3abafd63aeaca6550d220100e24a074be93c2a04213187769` |
| Fixture image | same immutable orchestrator image |

The dashboard image tag is `536de04-20260815T143607Z`. The final hardened orchestrator
image tag is `hardened3-20260815T150500Z`; the digest, not the tag, is authoritative.

## 5. Complete standalone deployment procedure

Run from the repository root. Do not put credentials, token values, card data, signed
headers, or iframe URLs in a tfvars file, shell history, CI log, or handover artifact.

### 5.1 Tooling and identity

Required locally: Git, Docker with BuildKit, AWS CLI v2, Terraform, Node.js 22+, Corepack,
`jq`, and permission to create the Module C resources in account `732031180826`.

```sh
cd /Users/alan/Documents/straitsx/888/straitsx-888
git switch module-c

export AWS_REGION=ap-southeast-1
aws sts get-caller-identity
aws configure get region
docker version
terraform version
node --version
corepack pnpm --version
```

The current deployment was performed as account root. That is not an acceptable recurring
deployment identity. Use a scoped role and short-lived credentials when available. If AWS
CLI login credentials work for `aws` but Terraform reports no credentials, export the
current temporary credentials into this shell without printing them:

```sh
eval "$(aws configure export-credentials --format env)"
aws sts get-caller-identity
```

### 5.2 Install and test the workspace

This is a pnpm workspace. Do not run `npm install` inside `services/dashboard`; its
`workspace:*` dependency requires installation from the repository root with the pinned
pnpm version.

```sh
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
```

Last verified result: typecheck passed; 19 test files and 187 tests passed, with 6
environment-dependent live-RPC tests skipped.

For local development:

```sh
corepack pnpm dev:fixtures
corepack pnpm dev:orchestrator
corepack pnpm dev:dashboard
```

### 5.3 Build, scan, and publish images

Never type the literal word `ACCOUNT` into the ECR URL. The publish script derives the
12-digit account ID from STS, creates the two repositories if absent, enables immutable tags
and scan-on-push, builds `linux/amd64`, pushes, waits for scans, rejects critical/high
findings, and prints digest-pinned Terraform values.

```sh
export AWS_REGION=ap-southeast-1
scripts/publish-module-c-images.sh "$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
```

Use the three printed `*_image=` values in the next step. The current deployed values are
listed in section 4.

### 5.4 Create the real standalone tfvars file

```sh
cp infra/module-c/terraform.standalone.tfvars.example /tmp/module-c.tfvars
chmod 600 /tmp/module-c.tfvars
${EDITOR:-vi} /tmp/module-c.tfvars
```

Replace all example account IDs, `replace-me`, and image values. Keep these standalone
settings while A/B is absent:

```hcl
name              = "straitsx-module-c"
aws_region        = "ap-southeast-1"
create_foundation = true
enable_cloudfront = true

certificate_arn         = null
alb_deletion_protection = false

dashboard_image    = "732031180826.dkr.ecr.ap-southeast-1.amazonaws.com/straitsx/module-c-dashboard@sha256:476b4904ee999852d50152c15c02fcf33a0a75f4b29c61d2f463eb3cf218e215"
orchestrator_image = "732031180826.dkr.ecr.ap-southeast-1.amazonaws.com/straitsx/module-c-orchestrator@sha256:24eed0a9683a29b3abafd63aeaca6550d220100e24a074be93c2a04213187769"
fixture_image      = "732031180826.dkr.ecr.ap-southeast-1.amazonaws.com/straitsx/module-c-orchestrator@sha256:24eed0a9683a29b3abafd63aeaca6550d220100e24a074be93c2a04213187769"

ledger_service_name        = "ledger.internal"
policy_service_name        = "policy.internal"
chain_gateway_service_name = "chain-gateway.internal"

https_egress_cidrs  = []
paying_wallet_address = "0x0000000000000000000000000000000000000000"

dashboard_desired_count = 2
service_max_count        = 4

tags = {
  Environment = "demo"
  Owner       = "module-c"
  Application = "straitsx-888"
}
```

The zero wallet is allowed only for the A/B-absent fail-closed deployment. Before live
integration, update `paying_wallet_address` through this tfvars file and Terraform so the
SSM value and IaC stay consistent. The existing local `/tmp/module-c-aws.tfvars` was found
with mode `0644`; change any retained copy to `0600` before reuse.

### 5.5 Plan and apply

The wrapper validates that the file exists, rejects example placeholders, formats,
initializes, validates, produces a saved plan, and applies exactly the reviewed plan.

```sh
scripts/deploy-module-c.sh module-c /tmp/module-c.tfvars
scripts/deploy-module-c.sh module-c /tmp/module-c.tfvars --apply
```

Do not pass `/absolute/path/module-c.tfvars`; that was documentation notation, not a real
file. If the wrapper reports a missing file, create `/tmp/module-c.tfvars` as shown above.

### 5.6 Wait and verify the standalone result

```sh
export ECS_CLUSTER_ARN="$(terraform -chdir=infra/module-c output -raw ecs_cluster_arn)"
export DASHBOARD_URL="$(terraform -chdir=infra/module-c output -raw dashboard_url)"

aws ecs wait services-stable \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_ARN" \
  --services \
    straitsx-module-c-dashboard \
    straitsx-module-c-orchestrator \
    straitsx-module-c-fixture

curl -fsS -o /dev/null -w 'dashboard=%{http_code}\n' "$DASHBOARD_URL/"
curl -fsS "$DASHBOARD_URL/api/health"
curl -sS -o /tmp/module-c-ready.json -w 'ready=%{http_code}\n' "$DASHBOARD_URL/api/ready"
jq . /tmp/module-c-ready.json

curl -sS -o /tmp/module-c-run.json -w 'run=%{http_code}\n' \
  -H 'content-type: application/json' \
  --data '{"instruction":"Buy the clean fixture","mandateId":"0x7f3a","agentId":"shopper-1","source":{"kind":"fixture","name":"clean"}}' \
  "$DASHBOARD_URL/api/run"
jq . /tmp/module-c-run.json
curl -fsS "$DASHBOARD_URL/api/runs"
```

Before A/B is present, the required result is dashboard `200`, health `200`, ready `503`,
run `503 DEPENDENCY_UNAVAILABLE`, and an empty run list. After A/B is present, ready must
become `200`; only then should functional payment tests begin.

## 6. Module A/B integration contract

### 6.1 A/B owner prerequisites

The A/B owner must provide all of the following before Module C can be accepted end to end:

- `ledger.internal:4001`, `policy.internal:4002`, and
  `chain-gateway.internal:4004` resolvable/reachable from the Module C VPC;
- `GET /health` returning success on all three contracts;
- a non-stub Module A KMS signer whose derived address matches the funded wallet and whose
  Fuji mandate is pinned;
- policy-to-signer `4003` ingress from the policy SG only, with no dashboard/orchestrator
  route;
- the shared `buildEscalationMessage` EIP-191 contract used by both dashboard and policy;
- Module B receipt storage for the optional migration field `rawToolResultHash`;
- Module B canonical intent commitment nonce, with `intentHash` and the signed
  `merchantDomain` exposed on the receipt;
- live Module A settlement confirmation returning success only when both `ok` and
  `transferMatched` are true;
- the expected paying-wallet address, chain configuration, and signer DNS name for the
  one-off isolation probe. The signer name is never added to a persistent Module C task.

The documented HTTP contracts are authoritative in `docs/api-contracts.md`. The important
Module C calls are:

| Owner | Contract used by C |
|---|---|
| Ledger B | `POST /intent`; attach challenge; nonce/decision/settlement/spend recording; `GET /receipt/:requestId`; `GET /window/:mandateId`; receipts include `intentHash`, signed `merchantDomain`, and optional settlement evidence `rawToolResultHash`. |
| Policy B | `POST /payment/request` with a complete `resolvedItem`, including non-empty `merchantDomain`; only validated `signed`, `refused`, or `escalated`; `POST /escalation/:requestId/resolve` with signature verification and expiry denial. Missing merchant domains refuse before nonce reservation. |
| Chain gateway A | `POST /settlement/confirm`; C proceeds only for `ok && transferMatched`; mandate/token/read models used by the dashboard. |
| Signer A | **No direct C contract.** Only policy may call signer `4003`. |

If A/B deploys in another VPC/account, `*.internal` cannot simply register in this private
namespace. The teams must first agree PrivateLink, VPC peering/TGW plus Route 53 Resolver,
or a shared private DNS design and update the same-VPC CIDR egress assumptions. Do not open
the ports to `0.0.0.0/0` as a shortcut.

### 6.2 Exact security-group handoff

Generate the canonical handoff at any time with:

```sh
terraform -chdir=infra/module-c output -json dependency_ingress_handoff
```

The currently deployed values are:

| A/B destination | Port | Allowed Module C source SGs |
|---|---:|---|
| ledger | 4001 | `sg-03f663099bc55d0a6`, `sg-0458716c037c17d08` |
| policy | 4002 | `sg-03f663099bc55d0a6`, `sg-0458716c037c17d08` |
| chain gateway | 4004 | `sg-03f663099bc55d0a6`, `sg-0458716c037c17d08` |

The A/B-owned stack must create those ingress rules. It must separately allow signer `4003`
from the **policy-service SG only** and remove any broader signer ingress. Module C must not
be granted signer access.

### 6.3 Enable live external HTTPS deliberately

The current `https_egress_cidrs = []`, so StraitsX and a real merchant are intentionally
unreachable from the orchestrator. Before a controlled live test:

1. Resolve the approved StraitsX MCP/card endpoints and selected merchant endpoints.
2. Review CDN/load-balancer address stability and include only current `/32` CIDRs.
3. Update `https_egress_cidrs` in the real Module C tfvars file and apply through Terraform.
4. Recheck card API origin/path validation and the merchant profile hostname/path allowlist.

`0.0.0.0/0` is rejected. Static IPs are demo-grade because merchants/CDNs can change.
Production should use inspected egress or AWS Network Firewall/proxy controls that can
enforce approved domains.

### 6.4 Register and run the post-A/B isolation probe

Create a private integration tfvars file:

```sh
cp infra/module-c-integration/terraform.tfvars.example /tmp/module-c-integration.tfvars
chmod 600 /tmp/module-c-integration.tfvars
${EDITOR:-vi} /tmp/module-c-integration.tfvars
```

Use these current Module C outputs and the final A/B DNS contracts:

```hcl
name       = "straitsx-module-c"
aws_region = "ap-southeast-1"

execution_role_arn   = "arn:aws:iam::732031180826:role/straitsx-module-c-execution"
task_role_arn        = "arn:aws:iam::732031180826:role/straitsx-module-c-task"
cloudwatch_log_group = "/ecs/straitsx-module-c"
orchestrator_image   = "732031180826.dkr.ecr.ap-southeast-1.amazonaws.com/straitsx/module-c-orchestrator@sha256:24eed0a9683a29b3abafd63aeaca6550d220100e24a074be93c2a04213187769"

ledger_service_name        = "ledger.internal"
policy_service_name        = "policy.internal"
chain_gateway_service_name = "chain-gateway.internal"

tags = {
  Environment = "demo"
  Owner       = "integration"
  Application = "straitsx-888"
}
```

Plan and apply only the C-owned probe task definition:

```sh
scripts/deploy-module-c.sh integration /tmp/module-c-integration.tfvars
scripts/deploy-module-c.sh integration /tmp/module-c-integration.tfvars --apply
```

Launch it in the exact orchestrator subnets and SG. Replace only `signer.internal` if the
A/B owner supplies a different private DNS name:

```sh
export ECS_CLUSTER_ARN="arn:aws:ecs:ap-southeast-1:732031180826:cluster/straitsx-module-c"
export PROBE_TASK_DEFINITION="$(terraform -chdir=infra/module-c-integration output -raw isolation_probe_task_definition_arn)"
export PROBE_NETWORK='awsvpcConfiguration={subnets=[subnet-086b63d008b2172d8,subnet-0cf8f66cfa2757f6f],securityGroups=[sg-03f663099bc55d0a6],assignPublicIp=DISABLED}'

export PROBE_TASK_ARN="$(aws ecs run-task \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_ARN" \
  --task-definition "$PROBE_TASK_DEFINITION" \
  --launch-type FARGATE \
  --network-configuration "$PROBE_NETWORK" \
  --overrides '{"containerOverrides":[{"name":"probe","environment":[{"name":"SIGNER_HOST","value":"signer.internal"},{"name":"SIGNER_PORT","value":"4003"}]}]}' \
  --query 'tasks[0].taskArn' \
  --output text)"

aws ecs wait tasks-stopped \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_ARN" \
  --tasks "$PROBE_TASK_ARN"

aws ecs describe-tasks \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER_ARN" \
  --tasks "$PROBE_TASK_ARN" \
  --query 'tasks[0].{stopCode:stopCode,stoppedReason:stoppedReason,container:containers[0].{exitCode:exitCode,reason:reason}}' \
  --output json

aws logs tail /ecs/straitsx-module-c \
  --region "$AWS_REGION" \
  --log-stream-name-prefix isolation-probe \
  --since 30m
```

A valid C10 pass requires all five facts in one task execution:

- signer DNS resolves to at least one address;
- policy `4002` health succeeds;
- ledger `4001` health succeeds;
- chain gateway `4004` health succeeds;
- signer TCP/HTTP `4003` fails from the orchestrator SG.

DNS failure is a failed probe, never evidence of isolation. Archive the task ARN, task
description, exit code `0`, and redacted CloudWatch output. Do not archive any signed header,
iframe URL, PAN, CVC, expiry, or approval signature.

## 7. Functional acceptance after A/B connects

Run these gates in order. Stop on the first failure.

1. `GET /api/health` is `200` and `GET /api/ready` becomes `200` with all three dependencies
   ready.
2. Inspect the orchestrator task definition and security group: there is no signer URL,
   secret, route, or `4003` egress.
3. Execute and archive the C10 isolation probe from section 6.4.
4. Run all four deterministic fixtures:
   - `clean` signs and proceeds only after independent settlement match;
   - `poisoned-recipient` refuses check 4 with no signature/settlement;
   - `poisoned-amount` refuses check 5 with no signature/settlement;
   - `wrong-item` escalates check 9, supports approve/deny/expiry, and resumes the same run.
5. Confirm SSE order:
   `INTENT_CREATED -> DISCOVERY_DONE -> CHALLENGE_RECEIVED -> POLICY_DECISION ->
   SETTLEMENT_CONFIRMED -> CARD_ISSUED -> CHECKOUT_ASSERTED -> SPEND_RECORDED`.
6. Force settlement `ok=false` and `transferMatched=false` cases. Neither may record
   settlement, request the card iframe, check out, or record spend.
7. Verify the ledger receipt stores `rawToolResultHash` and checkout observation uses
   `proof: "none"`.
8. Test escalation signature verification, denial, expiry auto-denial, standing approval,
   and a fresh request after terminal state.
9. Test exact merchant host/path, lookalike refusal, one-time card view, confirmation-page
   extraction, and transient browser cleanup.
10. Review CloudWatch, ALB logs, browser console, and any captured evidence for secret/card
    leakage. Video, trace, screenshot, and console capture must be disabled while card data
    is exposed.
11. Run the Fuji acceptance with the funded/pinned non-stub signer and real XSGD settlement.
    Run production only with organiser clearance, production chain `43114`, the approved
    merchant profile, and a user-supplied SGD 5-30 purchase.

Module C is fully functional only when all of the above pass. Current evidence proves only
standalone availability and fail-closed dependency handling.

## 8. Operations, evidence, rollback, and teardown

### Routine evidence commands

```sh
terraform -chdir=infra/module-c output -json

aws ecs describe-services \
  --region "$AWS_REGION" \
  --cluster straitsx-module-c \
  --services straitsx-module-c-dashboard straitsx-module-c-orchestrator straitsx-module-c-fixture \
  --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition,rollout:deployments[0].rolloutState}'

aws cloudwatch describe-alarms \
  --region "$AWS_REGION" \
  --alarm-name-prefix straitsx-module-c

aws logs tail /ecs/straitsx-module-c --region "$AWS_REGION" --since 30m
```

Create and confirm an owned alarm subscription before integration testing:

```sh
aws sns subscribe \
  --region "$AWS_REGION" \
  --topic-arn arn:aws:sns:ap-southeast-1:732031180826:straitsx-module-c-alarms \
  --protocol email \
  --notification-endpoint operator@example.com
```

Replace the example email and confirm the AWS email. Prefer managing the final subscription
through Terraform (`alarm_email`) to avoid drift. The current target-5xx alarm needs a
separate integration/readiness signal or status-code filtering so expected fail-closed 503s
do not page as application faults.

### Roll-forward and rollback

The preferred recovery is roll-forward:

1. fix and test the source;
2. publish a new immutable image digest;
3. replace the digest in the real tfvars file;
4. review `scripts/deploy-module-c.sh module-c ...`;
5. apply and let the ECS circuit breaker roll back an unhealthy deployment automatically.

For an application rollback, restore the last known-good image digests in tfvars and apply
through the wrapper. Do not rely on mutable ECR tags. An emergency `aws ecs update-service`
to an older task definition creates Terraform drift; if used, immediately reconcile the
digest and task definition through Terraform and record the incident.

The orchestrator contains process-local non-secret run context, so replacing its only task
terminates in-flight runs. Drain or allow terminal completion before deployment where
possible. Durable run storage is required before scaling orchestrator above one or claiming
HA/resumable recovery across task replacement.

### Teardown

Destroy the optional integration task definition first, then Module C. Review the destroy
plan carefully; the stack includes logs, the secret, SSM wallet parameter, networking, NAT,
and the ALB log bucket. Export required redacted evidence before teardown.

```sh
terraform -chdir=infra/module-c-integration plan -destroy -var-file=/tmp/module-c-integration.tfvars
terraform -chdir=infra/module-c-integration destroy -var-file=/tmp/module-c-integration.tfvars

terraform -chdir=infra/module-c plan -destroy -var-file=/tmp/module-c.tfvars
terraform -chdir=infra/module-c destroy -var-file=/tmp/module-c.tfvars
```

These commands are intentionally not automated by the deployment wrapper. The NAT gateway,
interface endpoints, ALB, CloudFront, Fargate tasks, and logs continue to incur cost while
the environment remains deployed.

## 9. AWS Well-Architected review

Scope: the deployed Module C account/Region and its integration edge to A/B. The review uses
`docs/references/wellarchitected-framework.pdf` through the project-scoped
`.agents/skills/aws-well-architected-review` checklist. A/B internals, account-wide controls,
and live payment rails are external evidence gates, not assumed compliant.

| Pillar | Status | Deployed evidence | Remaining gap |
|---|---|---|---|
| Operational excellence | Partial | Versioned Terraform/Dockerfiles, plan wrapper, health/readiness split, logs, alarms, circuit breaker | Root deployment identity, no alarm subscriber, active/noisy 5xx alarm, dirty release source, rollback not exercised. |
| Security | Partial | Private tasks, narrow SG flows, no signer configuration, secrets/SSM, encrypted logs, immutable digests, non-root/read-only containers, scan gate | Origin leg is HTTP, no WAF/custom domain, local state, live isolation proof and A/B signature verification pending. |
| Reliability | Partial | Two-AZ ALB/dashboard, autoscaling, health checks, fail-closed dependencies, deployment rollback | Single NAT, one fixture, one process-local orchestrator, no tested restore/DR or cross-task run recovery. |
| Performance efficiency | Partial | Fargate sizing parameters, dashboard target tracking, CloudFront | No load test or metric-based sizing evidence. |
| Cost optimization | Partial | Fargate, bounded retention, tags, dashboard scaling | No budget/anomaly alerts; NAT/endpoints/ALB idle cost needs review. |
| Sustainability | Partial | Managed compute, scaling, finite log lifecycle | No utilization baseline/right-sizing record; demo resources need teardown decision. |

### Prioritized findings

| ID / priority | Evidence and impact | Required remediation | Verification / owner / timing |
|---|---|---|---|
| `SEC-01` Critical | Deployment identity is `arn:aws:iam::732031180826:root`. Root credential compromise has account-wide blast radius. | Stop using root for routine work; protect root with MFA, remove/rotate root access keys, deploy through a least-privilege short-lived role. | STS shows an assumed deployment role and account root has no active access keys. Account owner, before next apply. |
| `OPS-01` High | SNS topic has zero subscriptions; ALB 5xx alarm is currently `ALARM` after two datapoints of 6. Alerts are neither delivered nor actionable. | Add/confirm an owned destination; separate expected readiness/run 503s from genuine server faults; exercise alarm delivery. | Confirmed subscription, test notification received, normal steady state `OK`. Module C/account owner, before A/B integration. |
| `REL-01` High | Orchestrator run/escalation state is process-local and service count is 1. Task replacement loses in-flight resumes. | Add encrypted durable non-secret run state with idempotent transitions, then raise minimum count and test recovery. | Kill/redeploy a task during escalation and resume the same request exactly once. Module C, before HA claim. |
| `SEC-02` High | Viewer TLS terminates at CloudFront; origin uses HTTP, default CloudFront hostname, no WAF. | For production add custom DNS/certificate, TLS to origin, origin authentication/control, WAF and tested rate limits. | TLS scan, direct-origin denial, WAF test, Route 53 alias. Platform/C owner, before production. |
| `SEC-03` High gate | A/B is absent, so signer isolation, signature verification, raw evidence persistence and settlement matching are unproven. | Complete the A/B contract and execute section 6.4 plus section 7. | Redacted logs/receipts and probe exit 0. A/B + C owners, before any live rail claim. |
| `REL-02` Medium | Both private AZ route tables use one NAT in one AZ. NAT/AZ failure can remove approved external HTTPS. | Use per-AZ NAT or an inspected highly available egress design; keep private endpoints. | Route-table review and AZ impairment test. Platform owner, before production. |
| `SEC-04` Medium | Terraform state is local and contains generated secret material; retained tfvars was mode `0644`. | Move state to encrypted remote backend with locking and restricted IAM; chmod local tfvars `0600`; remove obsolete copies securely. | Backend encryption/lock/access test and file permission check. Platform owner, before shared operations. |
| `OPS-02` Medium | Deployed images came from a dirty working tree; digest exists but source-to-artifact provenance is incomplete. | Commit/tag reviewed changes; build in CI; retain SBOM, scan report, digest and provenance/attestation. | Clean checkout reproduces digest or signed build attestation maps commit to digest. C owner, next release. |
| `COST-01` Medium | No account budget/anomaly alert; NAT, endpoints, ALB and CloudFront remain billed while idle. | Add account budget/anomaly alert and teardown schedule for demo environments. | Alert test and monthly cost review. Account owner, post-integration but before unattended operation. |

### Launch blockers versus post-launch work

Blockers for **A/B integration testing**:

- confirmed alarm destination and understood/reset alarm behavior;
- scoped deployment identity instead of root;
- A/B health/DNS and exact SG ingress contract;
- real wallet/mandate/signer and Module B acceptance fields;
- approved external HTTPS egress;
- successful C10 isolation probe.

Additional blockers for **production**:

- durable orchestrator state and tested task-replacement recovery;
- end-to-end TLS/custom hostname/origin protection/WAF;
- highly available inspected egress;
- encrypted remote Terraform state and release provenance;
- production chain/merchant clearance and redacted live acceptance evidence.

Post-launch optimizations, after the above controls are working: load-based right-sizing,
budgets/anomaly detection, longer-term DR objectives, and sustainability utilization review.

## 10. Authoritative file and script inventory

| Path | Purpose | SHA-256 at handover |
|---|---|---|
| `scripts/publish-module-c-images.sh` | Build, push, scan-gate, and print digest-pinned images | `746558f7191e1a649e5edc1402304cce1c5d29e747d757f00b07fe8300f01837` |
| `scripts/deploy-module-c.sh` | Validate/plan/apply either C or integration stack | `acae43604fee8c114289eefee2f0b1a656200748ba687b19c59448e9a29a326d` |
| `scripts/isolation-probe.ts` | One-off ECS positive A/B and negative signer network proof | `b1e1009a1e63bef34f707c82251bd9d37d91d63854512c5060593a6387fe9c43` |
| `scripts/verify-signer-isolation.sh` | Legacy/local negative-only check; not sufficient for AWS C10 evidence | `fc0530d0e32e2ef79fd4863dfbe2a54ca95f48d5ca9cf2bf2eb3437b72647b02` |
| `services/agent-orchestrator/docker-entrypoint.sh` | Prepare ephemeral `/tmp`, then drop to UID/GID 1001 | `ac291ed5a85e6cd2bd69e5c999575e6e1c98b1334110b8c3a9c80610f20ace1e` |
| `infra/module-c/foundation.tf` | Optional standalone VPC/platform prerequisites | `9afbab93b1b3eaea14ed1fb1c8ae70ca70ca8de2a26f18e7a06cf6e8a2a540fd` |
| `infra/module-c/main.tf` | Module C services, routing, SGs, IAM, scaling and alarms | `3f5b0e620a7f8673917e51b74459735092fe6053bc7085491f5cdf26c7a61dab` |
| `infra/module-c/variables.tf` | Validated C inputs | `ea04d03eb3c4d752f4d7826a389314b783734cb14446794a72cc75fc9d76bef3` |
| `infra/module-c/outputs.tf` | Public URL and A/B handoff outputs | `24907f90ffb4a9ea957034333dc7e02718ca35e93b0fdd746c6c5f9497322125` |
| `infra/module-c/versions.tf` | Terraform/provider constraints; state is local until a remote backend is configured | `4ae209b9187d294974c77a0461fdfbfae8cfccd65a69f7cc7ec77da7a8165e0d` |
| `infra/module-c/.terraform.lock.hcl` | Pinned provider selections/checksums | `e47df301e05bb8dd5ae1fb572f2090140891f49b1b2a642fb6f0adf886bac01e` |
| `infra/module-c/terraform.standalone.tfvars.example` | Self-contained deployment template | `9bb59d8adba415990a47a70be74b2f1a6170371a43a401d78f8f1439cb3b6c14` |
| `infra/module-c/terraform.tfvars.example` | Existing-platform deployment template | `d61fa79ced8409c336c5910c5935997bd36372061aa51667d673b42b3aa40a32` |
| `infra/module-c-integration/main.tf` | C-owned one-off isolation probe task definition | `aa758c90b7aab376740110cfd6a99fc3ec7ebb784e0c452e885eec33ca1984b6` |
| `infra/module-c-integration/variables.tf` | Probe inputs and digest validation | `017dd7e2f99d64e85bfba5a998f127691e6201b418bf3565b740993c9d7bab8d` |
| `infra/module-c-integration/outputs.tf` | Probe task-definition output | `82d0fdcb9bd9cb08334678187cc1aab312b1cf1c14577c8070b6b0c63943c4b9` |
| `infra/module-c-integration/versions.tf` | Probe Terraform/provider constraints | `7f972063faf924c4c7c046ddd5b0b13334a396fe680dfddf0ee601b1262a062a` |
| `infra/module-c-integration/terraform.tfvars.example` | Post-A/B probe configuration template | `ac8ea2b75947289723918e43b74d02917f91679041ba910fe1985850d388861a` |
| `services/dashboard/Dockerfile` | Dashboard production image | `2efc215f00f3f3352fbf8df7534d3d5b101e5364e6f827e7a849fc2a8710780e` |
| `services/agent-orchestrator/Dockerfile` | Hardened Playwright orchestrator/fixture image | `def00301b052574834bf95e2aacd9cfd15bc2dabc76e5fc7817160073359198f` |

The checked-in files are authoritative; verify checksums before using copied script text.
`scripts/sync-registry.ts` is a development registry helper, not an AWS deployment entry
point.

## Appendix A: `scripts/publish-module-c-images.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [release-tag]" >&2
  exit 64
fi

: "${AWS_REGION:?AWS_REGION must name the deployment Region}"

release_tag="${1:-$(git rev-parse --short HEAD)-$(date -u +%Y%m%dT%H%M%SZ)}"
target_platform="${TARGET_PLATFORM:-linux/amd64}"
dashboard_repository="${DASHBOARD_ECR_REPOSITORY:-straitsx/module-c-dashboard}"
orchestrator_repository="${ORCHESTRATOR_ECR_REPOSITORY:-straitsx/module-c-orchestrator}"

if [[ ! "$release_tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "release tag is not a valid Docker/ECR tag: $release_tag" >&2
  exit 64
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

account_id="$(aws sts get-caller-identity --query Account --output text)"
if [[ ! "$account_id" =~ ^[0-9]{12}$ ]]; then
  echo "AWS STS returned an invalid account ID: $account_id" >&2
  exit 69
fi

registry="${account_id}.dkr.ecr.${AWS_REGION}.amazonaws.com"
dashboard_repository_uri="${registry}/${dashboard_repository}"
orchestrator_repository_uri="${registry}/${orchestrator_repository}"

for repository in "$dashboard_repository" "$orchestrator_repository"; do
  if ! aws ecr describe-repositories \
    --region "$AWS_REGION" \
    --repository-names "$repository" >/dev/null 2>&1; then
    echo "creating ECR repository: $repository"
    aws ecr create-repository \
      --region "$AWS_REGION" \
      --repository-name "$repository" \
      --image-tag-mutability IMMUTABLE \
      --image-scanning-configuration scanOnPush=true >/dev/null
  fi
done

aws ecr get-login-password --region "$AWS_REGION" |
  docker login --username AWS --password-stdin "$registry"

dashboard_tagged="${dashboard_repository_uri}:${release_tag}"
orchestrator_tagged="${orchestrator_repository_uri}:${release_tag}"

# Disable the default BuildKit provenance index so the pushed digest is the
# scannable platform manifest consumed by Fargate. Provenance should be
# published separately by CI when an attestation store is configured.
docker build --provenance=false --platform "$target_platform" -f services/dashboard/Dockerfile -t "$dashboard_tagged" .
docker build --provenance=false --platform "$target_platform" -f services/agent-orchestrator/Dockerfile -t "$orchestrator_tagged" .
docker push "$dashboard_tagged"
docker push "$orchestrator_tagged"

dashboard_digest="$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$dashboard_repository" --image-ids "imageTag=${release_tag}" --query 'imageDetails[0].imageDigest' --output text)"
orchestrator_digest="$(aws ecr describe-images --region "$AWS_REGION" --repository-name "$orchestrator_repository" --image-ids "imageTag=${release_tag}" --query 'imageDetails[0].imageDigest' --output text)"

assert_scan_gate() {
  local repository="$1"
  local digest="$2"
  local counts critical high

  aws ecr wait image-scan-complete \
    --region "$AWS_REGION" \
    --repository-name "$repository" \
    --image-id "imageDigest=${digest}"
  counts="$(aws ecr describe-image-scan-findings \
    --region "$AWS_REGION" \
    --repository-name "$repository" \
    --image-id "imageDigest=${digest}" \
    --query 'imageScanFindings.findingSeverityCounts' \
    --output json)"
  critical="$(jq -r '.CRITICAL // 0' <<<"$counts")"
  high="$(jq -r '.HIGH // 0' <<<"$counts")"
  printf 'scan %s@%s: critical=%s high=%s\n' "$repository" "$digest" "$critical" "$high"
  if (( critical > 0 || high > 0 )); then
    echo "refusing to publish Terraform values: ECR scan gate failed" >&2
    exit 67
  fi
}

assert_scan_gate "$dashboard_repository" "$dashboard_digest"
assert_scan_gate "$orchestrator_repository" "$orchestrator_digest"

printf 'dashboard_image=%s@%s\n' "$dashboard_repository_uri" "$dashboard_digest"
printf 'orchestrator_image=%s@%s\n' "$orchestrator_repository_uri" "$orchestrator_digest"
printf 'fixture_image=%s@%s\n' "$orchestrator_repository_uri" "$orchestrator_digest"
```

## Appendix B: `scripts/deploy-module-c.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <module-c|integration> <tfvars-file> [--apply]" >&2
  exit 64
fi

stage="$1"
tfvars_file="$2"
apply_mode="${3:-}"

case "$stage" in
  module-c) stack_relative="infra/module-c" ;;
  integration) stack_relative="infra/module-c-integration" ;;
  *) echo "stage must be module-c or integration" >&2; exit 64 ;;
esac

if [[ ! -f "$tfvars_file" ]]; then
  echo "tfvars file does not exist: $tfvars_file" >&2
  echo "create one with:" >&2
  if [[ "$stage" == "module-c" ]]; then
    echo "  cp infra/module-c/terraform.standalone.tfvars.example /tmp/module-c.tfvars" >&2
  else
    echo "  cp ${stack_relative}/terraform.tfvars.example /tmp/${stage}.tfvars" >&2
  fi
  echo "then replace every example value before rerunning this command" >&2
  exit 66
fi
if [[ -n "$apply_mode" && "$apply_mode" != "--apply" ]]; then
  echo "third argument, when present, must be --apply" >&2
  exit 64
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stack_dir="${repo_root}/${stack_relative}"
tfvars_file="$(cd "$(dirname "$tfvars_file")" && pwd)/$(basename "$tfvars_file")"

placeholder_pattern='replace-me|111122223333|203\.0\.113\.|subnet-private-|subnet-public-|/absolute/path|ACCOUNT\.dkr\.ecr'
if grep -En "$placeholder_pattern" "$tfvars_file" >&2; then
  echo "tfvars still contains example placeholders; replace the lines shown above" >&2
  exit 65
fi

plan_file="$(mktemp "/tmp/${stage}.XXXXXX.tfplan")"
trap 'rm -f "$plan_file"' EXIT

terraform -chdir="$stack_dir" fmt -check
terraform -chdir="$stack_dir" init -reconfigure
terraform -chdir="$stack_dir" validate
terraform -chdir="$stack_dir" plan -var-file="$tfvars_file" -out="$plan_file"
terraform -chdir="$stack_dir" show "$plan_file"

if [[ "$apply_mode" == "--apply" ]]; then
  terraform -chdir="$stack_dir" apply "$plan_file"
else
  echo "plan only; rerun with --apply after review"
fi
```

## Appendix C: `scripts/isolation-probe.ts`

```ts
/** Run inside a one-off ECS task using the orchestrator security group. */
import { lookup } from "node:dns/promises";
import { connect } from "node:net";

const signerHost = process.env["SIGNER_HOST"];
const signerPort = Number(process.env["SIGNER_PORT"] ?? 4003);
const requiredUrls = [process.env["POLICY_URL"], process.env["LEDGER_URL"], process.env["CHAIN_GATEWAY_URL"]];

if (!signerHost || requiredUrls.some((url) => !url)) {
  throw new Error("SIGNER_HOST, POLICY_URL, LEDGER_URL and CHAIN_GATEWAY_URL are required");
}

const addresses = await lookup(signerHost, { all: true });
if (addresses.length === 0) throw new Error("signer DNS returned no addresses");
console.log(`PASS signer DNS resolved (${addresses.length} address record(s))`);

for (const base of requiredUrls as string[]) {
  const response = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${new URL(base).hostname} health returned ${response.status}`);
  console.log(`PASS reachable ${new URL(base).hostname}:${new URL(base).port}`);
}

const signerReachable = await new Promise<boolean>((resolve, reject) => {
  const socket = connect({ host: signerHost, port: signerPort });
  const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 5_000);
  socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
  socket.once("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    if (["ECONNREFUSED", "EHOSTUNREACH", "ETIMEDOUT"].includes(error.code ?? "")) resolve(false);
    else reject(error);
  });
});
if (signerReachable) throw new Error(`FAIL orchestrator security group reached signer TCP ${signerPort}`);
console.log(`PASS signer DNS exists but TCP/HTTP ${signerPort} is unreachable from orchestrator security group`);
```

## Appendix D: supporting runtime and local isolation scripts

`services/agent-orchestrator/docker-entrypoint.sh`:

```sh
#!/bin/sh
set -eu

# Fargate bind mounts start as root:root 0755. Fix only the ephemeral /tmp
# mount, then irrevocably drop to the image's pwuser before application code.
chown 1001:1001 /tmp
chmod 0700 /tmp
exec setpriv --reuid=1001 --regid=1001 --init-groups "$@"
```

`scripts/verify-signer-isolation.sh` is useful for a local negative check but is not valid
AWS C10 evidence because it does not first prove signer DNS and positive A/B reachability:

```bash
#!/usr/bin/env bash
# C10 — prove agent-orchestrator cannot reach signer-service. Run FROM the
# orchestrator host (or a container on the same network as it). A refused/
# timed-out connection is success; anything that returns HTTP is a failure —
# the security claim in docs/conventions.md §2 ("Only signer-service holds key
# material, and only policy-service may reach it") depends on this being a
# network-layer fact, not a code check. Coordinate with Owner A (A15), whose
# test asserts the same boundary from the other side.
#
# Usage: ./scripts/verify-signer-isolation.sh [signer-host] [signer-port]
set -euo pipefail

SIGNER_HOST="${1:-signer}"
SIGNER_PORT="${2:-4003}"

echo "verify-signer-isolation: curling http://${SIGNER_HOST}:${SIGNER_PORT}/health from this host..."
if curl --max-time 5 --silent --show-error --fail "http://${SIGNER_HOST}:${SIGNER_PORT}/health" >/dev/null; then
  echo "FAIL: signer-service answered — the orchestrator can reach the signer. Fix the network policy."
  exit 1
else
  echo "PASS: connection to signer-service was refused/unreachable, as required."
fi
```

## 11. Acceptance sign-off record

Complete this table during integration. Link only redacted evidence.

| Gate | Result | Evidence | Owner/date |
|---|---|---|---|
| Module C Terraform plan has no drift | Pass 2026-08-15 | Local plan output | Module C / 2026-08-15 |
| Dashboard public route and health | Pass 2026-08-15 | `200` checks in section 2 | Module C / 2026-08-15 |
| A/B-absent fail-closed behavior | Pass 2026-08-15 | ready/run `503`, runs `[]` | Module C / 2026-08-15 |
| Alarm destination confirmed and tested | Pending |  |  |
| A/B DNS/health and SG handoff | Pending |  |  |
| Signer isolation C10 | Pending |  |  |
| Module B signature verification | Pass locally 2026-08-16 | Dashboard canonical-message test plus policy owner/request/mandate/decision verification tests | A/B + C / 2026-08-16 |
| Module B `rawToolResultHash` receipt | Pending |  |  |
| Four fixture runs | Pending |  |  |
| Settlement mismatch fail-closed tests | Pending |  |  |
| Fuji live settlement/card issuance | Pending |  |  |
| Merchant checkout/redaction review | Pending |  |  |
| Production clearance and run | Pending |  |  |
