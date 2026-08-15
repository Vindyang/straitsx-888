variable "name" {
  type    = string
  default = "straitsx-module-c"
}
variable "aws_region" {
  type = string
}
variable "create_foundation" {
  description = "Create the Module C VPC, subnets, endpoints, ECS/Cloud Map, secrets, logging, and alarm prerequisites."
  type        = bool
  default     = false
}
variable "vpc_id" {
  type     = string
  default  = null
  nullable = true
}
variable "vpc_cidr" {
  type     = string
  default  = null
  nullable = true
}
variable "private_subnet_ids" {
  type    = list(string)
  default = []
  validation {
    condition     = var.create_foundation || length(var.private_subnet_ids) >= 2
    error_message = "Use at least two private subnets in distinct Availability Zones."
  }
}
variable "public_subnet_ids" {
  type    = list(string)
  default = []
  validation {
    condition     = var.create_foundation || length(var.public_subnet_ids) >= 2
    error_message = "Use at least two public subnets in distinct Availability Zones."
  }
}
variable "ecs_cluster_arn" {
  type     = string
  default  = null
  nullable = true
}
variable "cloudmap_namespace_id" {
  type     = string
  default  = null
  nullable = true
}
variable "cloudmap_namespace_name" {
  type     = string
  default  = null
  nullable = true
}
variable "dashboard_image" {
  type = string
  validation {
    condition     = strcontains(var.dashboard_image, "@sha256:")
    error_message = "Pin dashboard_image by immutable sha256 digest."
  }
}
variable "orchestrator_image" {
  type = string
  validation {
    condition     = strcontains(var.orchestrator_image, "@sha256:")
    error_message = "Pin orchestrator_image by immutable sha256 digest."
  }
}
variable "fixture_image" {
  type = string
  validation {
    condition     = strcontains(var.fixture_image, "@sha256:")
    error_message = "Pin fixture_image by immutable sha256 digest."
  }
}
variable "certificate_arn" {
  description = "ACM certificate for direct ALB HTTPS. Leave null when CloudFront routing is enabled."
  type        = string
  default     = null
  nullable    = true
}
variable "enable_cloudfront" {
  description = "Expose the dashboard through an AWS-managed CloudFront HTTPS hostname."
  type        = bool
  default     = false
}
variable "alb_deletion_protection" {
  type    = bool
  default = true
}
variable "ledger_service_name" {
  type = string
}
variable "policy_service_name" {
  type = string
}
variable "chain_gateway_service_name" {
  type = string
}
variable "internal_token_secret_arn" {
  type     = string
  default  = null
  nullable = true
}
variable "paying_wallet_ssm_arn" {
  type     = string
  default  = null
  nullable = true
}
variable "paying_wallet_address" {
  description = "Wallet address stored in SSM when create_foundation is true. Replace before live A/B integration."
  type        = string
  default     = "0x0000000000000000000000000000000000000000"
  validation {
    condition     = can(regex("^0x[0-9a-fA-F]{40}$", var.paying_wallet_address))
    error_message = "paying_wallet_address must be a 20-byte 0x-prefixed EVM address."
  }
}
variable "alarm_email" {
  description = "Optional email endpoint. AWS keeps it pending until the recipient confirms the subscription."
  type        = string
  default     = null
  nullable    = true
}
variable "https_egress_cidrs" {
  description = "Resolved CIDRs for the configured StraitsX endpoints and approved merchant only."
  type        = list(string)
  validation {
    condition     = alltrue([for cidr in var.https_egress_cidrs : cidr != "0.0.0.0/0"])
    error_message = "HTTPS egress must name resolved StraitsX/merchant CIDRs; 0.0.0.0/0 is forbidden."
  }
}
variable "task_cpu" {
  type    = number
  default = 512
}
variable "task_memory" {
  type    = number
  default = 1024
}
variable "dashboard_desired_count" {
  type    = number
  default = 2
}
variable "service_max_count" {
  type    = number
  default = 6
}
variable "cloudwatch_kms_key_arn" {
  type     = string
  default  = null
  nullable = true
}
variable "alb_access_logs_bucket" {
  type     = string
  default  = null
  nullable = true
}
variable "alarm_topic_arn" {
  type     = string
  default  = null
  nullable = true
}
variable "tags" {
  type    = map(string)
  default = {}
}
