# SDK reference

Start with [Integrate the SDK](../getting-started/sdk.md).
To use an existing AI client, [install clientd](../getting-started/clientd.md).

| Reference | Contents |
|---|---|
| [API](api.md) | Client factories, inference, wallet and status methods |
| [Recovery](recovery.md) | Pending operations, settlement, withdrawals and storage failures |
| [Deployment inputs](deployment.md) | Manifest, artifacts, model bindings and custody configuration |
| [Public profiles](public-profile.md) | Authenticated profile loading and verification |
| [Models](public-models.md) | Model/API/mode and tariff selection |
| [Distribution](distribution.md) | Package contents, workers and integrity pins |
| [Kit migration](kit-migration.md) | Changes from the first preview's Solana API |

A note holds private balance and spending secrets. A session authorizes bounded
usage. Settlement updates the balance with a verified receipt. The encrypted
journal retains financial recovery state; the application owns conversation history.

Amounts are integer micro-USDC strings: `"2000000"` means 2 USDC.
SOL for fees and rent is separate. See [support](../support.md) for preview limits.
