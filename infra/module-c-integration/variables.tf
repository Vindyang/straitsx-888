variable "name" {
  type    = string
  default = "straitsx-module-c"
}

variable "aws_region" { type = string }
variable "execution_role_arn" { type = string }
variable "task_role_arn" { type = string }
variable "cloudwatch_log_group" { type = string }

variable "orchestrator_image" {
  type = string
  validation {
    condition     = strcontains(var.orchestrator_image, "@sha256:")
    error_message = "Pin orchestrator_image by immutable sha256 digest."
  }
}

variable "ledger_service_name" { type = string }
variable "policy_service_name" { type = string }
variable "chain_gateway_service_name" { type = string }

variable "tags" {
  type    = map(string)
  default = {}
}
