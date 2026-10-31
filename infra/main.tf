# Serverless wallet-scan backend for Seedlab.
# Creates: S3 uploads bucket, DynamoDB jobs table, a single Lambda (API + S3
# trigger), an HTTP API Gateway, and IAM. Frontend builds separately and is
# pointed at the API Gateway URL via VITE_SCAN_API_BASE.
#
# Deploy:
#   cd server && ./build-lambda.sh      # produces ../infra/seedlab-scan.zip
#   cd ../infra && terraform init && terraform apply

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "seedlab"
}

variable "lambda_zip_path" {
  type    = string
  default = "seedlab-scan.zip"
}

variable "lambda_runtime" {
  type    = string
  default = "nodejs22.x"
}

variable "cors_allowed_origin" {
  type        = string
  default     = "*"
  description = "Set to your frontend origin in production, e.g. https://wallets.example.com"
}

data "aws_caller_identity" "current" {}

locals {
  name = var.project
}

resource "aws_dynamodb_table" "jobs" {
  name         = "${local.name}-scan-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"
  attribute {
    name = "jobId"
    type = "S"
  }
  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }
}

resource "aws_s3_bucket" "uploads" {
  bucket = "${local.name}-uploads-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Auto-expire uploaded files so secrets are not retained.
resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    id     = "expire-uploads"
    status = "Enabled"
    expiration {
      days = 1
    }
    filter {
      prefix = "uploads/"
    }
  }
}

resource "aws_iam_role" "lambda" {
  name = "${local.name}-scan-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${local.name}-scan-lambda-policy"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.jobs.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.uploads.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.uploads.arn
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.name}-scan"
  retention_in_days = 7
}

resource "aws_lambda_function" "scan" {
  function_name    = "${local.name}-scan"
  filename         = var.lambda_zip_path
  handler          = "lambda.handler"
  runtime          = var.lambda_runtime
  role             = aws_iam_role.lambda.arn
  timeout          = 900
  memory_size      = 1024
  source_code_hash = filebase64sha256(var.lambda_zip_path)
  environment {
    variables = {
      STORE_MODE     = "dynamo"
      JOBS_TABLE     = aws_dynamodb_table.jobs.name
      UPLOADS_BUCKET = aws_s3_bucket.uploads.id
      AWS_REGION     = var.region
    }
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scan.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.scan.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.uploads.arn
}

resource "aws_apigatewayv2_api" "api" {
  name          = "${local.name}-scan-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = [var.cors_allowed_origin]
    allow_methods = ["POST", "GET", "OPTIONS"]
    allow_headers = ["content-type", "authorization", "*"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.scan.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "api_any" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "ANY /api/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_s3_bucket_notification" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  lambda_function {
    lambda_function_arn = aws_lambda_function.scan.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "uploads/"
  }
  depends_on = [aws_lambda_permission.s3]
}

output "api_url" {
  description = "Base URL for the scan API. Set VITE_SCAN_API_BASE to this."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "uploads_bucket" {
  value = aws_s3_bucket.uploads.id
}

output "jobs_table" {
  value = aws_dynamodb_table.jobs.name
}
