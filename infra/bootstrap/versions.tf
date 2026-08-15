terraform {
  required_version = ">= 1.10, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = [var.target_account_id]

  default_tags {
    tags = merge(var.tags, {
      Environment = "demo"
      ManagedBy   = "Terraform"
      Project     = var.project_name
      Stack       = "bootstrap"
    })
  }
}
