---
name: aws-well-architected-review
description: Review, design, or revise AWS workloads against the AWS Well-Architected Framework across operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability. Use for AWS architecture reviews, Terraform/CloudFormation/CDK changes, deployment readiness, security-group/IAM analysis, observability, resilience, cost, or sustainability decisions.
---

# AWS Well-Architected Review

Use `references/review-checklist.md` as the required review rubric. Keep findings traceable to its AWS best-practice IDs.

## Workflow

1. Define workload scope, owners, environments, data classification, compliance needs, recovery objectives, availability target, expected demand, and budget. Mark undiscovered facts as `unknown`; never silently assume them.
2. Inventory accounts, Regions/AZs, networking, identity, secrets, compute, data stores, ingress/egress, deployment pipeline, telemetry, backups, and external dependencies.
3. Build a threat model and failure-mode map before recommending changes. Identify trust boundaries, irreversible actions, blast radii, and recovery paths.
4. Review all six pillars using the checklist. Do not treat security as exchangeable for cost or schedule.
5. Require evidence for each claim: code/resource reference, Terraform plan, policy simulation, test output, metric/alarm, runbook, restore test, or deployed probe. Design intent alone is not evidence.
6. Rank findings:
   - `critical`: credible compromise, data loss, or unrecoverable production failure.
   - `high`: major pillar risk or missing control with likely impact.
   - `medium`: material weakness with compensating controls.
   - `low`: optimization or documentation gap.
7. Propose the smallest safe remediation. Prefer automation, least privilege, immutable deployment, bounded retries/timeouts, multi-AZ managed services, encryption, centralized logs, tested recovery, autoscaling, and lifecycle controls.
8. Re-run static validation and relevant functional, security, resilience, and deployment tests after changes. Never claim a cloud control works from Terraform validation alone.

## Required output

Provide:

- Scope and assumptions.
- A six-pillar summary with status: `meets`, `partial`, `gap`, or `not applicable`.
- Prioritized findings with best-practice IDs, evidence, impact, remediation, and verification.
- Deployment blockers separated from post-launch improvements.
- Residual risks and external acceptance gates.

For infrastructure changes, include rollback/rollforward, alarms, ownership, and evidence-capture steps. Call out controls that require a deployed test, such as network isolation, restore, failover, or scaling.
