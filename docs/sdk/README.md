# SDK overview and reference

The SDK handles funding, local proofs, authorization, signed settlement and
withdrawals. Your application handles wallet selection, conversation history,
model selection and the interface.

1. Follow [Build a browser app](../getting-started/sdk.md) from a clean app install
   through wallet selection, funding, Chat and recovery.
2. Configure [deployment inputs](../getting-started/deployment-inputs.md), or use the public Devnet
   [profile and downloads](../getting-started/public-devnet-preview.md).
3. Add [recovery controls](../getting-started/recovery.md) and consult the [API reference](api.md).

Published clients are `0.2.0-devnet.8`; use the [release guide](../releases/usability-preview.md)
for downloads and upgrade guidance. The public preview uses operator-funded
usage without a fixed trial allowance; check [funding and access](../getting-started/devnet-funding.md)
and fresh preflight before use. See [status](../status.md) for current service
observations, tested combinations and remaining limits.
Upgrades from the first preview require the [SDK migration guide](../getting-started/sdk-migration.md).

## Responsibilities

| SDK | Application | Operator |
|---|---|---|
| Local proofs and encrypted note storage | Wallet/account selection | Vault, Pool and authenticated artifacts |
| Authorization and spending caps | Model picker and conversation history | Provider access and tariffs |
| Receipt verification and recovery | Explicit send and recovery actions | Services, availability and monitoring |

A **note** holds the private balance and spending secrets. A **session**
authorizes bounded API usage. A **settlement** updates the balance using a
verified receipt. The encrypted **journal** saves financial operations locally.
Current releases omit new direct request bodies and redact proxy bodies before
dispatch; see [retention details](../getting-started/recovery.md#local-request-retention).
It does not restore lost chat
responses; the app must manage its own history.

Amounts use integer micro-USDC strings: `"2000000"` means 2 USDC. The
session cap reserves capacity; the actual charge may be smaller. SOL for fees
and account rent is separate. Recovery never replays inference.

For an existing AI application, use the [clientd quickstart](../getting-started/clientd.md)
and [compatibility table](../integrations/README.md). The optional
[reference browser app](https://github.com/yukikm/solana-zkapi-client) is maintained
separately.
