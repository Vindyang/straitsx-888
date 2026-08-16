# Account 808 Unified Demo Deployment Implementation Plan

**Date:** 2026-08-16  
**Source design:** `docs/superpowers/specs/2026-08-16-account-808-unified-demo-deployment-design.md`  
**Target:** AWS account `808198486011`, `ap-southeast-1`  
**Status:** Ready for review; no implementation started  

## Operating rules

- Never use root for routine work.
- Never read, print, copy, or commit `.env`, keystore contents, access keys,
  passwords, secret values, full KMS identifiers, or operator email addresses.
- Never create, import, update, or destroy resources in account `732031180826`.
- Every AWS-facing script and Terraform provider must reject any account other
  than `808198486011` and any Region other than `ap-southeast-1`.
- Plan is the default. Apply requires an explicit flag and a reviewed saved plan.
- Do not run destructive teardown as validation.
- Do not run `git commit`; provide a suggested commit message after each logical
  implementation group.
- Treat Terraform validation as static evidence only. IAM, KMS, networking,
  alarms, runtime health, and rollback require deployed verification.

## User-controlled gates

Implementation pauses at each gate:

1. The user enables MFA for `Straitsx` interactively.
2. The user approves installation of Terraform on the workstation.
3. The user supplies the operator email privately in a mode-`0600` variable file
   outside the repository and confirms the SNS email subscription.
4. After the deployment role is tested, the user separately approves removal of
   standing `AdministratorAccess` from `Straitsx`.
5. The user reviews every Terraform saved plan before apply.
6. The user approves enabling any external transaction path. The initial
   deployment remains fixture/Fuji-oriented and fail-closed.

## Phase 1 — Local toolchain and deployment guardrails

### Task 1. Pin and validate Terraform

**Files**

- Create `.terraform-version`.
- Modify `infra/module-c/versions.tf`.
- Modify `infra/module-c-integration/versions.tf`.
- Create matching `versions.tf` files for new stacks.

**Steps**

1. After approval, install an official-checksum-verified Terraform patch release
   satisfying `>= 1.10, < 2.0`.
2. Record the exact patch in `.terraform-version`.
3. Set every stack's `required_version` to `>= 1.10, < 2.0` and keep provider
   versions bounded.
4. Regenerate and review provider lock files for the workstation platform.

**Verification**

```bash
terraform version
find infra -name '*.tf' -print0 | xargs -0 dirname | sort -u
terraform -chdir=infra/module-c fmt -check
terraform -chdir=infra/module-c-integration fmt -check
```

Expected: the installed patch matches `.terraform-version`; formatting passes.

### Task 2. Add reusable account, role, and plan guards

**Files**

- Create `scripts/aws-account-guard.sh`.
- Create `scripts/terraform-stack.sh`.
- Modify `scripts/deploy-module-c.sh` into a compatibility wrapper.
- Add shell guard tests under `scripts/test/aws-deployment-guards.sh`.

**Steps**

1. Require `EXPECTED_AWS_ACCOUNT_ID=808198486011` and
   `AWS_REGION=ap-southeast-1`.
2. Query STS and reject root, the wrong account, the wrong Region, or a session
   that is not the approved deployment-role ARN once bootstrap is complete.
3. Support `bootstrap`, `foundation`, `module-c`, `module-ab`, and `integration`
   stages.
4. Keep plan-only as the default. Require a command such as
   `--apply /tmp/foundation-reviewed.tfplan` to apply exactly the reviewed plan;
   never generate a new plan inside apply mode.
5. Reject variable files with permissions broader than `0600` and reject known
   example placeholders.
6. Store plan files in `/tmp`, never in the repository.

**Verification**

```bash
bash -n scripts/aws-account-guard.sh scripts/terraform-stack.sh scripts/deploy-module-c.sh
bash scripts/test/aws-deployment-guards.sh
```

Expected: wrong-account, root, unapproved-role, placeholder, unsafe-permission,
and apply-without-saved-plan cases fail before Terraform runs.

**Suggested commit message:**
`build(aws): add Terraform pin and deployment safety guards`

## Phase 2 — Bootstrap state, audit, identity, alerts, and budget

### Task 3. Create the bootstrap stack

**Files**

- Create `infra/bootstrap/versions.tf`.
- Create `infra/bootstrap/variables.tf`.
- Create `infra/bootstrap/main.tf`.
- Create `infra/bootstrap/outputs.tf`.
- Create `infra/bootstrap/backend.tf` with a partial S3 backend and native
  lockfile support.
