variable "name" {
  type    = string
  default = "straitsx-module-c"
}
variable "aws_region" {
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
variable "tags" {
  type    = map(string)
  default = {}
}