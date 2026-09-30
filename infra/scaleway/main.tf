terraform {
  backend "local" {}
  required_version = ">= 1.8.0, < 2.0.0"
  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "2.83.1"
    }
  }
}

provider "scaleway" {
  region          = var.region
  organization_id = var.organization_id == "" ? null : var.organization_id
}

resource "scaleway_account_project" "app" {
  count           = var.create_project ? 1 : 0
  name            = var.project_name
  organization_id = var.organization_id
}

resource "scaleway_container_namespace" "app" {
  name       = var.container_name
  project_id = var.create_project ? scaleway_account_project.app[0].id : var.project_id
  region     = var.region
  lifecycle {
    precondition {
      condition     = var.create_project ? (var.project_id == "" && var.organization_id != "") : var.project_id != ""
      error_message = "Choose an existing project ID or explicitly create a project in an organization."
    }
  }
}

resource "scaleway_container" "app" {
  name                   = var.container_name
  namespace_id           = scaleway_container_namespace.app.id
  image                  = var.image
  port                   = var.port
  privacy                = "public"
  protocol               = "http1"
  https_connections_only = true
  cpu_limit              = var.cpu_limit
  memory_limit_bytes     = var.memory_limit * 1000000
  min_scale              = var.min_scale
  max_scale              = var.max_scale
  timeout                = tonumber(var.application_environment.REDIRECTORY_REQUEST_TIMEOUT_SECONDS)
  environment_variables  = var.application_environment
  command                = ["node", "scripts/container.mjs", "--bootstrap"]
  args                   = []
  startup_probe {
    tcp               = true
    failure_threshold = 30
    interval          = "5s"
    timeout           = "3s"
  }
  lifecycle {
    ignore_changes = [secret_environment_variables, command]
    precondition {
      condition     = var.min_scale >= 0 && var.max_scale >= 1 && var.min_scale <= var.max_scale
      error_message = "Invalid scaling limits."
    }
  }
}

output "container_id" { value = scaleway_container.app.id }
output "endpoint" { value = scaleway_container.app.public_endpoint }
output "project_id" { value = scaleway_container_namespace.app.project_id }
