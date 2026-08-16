mock_provider "aws" {
  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::808198486011:policy/mock-policy"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-southeast-1:808198486011:mock-operations"
    }
  }
}

variables {
  signing_kms_key_arn = "arn:aws:kms:ap-southeast-1:808198486011:key/00000000-0000-4000-8000-000000000000"
}

run "state_storage_is_private_versioned_and_encrypted" {
  command = apply

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.terraform_state.block_public_acls,
      aws_s3_bucket_public_access_block.terraform_state.block_public_policy,
      aws_s3_bucket_public_access_block.terraform_state.ignore_public_acls,
      aws_s3_bucket_public_access_block.terraform_state.restrict_public_buckets,
    ])
    error_message = "Terraform state must block every form of public S3 access."
  }

  assert {
    condition     = aws_s3_bucket_versioning.terraform_state.versioning_configuration[0].status == "Enabled"
    error_message = "Terraform state must retain version history."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.terraform_state.rule).apply_server_side_encryption_by_default).sse_algorithm == "aws:kms"
    error_message = "Terraform state must use KMS encryption."
  }

  assert {
    condition     = strcontains(aws_s3_bucket_policy.terraform_state.policy, "aws:SecureTransport")
    error_message = "Terraform state bucket policy must deny non-TLS requests."
  }
}

run "deployment_role_requires_mfa" {
  command = apply

  assert {
    condition     = strcontains(aws_iam_role.deployer.assume_role_policy, "arn:aws:iam::808198486011:user/Straitsx")
    error_message = "Only the approved Straitsx bootstrap user may assume the deployment role."
  }

  assert {
    condition     = strcontains(aws_iam_role.deployer.assume_role_policy, "aws:MultiFactorAuthPresent")
    error_message = "The deployment-role trust policy must require MFA."
  }

  assert {
    condition     = aws_iam_role.deployer.max_session_duration == 3600
    error_message = "Deployment sessions must expire after one hour."
  }
}

run "deployment_policy_is_bounded" {
  command = apply

  assert {
    condition     = !strcontains(aws_iam_policy.deployer.policy, "\"Action\":\"*\"")
    error_message = "The deployment policy must not grant wildcard actions."
  }

  assert {
    condition     = strcontains(aws_iam_policy.deployer.policy, "iam:PassedToService")
    error_message = "PassRole must be conditioned on the destination AWS service."
  }

  assert {
    condition     = strcontains(aws_iam_policy.deployer.policy, "ecs-tasks.amazonaws.com")
    error_message = "The deployment role may pass workload roles only to ECS tasks."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.deployer.role == aws_iam_role.deployer.name
    error_message = "The bounded deployment policy must be attached to the deployment role."
  }
}

run "platform_policy_uses_concrete_actions" {
  command = apply

  assert {
    condition     = length(aws_iam_policy.deployer_platform.policy) <= 6144
    error_message = "The platform managed policy must fit AWS's 6,144-character limit."
  }

  assert {
    condition     = !strcontains(aws_iam_policy.deployer_platform.policy, "\"Action\":\"*\"")
    error_message = "The platform deployment policy must not grant wildcard actions."
  }

  assert {
    condition = alltrue([
      strcontains(aws_iam_policy.deployer_platform.policy, "ec2:CreateVpc"),
      strcontains(aws_iam_policy.deployer_platform.policy, "ecs:CreateService"),
      strcontains(aws_iam_policy.deployer_platform.policy, "ecr:CreateRepository"),
      strcontains(aws_iam_policy.deployer_platform.policy, "elasticloadbalancing:CreateLoadBalancer"),
      strcontains(aws_iam_policy.deployer_platform.policy, "servicediscovery:CreatePrivateDnsNamespace"),
    ])
    error_message = "The deployment policy must contain the concrete shared-platform and workload actions."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.deployer_platform.role == aws_iam_role.deployer.name
    error_message = "The platform policy must be attached to the deployment role."
  }
}

