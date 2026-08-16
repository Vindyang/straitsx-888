# Remote state in the bootstrap-owned bucket with S3 native locking.
# The bucket name is deterministic: <project>-<account>-<region>-tfstate.
terraform {
  backend "s3" {
    bucket       = "straitsx-888-808198486011-ap-southeast-1-tfstate"
    key          = "foundation/terraform.tfstate"
    region       = "ap-southeast-1"
    encrypt      = true
    use_lockfile = true
  }
}