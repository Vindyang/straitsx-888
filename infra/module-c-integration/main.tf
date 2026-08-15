provider "aws" {
  region = var.aws_region
  default_tags {
    tags = merge(var.tags, { Module = "C-integration", ManagedBy = "Terraform" })
  }
}

# This post-deployment evidence stack owns only a Module C probe task. A/B owns
# its ingress rules and signer isolation policy; no resource here mutates A/B.
resource "aws_ecs_task_definition" "isolation_probe" {
  family                   = "${var.name}-isolation-probe"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  volume { name = "probe-tmp" }

  container_definitions = jsonencode([{
    name                   = "probe"
    image                  = var.orchestrator_image
    essential              = true
    command                = ["pnpm", "test:isolation"]
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "probe-tmp", containerPath = "/tmp", readOnly = false }]
    environment = [
      { name = "LEDGER_URL", value = "http://${var.ledger_service_name}:4001" },
      { name = "POLICY_URL", value = "http://${var.policy_service_name}:4002" },
      { name = "CHAIN_GATEWAY_URL", value = "http://${var.chain_gateway_service_name}:4004" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = var.cloudwatch_log_group
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "isolation-probe"
      }
    }
  }])
}
