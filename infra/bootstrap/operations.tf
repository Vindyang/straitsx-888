resource "aws_sns_topic" "operations" {
  name              = "${var.project_name}-operations"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_policy" "operations" {
  arn = aws_sns_topic.operations.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.target_account_id}:root" }
        Action = [
          "sns:Publish",
          "sns:Subscribe",
          "sns:GetTopicAttributes",
          "sns:SetTopicAttributes",
        ]
        Resource = aws_sns_topic.operations.arn
      },
      {
        Sid    = "AllowOperationalAWSServicePublishers"
        Effect = "Allow"
        Principal = {
          Service = [
            "budgets.amazonaws.com",
            "cloudwatch.amazonaws.com",
            "events.amazonaws.com",
          ]
        }
        Action   = "sns:Publish"
        Resource = aws_sns_topic.operations.arn
        Condition = {
          StringEquals = {
            "aws:SourceAccount" = var.target_account_id
          }
        }
      },
    ]
  })
}

resource "aws_sns_topic_subscription" "operator_email" {
  count = var.operator_email == null ? 0 : 1

  topic_arn = aws_sns_topic.operations.arn
  protocol  = "email"
  endpoint  = var.operator_email
}

resource "aws_budgets_budget" "demo" {
  name         = "${var.project_name}-demo-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.operations.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.operations.arn]
  }

  depends_on = [aws_sns_topic_policy.operations]
}
