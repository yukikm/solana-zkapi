# Application developer guide

Use Solana zkAPI to fund API usage with USDC while keeping the payment note
separate from the API conversation. Your app sends ordinary chat messages;
the SDK handles the proof, authorization and signed settlement locally.

1. Install a reviewed [SDK tarball](distribution.md) and read the [quickstart](quickstart.md).
2. Obtain a [reviewed deployment bundle](deployment.md) from your operator.
3. Follow the [browser integration example](https://github.com/yukikm/solana-zkapi-client).
4. Add [recovery and user-facing states](recovery.md).
5. Consult the [API reference](api.md) and [verified feature status](status.md).

The current SDK uses `@solana/kit` 8.4.0 directly. Applications upgrading from
the first preview should read the [Kit migration guide](kit-migration.md) before
changing their wallet or RPC adapters.

## Responsibilities

| SDK | Application | Deployment operator |
|---|---|---|
| Local proofs and private note storage | Wallet discovery and account selection | Vault/Pool and authenticated build artifacts |
| Quote/authorization binding | Conversation history and model picker | Provider access and pinned tariffs |
| One-time inference dispatch | Display content, balances, expiry and progress | Control service, indexer, signer and challenger |
| Receipt and successor verification | Explicit new-send and recovery actions | Availability, monitoring and release validation |
| Durable financial transaction recovery | Protect the app origin and local custody | Publish independently verifiable configuration |

A **note** is the private balance plus the secrets needed to spend or withdraw
it. A **session** authorizes bounded API usage. A **settlement** is a verified
update to that balance. A **journal** saves operations encrypted on the user's
device so interrupted work can be recovered.

Amounts are decimal strings of integer micro-USDC. `"2000000"` means 2 USDC.
An authorization cap reserves spending capacity; it is not the API charge.
SOL for transaction fees and account rent is separate.

For an existing AI application, follow the [clientd quickstart](clientd-quickstart.md)
and set its OpenAI-compatible base URL to `http://127.0.0.1:8787/v1`. The API key
is the local inference token; provider management keys remain with the operator.
See the [application guides and compatibility table](../integrations/README.md)
for OpenClaw, Claude Code and Codex. A configurable endpoint does not by itself
establish compatibility with the client's request format.
