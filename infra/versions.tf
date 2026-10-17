terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
  }

  # The state bucket is created once by hand; pass it at init:
  #   terraform init -backend-config="bucket=<state bucket>"
  backend "s3" {
    key          = "herding-cats/terraform.tfstate"
    region       = "us-west-2"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project = "herding-cats"
    }
  }
}
