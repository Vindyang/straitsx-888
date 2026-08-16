# Account 808 Unified Demo Deployment Design

**Date:** 2026-08-16  
**Status:** Approved design; awaiting written-spec review  
**Target account:** `808198486011`  
**Region:** `ap-southeast-1`  
**Environment:** Demo-grade  

## 1. Objective

Deploy Modules A, B, and C into AWS account `808198486011` on one shared AWS
foundation. Keep the A/B payment rail and Module C as separate workload stacks so
each can be deployed and rolled back without changing the shared network, cluster,
or the other workload.

The deployment must demonstrate:

- non-root, MFA-protected administration with temporary credentials;
- private ECS Fargate services with least-privilege IAM and security groups;
- KMS signer isolation from the orchestrator and other workloads;
- immutable, scanned, digest-pinned container images;
- observable deployment and runtime health;
- a repeatable rollback path; and
- evidence captured from the deployed environment rather than inferred from
  Terraform configuration alone.

This design does not authorize any change to account `732031180826`. Resources in
that account remain untouched, even if they continue to incur charges.

## 2. Scope and assumptions

### 2.1 In scope

- Bootstrap controls for Terraform state, deployment identity, audit logging,
  alert routing, and budget notifications.
- A shared VPC, subnets, NAT gateway, VPC endpoints, ECS cluster, Cloud Map
  namespace, logging, and shared encryption controls.
- Module C workloads and public edge.
- Module A/B ledger, policy, signer, chain-gateway, and orchestrator workloads.
- ECR repositories and immutable image publication.
- Deployed health, IAM, KMS, and network-isolation verification.
- Runbooks for deployment, rollback, evidence capture, and teardown.
- Documentation updates that replace obsolete references to account
  `732031180826` only after equivalent resources are deployed and verified in
  account `808198486011`.

### 2.2 Out of scope

- Destroying or migrating resources in account `732031180826`.
- Production availability or disaster-recovery guarantees.
- Durable application state, multi-replica stateful services, or backup/restore.
- Service-to-service TLS inside the private VPC.
- Inspected or destination-allowlisted Avalanche RPC egress.
- Organization-wide identity or multi-account governance.
- Reducing the current `Straitsx` administrator policy before the replacement
  deployment role is verified. Removing standing administrator access after
  verification requires an explicit implementation-time approval and is a
  workload-deployment gate.

### 2.3 Known facts

- Account `808198486011` is a standalone AWS account.
- Root MFA is enabled and root has no access keys.
- IAM user `Straitsx` has one active access key, no MFA device, and
  `AdministratorAccess`.
- No ECS cluster, ECR repository, Cloud Map namespace, CloudTrail trail,
  CloudWatch alarm, SNS topic, or AWS Budget currently exists in the target
  account.
- A signing-only, `ECC_SECG_P256K1` KMS key exists in `ap-southeast-1`.
- Existing A/B IAM roles trust EC2 and are not valid Fargate task roles.
- Current application state is process-local, including ledger and orchestration
  state and signer replay protection.
- Terraform is not installed on the deployment workstation.

### 2.4 Unknowns and explicit limits

- Compliance obligations and formal data-classification policy are unknown.
- Expected transaction volume and performance targets are unknown.
- Production availability target, RPO, and RTO are undefined.
- One designated operator owns demo alarms and deployment decisions; the exact
  email address is supplied privately during implementation.
- Until a formal classification policy exists, credentials, signing material,
  tokens, and transaction payloads are treated as confidential and redacted from
  committed evidence.
- The monthly demo budget threshold is USD 25. A budget is an alerting control,
  not a hard spending limit.

## 3. Chosen architecture

### 3.1 Terraform state boundaries

The deployment uses four bounded Terraform states:

1. **Bootstrap (`infra/bootstrap`):** remote state storage and locking, the
   MFA-protected deployment role, CloudTrail, SNS alarm routing, AWS Budget, and
   common resource tags.
2. **Foundation (`infra/foundation`):** VPC, two-AZ public and private subnets,
   one NAT gateway, VPC endpoints, ECS cluster, Cloud Map namespace, ECR
   repositories, shared logging, and shared encryption resources. These
   resources are derived from the foundation currently embedded in
   `infra/module-c` and become independently owned.
3. **Module C (`infra/module-c`):** dashboard, orchestrator-facing Module C
   components, public edge, service roles, secrets references, and Module C
   security groups. It consumes foundation outputs through explicit remote-state
   outputs.
4. **Module A/B (`infra/module-ab`):** ledger, policy, signer, chain gateway,
   orchestrator integration, service roles, secrets references, and A/B security
   groups. It consumes the same foundation outputs.

