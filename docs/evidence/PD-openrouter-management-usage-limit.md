# OpenRouter management-usage limitation

The historical observations and prior assessment below are retained. The final
[policy follow-up](#current-policy-follow-up--ethereum-parity) records the user-selected
Ethereum parity policy and supersedes the earlier completion gate.

At the **2026-10-08 13:31:26 UTC** operator cut, N-02 and N-03 each had a valid signed zero-charge settlement, while OpenClaw retained **USD 0.0008349** of response cost labeled `provider-billed`. **Response cost and management counters disagree; eventual provider invoice and operator loss are not independently quantified.** Final-cost accuracy and G3 remain unestablished. The existing signed charges remain final and are not retroactively increased. [Machine-readable evidence](PD-openrouter-management-usage-limit.json).

| Case | Management usage after key disable | Selected charge |
| --- | --- | --- |
| N-01 | 60 s: zero; 120 s and 180 s: 5,850 nano-USDC | 6 micro-USDC |
| N-02 | 60 s and 120 s: zero | 0 micro-USDC |
| N-03 | 60 s and 120 s: zero | 0 micro-USDC |

These are nominal intervals supported by saved timestamps, not latency guarantees. Both new receipts are `OPENROUTER_USAGE`, `billing_effect: charge`, `reason: metered`; neither is a waiver. The independent native observer verified all three signed histories and a balance of 4,999,994 micro-USDC. The read-only operator cut retained three reservations, three settled sessions, three signed settlements/receipts and all 19 checkpoint rows. No reservation was reclaimed. The two evidence channels report different costs; the provider's internal reason remains unknown.

## Cost-provenance follow-up

A read-only inspection on **2026-10-08 16:04:39 UTC** joined the retained OpenClaw transcript to the installed OpenClaw / `@openclaw/ai` **2026.9.8** cost parser. The two assistant records retain **USD 0.00054795** and **USD 0.00028695**, each labeled `provider-billed`; all local input/output/cache cost components are zero. Their sum matches the preserved result above.

The installed SSE parser passes the response's `usage` to `parseOpenAICompletionsUsage`. That function first calculates catalog cost, then `applyProviderReportedUsageCost` copies a numeric **`rawUsage.cost`** into the total and assigns `provider-billed`. Local token-price calculation does not assign this label. The aggregate retains it only when each contributing call has it. This supports response-field provenance rather than an ordinary local price estimate.

The [JSON follow-up](PD-openrouter-management-usage-limit.json) pins the inspected source/package files, selected transcript-event bytes and redacted observation. The package and lock still match the original R5 inputs; the follow-up source hashes are current observations, not a newly asserted complete execution-time dependency snapshot. Raw upstream SSE was not retained, and no independent provider invoice was obtained. The supported finding is a **client-recorded response-cost versus management-counter discrepancy**, with its provider-internal cause and eventual accounting outcome unknown. Original evidence hashes, reservations and signed charges remain unchanged.

## What the current implementation attests

The [OpenRouter adapter](../../services/control/src/direct/openrouter.rs) requires the disabled key to match its saved reference and reads both management `usage` and `byok_usage`. [Exact decimal conversion](../../services/control/src/quote.rs) sums these and rounds upward to nano-USDC; the zero is not micro-unit truncation. [Reconciliation](../../services/control/src/direct/runtime.rs) waits the configured grace after disable, then requires two equal normalized samples separated by another grace. It durably saves the selected usage before deleting the key. [Receipt construction](../../services/control/src/provider_runtime.rs) signs this selected observation, capped by the accepted session limit.

Thus the recorded counters and signed arithmetic agree. `operator_loss_nano_usdc: 0` is arithmetic against the selected counter; it does **not** prove absence of external operator loss. The [existing adapter contract](../../services/control/PROVIDERS.md) already describes stabilization as an operational rule rather than a mathematical finality guarantee. The [billing specification](../specs/api-proxy.md), however, requires a final USD total for complete direct-metering acceptance; these observations do not establish that requirement.

OpenRouter documents [management-key counters](https://openrouter.ai/docs/api/api-reference/api-keys/get-key), [response usage cost](https://openrouter.ai/docs/cookbook/administration/usage-accounting), and [generation-specific metadata](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation). The reviewed pages document no key-counter finality marker or maximum update delay after disable. This is a limitation of the reviewed documentation and an inference about what those interfaces establish, not a claim that OpenRouter cannot offer other guarantees. A longer grace or equal nonzero samples alone would not prove completeness.

## Preview boundary

The invitation-only Devnet preview may continue the separately authorized bounded lifecycle and recovery work with this operator-undercollection limitation explicit. This is not reconciled provider billing, permission for a new cap grant, or a broader production claim. Existing receipts, reserved exposure and failed observations remain preserved. Customer recovery/withdrawal follows the verified signed state; there is no inference replay, retroactive charge, indefinite zero-usage hold or new waiver format in this follow-up.

A complete metering remedy needs a reviewed accounting contract and authoritative completeness evidence, or an explicit compatible operator-loss policy. Client-reported cost alone cannot silently replace operator evidence. Any later authenticated provider observation must remain separate from the already final customer charge. This document changes no runtime, service, configuration, release or financial state.

## Current policy follow-up — Ethereum parity

The user subsequently directed exact behavioral parity with Ethereum zkAPI.
At upstream commit `045b444ea1b52538d1b40273c7cb6ed09468a052`, directly
managed keys follow disable → configured grace → one captured `usage + byok_usage`
observation → durable persistence → confirmed deletion → capped immutable charge.
Upstream explicitly treats aggregate-accounting delay as an operator assumption;
it supplies no authoritative provider-final receipt for this path.

This selected contract **supersedes the stronger final-invoice/completeness gate
in the prior assessment above**. The [normative capture policy](../specs/api-proxy.md#direct-openrouter-capture-policy--ethereum-parity)
and [source comparison](PD-openrouter-ethereum-parity.md) record the boundary.
Delayed or unobserved cost remains the operator's risk. It cannot reprice an
existing signed charge; missing/invalid usage cannot become zero. No separate
reconciliation service or new paid matrix is required for the core preview.

The runtime parity change is currently a local candidate, not a deployment claim.
All original sample timings, signed zero receipts, reservations and the
USD 0.0008349 client-retained `usage.cost` discrepancy remain unchanged. Provider
invoice accuracy and the broader G3 matrix are not established by this policy
selection. No historical inference is replayed or customer retrocharged.
