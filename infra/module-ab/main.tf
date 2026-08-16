data "terraform_remote_state" "foundation" {
  backend = "s3"
  config = {
    bucket       = "straitsx-888-808198486011-ap-southeast-1-tfstate"
    key          = "foundation/terraform.tfstate"
    region       = "ap-southeast-1"
    use_lockfile = true
  }
}

data "terraform_remote_state" "module_c" {
  backend = "s3"
  config = {
    bucket       = "straitsx-888-808198486011-ap-southeast-1-tfstate"
    key          = "module-c/terraform.tfstate"
    region       = "ap-southeast-1"
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = ["808198486011"]

  default_tags {
    tags = merge(var.tags, { Module = "A/B", ManagedBy = "Terraform", State = "module-ab" })
  }
}

locals {
  platform = data.terraform_remote_state.foundation.outputs
  module_c = data.terraform_remote_state.module_c.outputs

  vpc_id          = local.platform.vpc_id
  vpc_cidr        = local.platform.vpc_cidr
  private_subnets = local.platform.private_subnet_ids
  cluster_arn     = local.platform.ecs_cluster_arn
  cluster_name    = local.platform.ecs_cluster_name
  namespace_id    = local.platform.cloudmap_namespace_id
  namespace_name  = local.platform.cloudmap_namespace_name
  internal_token  = local.platform.internal_token_secret_arn
  logs_kms_key    = local.platform.cloudwatch_kms_key_arn
  alarm_topic_arn = local.platform.alarm_topic_arn
  orchestrator_sg = local.module_c.orchestrator_security_group_id
  dashboard_sg    = local.module_c.dashboard_security_group_id
}

data "aws_prefix_list" "s3" {
  name = "com.amazonaws.${var.aws_region}.s3"
}

# --- Security groups ---------------------------------------------------------------

resource "aws_security_group" "ledger" {
  name        = "straitsx-888-ledger-service"
  description = "ledger-service 4001 - reachable from policy and Module C"
  vpc_id      = local.vpc_id
  egress      = []
  lifecycle { ignore_changes = [ingress, egress] }
}
resource "aws_security_group" "policy" {
  name        = "straitsx-888-policy-service"
  description = "policy-service 4002 - the ONLY group that may reach the signer"
  vpc_id      = local.vpc_id
  egress      = []
  lifecycle { ignore_changes = [ingress, egress] }
}
resource "aws_security_group" "signer" {
  name        = "straitsx-888-signer-service"
  description = "signer-service 4003 - holds the only key, reachable from policy-service ONLY"
  vpc_id      = local.vpc_id
  egress      = []
  lifecycle { ignore_changes = [ingress, egress] }
}
resource "aws_security_group" "gateway" {
  name        = "straitsx-888-chain-gateway"
  description = "chain-gateway 4004 - reachable from policy and Module C"
  vpc_id      = local.vpc_id
  egress      = []
  lifecycle { ignore_changes = [ingress, egress] }
}

# Ingress: exact source security groups, never CIDRs.

resource "aws_vpc_security_group_ingress_rule" "ledger_from_policy" {
  security_group_id            = aws_security_group.ledger.id
  referenced_security_group_id = aws_security_group.policy.id
  ip_protocol                  = "tcp"
  from_port                    = 4001
  to_port                      = 4001
}
resource "aws_vpc_security_group_ingress_rule" "ledger_from_module_c" {
  for_each                     = { orchestrator = local.orchestrator_sg, dashboard = local.dashboard_sg }
  security_group_id            = aws_security_group.ledger.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 4001
  to_port                      = 4001
}
resource "aws_vpc_security_group_ingress_rule" "policy_from_module_c" {
  for_each                     = { orchestrator = local.orchestrator_sg, dashboard = local.dashboard_sg }
  security_group_id            = aws_security_group.policy.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 4002
  to_port                      = 4002
}
# THE rule. The signer's only source is the policy security group.
resource "aws_vpc_security_group_ingress_rule" "signer_from_policy" {
  security_group_id            = aws_security_group.signer.id
  referenced_security_group_id = aws_security_group.policy.id
  ip_protocol                  = "tcp"
  from_port                    = 4003
  to_port                      = 4003
}
resource "aws_vpc_security_group_ingress_rule" "gateway_from_policy" {
  security_group_id            = aws_security_group.gateway.id
  referenced_security_group_id = aws_security_group.policy.id
  ip_protocol                  = "tcp"
  from_port                    = 4004
  to_port                      = 4004
}
resource "aws_vpc_security_group_ingress_rule" "gateway_from_module_c" {
  for_each                     = { orchestrator = local.orchestrator_sg, dashboard = local.dashboard_sg }
  security_group_id            = aws_security_group.gateway.id
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 4004
  to_port                      = 4004
}

# Egress: every task needs AWS startup traffic (interface endpoints 443, S3
# gateway prefix-list 443, DNS 53). Application egress is per service.

locals {
  task_sgs = {
    ledger  = aws_security_group.ledger.id
    policy  = aws_security_group.policy.id
    signer  = aws_security_group.signer.id
    gateway = aws_security_group.gateway.id
  }
}

resource "aws_vpc_security_group_egress_rule" "task_to_interface_endpoints" {
  for_each          = local.task_sgs
  security_group_id = each.value
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to private AWS interface endpoints"
}

resource "aws_vpc_security_group_egress_rule" "task_to_s3_endpoint" {
  for_each          = local.task_sgs
  security_group_id = each.value
  prefix_list_id    = data.aws_prefix_list.s3.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "ECR image layers through the S3 gateway endpoint"
}

resource "aws_vpc_security_group_egress_rule" "task_dns_tcp" {
  for_each          = local.task_sgs
  security_group_id = each.value
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = local.vpc_cidr
}
resource "aws_vpc_security_group_egress_rule" "task_dns_udp" {
  for_each          = local.task_sgs
  security_group_id = each.value
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
  cidr_ipv4         = local.vpc_cidr
}

# Policy reaches ledger, signer and gateway on their application ports only.
resource "aws_vpc_security_group_egress_rule" "policy_to_rail" {
  for_each          = { ledger = 4001, signer = 4003, gateway = 4004 }
  security_group_id = aws_security_group.policy.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
}

# Gateway reaches Avalanche RPC over outbound HTTPS through the NAT gateway.
# TCP 443 to 0.0.0.0/0 is an explicit demo residual risk; production requires
# inspected or destination-allowlisted egress.
resource "aws_vpc_security_group_egress_rule" "gateway_rpc_https" {
  security_group_id = aws_security_group.gateway.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "Avalanche RPC over HTTPS via NAT (demo residual risk)"
}

# --- IAM ---------------------------------------------------------------------------

locals {
  services = toset(["ledger", "policy", "signer", "gateway"])
}

resource "aws_iam_role" "execution" {
  for_each = local.services

  name = "straitsx-888-${each.key}-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each   = aws_iam_role.execution
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = aws_iam_role.execution

  role = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [local.internal_token]
    }]
  })
}

