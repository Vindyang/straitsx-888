locals {
  project_role_arn              = "arn:aws:iam::${var.target_account_id}:role/${var.project_name}-*"
  project_policy_arn            = "arn:aws:iam::${var.target_account_id}:policy/${var.project_name}-*"
  bootstrap_user_arn            = "arn:aws:iam::${var.target_account_id}:user/${var.bootstrap_user_name}"
  bootstrap_assume_policy_name  = "${var.project_name}-bootstrap-assume-deployer"
  bootstrap_assume_policy_arn   = "arn:aws:iam::${var.target_account_id}:policy/${local.bootstrap_assume_policy_name}"
  bootstrap_deployment_role_arn = "arn:aws:iam::${var.target_account_id}:role/${local.deployment_role_name}"

  deployer_identity_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadCallerIdentity"
        Effect   = "Allow"
        Action   = ["sts:GetCallerIdentity"]
        Resource = "*"
      },
      {
        Sid    = "ManageProjectRoles"
        Effect = "Allow"
        Action = [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListRolePolicies",
          "iam:PutRolePolicy",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
        ]
        Resource = local.project_role_arn
      },
      {
        Sid    = "ManageProjectPolicies"
        Effect = "Allow"
        Action = [
          "iam:CreatePolicy",
          "iam:CreatePolicyVersion",
          "iam:DeletePolicy",
          "iam:DeletePolicyVersion",
          "iam:GetPolicy",
          "iam:GetPolicyVersion",
          "iam:ListPolicyVersions",
          "iam:SetDefaultPolicyVersion",
          "iam:TagPolicy",
          "iam:UntagPolicy",
        ]
        Resource = local.project_policy_arn
      },
      {
        Sid      = "PassProjectRolesToECSTasksOnly"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = local.project_role_arn
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid      = "ReadExistingSigningKeyMetadata"
        Effect   = "Allow"
        Action   = ["kms:DescribeKey", "kms:GetPublicKey"]
        Resource = var.signing_kms_key_arn
      },
      {
        Sid      = "ReadApprovedBootstrapUser"
        Effect   = "Allow"
        Action   = ["iam:GetUser", "iam:ListAttachedUserPolicies"]
        Resource = local.bootstrap_user_arn
      },
      {
        Sid      = "MaintainBootstrapAssumePolicyOnly"
        Effect   = "Allow"
        Action   = ["iam:AttachUserPolicy", "iam:DetachUserPolicy"]
        Resource = local.bootstrap_user_arn
        Condition = {
          ArnEquals = {
            "iam:PolicyARN" = local.bootstrap_assume_policy_arn
          }
        }
      },
      {
        Sid      = "CreateRequiredServiceLinkedRoles"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole"]
        Resource = "arn:aws:iam::*:role/aws-service-role/*"
        Condition = {
          StringEquals = {
            "iam:AWSServiceName" = [
              "application-autoscaling.amazonaws.com",
              "ecs.amazonaws.com",
              "elasticloadbalancing.amazonaws.com",
            ]
          }
        }
      },
    ]
  })
}

resource "aws_iam_policy" "bootstrap_assume_deployer" {
  name        = local.bootstrap_assume_policy_name
  description = "Permit the approved bootstrap user to assume the deployment role only with MFA"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AssumeDeploymentRoleWithMFA"
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = local.bootstrap_deployment_role_arn
      Condition = {
        Bool = {
          "aws:MultiFactorAuthPresent" = "true"
        }
      }
    }]
  })
}

resource "aws_iam_user_policy_attachment" "bootstrap_assume_deployer" {
  user       = var.bootstrap_user_name
  policy_arn = aws_iam_policy.bootstrap_assume_deployer.arn
}

resource "aws_iam_policy" "deployer" {
  name        = "${var.project_name}-deployer-identity"
  description = "Bounded IAM and signing-key metadata permissions for StraitsX deployment"
  policy      = local.deployer_identity_policy
}

resource "aws_iam_role_policy_attachment" "deployer" {
  role       = aws_iam_role.deployer.name
  policy_arn = aws_iam_policy.deployer.arn
}
