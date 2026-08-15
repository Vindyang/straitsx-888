data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  foundation_azs = slice(data.aws_availability_zones.available.names, 0, 2)

  effective_vpc_id                 = var.create_foundation ? aws_vpc.module_c[0].id : var.vpc_id
  effective_vpc_cidr               = var.create_foundation ? aws_vpc.module_c[0].cidr_block : var.vpc_cidr
  effective_private_subnet_ids     = var.create_foundation ? values(aws_subnet.private)[*].id : var.private_subnet_ids
  effective_public_subnet_ids      = var.create_foundation ? values(aws_subnet.public)[*].id : var.public_subnet_ids
  effective_ecs_cluster_arn        = var.create_foundation ? aws_ecs_cluster.module_c[0].arn : var.ecs_cluster_arn
  effective_cloudmap_namespace_id  = var.create_foundation ? aws_service_discovery_private_dns_namespace.module_c[0].id : var.cloudmap_namespace_id
  effective_cloudmap_namespace     = var.create_foundation ? aws_service_discovery_private_dns_namespace.module_c[0].name : var.cloudmap_namespace_name
  effective_internal_token_arn     = var.create_foundation ? aws_secretsmanager_secret.internal_token[0].arn : var.internal_token_secret_arn
  effective_paying_wallet_ssm_arn  = var.create_foundation ? aws_ssm_parameter.paying_wallet[0].arn : var.paying_wallet_ssm_arn
  effective_cloudwatch_kms_key_arn = var.create_foundation ? aws_kms_key.logs[0].arn : var.cloudwatch_kms_key_arn
  effective_alb_logs_bucket        = var.create_foundation ? aws_s3_bucket.alb_logs[0].id : var.alb_access_logs_bucket
  effective_alarm_topic_arn        = var.create_foundation ? aws_sns_topic.alarms[0].arn : var.alarm_topic_arn
}

check "platform_inputs" {
  assert {
    condition = var.create_foundation || alltrue([
      var.vpc_id != null,
      var.vpc_cidr != null,
      var.ecs_cluster_arn != null,
      var.cloudmap_namespace_id != null,
      var.cloudmap_namespace_name != null,
      var.internal_token_secret_arn != null,
      var.paying_wallet_ssm_arn != null,
      var.cloudwatch_kms_key_arn != null,
      var.alb_access_logs_bucket != null,
      var.alarm_topic_arn != null,
    ])
    error_message = "Either set create_foundation=true or supply every external platform input."
  }
}

check "routing_mode" {
  assert {
    condition     = var.enable_cloudfront != (var.certificate_arn != null)
    error_message = "Choose exactly one public route: enable_cloudfront=true or supply certificate_arn."
  }
}

resource "aws_vpc" "module_c" {
  count                = var.create_foundation ? 1 : 0
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.name}-vpc" }
}

resource "aws_internet_gateway" "module_c" {
  count  = var.create_foundation ? 1 : 0
  vpc_id = aws_vpc.module_c[0].id
  tags   = { Name = "${var.name}-igw" }
}

resource "aws_subnet" "public" {
  for_each = var.create_foundation ? { for index, az in local.foundation_azs : az => index } : {}

  vpc_id                  = aws_vpc.module_c[0].id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(aws_vpc.module_c[0].cidr_block, 4, each.value)
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${each.key}" }
}

resource "aws_subnet" "private" {
  for_each = var.create_foundation ? { for index, az in local.foundation_azs : az => index } : {}

  vpc_id                  = aws_vpc.module_c[0].id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(aws_vpc.module_c[0].cidr_block, 4, each.value + 8)
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-private-${each.key}" }
}

resource "aws_route_table" "public" {
  count  = var.create_foundation ? 1 : 0
  vpc_id = aws_vpc.module_c[0].id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  count                  = var.create_foundation ? 1 : 0
  route_table_id         = aws_route_table.public[0].id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.module_c[0].id
}

resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_eip" "nat" {
  count  = var.create_foundation ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }

  depends_on = [aws_internet_gateway.module_c]
}

resource "aws_nat_gateway" "module_c" {
  count         = var.create_foundation ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = values(aws_subnet.public)[0].id
  tags          = { Name = "${var.name}-nat" }

  depends_on = [aws_internet_gateway.module_c]
}

resource "aws_route_table" "private" {
  for_each = aws_subnet.private
  vpc_id   = aws_vpc.module_c[0].id
  tags     = { Name = "${var.name}-private-${each.key}" }
}

resource "aws_route" "private_internet" {
  for_each               = aws_route_table.private
  route_table_id         = each.value.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.module_c[0].id
}

resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

