# Application developer guide

The SDK handles funding, local proofs, authorization, signed settlement and
withdrawals. Your application handles wallet selection, conversation history,
model selection and the interface.

1. Install the [SDK tarball](distribution.md) and follow the [quickstart](quickstart.md).
2. Configure a [deployment bundle](deployment.md), or use the public Devnet
   [profile and downloads](public-devnet-preview.md).
3. Add [recovery controls](recovery.md) and consult the [API reference](api.md).

Published clients are `0.2.0-devnet.8`; use the [release guide](../releases/usability-preview.md)
for downloads and upgrade guidance. The public preview uses operator-funded
usage without a fixed trial allowance; check [funding and access](devnet-funding.md)
and fresh preflight before use. See [status](status.md) for current service
observations, tested combinations and remaining limits.
Upgrades from the first preview require the [Kit migration guide](kit-migration.md).

## Responsibilities

| SDK | Application | Operator |
|---|---|---|
| Local proofs and encrypted note storage | Wallet/account selection | Vault, Pool and authenticated artifacts |
| Authorization and spending caps | Model picker and conversation history | Provider access and tariffs |
| Receipt verification and recovery | Explicit send and recovery actions | Services, availability and monitoring |

A **note** holds the private balance and spending secrets. A **session**
authorizes bounded API usage. A **settlement** updates the balance using a
verified receipt. The encrypted **journal** saves financial operations locally,
including request bodies needed for recovery. It does not restore lost chat
responses; the app must manage its own history.

Amounts use integer micro-USDC strings: `"2000000"` means 2 USDC. The
session cap reserves capacity; the actual charge may be smaller. SOL for fees
and account rent is separate. Recovery never replays inference.

For an existing AI application, use the [clientd quickstart](clientd-quickstart.md)
and [compatibility table](../integrations/README.md). The optional
[reference browser app](https://github.com/yukikm/solana-zkapi-client) is maintained
separately.
