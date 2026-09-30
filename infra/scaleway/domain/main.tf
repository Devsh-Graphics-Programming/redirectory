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
provider "scaleway" { region = var.region }
variable "region" { type = string }
variable "container_id" { type = string }
variable "endpoint" { type = string }
variable "hostname" { type = string }
variable "dns_zone" {
  type    = string
  default = ""
}
resource "scaleway_domain_record" "app" {
  count    = var.dns_zone == "" ? 0 : 1
  dns_zone = var.dns_zone
  name     = trimsuffix(var.hostname, ".${var.dns_zone}")
  type     = "CNAME"
  data     = "${trimprefix(var.endpoint, "https://")}."
  ttl      = 300
  lifecycle {
    precondition {
      condition     = endswith(var.hostname, ".${var.dns_zone}")
      error_message = "Use a subdomain of the selected DNS zone."
    }
  }
}
resource "scaleway_container_domain" "app" {
  container_id = var.container_id
  hostname     = var.hostname
  depends_on   = [scaleway_domain_record.app]
}
output "endpoint" { value = "https://${var.hostname}" }
