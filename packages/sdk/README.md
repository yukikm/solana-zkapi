# Solana zkAPI SDK

An SDK for USDC-funded AI usage on Solana. It handles wallet operations, local
proofs, encrypted storage, authorization and signed settlement. Applications own
their UI, conversation history and provider mode.

Start with the [browser app walkthrough](https://github.com/yukikm/solana-zkapi/blob/main/docs/getting-started/sdk.md),
[API reference](https://github.com/yukikm/solana-zkapi/blob/main/docs/sdk/api.md) and [distribution guide](https://github.com/yukikm/solana-zkapi/blob/main/docs/getting-started/sdk-distribution.md).
The published release is `0.2.0-devnet.8`; see
[downloads and verification](https://github.com/yukikm/solana-zkapi/blob/main/docs/getting-started/public-devnet-preview.md).
The package is distributed as a tarball, with `private: true` to disable npm
registry publication. Node integrations use Node 24.19.0; browser integrations
bundle the browser entry points.

The SDK uses `@solana/kit` 8.4.0. Install Kit explicitly if your app imports it,
and read the [migration guide](https://github.com/yukikm/solana-zkapi/blob/main/docs/getting-started/sdk-migration.md) when upgrading
from the first preview.

| Import | Purpose |
|---|---|
| `@zkapi/solana-sdk` | `createZkApiClient`, `ZkApiClient`, application types |
| `@zkapi/solana-sdk/browser` | Browser factory, custody and Wallet Standard adapter |
| `@zkapi/solana-sdk/deployment` | Load and verify a pinned artifact bundle |
| `@zkapi/solana-sdk/public-profile` | Load an authenticated profile and run read-only preflight |
| `@zkapi/solana-sdk/chat` | Text and streaming response readers |
| `@zkapi/solana-sdk/prover-worker` | Entry point to bundle as a module Worker |
| `./wallet`, `./control` and other documented subpaths | Lower-level integration |

The factory validates deployment pins, artifacts, RPC genesis and finalized
PoolConfig. Funding, recovery and inference require separate explicit actions.
Use a stable note ID and storage identity, consume or cancel each response, and
resolve pending work before new inference. Recovery never replays inference.

Direct-session reuse uses a 300-second lease and a 90-second renewal margin.
See [session reuse](https://github.com/yukikm/solana-zkapi/blob/main/docs/sdk/api.md#direct-session-reuse) for configuration
and settlement behavior. `.8` also provides [upgrade and privacy guidance](https://github.com/yukikm/solana-zkapi/blob/main/docs/releases/usability-preview.md).
Keep existing custody on its original profile and recovery inputs; upgrades use
a separate installation after the original note is closed.

## Single-signature deposit

Compact-enabled deployments support one-signature deposits. Older deployments
use buffer transactions; the authenticated configuration selects the path.
Details are in [INTERNALS.md](INTERNALS.md).

The SDK uses the [MIT license](LICENSE); dependencies retain their own terms.
