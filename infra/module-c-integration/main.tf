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

data "terraform_remote_state" "module_ab" {
  backend = "s3"
  config = {
    bucket       = "straitsx-888-808198486011-ap-southeast-1-tfstate"
    key          = "module-ab/terraform.tfstate"
    region       = "ap-southeast-1"
    use_lockfile = true
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = ["808198486011"]
  default_tags {
    tags = merge(var.tags, { Module = "C-integration", ManagedBy = "Terraform", State = "module-c-integration" })
  }
}

locals {
  foundation = data.terraform_remote_state.foundation.outputs
  module_c   = data.terraform_remote_state.module_c.outputs
  module_ab  = data.terraform_remote_state.module_ab.outputs
}

# This evidence stack owns only a Module C probe task. It runs inside the
# orchestrator security group, inheriting exactly the contracts Module C may
# call (4001, 4002, 4004) and never the signer (4003). The probe asserts the
# negative: signer.internal must be unreachable from Module C.
resource "aws_ecs_task_definition" "isolation_probe" {
  family                   = "${var.name}-isolation-probe"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = local.module_c.orchestrator_execution_role_arn
  task_role_arn            = local.module_c.orchestrator_task_role_arn

  volume { name = "probe-tmp" }

  container_definitions = jsonencode([{
    name                   = "probe"
    image                  = local.module_c.orchestrator_image
    essential              = true
    command                = ["pnpm", "test:isolation"]
    readonlyRootFilesystem = true
    mountPoints            = [{ sourceVolume = "probe-tmp", containerPath = "/tmp", readOnly = false }]
    environment = [
      { name = "LEDGER_URL", value = "http://${local.module_ab.ledger_service_name}:4001" },
      { name = "POLICY_URL", value = "http://${local.module_ab.policy_service_name}:4002" },
      { name = "CHAIN_GATEWAY_URL", value = "http://${local.module_ab.chain_gateway_service_name}:4004" },
      { name = "SIGNER_HOST", value = local.module_ab.signer_service_name },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = local.module_c.cloudwatch_log_group
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "isolation-probe"
      }
    }
  }])
}

resource "aws_ecs_service" "isolation_probe" {
  name            = "${var.name}-isolation-probe"
  cluster         = local.foundation.ecs_cluster_arn
  task_definition = aws_ecs_task_definition.isolation_probe.arn
  desired_count   = 0
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = local.foundation.private_subnet_ids
    security_groups  = [local.module_c.orchestrator_security_group_id]
    assign_public_ip = false
  }
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
}