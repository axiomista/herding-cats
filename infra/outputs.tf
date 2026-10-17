output "service_url" {
  description = "Public HTTPS URL of the service"
  # Express Mode returns the endpoint with its scheme; add one only if it is missing.
  value = startswith(aws_ecs_express_gateway_service.app.ingress_paths[0].endpoint, "https://") ? aws_ecs_express_gateway_service.app.ingress_paths[0].endpoint : "https://${aws_ecs_express_gateway_service.app.ingress_paths[0].endpoint}"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "secret_arn" {
  description = "Set the secret's JSON value by hand in the console"
  value       = aws_secretsmanager_secret.env.arn
}

output "deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN repository variable"
  value       = aws_iam_role.deploy.arn
}