- Create `infra/bootstrap/terraform.tfvars.example`.
- Create `infra/bootstrap/tests/bootstrap.tftest.hcl`.

**Resources and controls**

1. Provider `allowed_account_ids = ["808198486011"]` and Region validation.
2. Dedicated S3 state bucket with public access blocked, versioning, SSE-KMS,
   TLS-only bucket policy, and deletion protection.
3. One-time local bootstrap followed by `terraform init -migrate-state` into S3
   with `use_lockfile = true`.
4. Separate encrypted/versioned CloudTrail bucket with public access blocked,
   lifecycle retention, TLS-only policy, and CloudTrail delivery policy.
5. Multi-Region CloudTrail trail with log-file validation.
6. Encrypted SNS operations topic and optional email subscription.
7. USD 25 monthly budget with 80-percent actual and 100-percent forecast
   notifications.
8. MFA-protected deployment role trusted only by `Straitsx` in account 808.
9. A customer-managed deployment policy listing only services and project
   actions required by these stacks. Restrict `iam:PassRole` to project ECS roles
   passed to `ecs-tasks.amazonaws.com`.
10. Outputs for state bucket, backend keys, audit trail, alarm topic, deployment
    role, and account/Region identity.

The operator email is passed with:

```bash
install -m 600 /dev/null /tmp/straitsx-888-bootstrap.tfvars
terraform -chdir=infra/bootstrap plan \
  -var-file=/tmp/straitsx-888-bootstrap.tfvars
```

No email value appears in examples, command output, or committed evidence.

**Static verification**

```bash
terraform -chdir=infra/bootstrap fmt -check
terraform -chdir=infra/bootstrap init -backend=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test
```

Tests assert account/Region checks, public-access blocks, bucket versioning,
encryption, CloudTrail validation, budget thresholds, MFA trust, and restricted
PassRole conditions.

### Task 4. Apply bootstrap and harden human access

**AWS-changing; gated and sequential**

1. Confirm MFA is enabled for `Straitsx`.
2. Apply bootstrap from a reviewed saved plan using the current administrator
   access only for this bootstrap step.
3. Migrate bootstrap state to its new backend and verify encryption, versioning,
   and locking with a controlled concurrent-lock attempt.
4. Assume the deployment role using MFA and verify STS identity.
5. Test allowed read/plan actions and denied unrelated actions.
6. Pause for explicit approval.
7. Remove `AdministratorAccess` from `Straitsx` and replace it with only the
   MFA-conditioned deployment-role assumption policy.
8. Verify that direct long-lived-key administrative API calls fail while an
   MFA-authenticated role session succeeds.
9. Confirm the SNS subscription privately and verify the budget exists.
10. Confirm CloudTrail records a known read action.

**Rollback and lockout prevention**

- Do not remove standing admin access until the role session is open and its
  policy tests pass.
- Keep that tested role session open while changing the user policy.
- If the user-policy test fails, restore the prior attachment from the open role
  session before it expires.
- Root remains emergency-only and is not used unless both tested paths fail.

**Evidence**

- Redacted STS role identity.
- State-bucket encryption/versioning/lock results.
- CloudTrail event lookup.
- IAM policy simulation allow/deny results.
- Budget metadata and confirmed SNS subscription without the email value.

**Suggested commit message:**
`feat(aws): add secure bootstrap state identity and audit controls`

## Phase 3 — Extract the shared foundation

### Task 5. Move shared resources out of Module C

**Files**

- Create `infra/foundation/versions.tf`.
- Create `infra/foundation/variables.tf`.
- Create `infra/foundation/main.tf`.
- Create `infra/foundation/outputs.tf`.
- Create `infra/foundation/backend.tf`.
- Create `infra/foundation/terraform.tfvars.example`.
- Create `infra/foundation/tests/foundation.tftest.hcl`.
- Remove `infra/module-c/foundation.tf` after consumers are updated.

**Foundation ownership**

- Remote-state consumption of bootstrap outputs for the operations topic and
  backend configuration.
- VPC `10.20.0.0/16`, internet gateway, two public subnets, and two private
  subnets across distinct AZs.
- One NAT gateway, explicitly documented as the demo availability/cost tradeoff.
- ECR API/DKR, Logs, Secrets Manager, SSM, and KMS interface endpoints plus the
  S3 gateway endpoint.
