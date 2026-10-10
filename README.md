# Solana ZKAPI

Pay for AI API usage with USDC on Solana. ZKAPI provides local zero-knowledge
proofs, usage authorization, signed billing receipts and withdrawals.
SOL pays network fees; balances use integer micro-USDC.

**Devnet preview.** See [supported clients and limits](docs/support.md).

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

## Get started

Start with **[docs/getting-started](docs/getting-started/README.md)**.

| I want to… | Guide |
|---|---|
| Install and run clientd | [clientd](docs/getting-started/clientd.md) |
| Use OpenClaw | [OpenClaw](docs/getting-started/openclaw.md) |
| Configure Claude Desktop | [Claude Desktop and current limits](docs/getting-started/claude-desktop.md) |
| Configure Claude Code or Codex | [Claude Code](docs/getting-started/claude-code.md) · [Codex](docs/getting-started/codex.md) |
| Add ZKAPI to an application | [SDK](docs/getting-started/sdk.md) |
| Get Devnet funds and connection details | [Devnet](docs/getting-started/devnet.md) |
| Run a proxy or access service | [Operator setup](docs/getting-started/proxy-operator.md) |
| Connect an API provider | [Provider setup](docs/getting-started/api-provider.md) |

The native download supports Apple Silicon Macs. The SDK is distributed as a
tarball. The [reference chat app](https://github.com/yukikm/solana-zkapi-client)
is maintained separately.

In direct mode, requests go to the selected provider. In proxy mode, the
operator also receives prompts and responses. ZK proofs do not make the
provider's inputs private or provide network anonymity.

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
