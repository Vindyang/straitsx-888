output "dashboard_url" {
  value = var.enable_cloudfront ? "https://${aws_cloudfront_distribution.dashboard[0].domain_name}" : "https://${aws_lb.dashboard.dns_name}"
}
output "alb_dns_name" {
  value = aws_lb.dashboard.dns_name
}
output "cloudfront_distribution_id" {
  value = var.enable_cloudfront ? aws_cloudfront_distribution.dashboard[0].id : null
}
output "orchestrator_security_group_id" {
  value = aws_security_group.orchestrator.id
}
output "dashboard_security_group_id" {
  value = aws_security_group.dashboard.id
}
output "cloudwatch_log_group" {
  value = aws_cloudwatch_log_group.module_c.name
}
output "execution_role_arn" {
  value = aws_iam_role.execution.arn
}
output "task_role_arn" {
  value = aws_iam_role.task.arn
}
output "private_subnet_ids" {
  value = local.effective_private_subnet_ids
}
output "ecs_cluster_arn" {
  value = local.effective_ecs_cluster_arn
}
output "vpc_id" {
  value = local.effective_vpc_id
}
output "cloudmap_namespace_id" {
  value = local.effective_cloudmap_namespace_id
}
output "alarm_topic_arn" {
  value = local.effective_alarm_topic_arn
}
output "orchestrator_image" {
  value = var.orchestrator_image
}
output "dependency_ingress_handoff" {
  description = "Values the A/B owner uses in their own security-group rules. Module C does not mutate A/B resources."
  value = {
    orchestrator_security_group_id = aws_security_group.orchestrator.id
    dashboard_security_group_id    = aws_security_group.dashboard.id
    required_rules = {
      ledger = {
        port       = 4001
        source_sgs = [aws_security_group.orchestrator.id, aws_security_group.dashboard.id]
      }
      policy = {
        port       = 4002
        source_sgs = [aws_security_group.orchestrator.id, aws_security_group.dashboard.id]
      }
      chain_gateway = {
        port       = 4004
        source_sgs = [aws_security_group.orchestrator.id, aws_security_group.dashboard.id]
      }
    }
  }
}
