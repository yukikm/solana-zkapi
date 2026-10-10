# Solana zkAPI

Fund AI usage with USDC on Solana. The SDK handles local zero-knowledge proofs,
authorization, signed billing receipts and withdrawals. `clientd` exposes a local
API for existing AI clients. SOL pays network fees; usage is accounted for in
integer micro-USDC.

**Devnet preview:** published SDK/native version **`0.2.0-devnet.8`**.
The native download supports **Apple Silicon Macs, macOS 13.5+**. The SDK is
distributed as a tarball; there is no npm registry release. See
[supported features and limits](docs/status.md) before use.

## Get started

Start with **[Getting started](docs/getting-started/README.md)** and choose your
role. Installation, application setup, provider connection and operator
procedures are all maintained under `docs/getting-started/`.

| I want to… | Follow this guide |
|---|---|
| Install the native client | [clientd](docs/getting-started/clientd.md) |
| Use OpenClaw | [OpenClaw setup](docs/getting-started/openclaw.md) |
| Configure Claude Desktop | [Desktop gateway setup and compatibility](docs/getting-started/claude-desktop.md) |
| Build an application with the SDK | [SDK application walkthrough](docs/getting-started/sdk.md) |
| Call the local API from a script | [HTTP API](docs/getting-started/http-api.md) |
| Run a Proxy/payment service | [Operator setup](docs/getting-started/proxy-operator.md) |
| Connect an upstream API provider | [API provider setup](docs/getting-started/api-provider.md) |
| Fund, recover or upgrade | [Funding](docs/getting-started/devnet-funding.md), [recovery](docs/getting-started/recovery.md), [upgrading](docs/getting-started/upgrading.md) |

The native archive includes Node and the prover; it does not require a source
checkout. Existing funded installations keep their original profile, keys and
journal until recovery and closure. The public profile serves OpenRouter Chat;
Claude Desktop's Anthropic Messages gateway needs a different reviewed
deployment and has not passed Desktop acceptance here.

For deeper reference, use [all documentation](docs/README.md),
[API methods](docs/sdk/api.md), [architecture](docs/architecture/overview.md) and
[contributing](CONTRIBUTING.md). Current downloads and profile hashes are in
[Public Devnet](docs/getting-started/public-devnet-preview.md).

## How it works

An application or clientd creates a local encrypted note journal, funds the note
with USDC and authorizes bounded AI usage. Verified receipts settle the charge;
the remaining balance can be withdrawn. Applications own their UI, model
selection and conversation history. The optional
[reference chat application](https://github.com/yukikm/solana-zkapi-client)
is maintained separately.

In **direct** mode, prompts go to the selected provider using a short-lived key.
In **proxy** mode, the operator relays requests and can read prompts and responses.
Both modes expose prompts to the provider. Resolve uncertain operations through
the saved journal; recovery never automatically replays inference.

## Develop locally

Use the pinned versions in `package.json`, `.go-version` and
`rust-toolchain.toml`. For the SDK, use Node **24.19.0** and npm **11.9.0**:

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run typecheck
npm run build:sdk
npm run test:sdk-distribution
npm test
python3 scripts/check_design.py
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites and component checks.

## License and dependencies

New code and documentation use the [MIT license](LICENSE). The project reuses
pinned zkAPI circuits and cryptographic primitives, with Solana bindings, USDC
accounting and Solana transaction transport. Dependency versions and original
licenses are recorded in [vendor/](vendor/README.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