run "cloudtrail_is_durable_and_multi_region" {
  command = apply

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.cloudtrail.block_public_acls,
      aws_s3_bucket_public_access_block.cloudtrail.block_public_policy,
      aws_s3_bucket_public_access_block.cloudtrail.ignore_public_acls,
      aws_s3_bucket_public_access_block.cloudtrail.restrict_public_buckets,
    ])
    error_message = "CloudTrail storage must block every form of public S3 access."
  }

  assert {
    condition     = aws_s3_bucket_versioning.cloudtrail.versioning_configuration[0].status == "Enabled"
    error_message = "CloudTrail storage must be versioned."
  }

  assert {
    condition = alltrue([
      aws_cloudtrail.account.is_multi_region_trail,
      aws_cloudtrail.account.include_global_service_events,
      aws_cloudtrail.account.enable_log_file_validation,
    ])
    error_message = "CloudTrail must record global/multi-Region management activity with validation."
  }
}

run "operations_topic_and_budget_are_actionable" {
  command = apply

  assert {
    condition     = aws_sns_topic.operations.kms_master_key_id == "alias/aws/sns"
    error_message = "The operations topic must use SNS-managed encryption."
  }

  assert {
    condition = alltrue([
      strcontains(aws_sns_topic_policy.operations.policy, "budgets.amazonaws.com"),
      strcontains(aws_sns_topic_policy.operations.policy, "cloudwatch.amazonaws.com"),
      strcontains(aws_sns_topic_policy.operations.policy, "events.amazonaws.com"),
    ])
    error_message = "Budget, CloudWatch, and EventBridge must be allowed to publish operational alerts."
  }

  assert {
    condition = (
      aws_budgets_budget.demo.limit_amount == "25" &&
      aws_budgets_budget.demo.limit_unit == "USD" &&
      aws_budgets_budget.demo.time_unit == "MONTHLY"
    )
    error_message = "The demo budget must be USD 25 per month."
  }

  assert {
    condition = one([
      for notification in aws_budgets_budget.demo.notification : notification.threshold
      if notification.notification_type == "ACTUAL"
    ]) == 80
    error_message = "Actual spend must alert at 80 percent."
  }

  assert {
    condition = one([
      for notification in aws_budgets_budget.demo.notification : notification.threshold
      if notification.notification_type == "FORECASTED"
    ]) == 100
    error_message = "Forecast spend must alert at 100 percent."
  }
}

run "bootstrap_user_can_only_assume_deployer_with_mfa" {
  command = apply

  assert {
    condition = alltrue([
      strcontains(aws_iam_policy.bootstrap_assume_deployer.policy, "sts:AssumeRole"),
      strcontains(aws_iam_policy.bootstrap_assume_deployer.policy, "aws:MultiFactorAuthPresent"),
      strcontains(aws_iam_policy.bootstrap_assume_deployer.policy, "straitsx-888-deployer"),
      !strcontains(aws_iam_policy.bootstrap_assume_deployer.policy, "\"Action\":\"*\""),
    ])
    error_message = "The bootstrap-user policy must grant only MFA-conditioned deployment-role assumption."
  }

  assert {
    condition     = aws_iam_user_policy_attachment.bootstrap_assume_deployer.user == "Straitsx"
    error_message = "The assume-role policy must attach only to the approved Straitsx user."
  }
}

run "operations_policy_is_bounded" {
  command = apply

  assert {
    condition = (
      length(aws_iam_policy.deployer_operations.policy) <= 6144 &&
      !strcontains(aws_iam_policy.deployer_operations.policy, "\"Action\":\"*\"")
    )
    error_message = "The operations policy must fit AWS limits and contain no wildcard action."
  }

  assert {
    condition = alltrue([
      strcontains(aws_iam_policy.deployer_operations.policy, "cloudtrail:CreateTrail"),
      strcontains(aws_iam_policy.deployer_operations.policy, "budgets:ModifyBudget"),
      strcontains(aws_iam_policy.deployer_operations.policy, "sns:CreateTopic"),
      strcontains(aws_iam_policy.deployer_operations.policy, "kms:CreateKey"),
      strcontains(aws_iam_policy.deployer_operations.policy, "aws:RequestTag/Project"),
    ])
    error_message = "The operations policy must grant concrete audit/cost actions and tag-bound KMS creation."
  }

  assert {
    condition     = aws_iam_role_policy_attachment.deployer_operations.role == aws_iam_role.deployer.name
    error_message = "The bounded operations policy must be attached to the deployment role."
  }
}
