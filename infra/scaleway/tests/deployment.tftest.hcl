mock_provider "scaleway" {
  mock_resource "scaleway_account_project" {
    defaults = { id = "00000000-0000-4000-8000-000000000003" }
  }
}

variables {
  project_id = "00000000-0000-4000-8000-000000000001"
  image      = "ghcr.io/example/redirectory@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  application_environment = {
    REDIRECTORY_GITHUB_REPOSITORY       = "example/packages"
    REDIRECTORY_ANONYMOUS_READ          = "true"
    REDIRECTORY_MAX_UPLOAD_BYTES        = "1073741824"
    REDIRECTORY_REQUEST_TIMEOUT_SECONDS = "300"
  }
}

run "existing_project" {
  command = plan
  assert {
    condition     = length(scaleway_account_project.app) == 0
    error_message = "An existing project must not be owned by this stack."
  }
  assert {
    condition     = scaleway_container.app.privacy == "public" && scaleway_container.app.https_connections_only
    error_message = "Conan requires a public HTTPS endpoint."
  }
  assert {
    condition     = scaleway_container.app.min_scale == 0 && scaleway_container.app.max_scale == 1
    error_message = "Default deployment must scale from zero to one."
  }
  assert {
    condition     = !contains(keys(scaleway_container.app.environment_variables), "REDIRECTORY_ENCRYPTION_KEY")
    error_message = "Application secrets must not enter the infrastructure plan."
  }
  assert {
    condition     = !contains(keys(scaleway_container.app.environment_variables), "PORT")
    error_message = "Scaleway injects PORT from the container port setting."
  }
}

run "new_project" {
  command = plan
  variables {
    project_id      = ""
    organization_id = "00000000-0000-4000-8000-000000000002"
    create_project  = true
  }
  assert {
    condition     = length(scaleway_account_project.app) == 1
    error_message = "Explicit project creation must create one project."
  }
}

run "reject_ambiguous_project" {
  command = plan
  variables {
    create_project  = true
    organization_id = "00000000-0000-4000-8000-000000000002"
  }
  expect_failures = [scaleway_container_namespace.app]
}

run "reject_secret_in_plan" {
  command = plan
  variables {
    application_environment = {
      REDIRECTORY_ENCRYPTION_KEY          = "test-value"
      REDIRECTORY_REQUEST_TIMEOUT_SECONDS = "300"
    }
  }
  expect_failures = [var.application_environment]
}

run "custom_port" {
  command = plan
  variables {
    port = 18080
  }
  assert {
    condition     = scaleway_container.app.port == 18080 && scaleway_container.app.command == tolist(["node", "scripts/container.mjs", "--bootstrap"])
    error_message = "The container and bootstrap must use the configured platform port."
  }
}
