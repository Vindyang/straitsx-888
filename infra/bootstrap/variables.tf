variable "target_account_id" {
  description = "Only AWS account in which this stack may operate."
  type        = string
  default     = "808198486011"

  validation {
    condition     = var.target_account_id == "808198486011"
    error_message = "The unified demo target is AWS account 808198486011 only."
  }
}

variable "aws_region" {
  description = "Only AWS Region in which regional bootstrap resources may operate."
  type        = string
  default     = "ap-southeast-1"

  validation {
    condition     = var.aws_region == "ap-southeast-1"
    error_message = "The unified demo Region is ap-southeast-1 only."
  }
}

variable "project_name" {
  type    = string
  default = "straitsx-888"
}

variable "bootstrap_user_name" {
  description = "Existing IAM user allowed to bootstrap the MFA deployment role."
  type        = string
  default     = "Straitsx"

  validation {
    condition     = var.bootstrap_user_name == "Straitsx"
    error_message = "Only the existing Straitsx IAM user may bootstrap this deployment role."
  }
}

variable "signing_kms_key_arn" {
  description = "Existing signing-key ARN used only to scope deployment-time metadata reads."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^arn:aws:kms:ap-southeast-1:808198486011:key/[0-9a-f-]{36}$", var.signing_kms_key_arn))
    error_message = "signing_kms_key_arn must identify the existing account-808 key in ap-southeast-1."
  }
}

variable "operator_email" {
  description = "Private operator address for SNS delivery. Supply only from a mode-0600 tfvars file."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true

  validation {
    condition     = var.operator_email == null || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.operator_email))
    error_message = "operator_email must be null or a syntactically valid email address."
  }
}

variable "monthly_budget_usd" {
  type    = number
  default = 25

  validation {
    condition     = var.monthly_budget_usd == 25
    error_message = "The approved demo budget is USD 25 per month."
  }
}

variable "tags" {
  type    = map(string)
  default = {}
}
