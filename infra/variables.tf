variable "region" {
  description = "AWS region; closest to Seattle"
  type        = string
  default     = "us-west-2"
}

variable "app_name" {
  description = "Name used for the service, repository, secret and log group"
  type        = string
  default     = "herding-cats"
}

variable "image_tag" {
  description = "Image tag to run: the git SHA pushed by deploy.yml"
  type        = string
  default     = "latest"
}

variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to assume the deploy role"
  type        = string
  default     = "axiomista/herding-cats"
}

variable "container_port" {
  description = "Port the app listens on"
  type        = number
  default     = 3000
}
