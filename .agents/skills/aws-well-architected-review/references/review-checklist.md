# Review checklist

Derived from `docs/references/wellarchitected-framework.pdf` (AWS Well-Architected Framework,
1,002 pages, supplied 2026-08-15). IDs preserve traceability to the source. Read the source PDF
when a finding needs the full implementation guidance, examples, or risk explanation.

## Operational excellence

- `OPS01-BP03/BP04/BP05`: capture governance, compliance, and threat-landscape requirements.
- `OPS02-BP01-BP06`: identify workload, process, and operational owners; define exception paths and team boundaries.
- `OPS04-BP01-BP05`: define KPIs and instrument application, user, dependency, and trace telemetry without capturing secrets.
- `OPS05-BP01-BP10`: version control infrastructure, test changes, manage configuration, patch, share standards, use environments, and automate small reversible deployments.
- `OPS06-BP01-BP04`: plan unsuccessful changes; test deployments; use safe deployment and automated rollback/rollforward.
- `OPS07-BP02-BP06`: perform an operational readiness review; maintain runbooks, playbooks, deployment decisions, and support plans.
- `OPS08-BP01-BP05`: analyze metrics/logs/traces; create actionable alerts and dashboards.
- `OPS10-BP01-BP07`: define incident processes, alert ownership, impact priorities, escalation, communications, and automated response.
- `OPS11-BP01-BP09`: run continuous improvement and post-incident learning.

## Security

- `SEC01-BP01-BP08`: separate workloads/accounts, protect root, define control objectives, reduce scope, automate controls, and threat-model.
- `SEC02-BP01-BP05`: strong sign-in, temporary credentials, secure secret storage/use, centralized identity, and rotation.
- `SEC03-BP01-BP09`: document access needs, grant least privilege, create emergency access, continuously reduce permissions, and review public/cross-account access.
- `SEC04-BP01-BP04`: standardize service/application/security logs, centralize them, correlate alerts, and remediate non-compliance. Redact secrets and sensitive data at source.
- `SEC05-BP01-BP04`: layer networks, explicitly control flows, inspect where appropriate, and automate network protections. Validate negative paths from the real source identity; DNS failure is not isolation proof.
- `SEC06-BP01-BP05`: scan vulnerabilities, use hardened/immutable images, reduce interactive access, verify software integrity, and automate protection.
- `SEC07-BP01-BP04`: classify data, apply sensitivity-based controls, automate discovery, and define lifecycle/retention.
- `SEC08-BP01-BP04`: managed keys, encryption at rest, automated protection, and access control.
- `SEC09-BP01-BP03`: manage certificates/keys, encrypt in transit, and authenticate network communication.
- `SEC10-BP01-BP08`: prepare incident contacts, plans, forensic capability, playbooks, access/tools, simulations, and learning.
- `SEC11-BP01-BP08`: train, automate security tests, review code, centralize dependencies, deploy programmatically, and assess pipeline security.

## Reliability

- `REL01-BP01-BP06`: understand, monitor, and maintain headroom for service quotas.
- `REL02-BP01/BP03`: highly available public connectivity and subnet capacity for growth/AZ distribution.
- `REL03-BP01-BP03`: segment by business domain and maintain explicit service contracts.
- `REL04-BP01-BP04`: understand distributed dependencies, loosely couple, do constant work, and make mutations idempotent.
- `REL05-BP01-BP07`: graceful degradation, throttling, bounded retries, fail-fast queues, client timeouts, statelessness, and emergency levers.
- `REL06-BP01-BP07`: monitor every component, define metrics, alert, automate responses, analyze logs, and trace end to end.
- `REL07-BP01-BP04`: automate scaling and load-test.
- `REL08-BP01-BP05`: deployment runbooks, functional/resilience tests, immutable infrastructure, and automated changes.
- `REL09-BP01-BP04`: identify, encrypt, automate, and restore-test backups.
- `REL10-BP01-BP03`: use multiple locations/AZs, automate recovery, and apply bulkheads.
- `REL11-BP01-BP07`: detect failures, route to healthy capacity, self-heal, prefer data-plane recovery, and meet availability targets.
- `REL12-BP01-BP05` and `REL13-BP01-BP05`: investigate/test failures, define RTO/RPO, test DR, prevent drift, and automate recovery.

## Performance efficiency

- `PERF01-BP01-BP07`: use current AWS guidance, reference architectures, benchmarks, and measured tradeoffs.
- `PERF02-BP01-BP05`: select, measure, right-size, and dynamically scale compute.
- `PERF03-BP01-BP05`: choose purpose-built stores and measure/tune access patterns and caching.
- `PERF04-BP01-BP07`: model network effects, load balance, choose location/protocols, and optimize from metrics.
- `PERF05-BP01-BP07`: define KPIs, monitor, load-test, automate remediation, update, and review regularly.

## Cost optimization

- `COST01-BP01-BP09`: assign cost ownership, budgets, reporting, proactive monitoring, and business-value measures.
- `COST02-BP01-BP06`: set policies/targets, account structure, roles, controls, and lifecycle tracking.
- `COST03-BP01-BP06`: enable detailed cost sources, tags/attribution, metrics, and billing tools.
- `COST04-BP01-BP05`: track and automatically decommission resources; enforce retention.
- `COST05-BP01-BP06`: analyze every component and usage profile.
- `COST06-BP01-BP04`: model and right-size from data; use shared resources where appropriate.
- `COST08-BP01-BP03`: model and minimize data-transfer cost.
- `COST09-BP01-BP03`: analyze demand, buffer/throttle, and supply dynamically.
- `COST10-BP01/BP02` and `COST11-BP01`: review regularly and automate operations.

## Sustainability

- `SUS01-BP01`: choose Region using business and sustainability requirements.
- `SUS02-BP01-BP06`: scale dynamically, remove unused assets, optimize placement/team resources, and flatten demand.
- `SUS03-BP01-BP05`: schedule asynchronous work, remove low-use components, optimize hot code, and use appropriate patterns.
- `SUS04-BP01-BP08`: classify data, apply lifecycle policies, remove redundancy, minimize movement, and back up only what cannot be recreated.
- `SUS05-BP01-BP04`: minimize hardware and use efficient instance types and managed services.
- `SUS06-BP01-BP05`: communicate goals, rapidly adopt improvements, stay current, and improve build/test utilization.

## Evidence gates for AWS infrastructure

- Terraform formatting/validation is syntax evidence, not runtime evidence.
- IAM needs policy simulation or controlled assume-role/API tests.
- Security-group isolation needs a deployed positive-and-negative probe from the exact source security group.
- Availability needs multi-AZ placement plus failure/failover evidence.
- Backups need a successful restore test tied to stated RTO/RPO.
- Autoscaling needs load evidence and alarm behavior.
- Observability needs emitted sample signals, usable dashboards, and actionable alarm routing.
- Rollback needs a rehearsed command or automated deployment behavior.
