mock_provider "scaleway" {}
variables {
  region       = "pl-waw"
  container_id = "pl-waw/00000000-0000-4000-8000-000000000001"
  endpoint     = "https://example.functions.fnc.fr-par.scw.cloud"
  hostname     = "conan.example.com"
}
run "external_dns" {
  command = plan
  assert {
    condition     = length(scaleway_domain_record.app) == 0
    error_message = "External DNS must not create a managed DNS record."
  }
}
run "managed_dns" {
  command = plan
  variables { dns_zone = "example.com" }
  assert {
    condition     = scaleway_domain_record.app[0].name == "conan" && endswith(scaleway_domain_record.app[0].data, ".")
    error_message = "CNAME must use the relative name and an absolute target."
  }
}
