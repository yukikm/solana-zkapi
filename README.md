# Solana zkAPI

Build AI applications with USDC-funded private usage credits on Solana.

Solana zkAPI handles funding, local zero-knowledge proofs, API authorization,
verified billing and withdrawals. Your application owns the conversation UI,
model selection and chat history. SOL pays network fees; API usage is accounted
for in integer micro-USDC (1 USDC = 1,000,000 micro-USDC).

**Development preview.** Local protocol tests and selected Devnet/provider demos
have passed. The application SDK has separate local tests. Full provider
acceptance, production setup, audits and release gates remain incomplete.
There is no published npm release or ready-to-use production deployment bundle.
See [supported features and evidence](docs/sdk/status.md).

[Quickstart](docs/sdk/quickstart.md)

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
application](examples/browser-chat/README.md) and [API reference](docs/sdk/api.md).
The application includes model/API selection, conversation history, streaming
and recovery controls. Install a reviewed deployment bundle before real use.

## Choose an integration

| You want to… | Start here |
|---|---|
| Build a browser chat app | [Application SDK quickstart](docs/sdk/quickstart.md) |
| Run the provided chat interface | [Browser application](examples/browser-chat/README.md) |
| Connect a local OpenAI-compatible client | [clientd](apps/clientd/README.md) |
| Operate a deployment | [Operator configuration](docs/sdk/deployment.md), [control service](services/control/README.md), [operations](deploy/operations/README.md) |
| Understand or change the protocol | [Implementation contract](docs/implementation-ready.md), [implementation plan](docs/implementation-plan.md) |
| Inspect what was actually verified | [Current boundaries](docs/sdk/status.md), [parity review and direct-provider evidence](docs/evidence/I10-parity-review.md), [historical I10 evidence](docs/evidence/I10.md) |

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
npm run typecheck:examples
npm test
```

SDK tests use local fixtures; the browser storage test needs Chromium. They do
not spend provider credits or submit public transactions. See
[CONTRIBUTING.md](CONTRIBUTING.md) for test scopes and evidence requirements.

## Upstream and release preparation

Based on [`ethereum/zkapi`](https://github.com/ethereum/zkapi) at
`045b444ea1b52538d1b40273c7cb6ed09468a052`. Solana bindings, USDC accounting and
transaction transport are intentional differences. Original notices and licenses
are retained; see [source provenance](vendor/README.md). A license for the new
repository-wide work has not yet been selected; do not infer one from an upstream
component's license.

Historical status prose from the previous README is preserved in the
[README archive](docs/evidence/I10-readme-before-app-sdk.md). Historical reports
are source-specific evidence, not a statement that the latest source passed every gate.
