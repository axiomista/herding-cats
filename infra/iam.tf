data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# Execution role: pulls the image, reads the one secret, writes logs.
resource "aws_iam_role" "execution" {
  name               = "${var.app_name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.env.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secret.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secret" {
  name   = "read-env-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secret.json
}

# Task role: the app needs no AWS permissions at runtime.
resource "aws_iam_role" "task" {
  name               = "${var.app_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

# Infrastructure role: lets ECS Express Mode create the load balancer, target group and scaling.
data "aws_iam_policy_document" "ecs_infra_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "infrastructure" {
  name               = "${var.app_name}-ecs-infrastructure"
  assume_role_policy = data.aws_iam_policy_document.ecs_infra_trust.json
}

resource "aws_iam_role_policy_attachment" "infrastructure_managed" {
  role       = aws_iam_role.infrastructure.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"
}

# GitHub Actions deploy role, assumed through OIDC: no stored keys.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "deploy_trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_oidc_sub_prefix}:environment:production"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.app_name}-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_trust.json
}

# The deploy role pushes images and runs terraform apply on this stack. It gets no IAM write
# actions: any of them (PutRolePolicy, AttachRolePolicy, UpdateAssumeRolePolicy) would let the
# deploy job grant itself, or a role it can pass to a task, AdministratorAccess. A change to the
# roles or policies in this file is therefore applied by an admin, not by deploy.yml; the deploy
# job's apply only needs to read them.
locals {
  stack_role_arns = [
    aws_iam_role.execution.arn,
    aws_iam_role.task.arn,
    aws_iam_role.infrastructure.arn,
  ]
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart", "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.app.arn]
  }
  statement {
    sid = "ManageStack"
    actions = [
      "ecr:*", "ecs:*", "logs:*", "secretsmanager:DescribeSecret", "secretsmanager:GetResourcePolicy",
      "secretsmanager:TagResource", "secretsmanager:UpdateSecret", "kms:Describe*", "kms:Get*", "kms:List*",
      "kms:TagResource", "kms:EnableKeyRotation", "ec2:Describe*", "elasticloadbalancing:Describe*",
      "application-autoscaling:Describe*", "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }
  statement {
    sid       = "ReadIam"
    actions   = ["iam:Get*", "iam:List*"]
    resources = ["*"]
  }
  statement {
    sid       = "TagStackRoles"
    actions   = ["iam:TagRole", "iam:UntagRole"]
    resources = local.stack_role_arns
  }
  # Only the stack's own roles, and only to ECS.
  statement {
    sid       = "PassStackRoles"
    actions   = ["iam:PassRole"]
    resources = local.stack_role_arns
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs.amazonaws.com", "ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "TerraformState"
    actions   = ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::*-tfstate*", "arn:aws:s3:::*-tfstate*/*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
