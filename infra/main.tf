data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  image      = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"

  # Every variable in the spec's Auth and security table, read from the one secret.
  secret_keys = [
    "BOX_CLIENT_ID", "BOX_CLIENT_SECRET", "BOX_ENTERPRISE_ID",
    "BOX_SCAN_FOLDER_ID", "BOX_AUDIT_FOLDER_ID",
    "BOX_WEBHOOK_PRIMARY_KEY", "BOX_WEBHOOK_SECONDARY_KEY",
    "MODE", "SWEEP_INTERVAL_MINUTES", "ORG_NAME",
    "DEMO_PASSCODE", "SESSION_SECRET",
  ]
}

# ECR: images tagged with the git SHA; keep the last 10.
resource "aws_ecr_repository" "app" {
  name                 = var.app_name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 10 }
      action       = { type = "expire" }
    }]
  })
}

# One secret holding every app variable as JSON. Terraform creates the container only; the values
# are set by hand in the console so they never enter Terraform state.
resource "aws_kms_key" "secret" {
  description         = "Encrypts the ${var.app_name}/env secret"
  enable_key_rotation = true
}

resource "aws_kms_alias" "secret" {
  name          = "alias/${var.app_name}-env"
  target_key_id = aws_kms_key.secret.key_id
}

resource "aws_secretsmanager_secret" "env" {
  name        = "${var.app_name}/env"
  description = "Environment for the ${var.app_name} service - values set by hand"
  kms_key_id  = aws_kms_key.secret.arn
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.app_name}"
  retention_in_days = 14
}

# One always-on task: scan state is in memory, so a second task would not see the first one's scans.
resource "aws_ecs_express_gateway_service" "app" {
  service_name            = var.app_name
  execution_role_arn      = aws_iam_role.execution.arn
  infrastructure_role_arn = aws_iam_role.infrastructure.arn
  task_role_arn           = aws_iam_role.task.arn
  # 0.25 vCPU, the smallest Fargate size; Box AI does the heavy work remotely.
  cpu                   = "256"
  memory                = "1024"
  health_check_path     = "/healthz"
  wait_for_steady_state = true

  scaling_target = [{
    auto_scaling_metric       = "AVERAGE_CPU"
    auto_scaling_target_value = 70
    min_task_count            = 1
    max_task_count            = 1
  }]

  primary_container {
    image          = local.image
    container_port = var.container_port

    aws_logs_configuration = [{
      log_group         = aws_cloudwatch_log_group.app.name
      log_stream_prefix = var.app_name
    }]

    environment {
      name  = "PORT"
      value = tostring(var.container_port)
    }

    environment {
      name  = "SWEEPS_ENABLED"
      value = tostring(var.sweeps_enabled)
    }

    dynamic "secret" {
      # Sorted, as ECS returns them, so plans show no reordering diff.
      for_each = sort(local.secret_keys)
      content {
        name       = secret.value
        value_from = "${aws_secretsmanager_secret.env.arn}:${secret.value}::"
      }
    }
  }
}
