output "vpc_id" {
  value = aws_vpc.main.id
}

output "vpc_cidr" {
  value = aws_vpc.main.cidr_block
}

output "private_subnet_ids" {
  description = "Private subnet IDs ordered by Availability Zone."
  value       = [for key in local.foundation_azs : aws_subnet.private[key].id]
}

output "public_subnet_ids" {
  description = "Public subnet IDs ordered by Availability Zone."
  value       = [for key in local.foundation_azs : aws_subnet.public[key].id]
}

output "ecs_cluster_arn" {
  value = aws_ecs_cluster.main.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "cloudmap_namespace_id" {
  value = aws_service_discovery_private_dns_namespace.main.id
}

output "cloudmap_namespace_name" {
  value = aws_service_discovery_private_dns_namespace.main.name
}

output "endpoint_security_group_id" {
  value = aws_security_group.endpoints.id
}

output "cloudwatch_kms_key_arn" {
  value = aws_kms_key.logs.arn
}

output "internal_token_secret_arn" {
  value = aws_secretsmanager_secret.internal_token.arn
}

output "paying_wallet_ssm_arn" {
  value = aws_ssm_parameter.paying_wallet.arn
}

output "alb_logs_bucket" {
  value = aws_s3_bucket.alb_logs.id
}

output "alarm_topic_arn" {
  value = data.terraform_remote_state.bootstrap.outputs.operations_topic_arn
}

output "s3_prefix_list_id" {
  value = data.aws_prefix_list.s3.id
}

output "ecr_repository_urls" {
  value = {
    dashboard    = aws_ecr_repository.services["dashboard"].repository_url
    orchestrator = aws_ecr_repository.services["orchestrator"].repository_url
    ledger       = aws_ecr_repository.services["ledger"].repository_url
    policy       = aws_ecr_repository.services["policy"].repository_url
    signer       = aws_ecr_repository.services["signer"].repository_url
    gateway      = aws_ecr_repository.services["gateway"].repository_url
  }
}