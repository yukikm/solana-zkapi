# Solana ZKAPI

ZKAPI provides USDC payments and zero-knowledge usage authorization for APIs on
Solana. Its payment lifecycle combines local proofs, capped authorization,
signed billing receipts and withdrawals.
SOL pays network fees; balances use integer micro-USDC.

**Devnet preview.** See [supported clients and limits](docs/support.md).

ZKAPI's payment lifecycle is independent of the API's application domain.
This source tree includes registered, fixed-price JSON operations and inference
adapters. Both reuse the same wallet, authorization, accounting and settlement.
The JSON API integration is a local development capability; published `.8`
packages and the existing public deployment retain their recorded inference scope.

## Get started

Start with **[API integration and the payment lifecycle](docs/getting-started/api-integration.md)**.
The [Getting started index](docs/getting-started/README.md) separates general
integration concepts, inference tutorials and operator procedures.

| I want to… | Guide |
|---|---|
| Understand how ZKAPI fits an API | [API integration](docs/getting-started/api-integration.md) |
| Verify a fixed-price JSON API locally | [JSON API tutorial](docs/getting-started/json-api.md) |
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

In direct mode, requests go to the selected provider. In proxy mode, the
operator also receives request and response content. ZK proofs do not make
that content private from its recipients, prove API response correctness or
provide network anonymity.

## Public Devnet addresses

Deployment: `public-devnet-20261008-a`. All explorer links below use **Solana Devnet**.

| Account | Address |
|---|---|
| Vault program | [2sXbYtY2NbyGm1GeCETkkjAa5LxWCA8v8aj2ePW3yVDH](https://explorer.solana.com/address/2sXbYtY2NbyGm1GeCETkkjAa5LxWCA8v8aj2ePW3yVDH?cluster=devnet) |
| Pool | [Cx8DbA49UCuASoc3goLCU9ro25eWVtcGMbvfPPJsSQzV](https://explorer.solana.com/address/Cx8DbA49UCuASoc3goLCU9ro25eWVtcGMbvfPPJsSQzV?cluster=devnet) |
| Vault (USDC token account) | [8SDDE1VZ7TDZ13N8yRmrZYnWuwFbuBoD6oWCgTb12R2S](https://explorer.solana.com/address/8SDDE1VZ7TDZ13N8yRmrZYnWuwFbuBoD6oWCgTb12R2S?cluster=devnet) |
| USDC mint | [4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU](https://explorer.solana.com/address/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU?cluster=devnet) |

Program, Pool and mint are pinned in the [public manifest](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/assets/manifest.json);
the Vault is the Pool's derived USDC token account. Deposit through
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
