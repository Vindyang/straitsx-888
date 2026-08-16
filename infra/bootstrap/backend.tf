terraform {
  backend "s3" {
    bucket       = "straitsx-888-808198486011-ap-southeast-1-tfstate"
    key          = "bootstrap/terraform.tfstate"
    region       = "ap-southeast-1"
    use_lockfile = true
  }
}