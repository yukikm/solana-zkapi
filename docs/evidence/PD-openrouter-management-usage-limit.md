# OpenRouter management-usage limitation

At the **2026-10-08 13:31:26 UTC** operator cut, N-02 and N-03 each had a valid signed zero-charge settlement, while OpenClaw separately reported **USD 0.0008349** of provider-billed cost. **External provider-cost reconciliation is not established.** This is a demonstrated metering-acceptance gap; it does not close final-cost accuracy or G3. The existing signed charges remain final and are not retroactively increased. [Machine-readable evidence](PD-openrouter-management-usage-limit.json).

| Case | Management usage after key disable | Selected charge |
| --- | --- | --- |
| N-01 | 60 s: zero; 120 s and 180 s: 5,850 nano-USDC | 6 micro-USDC |
| N-02 | 60 s and 120 s: zero | 0 micro-USDC |
| N-03 | 60 s and 120 s: zero | 0 micro-USDC |

These are nominal intervals supported by saved timestamps, not latency guarantees. Both new receipts are `OPENROUTER_USAGE`, `billing_effect: charge`, `reason: metered`; neither is a waiver. The independent native observer verified all three signed histories and a balance of 4,999,994 micro-USDC. The read-only operator cut retained three reservations, three settled sessions, three signed settlements/receipts and all 19 checkpoint rows. No reservation was reclaimed. The two evidence channels report different costs; the provider's internal reason remains unknown.

## What the current implementation attests

The [OpenRouter adapter](../../services/control/src/direct/openrouter.rs) requires the disabled key to match its saved reference and reads both management `usage` and `byok_usage`. [Exact decimal conversion](../../services/control/src/quote.rs) sums these and rounds upward to nano-USDC; the zero is not micro-unit truncation. [Reconciliation](../../services/control/src/direct/runtime.rs) waits the configured grace after disable, then requires two equal normalized samples separated by another grace. It durably saves the selected usage before deleting the key. [Receipt construction](../../services/control/src/provider_runtime.rs) signs this selected observation, capped by the accepted session limit.

Thus the recorded counters and signed arithmetic agree. `operator_loss_nano_usdc: 0` is arithmetic against the selected counter; it does **not** prove absence of external operator loss. The [existing adapter contract](../../services/control/PROVIDERS.md) already describes stabilization as an operational rule rather than a mathematical finality guarantee. The [billing specification](../specs/api-proxy.md), however, requires a final USD total for complete direct-metering acceptance; these observations do not establish that requirement.

OpenRouter documents [management-key counters](https://openrouter.ai/docs/api/api-reference/api-keys/get-key), [response usage cost](https://openrouter.ai/docs/cookbook/administration/usage-accounting), and [generation-specific metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation). The reviewed pages provide no key-counter finality marker or maximum update delay after disable. A longer grace or equal nonzero samples alone would not prove completeness.

## Preview boundary

The invitation-only Devnet preview may continue the separately authorized bounded lifecycle and recovery work with this operator-undercollection limitation explicit. This is not reconciled provider billing, permission for a new cap grant, or a broader production claim. Existing receipts, reserved exposure and failed observations remain preserved. Customer recovery/withdrawal follows the verified signed state; there is no inference replay, retroactive charge, indefinite zero-usage hold or new waiver format in this follow-up.

A complete metering remedy needs a reviewed accounting contract and authoritative completeness evidence, or an explicit compatible operator-loss policy. Client-reported cost alone cannot silently replace operator evidence. Any later authenticated provider observation must remain separate from the already final customer charge. This document changes no runtime, service, configuration, release or financial state.