- Endpoint security group and exact HTTPS ingress.
- ECS cluster with Container Insights and Fargate capacity provider.
- Private Cloud Map namespace `internal`.
- KMS key/alias for CloudWatch logs.
- Shared internal-token secret generated by Terraform.
- Paying-wallet address in SSM, supplied privately and validated as a 20-byte
  EVM address.
- ALB access-log bucket with delivery policy, encryption, public block, and
  90-day lifecycle.
- Six immutable, scan-on-push ECR repositories: dashboard, orchestrator, ledger,
  policy, signer, and chain gateway. Repositories use lifecycle rules and are not
  force-deleted.

**Outputs**

Expose only VPC ID/CIDR, ordered subnet IDs, ECS cluster ARN/name, Cloud Map
namespace ID/name, endpoint SG, log-key ARN, shared secret ARN, wallet parameter
ARN, ALB log bucket, alarm topic ARN, and ECR repository URLs.

**Verification**

```bash
terraform -chdir=infra/foundation fmt -check
terraform -chdir=infra/foundation init -backend=false
terraform -chdir=infra/foundation validate
terraform -chdir=infra/foundation test
```

Tests assert two AZs, no public IP mapping, one documented NAT, required
endpoints, private DNS, immutable ECR, bounded retention, encryption, and no
workload ECS services.

### Task 6. Convert Module C into a foundation consumer

**Files**

- Modify `infra/module-c/main.tf`.
- Modify `infra/module-c/variables.tf`.
- Modify `infra/module-c/outputs.tf`.
- Modify `infra/module-c/versions.tf`.
- Modify `infra/module-c/terraform.tfvars.example`.
- Remove obsolete `infra/module-c/terraform.standalone.tfvars.example`.
- Add `infra/module-c/backend.tf`.
- Add `infra/module-c/tests/module-c.tftest.hcl`.

**Steps**

1. Remove `create_foundation` and all conditional effective-resource locals.
2. Read only documented foundation outputs from remote state.
3. Keep the public ALB/CloudFront, dashboard, orchestrator, and fixture in Module
   C state.
4. Replace the shared task/execution role with least-privilege per-service roles.
5. Add explicit KMS sign/decrypt/data-key denies to all Module C task roles.
6. Retain private tasks, no public IP, read-only root filesystem, non-root UID,
   health checks, Cloud Map, encrypted logs, and deployment circuit breakers.
7. Set orchestrator and fixture to desired count one with minimum healthy `0`
   and maximum `100`; keep dashboard at two with safe rolling replacement.
8. Keep exact SG ingress. At the cross-state A/B boundary, permit egress only to
   the VPC CIDR on ports `4001`, `4002`, and `4004`; A/B ingress remains limited
   to the exact orchestrator/dashboard SGs.
9. Remove any Terraform dependency on resources that Module C no longer owns.

**Verification**

```bash
terraform -chdir=infra/module-c fmt -check
terraform -chdir=infra/module-c init -backend=false
terraform -chdir=infra/module-c validate
terraform -chdir=infra/module-c test
```

Tests assert no VPC/cluster/namespace creation, no signer endpoint or port 4003
rule, explicit KMS deny, singleton deployment policy, and digest-pinned images.

**Suggested commit message:**
`refactor(aws): extract shared foundation from Module C`

## Phase 4 — Build the A/B Fargate workload stack

### Task 7. Create Module A/B Terraform

**Files**

- Create `infra/module-ab/versions.tf`.
- Create `infra/module-ab/variables.tf`.
- Create `infra/module-ab/main.tf`.
- Create `infra/module-ab/outputs.tf`.
- Create `infra/module-ab/backend.tf`.
- Create `infra/module-ab/terraform.tfvars.example`.
- Create `infra/module-ab/tests/module-ab.tftest.hcl`.

**Resources**

1. Remote-state consumption of the shared foundation and Module C SG outputs.
2. Separate ledger, policy, signer, and chain-gateway security groups.
3. Cloud Map services named `ledger`, `policy`, `signer`, and `chain-gateway` in
   the shared `internal` namespace.
4. Separate encrypted log groups with 30-day retention.
5. Per-service execution and task roles.
6. Digest-pinned Fargate task definitions and one ECS service per component.
7. EventBridge rules for unexpected task stops and CloudWatch alarms for
   unhealthy or missing singleton services.

**Security-group contract**

- Ledger `4001`: ingress from policy, Module C orchestrator, and dashboard only.
- Policy `4002`: ingress from Module C orchestrator and dashboard only.
- Signer `4003`: ingress from policy only.
- Chain gateway `4004`: ingress from policy, Module C orchestrator, and dashboard
  only.
