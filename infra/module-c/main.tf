provider "aws" {
  region = var.aws_region
  default_tags {
    tags = merge(var.tags, { Module = "C", ManagedBy = "Terraform" })
  }
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "secrets" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue", "ssm:GetParameters"]
      Resource = [var.internal_token_secret_arn, var.paying_wallet_ssm_arn]
    }]
  })
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = aws_iam_role.execution.assume_role_policy
}

resource "aws_cloudwatch_log_group" "module_c" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
  kms_key_id        = var.cloudwatch_kms_key_arn
}

resource "aws_security_group" "orchestrator" {
  name   = "${var.name}-orchestrator"
  vpc_id = var.vpc_id
  egress = []
}
resource "aws_security_group" "dashboard" {
  name   = "${var.name}-dashboard"
  vpc_id = var.vpc_id
  egress = []
}
resource "aws_security_group" "fixture" {
  name   = "${var.name}-fixture"
  vpc_id = var.vpc_id
  egress = []
}
resource "aws_security_group" "alb" {
  name   = "${var.name}-alb"
  vpc_id = var.vpc_id
  egress = []
}

resource "aws_vpc_security_group_egress_rule" "orch_service" {
  for_each = {
    ledger  = { sg = var.ledger_security_group_id, port = 4001 }
    policy  = { sg = var.policy_security_group_id, port = 4002 }
    chain   = { sg = var.chain_gateway_security_group_id, port = 4004 }
    fixture = { sg = aws_security_group.fixture.id, port = 4010 }
  }
  security_group_id            = aws_security_group.orchestrator.id
  referenced_security_group_id = each.value.sg
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_egress_rule" "orch_dns_udp" {
  security_group_id = aws_security_group.orchestrator.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}
resource "aws_vpc_security_group_egress_rule" "orch_dns_tcp" {
  security_group_id = aws_security_group.orchestrator.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}
resource "aws_vpc_security_group_egress_rule" "orch_https" {
  for_each          = toset(var.https_egress_cidrs)
  security_group_id = aws_security_group.orchestrator.id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

# Signer port 4003 is intentionally absent from orchestrator egress.
resource "aws_vpc_security_group_ingress_rule" "signer_from_policy_only" {
  security_group_id            = var.signer_security_group_id
  referenced_security_group_id = var.policy_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 4003
  to_port                      = 4003
}
resource "aws_vpc_security_group_ingress_rule" "fixture_from_orchestrator" {
  security_group_id            = aws_security_group.fixture.id
  referenced_security_group_id = aws_security_group.orchestrator.id
  ip_protocol                  = "tcp"
  from_port                    = 4010
  to_port                      = 4010
}

resource "aws_vpc_security_group_ingress_rule" "module_c_to_dependencies" {
  for_each = {
    orchestrator_ledger = { target = var.ledger_security_group_id, source = aws_security_group.orchestrator.id, port = 4001 }
    orchestrator_policy = { target = var.policy_security_group_id, source = aws_security_group.orchestrator.id, port = 4002 }
    orchestrator_chain  = { target = var.chain_gateway_security_group_id, source = aws_security_group.orchestrator.id, port = 4004 }
    dashboard_ledger    = { target = var.ledger_security_group_id, source = aws_security_group.dashboard.id, port = 4001 }
    dashboard_policy    = { target = var.policy_security_group_id, source = aws_security_group.dashboard.id, port = 4002 }
    dashboard_chain     = { target = var.chain_gateway_security_group_id, source = aws_security_group.dashboard.id, port = 4004 }
  }
  security_group_id            = each.value.target
  referenced_security_group_id = each.value.source
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

resource "aws_vpc_security_group_egress_rule" "dashboard_service" {
  for_each = {
    ledger       = { sg = var.ledger_security_group_id, port = 4001 }
    policy       = { sg = var.policy_security_group_id, port = 4002 }
    chain        = { sg = var.chain_gateway_security_group_id, port = 4004 }
    orchestrator = { sg = aws_security_group.orchestrator.id, port = 4005 }
  }
  security_group_id            = aws_security_group.dashboard.id
  referenced_security_group_id = each.value.sg
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}

locals {
  logs = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.module_c.name
      awslogs-region        = var.aws_region
      awslogs-stream-prefix = "service"
    }
  }
  secrets = [{ name = "INTERNAL_TOKEN", valueFrom = var.internal_token_secret_arn }]
  orchestrator_environment = [
    { name = "LEDGER_URL", value = "http://${var.ledger_service_name}:4001" },
    { name = "POLICY_URL", value = "http://${var.policy_service_name}:4002" },
    { name = "CHAIN_GATEWAY_URL", value = "http://${var.chain_gateway_service_name}:4004" },
    { name = "FIXTURE_BASE_URL", value = "http://${var.name}-fixture.${var.cloudmap_namespace_name}:4010" }
  ]
}

