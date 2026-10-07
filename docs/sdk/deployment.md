# Deployment inputs for app maintainers

This configuration is installed once by the application maintainer. Users
choose a wallet and use the app; they do not assemble cryptographic pins.
Until reviewed bundles are distributed, an integration requires access to a
configured operator. This guide does not advertise a public production service.

## Public bundle

The [reference application loader](https://github.com/yukikm/solana-zkapi-client) accepts a
`ReviewedBrowserProfile` containing:

| Input | Source and checks |
|---|---|
| `trust` | Independently reviewed `ManifestTrustPolicy`, compiled into the app or separately authenticated distribution |
| `manifestUrl` | Raw manifest; its canonical digest/signature must match the independent trust anchor |
| `artifacts.idl` | Compiler-backed Vault IDL |
| `artifacts.requestPk`, `requestVk` | Request proving/verifying keys |
| `artifacts.withdrawalPk`, `withdrawalVk` | Withdrawal keys |
| `artifacts.treePk`, `treeVk` | Layout-2 transition keys |
| `artifacts.treeSourceBundle`, `treeVerifierConstants` | Pinned source archive and verifier constants |
| `artifacts.additional` | Exactly the manifest's additional artifact digest entries |
| `wasmUrl`, `wasmSha256` | Offline prover WASM and independently installed build hash |
| `models` | Reviewed model/API/provider configurations and pinned tariff objects |
| `rpcUrl` | Public browser-safe RPC or controlled relay; no secret URL in client assets |
| `indexerOrigin` | Independently configured indexer HTTPS origin |

The factory authenticates the bundle, RPC genesis and actual finalized
PoolConfig. A trust policy fetched alongside an untrusted manifest is not an
independent trust root. Do not derive the trust anchor/build pins from whatever
the server returned. Protect the JS worker through your trusted app build too.

The `0.2.0-devnet.2` candidate's `loadDeploymentAssets` supports public
descriptor schema 2 with authenticated license/provenance notices. Its
`notices` map associates safe flat labels with unique same-directory filenames,
and `files` binds their exact byte lengths and SHA-256 hashes. Limits are 32
notices, 1 MiB per file and 4 MiB combined; files may not collide with proof,
manifest or WASM paths. The loader must retrieve and verify every notice before
returning `assets.notices`. Preserve those bytes when installing or distributing
the assets. Missing or modified notices fail the whole load. Schema 1 remains
supported with an empty notice map; older released SDKs cannot read schema 2.
See [distribution](../../packages/sdk/DISTRIBUTION.md#loading-a-distributable-public-artifact-bundle)
for the offline packager and exact-file publication review. Source support alone
is not a new published SDK or a downloadable bundle acceptance result.

`ArtifactBundle` and `ManifestTrustPolicy` in [trust.ts](../../packages/sdk/src/trust.ts)
are the exact contracts. The existing [operator services](../../services/control/README.md)
and [deployment operations](../../deploy/operations/README.md) produce and run
these components. The [operator browser relay](../../scripts/devnet-browser-relay/README.md)
demonstrates same-origin relays without exposing private RPC credentials.

## Model configuration

Each `ModelConfiguration` contains `id`, optional display `label`, `provider`,
supported `apis` and a complete tariff. Allowed native combinations are:

| Mode/provider | API |
|---|---|
| Proxy / OpenAI | `chat`, `responses` |
| Proxy / OpenRouter | `chat` |
| Proxy / Anthropic | `messages` |
| Direct OpenRouter | `chat` |
| Direct OA | `chat`, `responses` |

Proxy tariffs bind a single model and fixed integer usage rates. Direct tariffs
use `model: "*"` and provider-reported USD accounting, while the application's
model list still explicitly restricts selectable IDs. The factory checks each
tariff hash against the manifest; `ControlClient` verifies every signed quote
and tariff binding again. The backend must actually configure the same tariff.
Adding a model to the UI alone does not enable it or establish compatibility.

Modes are `proxy`, `direct_openrouter`, or `direct_oa`. Direct configuration
must supply an independently trusted `directProviderBases` entry. OA also needs
`oaVerifier: {base, stationId}`. The SDK does not infer these from key responses.
Configuration never permits fallback from direct to proxy.

## Hosting and custody

Serve over HTTPS (localhost for development), with module Worker, IndexedDB,
Web Locks and Web Crypto support. Allow the intended worker/connect destinations
in CSP. Control/indexer/inference endpoints need suitable CORS or a narrowly
routed app relay. The reference app can use the bounded local devnet relay; hosted apps need their
own reviewed CORS or relay configuration.

Use `createSolanaRpc(reviewedRpcUrl)` from `@solana/kit` for the `connection`
field. Every SDK financial read explicitly requests finalized commitment; Kit
returns RPC integer fields as bigint. If the app requires an existing bounded
fetch or relay, import `createSolanaRpcWithFetch` from
`@zkapi/solana-sdk/transport` and supply that fetch. This helper uses Kit's
lossless RPC codecs and does not retry requests.

Custom `deployment.fetch` must preserve `credentials: 'omit'`, redirect refusal,
abort signals, exact request bodies and the no-retry policy. Configure RPC
transport separately through the supplied Kit RPC client; `deployment.fetch` does
not replace the RPC client's transport. Do not attach chat-account cookies,
private note IDs, wallet addresses or logs to control requests.

Authorization downloads the pool-wide `/zkapi/v1/tree/snapshot` descriptor and
its content-addressed snapshot through the configured indexer origin. It reads
only the shared PoolConfig, TreeState and Clock accounts, authenticates the
finalized root/sequence/next-ID cut and reconstructs the selected path locally
in the pinned native/WASM prover. Relays must allow both exact snapshot routes.
The initial reader bounds are 4 MiB and 16,384 combined active/pending records;
larger snapshots fail closed without falling back to a selected-note query.
Custom authorization adapters must implement `sessionSnapshot`. The separate
financial recovery `snapshot` still verifies individual Note/Pending accounts.
Network addresses, timing and publicly visible funding/withdrawal remain visible;
this change does not provide network anonymity.

Direct mode sends prompts and responses to the selected provider; proxy mode
also exposes that content to the proxy operator. The control authorization and
settlement protocol does not receive the inference body in direct mode. Providers
and operators remain trusted for their key-management and usage reports. ZK
proofs do not verify model outputs or prove that reported usage is accurate.

The Solana settlement trust model also includes the USDC issuer's mint/freeze
controls, the deployed program's upgrade authority and the additional layout-2
tree circuit/setup. A fresh experimental devnet profile uses a single-party
OS-random tree setup and the pinned upstream request/withdrawal setup; it is not
an independently verified ceremony. Independently review the deployed program
bytes and upgrade authority as well as client artifact pins. These differences
from Ethereum native-ETH settlement remain relevant on devnet.

Both direct and proxy request bodies are retained in the encrypted local journal
for exact operation identity and recovery, including any conversation context
the app sends. Newly received direct provider keys stay only in the current
`ControlClient`'s memory; restarting closes and settles the saved session without
recovering or replaying inference. Historical journals/backups from earlier
versions may still contain encrypted provider keys and are not migrated on read.
Clearing a chat display does not erase retained requests. The browser stores its
nonextractable encryption key in the same origin; trusted app code can decrypt
the records. See [local retention](recovery.md#local-request-retention) before
making a no-storage or ephemeral-chat claim.

The default transaction preparation commitment is `finalized`. Applications may
explicitly configure `confirmed` for blockhash/preflight preparation; proof cuts,
funding acceptance and financial receipts remain finalized. Choose an explicit
priority fee policy and inspect fees in the wallet. API charges remain USDC;
fees/rent remain SOL.

Do not update deployment/IDL/build pins on funded or unresolved journals. A new
deployment requires an explicit migration procedure, not a configuration refresh.
Existing I10 demo state stays in its existing origin/profile and schema.
The new browser factory does not import or migrate that demo's custody namespace.