The existing `infra/module-c-integration` probe remains an ephemeral task
definition or a small separate verification state. It must not own durable
platform resources.

Bootstrap begins with a one-time local state because its S3 backend does not yet
exist. It creates a dedicated S3 state bucket with public access blocked,
versioning, encryption, and S3 native lockfiles. Bootstrap state is then migrated
into that backend before any other stack is applied. Terraform must satisfy
`>= 1.10, < 2.0`, and the exact patch release and official checksum are recorded
in the repository's version pin during implementation.

State consumers receive only documented outputs, such as VPC ID, private subnet
IDs, cluster ARN, namespace ID, endpoint security-group ID, and log-key ARN. A
workload state must not discover or modify another workload's resources by tag or
name.

### 3.2 Why A/B and C remain separate

A/B form one tightly coupled private payment rail. Version skew between ledger,
policy, signer, and gateway can violate payment and authorization assumptions, so
they deploy as one workload release.

Module C owns a different public-edge and orchestration lifecycle. Keeping it in a
separate state allows it to roll forward or back without replacing payment-rail
tasks. The split is a lifecycle and blast-radius boundary, not duplicated
infrastructure.

### 3.3 Runtime topology

- All containers run on ECS Fargate in private subnets with no public IP.
- Cloud Map provides internal service discovery.
- Only the intended Module C dashboard/API entry point is public, through
  CloudFront and an Application Load Balancer.
- Ledger, policy, signer, gateway, and orchestrator use one task each because
  their current state or coordination assumptions are not safe for horizontal
  scaling.
- The dashboard may use two tasks because it does not own transactional state.
- The chain gateway also remains at one task for the demo, although it can become
  horizontally scalable after its statelessness is verified.

## 4. Data flow and trust boundaries

### 4.1 Intended flows

1. A user reaches CloudFront and the ALB.
2. The dashboard or orchestrator calls the private ledger, policy, and gateway
   services on their documented ports.
3. Policy evaluates the request and is the only application service permitted to
   reach signer TCP port `4003`.
4. Signer requests a signature from the designated KMS signing key.
5. The chain gateway sends HTTPS JSON-RPC traffic through the NAT gateway to the
   configured Avalanche RPC endpoint.
6. Services emit redacted application logs to CloudWatch Logs.

### 4.2 Explicitly forbidden flows

- Internet-to-private-service ingress.
- Orchestrator-to-signer TCP access.
- Dashboard-to-signer TCP access.
- Module C task-role KMS signing access.
- Policy access to KMS signing, decrypt, or data-key APIs.
- Signer access to unrelated KMS keys or non-signing cryptographic APIs.
- CIDR-wide ingress to A/B service ports.
- Secrets in images, task-definition plaintext environment values, Terraform
  source, committed variable files, logs, or evidence artifacts.

## 5. Identity and security controls

### 5.1 Human access

- Root is not used for deployment or routine operation.
- Enabling MFA on `Straitsx` is a prerequisite.
- Bootstrap creates an MFA-enforced deployment role.
- Deployment and verification use temporary STS credentials from that role.
- No new long-lived access key is created.
- MFA enrollment alone does not protect direct API calls made with the existing
  access key. After the deployment role and emergency-access path are verified,
  implementation pauses for explicit approval to remove the user's standing
  `AdministratorAccess` and replace it with permission to assume the deployment
  role only when MFA is present. Workload apply does not proceed until this
  control is verified.

The operator email is never entered in chat or committed to the repository. It is
provided through a local Terraform variable file outside the repository with mode
`0600`.

### 5.2 ECS roles

Each service has a Fargate task role that trusts `ecs-tasks.amazonaws.com` and a
separate execution role.

- Execution roles may pull their image, create/write their log stream, and read
  only the secrets needed during task startup.
- The signer task role receives only the exact KMS signing actions on the exact
  signing key.
- Policy receives an explicit deny for KMS sign, decrypt, and data-key actions.
- Orchestrator and Module C task roles receive explicit KMS signing denies.
- Existing EC2-trusted roles and instance profiles are not reused. They are
  decommissioned only after replacement roles are verified and with explicit
  approval where deletion is required.

The existing signing key is a pre-existing dependency identified through a
private Terraform input. It is not recreated, imported, scheduled for deletion,
or otherwise lifecycle-owned by these stacks. The deployment manages task-role
permissions and verifies that the key policy permits only the intended IAM path.

### 5.3 Network controls

- Ingress rules reference the exact source security groups; no A/B service port
  accepts VPC-wide or internet CIDRs.