resource "aws_iam_role" "task" {
  for_each = local.services

  name               = "straitsx-888-${each.key}-task"
  assume_role_policy = aws_iam_role.execution[each.key].assume_role_policy
}

# The signer is the ONLY task that may sign. Its permission names the exact
# existing key and nothing else.
resource "aws_iam_role_policy" "signer_kms" {
  count = 1
  role  = aws_iam_role.task["signer"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "SignWithTheExactSigningKeyOnly"
      Effect   = "Allow"
      Action   = ["kms:Sign", "kms:GetPublicKey"]
      Resource = [var.signing_kms_key_arn]
    }]
  })
}

# Everyone else is explicitly denied — absence is not an invariant.
resource "aws_iam_role_policy" "task_deny_kms_signing" {
  for_each = toset(["ledger", "policy", "gateway"])

  role = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "MayNeverSign"
      Effect   = "Deny"
      Action   = ["kms:Sign", "kms:Decrypt", "kms:GenerateDataKey"]
      Resource = "*"
    }]
  })
}

# --- Logs --------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "services" {
  for_each = local.services

  name              = "/ecs/${var.name}/${each.key}"
  retention_in_days = 30
  kms_key_id        = local.logs_kms_key
}

# --- Cloud Map ---------------------------------------------------------------------

resource "aws_service_discovery_service" "services" {
  for_each = {
    ledger  = "ledger"
    policy  = "policy"
    signer  = "signer"
    gateway = "chain-gateway"
  }

  name = each.value
  dns_config {
    namespace_id   = local.namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
}

# --- Task definitions ---------------------------------------------------------------

locals {
  logs_for = { for k in local.services : k => {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.services[k].name
      awslogs-region        = var.aws_region
      awslogs-stream-prefix = "service"
    }
  } }

  internal_token_secret = [{ name = "INTERNAL_TOKEN", valueFrom = local.internal_token }]
}

resource "aws_ecs_task_definition" "ledger" {
  family                   = "${var.name}-ledger"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["ledger"].arn
  task_role_arn            = aws_iam_role.task["ledger"].arn
  container_definitions = jsonencode([{
    name                   = "ledger"
    image                  = var.ledger_image
    essential              = true
    user                   = "1000"
    portMappings           = [{ containerPort = 4001 }]
    secrets                = local.internal_token_secret
    logConfiguration       = local.logs_for["ledger"]
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true, tmpfs = [{ containerPath = "/tmp", size = 128 }] }
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:4001/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])
}

