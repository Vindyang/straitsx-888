output "ledger_security_group_id" {
  value = aws_security_group.ledger.id
}
output "policy_security_group_id" {
  value = aws_security_group.policy.id
}
output "signer_security_group_id" {
  value = aws_security_group.signer.id
}
output "chain_gateway_security_group_id" {
  value = aws_security_group.gateway.id
}
output "ledger_service_name" {
  value = "ledger.internal"
}
output "policy_service_name" {
  value = "policy.internal"
}
output "signer_service_name" {
  value = "signer.internal"
}
output "chain_gateway_service_name" {
  value = "chain-gateway.internal"
}
output "signer_cloudmap_service_id" {
  value = aws_service_discovery_service.services["signer"].id
}
output "task_definition_arns" {
  value = {
    ledger  = aws_ecs_task_definition.ledger.arn
    policy  = aws_ecs_task_definition.policy.arn
    signer  = aws_ecs_task_definition.signer.arn
    gateway = aws_ecs_task_definition.gateway.arn
  }
}