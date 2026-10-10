# Getting started

Start here whenever you want to install, connect, build or operate Solana zkAPI.
Choose your role and follow the guides in order. Each guide states its inputs,
commands, expected result and where support currently stops.

The current release is a **Devnet preview**. Native downloads support Apple
Silicon Macs, macOS 13.5+. SDK applications use the published tarball. Check
[support status](../status.md) for tested combinations; configuration examples
alone do not establish live acceptance.

## Choose your role

| Your role | What you provide | Follow this path | Result |
|---|---|---|---|
| User of an existing AI application | Your Devnet wallet and private client profile | [clientd](clientd.md) → [funding](devnet-funding.md) → [OpenClaw](openclaw.md) | AI requests through your local zkAPI endpoint |
| User connecting another HTTP client or script | A running, funded clientd | [HTTP API](http-api.md) | One explicit request and a checked settlement |
| Claude Desktop user | A reviewed Anthropic Messages deployment and compatible Desktop setup | [Claude Desktop](claude-desktop.md) | Gateway setup instructions and compatibility checks; the public Chat profile cannot serve this route |
| Application developer using the SDK | Your application and the user's selected wallet | [SDK application](sdk.md) | A local application that loads the profile, funds a note and sends a request |
| Proxy / payment-service operator | Server, Solana deployment, private signing custody, database and provider access | [Proxy operator](proxy-operator.md) | Configured services, deployment checks and a consumer handoff |
| API provider | Supported inference API/account capabilities and model/pricing information | [API provider](api-provider.md) | A provider connection and validated catalog/tariff for the operator |

An ordinary user does not need to operate PostgreSQL, a signer or a challenger,
and does not need a provider management key. The **Proxy operator** hosts the
payment and optional inference services. The **API provider** supplies model
inference and usage/key-management capabilities. One organization can fill both
roles, but their credentials and responsibilities remain separate.

## User and application tasks

| Task | Guide | Start when |
|---|---|---|
| Install, start, stop or restart clientd | [clientd](clientd.md) | You want a local endpoint without building an app |
| Configure Tor runtime or invitation access | [clientd network setup](clientd-network.md) | You are preparing a new profile with these optional requirements |
| Configure OpenClaw | [OpenClaw](openclaw.md) | clientd is running and the note is funded |
| Configure Claude Desktop | [Claude Desktop](claude-desktop.md) | You need to check Desktop's Messages gateway requirements |
| Evaluate Claude Code | [Claude Code](claude-code.md) | You need the CLI configuration and its known request-format blockers |
| Evaluate Codex CLI | [Codex CLI](codex.md) | You need Responses configuration and its known compatibility blockers |
| Call the local API from a script | [HTTP API](http-api.md) | You have a running clientd and its inference token file |
| Install the SDK and build your first app | [SDK application](sdk.md) | You are building the wallet/application interface |
| Find current downloads and public endpoints | [Public Devnet](public-devnet-preview.md) | You need the published profile and independent hashes |
| Obtain Devnet USDC and SOL | [Funding and access](devnet-funding.md) | Read-only preflight and admission checks succeed |
| Select models and check availability | [Models](public-models.md) | You have a pinned profile or running clientd |
| Recover an interrupted request or wallet operation | [Recovery](recovery.md) | Status reports pending, unknown or recovery-required work |
| Upgrade an existing installation | [Upgrading](upgrading.md) | You already have custody or a funded note |
| Use another reviewed deployment | [Deployment inputs](deployment-inputs.md) | You maintain a custom application or private operator |
| Bundle workers/assets or build an SDK tarball | [SDK distribution](sdk-distribution.md) | You need distribution details beyond the first-app guide |
| Port a first-preview SDK integration to Kit | [SDK migration](sdk-migration.md) | Your application uses the old TypeScript API |

OpenClaw's historical settlement adapter has a separate
[maintenance guide](openclaw-settlement-adapter.md); new installations start with
[OpenClaw setup](openclaw.md). Claude Code and Codex CLI have recorded request
compatibility blockers in the [client matrix](../integrations/README.md).
They are different products from Claude Desktop.

## Operator tasks

Start with [Proxy operator setup](proxy-operator.md). Use these procedures for
the corresponding stage, rather than treating a public API gateway as an
inference proxy automatically:

| Task | Procedure |
|---|---|
| Connect upstream providers and define model pricing | [API provider](api-provider.md) |
| Create a new Devnet setup, Vault program and Pool | [Chain deployment](operators/chain-deployment.md) |
| Bootstrap the direct OpenRouter payment service | [Direct OpenRouter](operators/direct-openrouter.md) |
| Prepare the required files and operator configuration | [Bootstrap inputs](operators/bootstrap-inputs.md) |
| Prepare services, chain inputs and an authenticated profile | [Deployment](operators/deployment.md) |
| Configure public routes and admission | [Gateway](operators/gateway.md) |
| Serve an existing local browser application through the operator relay | [Browser relay](operators/browser-relay.md) |
| Provision AWS networking and durable storage | [Hosting](operators/hosting.md) |
| Select provider-spending policy | [Budget](operators/budget.md) |
| Install service units | [Service supervision](operators/service-units.md) |
| Back up, restore and monitor | [Operations](operators/operations.md) |
| Restart an existing deployment without replacing state | [Same-state maintenance](operators/same-state-restart.md) |
| Handle admission/service incidents | [Incidents](operators/incidents.md) |
| Prevent archive storage exhaustion | [Archive storage](operators/archive-storage.md) |

Deployment configuration templates remain next to their code under `deploy/`.
Architecture, API reference and protocol contracts remain in the
[reference documentation](../README.md); installation and operational procedures
are maintained here.
