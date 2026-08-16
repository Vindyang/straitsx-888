variable "name" {
  type    = string
  default = "straitsx-module-ab"
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "ledger_image" {
  type = string
  validation {
    condition     = strcontains(var.ledger_image, "@sha256:")
    error_message = "Pin ledger_image by immutable sha256 digest."
  }
}

variable "policy_image" {
  type = string
  validation {
    condition     = strcontains(var.policy_image, "@sha256:")
    error_message = "Pin policy_image by immutable sha256 digest."
  }
}

variable "signer_image" {
  type = string
  validation {
    condition     = strcontains(var.signer_image, "@sha256:")
    error_message = "Pin signer_image by immutable sha256 digest."
  }
}

variable "chain_gateway_image" {
  type = string
  validation {
    condition     = strcontains(var.chain_gateway_image, "@sha256:")
    error_message = "Pin chain_gateway_image by immutable sha256 digest."
  }
}

variable "signing_kms_key_arn" {
  description = "Existing account-808 signing key. The signer task's ONLY signing permission targets this key."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^arn:aws:kms:ap-southeast-1:808198486011:key/[0-9a-f-]{36}$", var.signing_kms_key_arn))
    error_message = "signing_kms_key_arn must identify the existing account-808 signing key."
  }
}

variable "expected_signer_address" {
  description = "KMS-derived paying wallet the signer asserts at boot."
  type        = string

  validation {
    condition     = can(regex("^0x[0-9a-fA-F]{40}$", var.expected_signer_address))
    error_message = "expected_signer_address must be a 20-byte 0x-prefixed EVM address."
  }
}

variable "pinned_mandates" {
  description = "JSON map of mandateId -> { settlementRecipient, hardMaxTotal } loaded by the signer at boot."
  type        = string
  default     = "{}"

  validation {
    condition     = can(jsondecode(var.pinned_mandates)) && can(regex("^\\{", var.pinned_mandates))
    error_message = "pinned_mandates must be a JSON object."
  }
}

variable "signer_chain_id" {
  type    = number
  default = 43113
}

variable "chain_ids" {
  type    = string
  default = "43113"
}

variable "rpc_url_43113" {
  type    = string
  default = "https://api.avax-test.network/ext/bc/C/rpc"
}

variable "rpc_url_43114" {
  type    = string
  default = "https://api.avax.network/ext/bc/C/rpc"
}

variable "rpc_timeout_ms" {
  type    = number
  default = 10000
}

variable "tags" {
  type    = map(string)
  default = {}
}