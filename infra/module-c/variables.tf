variable "name" {
  type    = string
  default = "straitsx-module-c"
}
variable "aws_region" {
  type = string
}
variable "vpc_id" {
  type = string
}
variable "vpc_cidr" {
  type = string
}
variable "private_subnet_ids" {
  type = list(string)
  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Use at least two private subnets in distinct Availability Zones."
  }
}
variable "public_subnet_ids" {
  type = list(string)
  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "Use at least two public subnets in distinct Availability Zones."
  }
}
variable "ecs_cluster_arn" {
  type = string
}
variable "cloudmap_namespace_id" {
  type = string
}
variable "cloudmap_namespace_name" {
  type = string
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
  type = string
}
variable "ledger_security_group_id" {
  type = string
}
variable "policy_security_group_id" {
  type = string
}
variable "chain_gateway_security_group_id" {
  type = string
}
variable "signer_security_group_id" {
  type = string
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
variable "signer_service_name" {
  type = string
}
variable "internal_token_secret_arn" {
  type = string
}
variable "paying_wallet_ssm_arn" {
  type = string
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
variable "cloudwatch_kms_key_arn" { type = string }
variable "alb_access_logs_bucket" { type = string }
variable "alarm_topic_arn" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}
