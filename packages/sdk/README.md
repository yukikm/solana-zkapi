# Solana zkAPI SDK

An SDK for USDC-funded API usage on Solana. It handles wallet operations, local
proofs, encrypted storage, authorization and signed settlement. Applications own
their UI, request/response data and provider selection.

Start with [General API integration](../../docs/getting-started/api-integration.md)
for the shared payment lifecycle. The current source supports registered
fixed-price POST JSON APIs through `requestApi()`; start with the
[local JSON API tutorial](../../docs/getting-started/json-api.md).
Inference adapters support Chat Completions, Responses and Messages as enabled
by a deployment's profile. New methods, billing units and response formats
still require explicit adapters and contracts.

Use the [inference SDK tutorial](../../docs/getting-started/sdk.md),
[API reference](../../docs/sdk/api.md) and [distribution guide](DISTRIBUTION.md)
for the implemented interfaces.
The published release is `0.2.0-devnet.8` and retains its inference interfaces;
the registered JSON API addition is source/local only. See
[downloads and verification](../../docs/getting-started/devnet.md).
The package is distributed as a tarball, with `private: true` to disable npm
registry publication. Node integrations use Node 24.19.0; browser integrations
bundle the browser entry points.

The SDK uses `@solana/kit` 8.4.0. Install Kit explicitly if your app imports it,
and read the [migration guide](../../docs/sdk/kit-migration.md) when upgrading
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
PoolConfig. `ControlClient` and `WalletClient` share the encrypted note journal;
`ClientDaemon` and the application facade reuse their lifecycle. Adding another
API type beyond the registered JSON adapter requires matching request, tariff and discovery contracts,
using the existing accounting ledger and recovery rules.

Funding, recovery and API execution require separate explicit actions.
Use a stable note ID and storage identity, consume or cancel each response, and
resolve pending work before new inference. Recovery never replays inference.

Direct-session reuse uses a 300-second lease and a 90-second renewal margin.
See [session reuse](../../docs/sdk/api.md#direct-session-reuse) for configuration
and settlement behavior. `.8` also provides [upgrade and privacy guidance](../../docs/releases/usability-preview.md).
Keep existing custody on its original profile and recovery inputs; upgrades use
a separate installation after the original note is closed.

## Single-signature deposit

Compact-enabled deployments support one-signature deposits. Older deployments
use buffer transactions; the authenticated configuration selects the path.
Details are in [INTERNALS.md](INTERNALS.md).

The SDK uses the [MIT license](LICENSE); dependencies retain their own terms.
