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
      Resource = [local.effective_internal_token_arn, local.effective_paying_wallet_ssm_arn]
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
  kms_key_id        = local.effective_cloudwatch_kms_key_arn
}

resource "aws_security_group" "orchestrator" {
  name   = "${var.name}-orchestrator"
  vpc_id = local.effective_vpc_id
  egress = []
  lifecycle { ignore_changes = [ingress, egress] }
}
resource "aws_security_group" "dashboard" {
  name   = "${var.name}-dashboard"
  vpc_id = local.effective_vpc_id
  egress = []
  lifecycle { ignore_changes = [ingress, egress] }
}
resource "aws_security_group" "fixture" {
  name   = "${var.name}-fixture"
  vpc_id = local.effective_vpc_id
  egress = []
  lifecycle { ignore_changes = [ingress, egress] }
}
resource "aws_security_group" "alb" {
  name   = "${var.name}-alb"
  vpc_id = local.effective_vpc_id
  egress = []
  lifecycle { ignore_changes = [ingress, egress] }
}

data "aws_prefix_list" "s3" {
  name = "com.amazonaws.${var.aws_region}.s3"
}

locals {
  task_security_groups = {
    dashboard    = aws_security_group.dashboard.id
    fixture      = aws_security_group.fixture.id
    orchestrator = aws_security_group.orchestrator.id
  }
}

# Private Fargate startup traffic. The platform stack supplies interface
# endpoints for ECR, Logs, Secrets Manager and SSM plus an S3 gateway endpoint.
resource "aws_vpc_security_group_egress_rule" "task_to_interface_endpoints" {
  for_each          = local.task_security_groups
  security_group_id = each.value
  cidr_ipv4         = local.effective_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS to private AWS interface endpoints"
}

resource "aws_vpc_security_group_egress_rule" "task_to_s3_endpoint" {
  for_each          = local.task_security_groups
  security_group_id = each.value
  prefix_list_id    = data.aws_prefix_list.s3.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "ECR image layers through the S3 gateway endpoint"
}

resource "aws_vpc_security_group_egress_rule" "orch_fixture" {
  security_group_id            = aws_security_group.orchestrator.id
  referenced_security_group_id = aws_security_group.fixture.id
  ip_protocol                  = "tcp"
  from_port                    = 4010
  to_port                      = 4010
}

# Stable same-VPC service contracts decouple this stack from A/B resource IDs.
# A/B (or infra/module-c-integration) owns the matching ingress rules. Port
# 4003 is deliberately absent, so the orchestrator cannot reach the signer.
resource "aws_vpc_security_group_egress_rule" "orch_dependency_contracts" {
  for_each = {
    ledger = 4001
    policy = 4002
    chain  = 4004
  }
  security_group_id = aws_security_group.orchestrator.id
  cidr_ipv4         = local.effective_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
}