resource "aws_ecs_task_definition" "policy" {
  family                   = "${var.name}-policy"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution["policy"].arn
  task_role_arn            = aws_iam_role.task["policy"].arn
  container_definitions = jsonencode([{
    name         = "policy"
    image        = var.policy_image
    essential    = true
    user         = "1000"
    portMappings = [{ containerPort = 4002 }]
    environment = [
      { name = "SIGNER_URL", value = "http://signer.internal:4003" },
      { name = "LEDGER_URL", value = "http://ledger.internal:4001" },
      { name = "CHAIN_GATEWAY_URL", value = "http://chain-gateway.internal:4004" }
    ]
    secrets                = local.internal_token_secret
    logConfiguration       = local.logs_for["policy"]
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true, tmpfs = [{ containerPath = "/tmp", size = 256 }] }
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:4002/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])
}

resource "aws_ecs_task_definition" "signer" {
  family                   = "${var.name}-signer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution["signer"].arn
  task_role_arn            = aws_iam_role.task["signer"].arn
  container_definitions = jsonencode([{
    name         = "signer"
    image        = var.signer_image
    essential    = true
    user         = "1000"
    portMappings = [{ containerPort = 4003 }]
    environment = [
      { name = "KMS_KEY_ID", value = var.signing_kms_key_arn },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "EXPECTED_SIGNER_ADDRESS", value = var.expected_signer_address },
      { name = "SIGNER_CHAIN_ID", value = tostring(var.signer_chain_id) },
      { name = "SIGNER_KEY_SOURCE", value = "kms" },
      { name = "PINNED_MANDATES", value = var.pinned_mandates }
    ]
    secrets                = local.internal_token_secret
    logConfiguration       = local.logs_for["signer"]
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true, tmpfs = [{ containerPath = "/tmp", size = 256 }] }
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:4003/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])
}

resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.name}-chain-gateway"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["gateway"].arn
  task_role_arn            = aws_iam_role.task["gateway"].arn
  container_definitions = jsonencode([{
    name         = "chain-gateway"
    image        = var.chain_gateway_image
    essential    = true
    user         = "1000"
    portMappings = [{ containerPort = 4004 }]
    environment = [
      { name = "CHAIN_IDS", value = var.chain_ids },
      { name = "RPC_URL_43113", value = var.rpc_url_43113 },
      { name = "RPC_URL_43114", value = var.rpc_url_43114 },
      { name = "RPC_TIMEOUT_MS", value = tostring(var.rpc_timeout_ms) }
    ]
    secrets                = local.internal_token_secret
    logConfiguration       = local.logs_for["gateway"]
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true, tmpfs = [{ containerPath = "/tmp", size = 128 }] }
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:4004/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
  }])
}

# --- ECS services -------------------------------------------------------------------

# A/B deploys as ONE release: version skew between these four breaks signing in
# both directions (deployment.md §5). Singleton tasks replace in place.
locals {
  service_definitions = {
    ledger  = { td = aws_ecs_task_definition.ledger.arn, sg = aws_security_group.ledger.id, registry = aws_service_discovery_service.services["ledger"].arn, name = "ledger" }
    policy  = { td = aws_ecs_task_definition.policy.arn, sg = aws_security_group.policy.id, registry = aws_service_discovery_service.services["policy"].arn, name = "policy" }
    signer  = { td = aws_ecs_task_definition.signer.arn, sg = aws_security_group.signer.id, registry = aws_service_discovery_service.services["signer"].arn, name = "signer" }
    gateway = { td = aws_ecs_task_definition.gateway.arn, sg = aws_security_group.gateway.id, registry = aws_service_discovery_service.services["gateway"].arn, name = "chain-gateway" }
  }
}

resource "aws_ecs_service" "services" {
  for_each = local.service_definitions

  name                               = "${var.name}-${each.value.name}"
  cluster                            = local.cluster_arn
  task_definition                    = each.value.td
  desired_count                      = 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = local.private_subnets
    security_groups  = [each.value.sg]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = each.value.registry
  }
}

# --- Observability -------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "service_running" {
  for_each = local.service_definitions

  alarm_name          = "${var.name}-${each.value.name}-running"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ServiceRunningCount"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  treat_missing_data  = "breaching"
  dimensions = {
    ClusterName = local.cluster_name
    ServiceName = "${var.name}-${each.value.name}"
  }
  alarm_actions = [local.alarm_topic_arn]
}

# Unexpected task stops route into the same operational notification path.
resource "aws_cloudwatch_event_rule" "ab_task_stop" {
  name        = "${var.name}-task-stop"
  description = "Unexpected A/B ECS task stops"
  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [local.cluster_arn]
      lastStatus = ["STOPPED"]
      stopCode   = ["TaskFailedToStart", "EssentialContainerExited"]
    }
  })
}

resource "aws_cloudwatch_event_target" "ab_task_stop" {
  rule      = aws_cloudwatch_event_rule.ab_task_stop.name
  target_id = "operations-topic"
  arn       = local.alarm_topic_arn
}