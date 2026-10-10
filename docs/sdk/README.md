# SDK reference

The SDK provides USDC custody, local proofs, usage authorization, signed
settlement and recovery for API integrations. Start with
[General API integration](../getting-started/api-integration.md) to understand
the shared lifecycle and current adapter boundaries.

The current source facade also exposes registered fixed-price POST JSON APIs;
follow the [local JSON API tutorial](../getting-started/json-api.md). Published
`.8` packages and the existing public profile retain their inference support.
For an inference integration with a supported deployment, follow the
[inference SDK tutorial](../getting-started/sdk.md). To use an existing AI client,
[install clientd](../getting-started/clientd.md).

| Reference | Contents |
|---|---|
| [API](api.md) | Client factories, wallet/status methods, registered JSON calls and inference methods |
| [Recovery](recovery.md) | Pending operations, settlement, withdrawals and storage failures |
| [Deployment inputs](deployment.md) | Manifest, artifacts, model bindings and custody configuration |
| [Public profiles](public-profile.md) | Authenticated profile loading and verification |
| [Models](public-models.md) | Model/API/mode and tariff selection |
| [Distribution](distribution.md) | Package contents, workers and integrity pins |
| [Kit migration](kit-migration.md) | Changes from the first preview's Solana API |

A note holds private balance and spending secrets. A session authorizes bounded
usage. Settlement updates the balance with a verified receipt. The encrypted
journal retains financial recovery state; the application owns its request and
response data, including conversation history for inference applications.

`ControlClient` and `WalletClient` share that journal, and `ClientDaemon` and the
application facade reuse their lifecycle. Lower-level imports do not bypass
the control service's provider, endpoint and tariff validation. A new API type
needs the corresponding adapter and contracts described in the general guide.

Amounts are integer micro-USDC strings: `"2000000"` means 2 USDC.
SOL for fees and rent is separate. See [support](../support.md) for preview limits.
