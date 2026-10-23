# Documentation

**New users: start with [Getting started](getting-started/README.md).**

Read [API integration and the payment lifecycle](getting-started/api-integration.md)
for the general design and extension requirements. Run the
[fixed-price JSON API lifecycle](getting-started/json-api.md) locally, or choose
[Inference API getting started](getting-started/inference.md) for inference clients.

| Directory | Contents |
|---|---|
| [getting-started/](getting-started/README.md) | General API integration, inference tutorials and operator procedures |
| [sdk/](sdk/README.md) | SDK API, configuration, recovery and migration reference |
| [specs/](architecture.md#specifications) | Protocol, wire formats, accounting and operational requirements |
| [adr/](architecture.md#design-decisions) | Design decisions |
| [contracts/](contracts/openapi.json) | OpenAPI, database schema, IDL and deterministic vectors |
| [releases/](releases/README.md) | Version-specific changes and download pins |

[Support](support.md) lists compatibility and preview limits.
[Architecture](architecture.md) explains the components.
[Testing](testing.md) lists contributor checks.
The [Node security upgrade guide](getting-started/node-security-upgrade.md) covers
the `.14` runtime update, authenticated artifacts and custody preservation.

The [universal API gateway design](specs/universal-api-gateway.md) and
[finite HTTP contract](specs/universal-api-gateway-contract.md) specify the initial
carrier, native Codex/Claude Code connections and metering. Async/duplex features
are separate extensions. The [finite HTTP guide](getting-started/finite-http-api.md)
covers the source implementation; public provider acceptance and published
interfaces remain separately documented above.
