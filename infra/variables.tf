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

variable "github_oidc_sub_prefix" {
  description = "OIDC sub claim prefix of the GitHub repository allowed to assume the deploy role (immutable owner@id/name@id form)"
  type        = string
  default     = "repo:axiomista@17440089/herding-cats@1423070714"
}

variable "container_port" {
  description = "Port the app listens on"
  type        = number
  default     = 3000
}

variable "sweeps_enabled" {
  description = "Run the startup and timed sweeps; off to save Box AI and API calls"
  type        = bool
  default     = false
}