- Policy egress: ledger `4001`, signer `4003`, and gateway `4004` only, plus
  required AWS startup endpoints and DNS.
- Signer egress: KMS endpoint `443`, required AWS startup endpoints, and DNS.
- Ledger egress: required AWS startup endpoints and DNS only.
- Gateway egress: required AWS endpoints/DNS plus outbound HTTPS through NAT for
  Avalanche RPC. This is explicitly TCP `443` to `0.0.0.0/0` for the demo and is
  recorded as a production residual risk.
- No A/B ingress rule uses a CIDR source.

**IAM contract**

- Signer task role: `kms:GetPublicKey` and `kms:Sign` on the supplied existing
  signing key only.
- Signer receives no decrypt or data-key action.
- Ledger, policy, gateway, orchestrator, dashboard, and fixture task roles carry
  explicit denies for KMS signing; policy also denies decrypt and data-key APIs.
- Execution roles read only the shared internal-token secret and the specific
  parameters needed by that service.
- The existing EC2-trusted roles are neither imported nor attached.

**Runtime configuration**

- Ledger: `PORT=4001`, internal token.
- Policy: `PORT=4002`, ledger/gateway/signer URLs, dashboard URL, paying-wallet
  address, bounded validity/escalation settings, internal token.
- Signer: `PORT=4003`, `SIGNER_KEY_SOURCE=kms`, private KMS identifier input,
  expected signer address, initial demo chain `43113`, pinned mandates, internal
  token, and Region. Local-key configuration is absent.
- Gateway: `PORT=4004`, configured chain IDs/RPC timeouts, internal token. The
  initial deployment permits Fuji validation and mainnet registry reads but no
  production merchant payment path.

All four services use desired count one, minimum healthy `0`, maximum `100`,
deployment circuit breakers, read-only roots, non-root UID, ephemeral `/tmp`, and
container health checks.

**Verification**

```bash
terraform -chdir=infra/module-ab fmt -check
terraform -chdir=infra/module-ab init -backend=false
terraform -chdir=infra/module-ab validate
terraform -chdir=infra/module-ab test
```

Tests inspect the plan for exact ingress sources, absence of orchestrator-to-
signer rules, exact KMS allow/deny actions, Fargate trust, singleton deployment
settings, no public IP, read-only containers, and digest validation.

**Suggested commit message:**
`feat(aws): define isolated A/B Fargate services`

## Phase 5 — Immutable image publication

### Task 8. Publish all workload images through one guarded script

**Files**

- Create `scripts/publish-aws-images.sh`.
- Modify `scripts/publish-module-c-images.sh` into a compatibility wrapper.
- Add `scripts/test/publish-aws-images.test.sh`.
- Update `.gitignore` only if a new local digest-output filename needs coverage.

**Steps**

1. Run the AWS identity guard before ECR login.
2. Require the six Terraform-owned repositories to exist; never create them
   imperatively.
3. Use one immutable release tag derived from Git SHA and UTC timestamp.
4. Build Linux AMD64 images:
   - dashboard from `services/dashboard/Dockerfile`;
   - orchestrator/fixture from `services/agent-orchestrator/Dockerfile`;
   - ledger from root `Dockerfile`, entry `services/ledger-service/src/index.ts`,
     port `4001`;
   - policy from root `Dockerfile`, entry `services/policy-service/src/index.ts`,
     port `4002`;
   - signer from root `Dockerfile`, entry `services/signer-service/src/main.ts`,
     port `4003`;
   - gateway from root `Dockerfile`, entry
     `services/chain-gateway/src/main.ts`, port `4004`.
5. Push without mutable tag reuse, wait for scans, and fail on any critical/high
   finding under the established gate.
6. Resolve ECR digests and write only non-secret image references to a mode-0600
   file in `/tmp` for workload plans.

**Verification**

```bash
bash -n scripts/publish-aws-images.sh
bash scripts/test/publish-aws-images.test.sh
```

Before push, repeat the existing local smoke test for all images with non-root,
read-only root filesystem, writable `/tmp`, successful health endpoints, and
`docker inspect` evidence for the configured user and health check.

**Suggested commit message:**
`build(aws): publish scanned digest-pinned workload images`

## Phase 6 — Integration, observability, and evidence automation

### Task 9. Update the deployed isolation probe

**Files**

