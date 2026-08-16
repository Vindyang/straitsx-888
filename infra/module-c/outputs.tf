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
output "starnote_adapter_security_group_id" {
  description = "Security group the StarNote payment adapter Lambda uses inside this VPC"
  value       = aws_security_group.starnote_adapter.id
}
output "dashboard_security_group_id" {
  value = aws_security_group.dashboard.id
}
output "cloudwatch_log_group" {
  value = aws_cloudwatch_log_group.module_c.name
}
output "orchestrator_task_role_arn" {
  value = aws_iam_role.task["orchestrator"].arn
}
output "orchestrator_execution_role_arn" {
  value = aws_iam_role.execution["orchestrator"].arn
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