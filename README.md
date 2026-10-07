# Solana zkAPI

Build AI applications with USDC-funded private usage credits on Solana.

Solana zkAPI handles funding, local zero-knowledge proofs, API authorization,
verified billing and withdrawals. Your application owns the conversation UI,
model selection and chat history. SOL pays network fees; API usage is accounted
for in integer micro-USDC (1 USDC = 1,000,000 micro-USDC).

**Development preview.** Local protocol tests and selected Devnet/provider demos
have passed. Independent SDK installation and selected devnet/provider lifecycles
also have [separate evidence](docs/evidence/I10-external-integration.md). Full provider
acceptance, production setup, audits and release gates remain incomplete.
The [public-profile client release](docs/evidence/PD-public-client-publication.md)
provides an SDK tarball and a macOS ARM64 clientd distribution.
There is no published npm release or ready-to-use production deployment bundle.
See [supported features and evidence](docs/sdk/status.md).

For the remaining work to offer a public Devnet deployment that independent
apps can use from published inputs, see the [public Devnet readiness backlog](docs/public-devnet-readiness-backlog.md).
It distinguishes existing implementation/live evidence from missing hosted
services, complete artifacts, onboarding and current-release acceptance.
The published `0.2.0-devnet.2` preview adds an
[authenticated public profile and read-only preflight](docs/sdk/public-profile.md),
an [independent consumer example](tools/public-devnet-consumer/README.md),
and [funding instructions](docs/sdk/devnet-funding.md).
See the [implementation record](docs/public-devnet-implementation.md) for the
remaining operator readiness and funded-acceptance requirements. The
[public deployment guide](docs/sdk/public-devnet-preview.md) supplies the actual
profile and verified downloads. New admission remains suspended during operator
catch-up and funded acceptance; downloading a client is not service readiness.

[Kit migration](docs/sdk/kit-migration.md) · [SDK quickstart](docs/sdk/quickstart.md) · [SDK tarball](docs/sdk/distribution.md) · [Local clientd](docs/sdk/clientd-quickstart.md)

The current source and published `0.2.0-devnet.2` use `@solana/kit` 8.4.0 throughout the
SDK and native client. Its native Kit API is a breaking change from the first
preview; follow the [migration guide](docs/sdk/kit-migration.md). The existing
immutable `v0.1.0-devnet.1` release remains historical.
[`v0.2.0-devnet.2`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.2)
is published; [signature and anonymous-download verification](docs/evidence/PD-public-client-publication.json)
identify the exact released files.

## Build an application

Start with the [SDK guide](docs/sdk/README.md). Its browser factory composes the
existing wallet, proof worker, encrypted journal and session lifecycle:

```ts
import { createBrowserClient } from '@zkapi/solana-sdk/browser';
import { readChatText } from '@zkapi/solana-sdk/chat';

// options contains your reviewed deployment bundle and selected wallet.
// See the quickstart for initialization, funding and recovery.
const { client, dispose } = await createBrowserClient(options);
const response = await client.chat({
  operationId: crypto.randomUUID(), // once per explicit user Send action
  model: client.listModels()[0].id,
  messages: [{ role: 'user', content: 'Hello!' }],
  maxOutputTokens: 128,
});
const text = await readChatText(response);
const status = await client.status(); // verified balance and pending settlement
```

This excerpt assumes a funded, available note. Always consume or cancel the
response, inspect pending settlement, and recover saved work before a new send.
The SDK never automatically retries inference. See the [standalone browser chat
application](https://github.com/yukikm/solana-zkapi-client) and [API reference](docs/sdk/api.md).
The application includes model/API selection, conversation history, streaming
and recovery controls. Install a reviewed deployment bundle before real use.

The demonstration UI is maintained in the separate
[solana-zkapi-client repository](https://github.com/yukikm/solana-zkapi-client). The core SDK, native daemon
and their acceptance tests do not require that repository.

## Choose an integration

| You want to… | Start here |
|---|---|
| Build a browser chat app | [Application SDK quickstart](docs/sdk/quickstart.md) |
| Run the provided chat interface | [Browser application](https://github.com/yukikm/solana-zkapi-client) |
| Connect a local AI client or agent | [clientd quickstart](docs/sdk/clientd-quickstart.md), [application guides and compatibility](docs/integrations/README.md) |
| Operate a deployment | [Operator configuration](docs/sdk/deployment.md), [control service](services/control/README.md), [operations](deploy/operations/README.md) |
| Understand or change the protocol | [Implementation contract](docs/implementation-ready.md), [implementation plan](docs/implementation-plan.md) |
| Inspect what was actually verified | [Current boundaries](docs/sdk/status.md), [external integration evidence](docs/evidence/I10-external-integration.md), [historical I10 evidence](docs/evidence/I10.md) |

In **direct** mode, prompts go to the selected provider using a short-lived key.
In **proxy** mode, the operator relays requests and can read prompts and responses.
Applications select a mode explicitly. Neither mode hides prompt contents from
the provider or provides network anonymity by itself.

## Develop locally

Use the versions in `package.json` and `rust-toolchain.toml` (Node 24.19.0,
npm 11.9.0 for TypeScript). From this checkout:

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run typecheck
npm run build:sdk
npm run test:sdk-distribution
npm test
```

SDK tests use local fixtures; the browser storage test needs Chromium. They do
not spend provider credits or submit public transactions. See
[CONTRIBUTING.md](CONTRIBUTING.md) for test scopes and evidence requirements.

## Upstream and release preparation

Based on [`ethereum/zkapi`](https://github.com/ethereum/zkapi) at
`045b444ea1b52538d1b40273c7cb6ed09468a052`. Solana bindings, USDC accounting and
transaction transport are intentional differences. Original notices and licenses
are retained; see [source provenance](vendor/README.md) and
[third-party notices](THIRD_PARTY_NOTICES.md). Newly authored Solana zkAPI code
and documentation are available under the [MIT license](LICENSE). Vendored and
third-party components retain their own license terms.

Historical status prose from the previous README is preserved in the
[README archive](docs/evidence/I10-readme-before-app-sdk.md). Historical reports
are source-specific evidence, not a statement that the latest source passed every gate.