- Modify `infra/module-c-integration/main.tf`.
- Modify `infra/module-c-integration/variables.tf`.
- Modify `infra/module-c-integration/outputs.tf`.
- Modify `infra/module-c-integration/versions.tf`.
- Add `infra/module-c-integration/backend.tf`.
- Add `infra/module-c-integration/tests/integration.tftest.hcl`.
- Create `scripts/isolation-probe.test.ts`.
- Keep `scripts/isolation-probe.ts` as the probe implementation unless a test
  exposes a correctness issue.

**Steps**

1. Consume the shared foundation and Module C outputs from remote state.
2. Run the task with the exact orchestrator security group and task role.
3. Supply `SIGNER_HOST=signer.internal` and signer port `4003` explicitly.
4. Retain all positive controls: ledger, policy, and gateway health must succeed.
5. Require signer DNS resolution before testing TCP failure.
6. Write to a dedicated encrypted probe log group.
7. Output the task-definition ARN and a ready-to-run network configuration, not
   secrets.

**Verification**

```bash
pnpm vitest run scripts/isolation-probe.test.ts
terraform -chdir=infra/module-c-integration fmt -check
terraform -chdir=infra/module-c-integration init -backend=false
terraform -chdir=infra/module-c-integration validate
terraform -chdir=infra/module-c-integration test
```

If no unit test exists for `scripts/isolation-probe.ts`, create one that covers
DNS failure as inconclusive, positive dependency failure, signer reachability as
failure, timeout/refusal as success, and exit status.

### Task 10. Add operational verification scripts and runbook

**Files**

- Create `scripts/verify-aws-demo.sh`.
- Create `scripts/verify-iam-kms.sh`.
- Create `scripts/rehearse-ecs-rollback.sh`.
- Create `docs/account-808-deployment-runbook.md`.
- Create `docs/evidence/account-808/README.md`.

**Steps**

1. Guard account, Region, and assumed role before every check.
2. Verify ECS desired/running counts, deployments, task-definition digests,
   Cloud Map instances, ALB targets, and public health/readiness.
3. Use IAM policy simulation for signer KMS allows and all non-signer denies.
4. Exercise a controlled signer request and independently verify the signature
   without logging the signature or full key identifier.
5. Run the isolation probe task, wait for completion, and record task ARN, exit
   code zero, DNS-positive result, dependency-positive results, and signer TCP
   negative result.
6. Emit a temporary custom metric to a dedicated test alarm and confirm the SNS
   path; return the alarm to normal state.
7. Verify a known CloudTrail event.
8. Rehearse rollback on the non-transactional fixture or a disposable canary
   service, capture circuit-breaker behavior, then reconcile Terraform.
9. Write only redacted evidence metadata and commands to `docs/evidence/account-808`.

**Verification**

```bash
bash -n scripts/verify-aws-demo.sh scripts/verify-iam-kms.sh scripts/rehearse-ecs-rollback.sh
rg -n 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|BEGIN .*PRIVATE KEY|arn:aws:kms:[^ ]*:key/[0-9a-f-]{36}|[[:alnum:]._%+-]+@[[:alnum:].-]+\.[A-Za-z]{2,}' docs/evidence/account-808
```

The secret scan must return no sensitive values. A full KMS key ARN is excluded
from committed evidence even though an ARN is not key material.

**Suggested commit message:**
`test(aws): automate runtime isolation and rollback evidence`

## Phase 7 — Static validation before AWS workload apply

### Task 11. Run repository and Terraform validation

**Commands**

```bash
pnpm typecheck
pnpm test
pnpm sol:test
terraform fmt -check -recursive infra
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/foundation validate
terraform -chdir=infra/module-c validate
terraform -chdir=infra/module-ab validate
terraform -chdir=infra/module-c-integration validate
terraform -chdir=infra/bootstrap test
terraform -chdir=infra/foundation test
terraform -chdir=infra/module-c test
terraform -chdir=infra/module-ab test
terraform -chdir=infra/module-c-integration test
git diff --check
```

Also run policy/static checks that assert:

- every provider restricts account 808;
- no Terraform or script contains account 732 as a target;
- no Fargate role trusts EC2;
- no image variable accepts a tag without `@sha256:`;
- no A/B service receives a public IP;
- only policy ingress reaches signer `4003`;
- only signer can call KMS signing actions; and
- no local tfvars, state, plan, secret, or evidence credential is tracked.

Stop on any failure. Static success does not authorize apply.

## Phase 8 — Controlled deployment to account 808

### Task 12. Apply foundation and publish images

1. Assume the verified MFA deployment role.
2. Plan the foundation with a private mode-0600 variable file.
3. Confirm the saved plan creates only account-808 shared resources and contains
   no unexpected deletion or replacement.
