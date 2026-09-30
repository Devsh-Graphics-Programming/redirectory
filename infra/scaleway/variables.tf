variable "region" {
  type    = string
  default = "pl-waw"
}
variable "project_id" {
  type    = string
  default = ""
}
variable "organization_id" {
  type    = string
  default = ""
}
variable "create_project" {
  type    = bool
  default = false
}
variable "project_name" {
  type    = string
  default = "redirectory"
}
variable "container_name" {
  type    = string
  default = "redirectory"
}
variable "image" {
  type = string
  validation {
    condition     = can(regex("^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use a public OCI image pinned by sha256 digest."
  }
}
variable "cpu_limit" {
  type    = number
  default = 140
}
variable "port" {
  type    = number
  default = 9595
  validation {
    condition     = var.port >= 1 && var.port <= 65535 && floor(var.port) == var.port
    error_message = "The application port must be an integer between 1 and 65535."
  }
}
variable "memory_limit" {
  type    = number
  default = 256
}
variable "min_scale" {
  type    = number
  default = 0
}
variable "max_scale" {
  type    = number
  default = 1
}
variable "application_environment" {
  type = map(string)
  validation {
    condition = alltrue([for key in keys(var.application_environment) : contains([
      "REDIRECTORY_GITHUB_REPOSITORY", "REDIRECTORY_ANONYMOUS_READ",
      "REDIRECTORY_MAX_UPLOAD_BYTES", "REDIRECTORY_REQUEST_TIMEOUT_SECONDS"
    ], key)])
    error_message = "Only non-secret application settings belong in Terraform."
  }
}