- Same-state egress rules reference destination security groups. At the Module C
  to A/B state boundary, egress is restricted to the VPC CIDR and exact service
  port to avoid a circular Terraform-state dependency; the destination's exact
  source-SG ingress remains authoritative.
- Dashboard/orchestrator may reach ledger, policy, and gateway on the documented
  application ports.
- Policy alone may reach signer port `4003`.
- Signer uses the KMS VPC endpoint.
- Gateway uses outbound HTTPS through the NAT gateway for Avalanche RPC.
- Internal HTTP is accepted for the demo because tasks are private, authenticated
  at the application layer, and constrained by security groups.

Private service-to-service TLS and inspected, destination-restricted gateway
egress are production hardening requirements.

### 5.4 Images, secrets, and audit

- ECR repositories use immutable tags and scan on push.
- Deployment blocks images with critical or high findings under the existing
  publication policy.
- ECS task definitions use resolved SHA-256 image digests.
- Secrets live in Secrets Manager or SSM Parameter Store and are referenced by
  ARN. Local `.env` contents are never uploaded wholesale.
- A multi-Region CloudTrail trail with log-file validation records account
  control-plane activity to a dedicated encrypted, versioned S3 bucket with
  public access blocked and bounded retention.
- CloudWatch log groups use encryption and bounded retention appropriate for a
  demo environment.
- Application and verification logs redact credentials, tokens, raw secrets, and
  sensitive transaction payloads at the source.

## 6. Runtime behavior and failure handling

### 6.1 Stateful singleton deployment

Ledger, policy, signer, gateway, and orchestrator deploy with desired count one.
For services with process-local state, deployment configuration prevents old and
new tasks from serving simultaneously. A stop-then-start replacement accepts
brief downtime to avoid split in-memory state by using minimum healthy percent
`0` and maximum percent `100`.

ECS deployment circuit breakers and rollback are enabled. A replacement that
does not become healthy returns to the last known task definition where ECS can
do so safely. Operators must understand that rolling back compute does not
restore lost in-memory state.

### 6.2 Health and dependency behavior

- Each service exposes a lightweight health endpoint.
- Container health checks and service registration reflect actual readiness.
- Clients use explicit timeouts and bounded retries.
- Signing and payment mutations must be idempotent or fail closed; retries must
  not create duplicate transfers or signatures.
- Dependency failure produces a controlled error and an actionable log rather
  than an unbounded retry loop.
- Real external payment execution starts disabled and is enabled only after
  health, IAM, KMS, and isolation gates pass.

### 6.3 Accepted failure modes

- A task restart loses ledger balances, orchestration runs, and replay state.
- A singleton deployment or failure causes temporary unavailability.
- The single NAT gateway is an egress dependency across both private subnets.
- No backup, restore, failover, or autoscaling behavior is claimed.

These constraints make the environment demo-grade. Production readiness requires
durable shared storage, tested recovery, defined RPO/RTO, safe multi-replica
semantics, and multi-AZ failure evidence.

## 7. Observability and cost controls

- CloudWatch captures service logs, service running-count and ALB health/error
  metrics. EventBridge routes unexpected ECS task-stop events into the same
  operational notification path.
- Alarms publish to an SNS topic owned by the designated operator.
- Implementation includes a controlled test alarm and confirmation that the
  notification path works.
- CloudTrail is enabled before workload deployment.
- Common tags identify project, environment, module, owner, and Terraform state.
- An AWS Budget has a USD 25 monthly limit and alerts at 80 percent actual spend
  and 100 percent forecast spend.
- Teardown documentation identifies each state and the required destruction
  order. Destruction is never run automatically as part of validation.
- NAT gateway, VPC endpoint, CloudFront, ALB, Fargate, logging, and ECR costs are
  called out because the USD 25 budget may be exceeded during extended runtime.

## 8. Deployment sequence

1. Enable MFA on `Straitsx` interactively and verify it.
2. Install an official-checksum-verified Terraform release satisfying
   `>= 1.10, < 2.0` after separate approval to install the missing tool, and pin
   its exact patch version in the repository.
3. Bootstrap remote encrypted and versioned state, locking, the MFA deployment
   role, CloudTrail, SNS, alarms, budget, and common tags.
4. Assume the deployment role with MFA and verify account, role ARN, and Region.
5. Pause for explicit approval, then remove standing administrator access from
   `Straitsx`, restrict it to MFA-conditioned deployment-role assumption, and
   verify both the permitted and denied paths without locking out the operator.
6. Refactor or extract the existing Module C foundation resources into the
   dedicated foundation state without importing anything from account
   `732031180826`.
