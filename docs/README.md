# Documentation

For installation, configuration and operational procedures, start with
**[Getting started](getting-started/README.md)**. It contains task-based paths for
users, application developers, Proxy operators and API providers. This page
indexes the design and reference material behind those procedures.

## Setup and operation

| Goal | Procedure |
|---|---|
| Run clientd or an existing AI client | [clientd](getting-started/clientd.md), [OpenClaw](getting-started/openclaw.md), [Claude Desktop](getting-started/claude-desktop.md) |
| Build an app or call an HTTP endpoint | [SDK application](getting-started/sdk.md), [HTTP API](getting-started/http-api.md) |
| Run a service or supply inference | [Proxy operator](getting-started/proxy-operator.md), [API provider](getting-started/api-provider.md) |
| Fund, recover and update | [Funding](getting-started/devnet-funding.md), [recovery](getting-started/recovery.md), [upgrading](getting-started/upgrading.md) |
| Deploy, supervise and maintain servers | [All operator procedures](getting-started/README.md#operator-tasks) |

[Support status](status.md) describes verified platforms and remaining limits.
The [client matrix](integrations/README.md) distinguishes tested integrations
from compatibility blockers.

## SDK reference

| Reference | Scope |
|---|---|
| [SDK overview](sdk/README.md) | Responsibilities, imports and concepts |
| [API](sdk/api.md) | Client methods, requests, sessions and settlement |
| [Public profiles](sdk/public-profile.md) | Profile-loader APIs and authenticated preflight contracts |
| [SDK internals](../packages/sdk/INTERNALS.md) | Journals, trust checks, codecs and transaction recovery |

## Architecture and specifications

Read the [architecture overview](architecture/overview.md) first. The contracts
below define protocol behavior; they are not claims of production qualification.

| Document | Scope |
|---|---|
| [Protocol requirements](specs/requirements.md) | Required capabilities and acceptance scenarios |
| [On-chain protocol](specs/protocol-solana.md) | Accounts, encoding, bindings, instructions and proofs |
| [Tree transitions](specs/tree-transition.md) | Layout 2, wire format and proof-bound updates |
| [API and billing](specs/api-proxy.md) | Authorization, providers, receipts and integer accounting |
| [Operations contract](specs/operations.md) | Trust boundaries, finality, recovery and release gates |
| [Single-signature deposits](architecture/single-signature-deposit.md) | Compact wire, transaction flow and recovery |
| [OpenAPI](contracts/openapi.json), [Vault IDL](contracts/zkapi_vault.json), [ledger](contracts/ledger.sql) | Machine-readable interfaces and database contract |

Design decisions: [proof-bound trees](adr/0001-proof-bound-tree-transition.md),
[signing keys](adr/0002-build-validated-signing-keys.md) and
[single-transaction deposits](adr/0003-single-transaction-deposit.md).

## Development and releases

- [Contributing](../CONTRIBUTING.md): toolchains and local checks.
- [Provider acceptance](development/provider-acceptance.md): isolated preflight and deliberate integration testing.
- [Verification policy](development/verification.md): test scope, local outputs and historical records.
- [Current release and upgrade guidance](releases/usability-preview.md): SDK/native `.8`.
- Earlier release notes: [privacy `.7`](releases/privacy-preview.md), [session reuse `.6`](releases/session-reuse-preview.md), [Kit preview](releases/kit-preview.md), [first preview](releases/devnet-preview.md).

Component READMEs stay beside their source for component-specific builds and
configuration. Keep all installation, integration and operator procedures in `getting-started/`,
SDK API reference in `sdk/`, and design in `architecture/`, `adr/` and `specs/`.
Deployment templates and executable assets stay beside their source in `deploy/`. Implementation diaries, handoffs and generated test reports do not
belong in the public guide tree.
