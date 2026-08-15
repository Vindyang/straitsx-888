locals {
  project_kms_key_arn   = "arn:aws:kms:${var.aws_region}:${var.target_account_id}:key/*"
  project_kms_alias_arn = "arn:aws:kms:${var.aws_region}:${var.target_account_id}:alias/${var.project_name}-*"
  operations_topic_arn  = "arn:aws:sns:${var.aws_region}:${var.target_account_id}:${var.project_name}-operations"
  budget_arn            = "arn:aws:budgets::${var.target_account_id}:budget/${var.project_name}-demo-monthly"

  deployer_operations_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "CreateTaggedProjectKeys"
        Effect   = "Allow"
        Action   = ["kms:CreateKey"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestTag/Project" = var.project_name
            "aws:RequestedRegion"    = var.aws_region
          }
        }
      },
      {
        Sid    = "ManageTaggedProjectKeys"
        Effect = "Allow"
        Action = [
          "kms:CancelKeyDeletion",
          "kms:DescribeKey",
          "kms:EnableKeyRotation",
          "kms:GetKeyPolicy",
          "kms:GetKeyRotationStatus",
          "kms:ListResourceTags",
          "kms:PutKeyPolicy",
          "kms:ScheduleKeyDeletion",
          "kms:TagResource",
          "kms:UntagResource",
          "kms:UpdateKeyDescription",
        ]
        Resource = local.project_kms_key_arn
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Project" = var.project_name
            "aws:RequestedRegion"     = var.aws_region
          }
        }
      },
      {
        Sid    = "UseProjectKeysForTerraformState"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:Encrypt",
          "kms:GenerateDataKey",
          "kms:ReEncryptFrom",
          "kms:ReEncryptTo",
        ]
        Resource = local.project_kms_key_arn
        Condition = {
          StringEquals = {
            "aws:ResourceTag/Project" = var.project_name
            "kms:ViaService"          = "s3.${var.aws_region}.amazonaws.com"
          }
        }
      },
      {
        Sid    = "ManageProjectKeyAliases"
        Effect = "Allow"
        Action = [
          "kms:CreateAlias",
          "kms:DeleteAlias",
          "kms:UpdateAlias",
        ]
        Resource = [
          local.project_kms_alias_arn,
          local.project_kms_key_arn,
        ]
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = var.aws_region
          }
        }
      },
      {
        Sid      = "ListKmsMetadata"
        Effect   = "Allow"
        Action   = ["kms:ListAliases", "kms:ListKeys"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "aws:RequestedRegion" = var.aws_region
          }
        }
      },
      {
        Sid    = "ManageAccountTrail"
        Effect = "Allow"
        Action = [
          "cloudtrail:AddTags",
          "cloudtrail:CreateTrail",
          "cloudtrail:DeleteTrail",
          "cloudtrail:GetEventSelectors",
          "cloudtrail:GetInsightSelectors",
          "cloudtrail:GetTrailStatus",
          "cloudtrail:ListTags",
          "cloudtrail:PutEventSelectors",
          "cloudtrail:RemoveTags",
          "cloudtrail:StartLogging",
          "cloudtrail:StopLogging",
          "cloudtrail:UpdateTrail",
        ]
        Resource = local.cloudtrail_arn
      },
      {
        Sid      = "ListTrails"
        Effect   = "Allow"
        Action   = ["cloudtrail:DescribeTrails", "cloudtrail:ListTrails", "cloudtrail:LookupEvents"]
        Resource = "*"
      },
      {
        Sid    = "ManageOperationsTopic"
        Effect = "Allow"
        Action = [
          "sns:CreateTopic",
          "sns:DeleteTopic",
          "sns:GetTopicAttributes",
          "sns:ListSubscriptionsByTopic",
          "sns:ListTagsForResource",
          "sns:SetTopicAttributes",
          "sns:Subscribe",
          "sns:TagResource",
          "sns:Unsubscribe",
          "sns:UntagResource",
        ]
        Resource = local.operations_topic_arn
      },
      {
        Sid    = "ManageDemoBudget"
        Effect = "Allow"
        Action = [
          "budgets:CreateBudget",
          "budgets:DeleteBudget",
          "budgets:DescribeBudget",
          "budgets:ModifyBudget",
          "budgets:ViewBudget",
        ]
        Resource = local.budget_arn
      },
    ]
  })
}

resource "aws_iam_policy" "deployer_operations" {
  name        = "${var.project_name}-deployer-operations"
  description = "Bounded audit, alerting, budget, and tagged KMS permissions"
  policy      = local.deployer_operations_policy
}

resource "aws_iam_role_policy_attachment" "deployer_operations" {
  role       = aws_iam_role.deployer.name
  policy_arn = aws_iam_policy.deployer_operations.arn
}
