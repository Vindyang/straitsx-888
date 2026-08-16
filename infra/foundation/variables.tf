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
  description = "Only AWS Region in which this stack may operate."
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

variable "vpc_cidr" {
  description = "Shared demo VPC CIDR."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }
}

variable "paying_wallet_address" {
  description = "Paying-wallet address exposed through SSM. Supplied privately; never committed."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^0x[0-9a-fA-F]{40}$", var.paying_wallet_address))
    error_message = "paying_wallet_address must be a 20-byte 0x-prefixed EVM address."
  }
}

variable "logs_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}