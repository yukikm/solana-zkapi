# Solana zkAPI

An SDK and API for funding AI usage with USDC on Solana. It handles local
zero-knowledge proofs, authorization, signed billing receipts and withdrawals.
Applications provide their own UI, model selection and conversation history.
SOL pays network fees; usage is accounted for in integer micro-USDC.

**Devnet preview.** Selected provider and native-client lifecycles have been
tested. Production use, audits and broader browser/provider coverage remain
incomplete. See [support and verification status](docs/sdk/status.md).

## Get started

| Task | Guide |
|---|---|
| Build an application | [SDK quickstart](docs/sdk/quickstart.md) and [API reference](docs/sdk/api.md) |
| Connect an AI agent | [clientd quickstart](docs/sdk/clientd-quickstart.md) and [client compatibility](docs/integrations/README.md) |
| Try the public Devnet deployment | [Downloads and profile](docs/sdk/public-devnet-preview.md), [funding and access](docs/sdk/devnet-funding.md) |
| Operate a deployment | [Deployment configuration](docs/sdk/deployment.md) and [operations](deploy/operations/README.md) |
| Work on the protocol | [Implementation contract](docs/implementation-ready.md) and [plan](docs/implementation-plan.md) |

The SDK is distributed as a tarball; the native client package targets macOS
ARM64. There is no npm registry release. The optional
[reference chat application](https://github.com/yukikm/solana-zkapi-client)
is maintained separately.

<a id="current-handoff--2026-10-09-jst"></a>

## Preview status

Based on records through **2026-10-10 JST**:

- The published client release is **`0.2.0-devnet.8`**. It includes direct-session
  reuse, request filtering, OpenRouter ZDR routing, journal minimization and
  read-only upgrade guidance. See the [release guide](docs/releases/usability-preview.md).
- **Public preflight was blocked at the latest recorded check:** the operator
  returned an empty model catalog on both `.7` and `.8`. The cause remains
  unproven. A separate ZDR catalog read does not establish inference readiness.
- The public gateway permits any browser origin and does not require an
  invitation. **All seven authorized request slots were consumed**; new usage
  needs additional operator-authorized capacity.
- Selected native/OpenClaw funding, recovery and withdrawal cases have
  [recorded results](docs/sdk/status.md). Current funded browser acceptance,
  broader provider coverage and long-term availability remain unverified.

Run fresh preflight and check provider capacity before use. Earlier successful
checks do not establish current availability. Existing funded notes must retain
their original profile, custody and journal. Operational details are in the
[incident guide](docs/sdk/public-devnet-operations.md); earlier handoffs are
preserved in the [documentation archive](docs/evidence/PD-documentation-cleanup-20261010.md).

## Build an application

After [initialization and funding](docs/sdk/quickstart.md):

```ts
import { readChatText } from '@zkapi/solana-sdk/chat';

const response = await client.chat({
  operationId: crypto.randomUUID(), // once per explicit user Send action
  model: client.listModels()[0].id,
  messages: [{ role: 'user', content: 'Hello!' }],
  maxOutputTokens: 128,
});
const text = await readChatText(response);
const status = await client.status(); // inspect balance and pending settlement
```

Consume or cancel every response. Resolve pending work through
[recovery](docs/sdk/recovery.md); the SDK never automatically replays inference.

In **direct** mode, prompts go to the selected provider using a short-lived key.
In **proxy** mode, the operator relays requests and can read prompts and
responses. Both modes expose prompts to the provider; neither provides network
anonymity by itself.

## Develop locally

Use the versions in `package.json` and `rust-toolchain.toml` (Node 24.19.0,
npm 11.9.0 for TypeScript):

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run typecheck
npm run build:sdk
npm run test:sdk-distribution
npm test
```

SDK tests use local fixtures; browser storage tests need Chromium. See
[CONTRIBUTING.md](CONTRIBUTING.md) for test scopes and evidence requirements.
Upgrading from the first preview requires the [Kit migration guide](docs/sdk/kit-migration.md).

## Upstream and license

Based on [`ethereum/zkapi`](https://github.com/ethereum/zkapi) at
`045b444ea1b52538d1b40273c7cb6ed09468a052`, with Solana bindings, USDC accounting
and Solana transaction transport. Newly authored code and documentation use the
[MIT license](LICENSE). Vendored components retain their own terms; see
[source provenance](vendor/README.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

An [earlier README archive](docs/evidence/I10-readme-before-app-sdk.md) preserves
the pre-application-SDK history.
