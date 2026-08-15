# Module C AWS deployment and Well-Architected evidence

Source rubric: `docs/references/wellarchitected-framework.pdf` and the project skill
`.agents/skills/aws-well-architected-review`.

## Deployment flow

1. Build the dashboard and orchestrator images from the workspace Dockerfiles. Scan them,
   push to ECR, and pass immutable `@sha256:` image references to Terraform.
2. Supply at least two public and two private subnets in distinct Availability Zones, an ACM
   certificate, encrypted CloudWatch key, ALB log bucket, SNS alarm topic, service-discovery
   names, dependency security groups, and Secrets Manager/SSM ARNs.
3. Resolve only the approved StraitsX and merchant HTTPS endpoints to
   `https_egress_cidrs`. `0.0.0.0/0` is rejected. Because CDN IPs can change, production
   should prefer an inspected egress proxy or AWS Network Firewall domain list; direct CIDR
   allowlisting requires an owned refresh runbook.
4. Run `terraform fmt -check`, `terraform validate`, a reviewed `terraform plan`, container
   tests, and image scans before apply. ECS deployment circuit breakers roll back unhealthy
   dashboard/orchestrator tasks.
5. Run the isolation probe as a one-off task using the exact private subnets and
   `orchestrator_security_group_id`. Archive its CloudWatch stream. A pass requires positive
   DNS plus policy/ledger/chain connectivity and negative signer:4003 connectivity.

Example probe launch (fill outputs explicitly):

```sh
aws ecs run-task \
  --cluster "$ECS_CLUSTER_ARN" \
  --task-definition "$ISOLATION_PROBE_TASK_DEFINITION_ARN" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIVATE_SUBNET_IDS],securityGroups=[$ORCHESTRATOR_SECURITY_GROUP_ID],assignPublicIp=DISABLED}"
```

## Six-pillar review

| Pillar | Status | Implemented evidence | Remaining gate |
|---|---|---|---|
| Operational excellence | partial | Versioned Terraform/Dockerfiles, health checks, deployment rollback, CloudWatch logs/alarms, runbook and evidence commands (`OPS05`, `OPS06`, `OPS07`, `OPS08`) | Alarm routing and rollback must be exercised in AWS. |
| Security | partial | Private Fargate tasks, least-privilege service flows, Secrets Manager/SSM, encrypted logs, immutable image digests, read-only/non-root containers, TLS ALB, signer negative probe (`SEC02`, `SEC03`, `SEC04`, `SEC05`, `SEC06`, `SEC09`) | Apply-time SG inspection, image scan, IAM simulation, and deployed isolation proof remain required. Module B must verify approval signatures. |
| Reliability | partial | Multi-AZ ALB/dashboard, target health checks, dashboard autoscaling, bounded application timeouts, circuit-breaker rollback (`REL02`, `REL05`, `REL06`, `REL08`) | Orchestrator resumable context is process-local, so its service intentionally remains one task. Durable non-secret run storage is required before horizontal scaling or HA claims. A/B datastore backup/DR is external. |
| Performance efficiency | partial | Fargate CPU/memory parameters, ALB, dashboard target tracking (`PERF02`, `PERF04`, `PERF05`) | Load-test and tune task sizes/targets from metrics. |
| Cost optimization | partial | Parameterized sizing, dashboard demand scaling, 30-day log retention, tags (`COST01`, `COST03`, `COST04`, `COST06`, `COST09`) | Add budgets/cost anomaly alerts at the account layer and review NAT/egress costs. |
| Sustainability | partial | Fargate managed compute, dashboard demand scaling, bounded log lifecycle (`SUS02`, `SUS04`, `SUS05`) | Measure utilization; right-size and remove idle demo resources after capture. |

## Non-negotiable acceptance evidence

- Terraform validation alone is not deployment proof.
- ECS services healthy across configured AZs.
- CloudWatch alarms deliver to an owned destination.
- Rollback/circuit breaker tested with a deliberately unhealthy image in a non-production environment.
- Signer DNS resolves while TCP/HTTP 4003 fails from the orchestrator security group.
- Policy 4002, ledger 4001, chain gateway 4004, DNS, and approved HTTPS destinations succeed.
- No signer URL appears in the orchestrator task definition.
- Logs and ALB evidence contain no card data, authorization headers, approval signatures, or iframe URLs.