resource "aws_vpc_security_group_egress_rule" "orch_dns_udp" {
  security_group_id = aws_security_group.orchestrator.id
  cidr_ipv4         = local.effective_vpc_cidr
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}
resource "aws_vpc_security_group_egress_rule" "orch_dns_tcp" {
  security_group_id = aws_security_group.orchestrator.id
  cidr_ipv4         = local.effective_vpc_cidr
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

resource "aws_vpc_security_group_ingress_rule" "fixture_from_orchestrator" {
  security_group_id            = aws_security_group.fixture.id
  referenced_security_group_id = aws_security_group.orchestrator.id
  ip_protocol                  = "tcp"
  from_port                    = 4010
  to_port                      = 4010
}

resource "aws_vpc_security_group_egress_rule" "dashboard_service" {
  security_group_id            = aws_security_group.dashboard.id
  referenced_security_group_id = aws_security_group.orchestrator.id
  ip_protocol                  = "tcp"
  from_port                    = 4005
  to_port                      = 4005
}

resource "aws_vpc_security_group_egress_rule" "dashboard_dependency_contracts" {
  for_each = {
    ledger = 4001
    policy = 4002
    chain  = 4004
  }
  security_group_id = aws_security_group.dashboard.id
  cidr_ipv4         = local.effective_vpc_cidr
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
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
  secrets = [{ name = "INTERNAL_TOKEN", valueFrom = local.effective_internal_token_arn }]
  orchestrator_environment = [
    { name = "LEDGER_URL", value = "http://${var.ledger_service_name}:4001" },
    { name = "POLICY_URL", value = "http://${var.policy_service_name}:4002" },
    { name = "CHAIN_GATEWAY_URL", value = "http://${var.chain_gateway_service_name}:4004" },
    { name = "FIXTURE_BASE_URL", value = "http://${var.name}-fixture.${local.effective_cloudmap_namespace}:4010" }
  ]
}

resource "aws_service_discovery_service" "orchestrator" {
  name = "${var.name}-orchestrator"
  dns_config {
    namespace_id   = local.effective_cloudmap_namespace_id
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
    namespace_id   = local.effective_cloudmap_namespace_id
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
    secrets                = concat(local.secrets, [{ name = "PAYING_WALLET_ADDRESS", valueFrom = local.effective_paying_wallet_ssm_arn }])
    logConfiguration       = local.logs
    readonlyRootFilesystem = true
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
  volume { name = "fixture-tmp" }
  container_definitions = jsonencode([{
    name                   = "fixture"
    image                  = var.fixture_image
    essential              = true
    command                = ["pnpm", "--filter", "@straitsx/agent-orchestrator", "fixtures"]
    portMappings           = [{ containerPort = 4010 }]
    logConfiguration       = local.logs
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true }
    mountPoints            = [{ sourceVolume = "fixture-tmp", containerPath = "/tmp", readOnly = false }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e 'fetch(\"http://127.0.0.1:4010/health\").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])
}

resource "aws_ecs_service" "orchestrator" {
  name            = "${var.name}-orchestrator"
  cluster         = local.effective_ecs_cluster_arn
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
    subnets          = local.effective_private_subnet_ids
    security_groups  = [aws_security_group.orchestrator.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.orchestrator.arn
  }
}
resource "aws_ecs_service" "fixture" {
  name            = "${var.name}-fixture"
  cluster         = local.effective_ecs_cluster_arn
  task_definition = aws_ecs_task_definition.fixture.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = local.effective_private_subnet_ids
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
      { name = "AGENT_ORCHESTRATOR_URL", value = "http://${var.name}-orchestrator.${local.effective_cloudmap_namespace}:4005" },
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
  cidr_ipv4         = local.effective_vpc_cidr
  ip_protocol       = each.value
  from_port         = 53
  to_port           = 53
}
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count             = var.enable_cloudfront ? 0 : 1
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

data "aws_ec2_managed_prefix_list" "cloudfront_origin" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_from_cloudfront" {
  count             = var.enable_cloudfront ? 1 : 0
  security_group_id = aws_security_group.alb.id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront_origin[0].id
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  description       = "HTTP origin traffic from AWS CloudFront only"
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
  subnets                    = local.effective_public_subnet_ids
  enable_deletion_protection = var.alb_deletion_protection
  access_logs {
    bucket  = local.effective_alb_logs_bucket
    prefix  = var.name
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.alb_logs]
}
resource "aws_lb_target_group" "dashboard" {
  name        = substr("${replace(var.name, "_", "-")}-dash", 0, 32)
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = local.effective_vpc_id
  health_check {
    path = "/api/health"
  }
}
resource "aws_lb_listener" "https" {
  count             = var.enable_cloudfront ? 0 : 1
  load_balancer_arn = aws_lb.dashboard.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dashboard.arn
  }
}


resource "aws_lb_listener" "http" {
  count             = var.enable_cloudfront ? 1 : 0
  load_balancer_arn = aws_lb.dashboard.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.dashboard.arn
  }
}

data "aws_cloudfront_cache_policy" "disabled" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  count = var.enable_cloudfront ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_distribution" "dashboard" {
  count               = var.enable_cloudfront ? 1 : 0
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.name} dashboard"
  price_class         = "PriceClass_100"
  wait_for_deployment = true

  origin {
    domain_name = aws_lb.dashboard.dns_name
    origin_id   = "module-c-alb"
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id         = "module-c-alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled[0].id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host[0].id
    compress                 = true
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  depends_on = [aws_lb_listener.http]
}
resource "aws_ecs_service" "dashboard" {
  name            = "${var.name}-dashboard"
  cluster         = local.effective_ecs_cluster_arn
  task_definition = aws_ecs_task_definition.dashboard.arn
  desired_count   = var.dashboard_desired_count
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = local.effective_private_subnet_ids
    security_groups  = [aws_security_group.dashboard.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.dashboard.arn
    container_name   = "dashboard"
    container_port   = 3000
  }
  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_lb_listener.https, aws_lb_listener.http]
}

resource "aws_appautoscaling_target" "service" {
  for_each           = { dashboard = aws_ecs_service.dashboard.name }
  max_capacity       = var.service_max_count
  min_capacity       = var.dashboard_desired_count
  resource_id        = "service/${element(reverse(split("/", local.effective_ecs_cluster_arn)), 0)}/${each.value}"
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
  alarm_actions       = [local.effective_alarm_topic_arn]
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
  alarm_actions = [local.effective_alarm_topic_arn]
}
