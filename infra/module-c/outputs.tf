output "dashboard_url" {
  value = "https://${aws_lb.dashboard.dns_name}"
}
output "orchestrator_security_group_id" {
  value = aws_security_group.orchestrator.id
}
output "isolation_probe_task_definition_arn" {
  value = aws_ecs_task_definition.isolation_probe.arn
}
output "cloudwatch_log_group" {
  value = aws_cloudwatch_log_group.module_c.name
}