7. Format, validate, and review every Terraform plan before apply.
8. Apply the shared foundation in account `808198486011`.
9. Create ECR repositories; build Linux AMD64 images; push immutable tags; wait
   for scans; and record digest-pinned references.
10. Apply Module C and validate its public and private readiness paths.
11. Apply Module A/B with real external payment execution disabled.
12. Run application, IAM, KMS, logging, alarm-routing, and network-isolation
    verification.
13. Enable the intended demo transaction path only after all blockers pass.
14. Update handover and deployment documentation with verified account, Region,
    resource identifiers, evidence locations, residual risks, and rollback steps.

## 9. Verification and acceptance evidence

Terraform formatting and validation are necessary but are not runtime evidence.
The deployment is accepted only when the following evidence is captured without
secrets:

### 9.1 Identity and configuration

- STS caller identity shows account `808198486011` and the MFA-protected
  deployment role.
- Terraform plans are reviewed for the intended account and Region.
- Remote state is encrypted, versioned, and locked.
- No planned action addresses account `732031180826`.

### 9.2 Images and runtime

- Every deployed task definition references an ECR digest.
- Image scans complete and satisfy the configured critical/high gate.
- ECS service desired and running counts match.
- Task ARNs, task-definition revisions, and health status are recorded.
- Public Module C health and private service health tests pass.

### 9.3 IAM and KMS

- Policy simulation or controlled API tests show the signer can perform only the
  required signing operation on the designated key.
- Controlled tests show policy, orchestrator, and Module C cannot sign with that
  key.
- The KMS signature is independently verified where the application test already
  supports this behavior.

### 9.4 Network isolation

An ephemeral Fargate probe runs with the exact orchestrator security group and
records:

- signer Cloud Map DNS resolves successfully;
- ledger, policy, and gateway health calls succeed; and
- a direct TCP connection to signer port `4003` fails.

DNS failure is not accepted as isolation evidence. The task ARN, exit code zero,
and redacted CloudWatch logs are captured.

### 9.5 Observability and rollback

- CloudTrail records a known deployment API action.
- A controlled alarm reaches the confirmed SNS subscription.
- The USD 25 budget and recipient are visible without exposing the address in
  committed evidence.
- A workload is rolled forward or back to a known task-definition digest, or the
  exact rollback command is rehearsed against a safe test revision.

## 10. Rollback, rollforward, and teardown

- Module A/B and Module C roll back independently by restoring the last known
  digest-pinned task definitions through their own Terraform states.
- Failed ECS deployments use the circuit breaker to return to the prior service
  revision where possible.
- The foundation does not roll back as part of an application rollback.
- Foundation changes require a separate plan, impact review, and recovery path.
- Rollforward uses a newly scanned immutable digest; tags are never repointed.
- Teardown order is integration probes, Module A/B, Module C, foundation, then
  bootstrap resources that are safe to remove.
- Remote state, audit logs, and evidence are retained or explicitly exported
  before their stores are considered for deletion.
- No teardown command targets account `732031180826`.

## 11. Threat and failure model

| Threat or failure | Primary control | Remaining risk |
|---|---|---|
| Stolen long-lived administrator credential | Remove standing admin access; permit only MFA-conditioned role assumption | Existing key remains sensitive and should later be rotated or removed |
| Orchestrator compromise reaches signer | Security-group isolation and explicit KMS deny | Policy compromise remains able to invoke signer by design |
| Signer task abuses KMS | Exact-key, signing-only IAM permissions | Application-layer misuse must still be detected in logs and policy checks |
| Secret disclosure through deployment | Secrets Manager/SSM references and log redaction | Operator workstation remains a trust boundary |
| Vulnerable or mutable image | Scan gate, immutable tags, digest pinning | Scanner coverage and newly disclosed vulnerabilities are time-dependent |
| Bad task release | Health checks, circuit breaker, independent workload rollback | In-memory state may be lost during replacement |
| AZ or NAT failure | Two-AZ subnets | Single NAT and singleton tasks prevent an HA claim |
| Avalanche RPC failure | Timeouts, bounded retries, fail-closed execution | No alternate provider or inspected egress in demo scope |
| Accidental cross-stack deletion | Dedicated states and explicit remote outputs | Foundation remains a shared blast radius |
| Unexpected spend | USD 25 budget, tags, teardown runbook | Budgets alert but do not stop resources automatically |

## 12. AWS Well-Architected assessment