resource "aws_security_group" "endpoints" {
  count       = var.create_foundation ? 1 : 0
  name        = "${var.name}-endpoints"
  description = "HTTPS from Module C tasks to private AWS endpoints"
  vpc_id      = aws_vpc.module_c[0].id
  egress      = []
  lifecycle { ignore_changes = [ingress, egress] }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count             = var.create_foundation ? 1 : 0
  security_group_id = aws_security_group.endpoints[0].id
  cidr_ipv4         = aws_vpc.module_c[0].cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each = var.create_foundation ? toset([
    "ecr.api",
    "ecr.dkr",
    "logs",
    "secretsmanager",
    "ssm",
    "kms",
  ]) : toset([])

  vpc_id              = aws_vpc.module_c[0].id
  service_name        = "com.amazonaws.${var.aws_region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = values(aws_subnet.private)[*].id
  security_group_ids  = [aws_security_group.endpoints[0].id]
  tags                = { Name = "${var.name}-${replace(each.value, ".", "-")}" }
}

resource "aws_vpc_endpoint" "s3" {
  count             = var.create_foundation ? 1 : 0
  vpc_id            = aws_vpc.module_c[0].id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = values(aws_route_table.private)[*].id
  tags              = { Name = "${var.name}-s3" }
}

resource "aws_ecs_cluster" "module_c" {
  count = var.create_foundation ? 1 : 0
  name  = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "module_c" {
  count              = var.create_foundation ? 1 : 0
  cluster_name       = aws_ecs_cluster.module_c[0].name
  capacity_providers = ["FARGATE"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_service_discovery_private_dns_namespace" "module_c" {
  count       = var.create_foundation ? 1 : 0
  name        = "internal"
  description = "Private service contracts for StraitsX modules"
  vpc         = aws_vpc.module_c[0].id
}

data "aws_iam_policy_document" "logs_kms" {
  count = var.create_foundation ? 1 : 0

  statement {
    sid     = "AccountAdministration"
    effect  = "Allow"
    actions = ["kms:*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
    resources = ["*"]
  }

  statement {
    sid    = "CloudWatchLogsEncryption"
    effect = "Allow"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }
    resources = ["*"]
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:${data.aws_partition.current.partition}:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:*"]
    }
  }
}

resource "aws_kms_key" "logs" {
  count                   = var.create_foundation ? 1 : 0
  description             = "Module C CloudWatch Logs encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.logs_kms[0].json
}

resource "aws_kms_alias" "logs" {
  count         = var.create_foundation ? 1 : 0
  name          = "alias/${var.name}-logs"
  target_key_id = aws_kms_key.logs[0].key_id
}

resource "random_password" "internal_token" {
  count   = var.create_foundation ? 1 : 0
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "internal_token" {
  count                   = var.create_foundation ? 1 : 0
  name                    = "/${var.name}/internal-token"
  description             = "Shared internal service token for Module C"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "internal_token" {
  count         = var.create_foundation ? 1 : 0
  secret_id     = aws_secretsmanager_secret.internal_token[0].id
  secret_string = random_password.internal_token[0].result
}

resource "aws_ssm_parameter" "paying_wallet" {
  count = var.create_foundation ? 1 : 0
  name  = "/${var.name}/paying-wallet"
  type  = "String"
  value = var.paying_wallet_address
}

resource "aws_s3_bucket" "alb_logs" {
  count  = var.create_foundation ? 1 : 0
  bucket = substr("${var.name}-${data.aws_caller_identity.current.account_id}-${var.aws_region}-alb-logs", 0, 63)
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  count                   = var.create_foundation ? 1 : 0
  bucket                  = aws_s3_bucket.alb_logs[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "alb_logs" {
  count  = var.create_foundation ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  count  = var.create_foundation ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  rule {
    id     = "expire-alb-logs"
    status = "Enabled"
    filter {}
    expiration { days = 90 }
  }
}

data "aws_iam_policy_document" "alb_logs" {
  count = var.create_foundation ? 1 : 0

  statement {
    sid     = "AllowALBLogDelivery"
    effect  = "Allow"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.alb_logs[0].arn}/${var.name}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
    ]
    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
  }

  statement {
    sid       = "AllowALBLogDeliveryAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.alb_logs[0].arn]
    principals {
      type        = "Service"
      identifiers = ["logdelivery.elasticloadbalancing.amazonaws.com"]
    }
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  count  = var.create_foundation ? 1 : 0
  bucket = aws_s3_bucket.alb_logs[0].id
  policy = data.aws_iam_policy_document.alb_logs[0].json
}

resource "aws_sns_topic" "alarms" {
  count             = var.create_foundation ? 1 : 0
  name              = "${var.name}-alarms"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "alarm_email" {
  count     = var.create_foundation && var.alarm_email != null ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}
