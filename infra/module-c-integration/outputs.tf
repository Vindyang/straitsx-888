output "isolation_probe_task_definition_arn" {
  value = aws_ecs_task_definition.isolation_probe.arn
}

output "isolation_probe_service_name" {
  value = aws_ecs_service.isolation_probe.name
}