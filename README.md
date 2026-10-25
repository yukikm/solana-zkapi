# Solana ZKAPI

SDK `.19` adds [withdrawal progress and verified waiting-period status](docs/releases/withdrawal-status-preview.md). It retains `.18` [recoverable custody for browser and Node.js](docs/sdk/recoverable-custody.md), including explicit recovery after device-data loss. Native installers remain at `.15`.

ZKAPI provides USDC payments and zero-knowledge usage authorization for APIs on
Solana. Its payment lifecycle combines local proofs, capped authorization,
signed billing receipts and withdrawals.
SOL pays network fees; balances use integer micro-USDC.

**Devnet preview.** See [supported clients and limits](docs/support.md).

ZKAPI's payment lifecycle is independent of the API's application domain.
This source tree includes registered, fixed-price JSON operations, finite HTTP gateways and
inference adapters. All reuse the same wallet, authorization, accounting and settlement.
SDK/native `.13` adds an offline registration compiler, API-only public profiles
and native invocation. See [JSON API onboarding](docs/getting-started/json-api.md)
and [new-Devnet registration](docs/getting-started/api-registration.md).
See the [`.13` release and upgrade guide](docs/releases/universal-api-gateway-preview.md).
The [`.14` security update](docs/releases/node-security-preview.md) upgrades Node
to 24.22.1 LTS while retaining existing profile and custody bindings; see its
[installation procedure](docs/getting-started/node-security-upgrade.md).
The existing public deployment retains its direct OpenRouter inference selection.

## How it works

![Solana ZKAPI direct flow: your app calls the local client, which proves payment to the control service, receives a capped provider key and calls the API provider directly. The Solana Vault holds deposited USDC; the client verifies signed settlement before reusing the balance or withdrawing.](docs/assets/how-it-works.svg)

Deposit USDC through the client to fund a private note. The client generates a
local ZK proof to authorize a capped session. The control service verifies the
proof and obtains a restricted provider key; API requests and responses then
travel directly between the client and provider. The public Devnet profile
shown here uses **OpenRouter Chat Completions**.

After the session closes, the client verifies the signed charge and updated
note state before another authorization or withdrawal. See the
[payment lifecycle](docs/getting-started/api-integration.md#follow-one-payment-lifecycle)
for the complete flow.

In direct mode, requests go to the selected provider. In proxy mode, the
operator also receives request and response content. ZK proofs do not make
that content private from its recipients, prove API response correctness or
provide network anonymity.

## Get started

Start with **[API integration and the payment lifecycle](docs/getting-started/api-integration.md)**.
The [Getting started index](docs/getting-started/README.md) separates general
integration concepts, inference tutorials and operator procedures.

| I want to… | Guide |
|---|---|
| Understand how ZKAPI fits an API | [API integration](docs/getting-started/api-integration.md) |
| Verify a fixed-price JSON API locally | [JSON API tutorial](docs/getting-started/json-api.md) |
| Register a POST JSON API for a new deployment | [Offline registration](docs/getting-started/api-registration.md) |
| Integrate finite HTTP APIs | [Finite HTTP gateway](docs/getting-started/finite-http-api.md) |
| Extend ZKAPI to another API | [Integration requirements](docs/getting-started/api-integration.md#integrate-another-kind-of-api) |
| Use the implemented inference APIs | [Inference API getting started](docs/getting-started/inference.md) |
| Add inference to an application | [Inference SDK tutorial](docs/getting-started/sdk.md) |
| Get Devnet funds and connection details | [Devnet](docs/getting-started/devnet.md) |
| Run authorization and settlement services | [Operator setup](docs/getting-started/proxy-operator.md) |

The [inference guides](docs/getting-started/inference.md) cover clientd,
OpenClaw, other AI clients and provider adapters. The published native package
supports Apple Silicon Macs; its installation guide is explicitly for macOS.
The SDK is distributed as a tarball. The
[reference chat app](https://github.com/yukikm/solana-zkapi-client) is an inference
application maintained separately.

## Public Devnet addresses

Deployment: `public-devnet-20261021-state-v1`. All explorer links below use **Solana Devnet**.

| Account | Address |
|---|---|
| Vault program | [2sXbYtY2NbyGm1GeCETkkjAa5LxWCA8v8aj2ePW3yVDH](https://explorer.solana.com/address/2sXbYtY2NbyGm1GeCETkkjAa5LxWCA8v8aj2ePW3yVDH?cluster=devnet) |
| Pool | [2zAKvvfiV1RZtWw71EYthWVrR3ZiWgmy92DS75JpmG8R](https://explorer.solana.com/address/2zAKvvfiV1RZtWw71EYthWVrR3ZiWgmy92DS75JpmG8R?cluster=devnet) |
| Vault (USDC token account) | [H2rvp4whEZV7AnTSLbvsBsY8RbFCVjcesEdaouS3ve2y](https://explorer.solana.com/address/H2rvp4whEZV7AnTSLbvsBsY8RbFCVjcesEdaouS3ve2y?cluster=devnet) |
| USDC mint | [4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU](https://explorer.solana.com/address/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU?cluster=devnet) |

Program, Pool and mint are pinned in the [public manifest](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261021-state-v1/assets/manifest.json);
the Vault is the Pool's derived USDC token account. This fresh PoC uses
[current-account synchronization](docs/getting-started/poc-state-sync.md) and new
client journals. Deposit through
[clientd](docs/getting-started/clientd.md) or the [SDK](docs/getting-started/sdk.md):
a direct token transfer to the Vault does not create a ZKAPI note.

## Documentation

- [Documentation index](docs/README.md)
- [SDK reference](docs/sdk/README.md)
- [Architecture and protocol](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

## License

New code and documentation use [MIT](LICENSE). Cryptographic components reuse
pinned [ethereum/zkapi](https://github.com/ethereum/zkapi) sources; they are required
build dependencies. See [source provenance](vendor/README.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