| Pillar | Status | Assessment |
|---|---|---|
| Operational excellence | Partial | IaC, remote state, alarms, runbooks, evidence, and reversible workload deployment are included. Formal incident organization remains outside demo scope. |
| Security | Partial | MFA sessions, least privilege, signer isolation, CloudTrail, immutable images, and managed secrets are included. Internal HTTP and broad RPC HTTPS egress remain accepted risks. |
| Reliability | Partial | The foundation spans two AZs, but single NAT and process-local singleton services prevent high-availability or recovery claims. |
| Performance efficiency | Partial | Fargate tasks start with explicit small sizing and metrics. Load testing, right-sizing evidence, and autoscaling are deferred. |
| Cost optimization | Partial | Shared infrastructure, tags, teardown instructions, and a USD 25 budget are included. NAT and endpoint costs require active monitoring. |
| Sustainability | Partial | Small Fargate tasks and shared resources limit idle capacity. There is no utilization baseline or automated scale-down evidence. |

### 12.1 Prioritized findings

| Severity | Best-practice IDs | Evidence | Impact | Remediation and verification |
|---|---|---|---|---|
| Critical | `SEC02-BP01/BP02`, `SEC03-BP02/BP06` | `Straitsx` has an active administrator key and no MFA device | Credential compromise grants broad account control | Enable MFA, verify the new role, obtain explicit approval to remove standing admin access, restrict the user to MFA-conditioned role assumption, and test allow/deny paths before workload apply |
| High | `SEC05-BP01/BP02` | Signer isolation is not yet deployed in account 808 | A compromised orchestrator could attempt unauthorized signing | Apply SG rules and run positive/negative probe from the exact orchestrator SG |
| High | `OPS05-BP01/BP04`, `OPS06-BP01/BP04`, `REL08-BP01/BP05` | No A/B Terraform Fargate stack or deployed rollback evidence exists | Changes are drift-prone and failed releases are harder to recover | Add versioned Terraform, digest-pinned tasks, circuit breakers, and rehearse rollback |
| High | `SEC04-BP01/BP02` | No CloudTrail trail exists in the target account | Administrative actions lack a durable workload audit trail | Create the trail in bootstrap and verify a known event |
| Medium | `REL04-BP01`, `REL05-BP06`, `REL11-BP03/BP07` | Ledger, orchestrator, and replay state are process-local | Restarts lose state and replicas can disagree | Keep demo singletons; require durable storage and recovery testing before production |
| Medium | `COST01-BP03/BP04`, `COST03-BP03`, `COST04-BP01/BP05` | No budget, cost alarm, or Terraform-owned lifecycle exists | Demo resources can create unobserved recurring spend | Add budget/SNS, tagging, state ownership, and teardown runbook; verify notification |

### 12.2 Deployment blockers

- MFA enabled and verified for `Straitsx`.
- Temporary deployment-role credentials in account `808198486011`.
- Explicitly approved and verified removal of standing `AdministratorAccess` from
  `Straitsx`, without operator lockout.
- Approved installation of a pinned Terraform version.
- Reviewed Terraform plans with no unintended account or destructive actions.
- Successful immutable image scans and digest resolution.
- Healthy deployed services and verified secret resolution.
- Controlled IAM and KMS allow/deny tests.
- Live network isolation evidence from the orchestrator security group.
- Confirmed alarm subscription and controlled alarm delivery.
- Documented, rehearsed workload rollback.

### 12.3 Post-launch improvements

- Move all mutable transaction and replay state to durable, encrypted stores.
- Define and test availability, RPO, RTO, backup, restore, and failover targets.
- Add safe multi-replica semantics, autoscaling, quota alarms, and load tests.
- Add private service TLS and authenticated workload identities.
- Restrict or inspect gateway egress and add an RPC failover strategy.
- Replace the single NAT gateway if the required availability justifies the cost.
- Rotate or remove the remaining long-lived access key after an alternate
  operator identity path is available, and continuously reduce the deployment
  role from bootstrap permissions to steady-state least privilege.
- Define compliance, data retention, incident-response, and support ownership.

## 13. Success criteria

The work is complete when:

- all newly deployed foundation and workload resources are Terraform-owned in
  account `808198486011`, with the pre-existing signing key documented as an
  external dependency;
- Modules A, B, and C use one shared foundation;
- A/B and C can roll back independently;
- tasks run privately, non-root, read-only where supported, and from scanned
  digest-pinned images;
- the signer is reachable only through the intended policy path and only the
  signer can invoke the designated KMS signing operation;
- health, transaction-path, logging, alarm, and isolation checks pass;
- evidence and runbooks are redacted, reproducible, and current; and
- documentation clearly labels the deployment demo-grade and records all
  residual risks.

No production-readiness claim is made by satisfying these criteria.
