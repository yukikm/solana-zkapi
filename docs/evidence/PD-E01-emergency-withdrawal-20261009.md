# E01: original deposit recovery and zero-AUTH emergency withdrawal

**E01 completed on 2026-10-09.** The installed native release `0.2.0-devnet.3` recovered the original one-micro-USDC Devnet deposit, initiated escape, waited for the authenticated chain Clock to reach the stored deadline, and returned **1 micro-USDC**. The original note is closed. The final operator cut retained the same four settled sessions, four complete reservations and all 25 recovery checkpoints, with **zero new persisted AUTH sessions or reservations**.

This is the active-note `initiate_escape` path with no pending AUTH session. It does not exercise unresolved-session emergency recovery or an operator challenge. The [companion JSON](PD-E01-emergency-withdrawal-20261009.json) pins the saved commands, exact signed transactions, deadline observations, final journal and independent collectors. No new implementation or installed release was needed for this completion.

## Original deposit and preserved history

At **00:56:12 UTC**, an explicit saved-wallet advance completed observation of the existing deposit; the deposit was neither recreated nor resent in this continuation. At **00:56:22 UTC**, the wallet was active at journal revision 4 with balance 1 micro-USDC. This no-resend conclusion joins the operator execution record with the installed inline-deposit recovery branch; finalized transaction receipts alone do not count network sends.

The original deposit signature remains `639MZrhc3UL1d8PwmrpkQgNst9J69QEg68YjV1Sbx7ghnLwydGr5HG1Bk1ib6qBJBMp5moCZ4p7xrfi5C64VYbPC`, finalized at slot **508866751**. Its 995-byte signed wire SHA256 is `0a09cef5537fc9f488a1f15edcf8166290d574b77fdd827dd403c8f2eae9f6eb`. Note 1, the original custody and journal were preserved; no wallet reinitialization or history deletion occurred.

The initial `pending` result, two later `unknown` observations, the post-gateway `client_request_failed`, the public signature-status HTTP429 and the released WalletChain `finalized indexer unavailable` observation remain preserved. Successful independent observations of the same original deposit are recorded separately. Those earlier results are not relabeled as an unsent deposit or a failed on-chain transaction.

## Escape deadline and finalization

Escape preparation completed at **00:56:50 UTC**. All five buffer/escape transactions were individually checked against the exact journal bytes and finalized RPC records. The saved advance completed escape execution at **01:10:38 UTC**. A released WalletChain snapshot at **01:10:52 UTC** showed `pending_escape`, Pending balance 1 micro-USDC, and deadline **1791509990 (01:39:50 UTC)**. Its chain Clock was still 1,738 seconds before that deadline.

A second retained observation at **01:35:53 UTC** was still 238 seconds early. At **01:40:08 UTC**, the authenticated account cut at slot **509015721** showed Clock **1791510006**, 16 seconds beyond the same stored deadline. Only then did finalization preparation run. The operative gate was `Clock >= Pending.deadline`, not elapsed local wall time.

The finalization signature is `3KVZ97C6wxA7jZ82hmmXazdGL6uk72ir1YRxZrfhNcd7ALXqPZR9iufsVX9aYYHiwSrfGistp3QY9NnTcMDpsSk1`. It finalized at slot **509015884**, with a 593-byte signed wire SHA256 `296d822399f2953ebc246c0206d13273c1bdbe4d9396beeda80edec63d92b5bf`. The first advance returned `pending`; after independent finality verification, the saved observation advance returned `complete` at **01:42:07 UTC**.

The independent final collector verified all seven signed transactions:

| Transaction | Finalized slot | Wire bytes | Compute units |
| --- | ---: | ---: | ---: |
| Original compact deposit | 508866751 | 995 | 184,421 |
| Create escape buffer | 509004960 | 397 | 17,333 |
| First append | 509007126 | 1,232 | 14,756 |
| Second append | 509007458 | 670 | 14,756 |
| Seal buffer | 509007774 | 286 | 15,320 |
| Execute escape | 509008109 | 656 | 348,704 |
| Finalize escape | 509015884 | 593 | 48,607 |

## Final chain, journal and operator agreement

The final chain collector at **01:42:37 UTC** matched signatures, signed wire/message bytes, instructions and token deltas. It verified the one-micro-USDC deposit and one-micro-USDC return. At account slot **509016348**, Note 1 was `closed` and Pending had `exists=false`; its account and deadline remained retained. The collector made ten read-only RPC requests and no transaction send. Receipt SHA256: `208951ccc21c3266a2ba425384f3dc827b75e4b4176f964f453357a85544209c`.

The final journal at **01:42:16 UTC** was closed at revision **19**, digest `09318a607128051690f5636b82df26a5b3634a1682750d4238f5ded67aaf0415`. It retained three completed wallet operations and all seven signed attempts, with zero AUTH history, zero settled sessions and no pending session. Its retained balance field is historical, not spendable funds. Read-only projection receipt SHA256: `52d8515ded130c05b046f78474508f2765a73913e0e2eb58e1c5fa77254a1be7`.

The complete operator comparison ran at **01:43:03–01:43:08 UTC**; the separate safe fetch completed at **01:43:55 UTC**. All financial table rows and reservation identity matched the writer-install baseline. DB SHA256 remained `49c3b1387f2916e8fe94c4672ebb848f22b73b98787f99e2483bfb9c06260f16`; reservations SHA256 remained `29be8a5b46f7efc666b8ad623093ab83a133365ef42cee036ea533453c337706`. Four sessions remained settled, four reservations remained complete, all 25 recovery checkpoints remained present, and no new persisted AUTH session or reservation appeared. Six service process identities were unchanged across this collector. The 5,470-byte fetched receipt SHA256 is `b64c689c0fe4f5f7f1819f3201e4eb277781e680fa06b5494edaf9dfa70796da`.

Wallet destination and treasury share an owner. The restored wallet token balance therefore does not erase earlier provider charges; the E01 conclusion joins exact transaction deltas, the zero-AUTH journal and unchanged full operator rows. The operator collector establishes persisted-state equality, not an HTTP AUTH request or provider packet count.

## Preserved preparations and limits

The read-only Python profile lookup's local CA failure is retained in root task tool output only; no separate filesystem failure receipt exists. Its replacement used curl with ordinary TLS verification. The first current-finality collector rejected a truncated hardcoded genesis after one `getGenesisHash` request; its response and failure remain separate from the corrected collector using the full pinned genesis. Neither preparation performed a financial mutation or bypassed TLS verification.

The operator helper's 114-character Comment was caught by local inspection and shortened to 95 characters in a separately preserved preparation **before rendering or dispatch**. This was not an AWS validation failure: prepared-01 was never dispatched, and the collector/fetch execution bodies were unchanged. Both earlier evidence drafts and all saved pending/unknown results remain preserved.

Finality here is finalized RPC evidence, not a cryptographic consensus proof. This checkpoint makes no global Vault-zero, provider packet-count, funded browser, unresolved-session emergency/challenge, external provider-cost reconciliation, continuous-readiness or full release-gate claim. Public readiness and broader core completion are separate records.
