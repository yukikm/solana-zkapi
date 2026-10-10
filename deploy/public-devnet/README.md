# Public Devnet deployment assets

Start with the [operator setup guide](../../docs/getting-started/proxy-operator.md)
for prerequisites, installation, configuration, service startup and verification.
The [gateway manual](../../docs/getting-started/operators/gateway.md) documents
access policy and routes. All deployment and maintenance procedures are under
[`docs/getting-started/operators`](../../docs/getting-started/operators/README.md).

This directory holds deployment inputs rather than onboarding instructions:

| Path | Purpose |
|---|---|
| `aws-budget-host.json` | Private US East preview infrastructure template |
| `aws-generated-host.json` | Earlier larger Tokyo infrastructure alternative |
| `nginx.*.conf.example` | Public ingress configuration templates |
| `systemd/` | Linux service units for the existing daemons |
| `profiles/` | Published consumer profile inputs |
| `upstream-setup-distribution.json`, `upstream-notices/` | Exact setup redistribution provenance and authenticated notices |

Keep private credentials, runtime state, journals and backup data outside this
directory. Published profile and notice bytes remain pinned release inputs.