resource "aws_service_discovery_service" "orchestrator" {
  name = "${var.name}-orchestrator"
  dns_config {
    namespace_id   = var.cloudmap_namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
}
resource "aws_service_discovery_service" "fixture" {
  name = "${var.name}-fixture"
  dns_config {
    namespace_id   = var.cloudmap_namespace_id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
}

resource "aws_ecs_task_definition" "orchestrator" {
  family                   = "${var.name}-orchestrator"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  volume { name = "checkout-tmp" }
  container_definitions = jsonencode([{
    name                   = "orchestrator"
    image                  = var.orchestrator_image
    essential              = true
    portMappings           = [{ containerPort = 4005 }]
    environment            = local.orchestrator_environment
    secrets                = concat(local.secrets, [{ name = "PAYING_WALLET_ADDRESS", valueFrom = var.paying_wallet_ssm_arn }])
    logConfiguration       = local.logs
    readonlyRootFilesystem = true
    user                   = "1001"
    linuxParameters        = { initProcessEnabled = true }
    mountPoints            = [{ sourceVolume = "checkout-tmp", containerPath = "/tmp", readOnly = false }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:4005/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])
}

resource "aws_ecs_task_definition" "fixture" {
  family                   = "${var.name}-fixture"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name                   = "fixture"
    image                  = var.fixture_image
    essential              = true
    command                = ["pnpm", "--filter", "@straitsx/agent-orchestrator", "fixtures"]
    portMappings           = [{ containerPort = 4010 }]
    logConfiguration       = local.logs
    readonlyRootFilesystem = true
    user                   = "1000"
    linuxParameters        = { initProcessEnabled = true }
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:4010/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])
}

resource "aws_ecs_task_definition" "isolation_probe" {
  family                   = "${var.name}-isolation-probe"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name      = "probe"
    image     = var.orchestrator_image
    essential = true
    command   = ["pnpm", "test:isolation"]
    environment = concat(local.orchestrator_environment, [
      { name = "SIGNER_HOST", value = var.signer_service_name },
      { name = "SIGNER_PORT", value = "4003" }
    ])
    logConfiguration = local.logs
  }])
}

resource "aws_ecs_service" "orchestrator" {
  name            = "${var.name}-orchestrator"
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.orchestrator.arn
  # Non-secret resumable context is process-local. Keep one task until a
  # durable run-store adapter lands; scaling this service would split runs.
  desired_count = 1
  launch_type   = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.orchestrator.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.orchestrator.arn
  }
}
resource "aws_ecs_service" "fixture" {
  name            = "${var.name}-fixture"
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.fixture.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.fixture.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.fixture.arn
  }
}

resource "aws_ecs_task_definition" "dashboard" {
  family                   = "${var.name}-dashboard"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  container_definitions = jsonencode([{
    name         = "dashboard"
    image        = var.dashboard_image
    essential    = true
    portMappings = [{ containerPort = 3000 }]
    environment = [
      { name = "AGENT_ORCHESTRATOR_URL", value = "http://${var.name}-orchestrator.${var.cloudmap_namespace_name}:4005" },
      { name = "LEDGER_URL", value = "http://${var.ledger_service_name}:4001" },
      { name = "POLICY_URL", value = "http://${var.policy_service_name}:4002" },
      { name = "CHAIN_GATEWAY_URL", value = "http://${var.chain_gateway_service_name}:4004" }
    ]
    secrets                = local.secrets
    logConfiguration       = local.logs
    readonlyRootFilesystem = true
    user                   = "1000"
    linuxParameters        = { initProcessEnabled = true }
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:3000/api/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_vpc_security_group_ingress_rule" "dashboard_from_alb" {
  security_group_id            = aws_security_group.dashboard.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}
resource "aws_vpc_security_group_ingress_rule" "orchestrator_from_dashboard" {
  security_group_id            = aws_security_group.orchestrator.id
  referenced_security_group_id = aws_security_group.dashboard.id
  ip_protocol                  = "tcp"
  from_port                    = 4005
  to_port                      = 4005
}
resource "aws_vpc_security_group_egress_rule" "dashboard_dns" {
  for_each          = toset(["tcp", "udp"])
  security_group_id = aws_security_group.dashboard.id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = each.value
  from_port         = 53
  to_port           = 53
}
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_egress_rule" "alb_to_dashboard" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.dashboard.id
  ip_protocol                  = "tcp"
  from_port                    = 3000
  to_port                      = 3000
}

resource "aws_lb" "dashboard" {
  name                       = substr(replace(var.name, "_", "-"), 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = var.public_subnet_ids
  enable_deletion_protection = true
  access_logs {
    bucket  = var.alb_access_logs_bucket
    prefix  = var.name
    enabled = true
  }
}
resource "aws_lb_target_group" "dashboard" {
  name        = substr("${replace(var.name, "_", "-")}-dash", 0, 32)
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path = "/api/health"
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.dashboard.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dashboard.arn
  }
}
resource "aws_ecs_service" "dashboard" {
  name            = "${var.name}-dashboard"
  cluster         = var.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.dashboard.arn
  desired_count   = var.dashboard_desired_count
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.dashboard.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.dashboard.arn
    container_name   = "dashboard"
    container_port   = 3000
  }
  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "service" {
  for_each           = { dashboard = aws_ecs_service.dashboard.name }
  max_capacity       = var.service_max_count
  min_capacity       = var.dashboard_desired_count
  resource_id        = "service/${element(reverse(split("/", var.ecs_cluster_arn)), 0)}/${each.value}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each           = aws_appautoscaling_target.service
  name               = "${var.name}-${each.key}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = each.value.resource_id
  scalable_dimension = each.value.scalable_dimension
  service_namespace  = each.value.service_namespace
  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  treat_missing_data  = "notBreaching"
  dimensions          = { LoadBalancer = aws_lb.dashboard.arn_suffix }
  alarm_actions       = [var.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  alarm_name          = "${var.name}-unhealthy-targets"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "UnHealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "breaching"
  dimensions = {
    LoadBalancer = aws_lb.dashboard.arn_suffix
    TargetGroup  = aws_lb_target_group.dashboard.arn_suffix
  }
  alarm_actions = [var.alarm_topic_arn]
}
