variable "name" {
  type    = string
  default = "straitsx-module-c"
}

variable "aws_region" {
  type    = string
  default = "ap-southeast-1"
}

variable "tags" {
  type    = map(string)
  default = {}
}