4. After user approval, apply that saved plan.
5. Verify VPC/AZ layout, endpoints, cluster, namespace, logging key, secrets
   metadata, ECR settings, and alarm-topic output.
6. Publish all six images and record digests/scan results.

**Rollback**

- A failed first foundation apply is corrected and rolled forward from Terraform.
- Do not destroy the foundation automatically.
- Preserve remote state and CloudTrail evidence.

### Task 13. Apply Module C

1. Plan using foundation outputs and digest-pinned dashboard/orchestrator images.
2. Confirm the plan contains no VPC, subnet, cluster, namespace, A/B, or signer
   resources.
3. Apply the reviewed saved plan.
4. Wait for dashboard, orchestrator, and fixture stability.
5. Verify CloudFront/ALB health, dashboard health, and expected pre-A/B readiness
   failure.

**Rollback**

Restore the previous digest-pinned task definitions through Module C Terraform.
The foundation remains unchanged.

### Task 14. Apply Module A/B

1. Plan with digest-pinned A/B images, foundation outputs, Module C SG outputs,
   the private KMS identifier, expected signer address, and Fuji demo settings.
2. Confirm the plan does not create or replace the existing signing key.
3. Confirm exact SG and IAM plan assertions manually.
4. Apply the reviewed saved plan.
5. Wait for all four singleton services to stabilize.
6. Verify signer boot derives the expected address through redacted health output.
7. Verify Module C readiness becomes healthy.

**Rollback**

Restore the last known A/B digest variables and apply only the Module A/B state.
Do not change Module C or foundation state. State lost during task replacement is
accepted for the demo and recorded.

### Task 15. Apply and run integration evidence

1. Apply the ephemeral integration task definition.
2. Run the isolation probe in the orchestrator network configuration.
3. Run IAM/KMS simulations and a controlled positive signature flow.
4. Run public and private health checks.
5. Exercise alarm delivery and CloudTrail lookup.
6. Rehearse rollback on the selected non-transactional target.
7. Capture redacted evidence and verify no secrets appear.

The deployment is not accepted if signer DNS fails, if any positive dependency
check fails, or if orchestrator TCP reaches signer `4003`.

## Phase 9 — Documentation and handover

### Task 16. Replace stale deployment guidance with verified facts

**Files**

- Update `module-ab-handover.md`.
- Update `module-c-aws-integration-handover.md`.
- Update `docs/deployment.md`.
- Update `docs/module-c-deployment.md`.
- Update `docs/execution_plan.md`.
- Update `docs/owner-a-tasks.md`, `docs/owner-b-tasks.md`, and
  `docs/owner-c-tasks.md` where deployment status changes.
- Update `README.md` if its signer status or deployment instructions remain
  stale.

**Rules**

1. Do not rewrite the old account's historical evidence as though it occurred in
   account 808.
2. Clearly label old account `732031180826` as untouched and outside current
   authority.
3. Record only deployed resource identifiers and test outcomes independently
   verified in account 808.
4. Keep full KMS identifiers, email, credentials, and secret values out of the
   documents.
5. Mark the environment demo-grade and list in-memory state loss, single NAT,
   internal HTTP, outbound RPC HTTPS, and absent RPO/RTO as residual risks.
6. Include exact plan, apply, rollback, evidence, and teardown ordering.

**Final verification**

```bash
pnpm typecheck
pnpm test
pnpm sol:test
terraform fmt -check -recursive infra
git diff --check
git status --short
```

Compare the deployed evidence against every success criterion in the source
design. Report any unmet item as blocked or residual; do not silently mark it
complete.

**Suggested commit message:**
`docs(aws): hand over unified account 808 demo deployment`

## Completion definition

Implementation is complete only when:

- bootstrap, foundation, Module C, Module A/B, and integration states are remote,
  encrypted, locked, and drift-free;
- all new resources exist only in account `808198486011`;
- the operator uses an MFA-protected temporary deployment role without standing
  administrator access;
- all six images pass the scan gate and ECS uses immutable digests;
- all private services are healthy and the intended public route is healthy;
- IAM/KMS positive and negative tests pass;
- the exact-orchestrator-SG network probe passes all positive controls and blocks
  signer `4003`;
- alarm delivery, CloudTrail visibility, and rollback are exercised;
- evidence is redacted and documentation reflects verified current state; and
- the old account remains unchanged.

The environment remains demo-grade after completion. Production hardening is a
separate design and implementation cycle.
