output "state_bucket_name" {
  value = aws_s3_bucket.terraform_state.id
}

output "state_kms_key_arn" {
  value = aws_kms_key.terraform_state.arn
}

output "deployment_role_arn" {
  value = aws_iam_role.deployer.arn
}

output "deployment_identity_policy_arn" {
  value = aws_iam_policy.deployer.arn
}

output "cloudtrail_name" {
  value = aws_cloudtrail.account.name
}

output "cloudtrail_bucket_name" {
  value = aws_s3_bucket.cloudtrail.id
}

output "operations_topic_arn" {
  value = aws_sns_topic.operations.arn
}

output "budget_name" {
  value = aws_budgets_budget.demo.name
}
