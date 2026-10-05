# I10 real-provider acceptance preparation

This workflow uses the existing provider adapters, `controld`, shared PostgreSQL ledger, isolated `signerd`/`dispatcherd`, and SDK `ControlClient`/`WalletClient`. It does not create a second financial state machine. The preparation and offline tests described here do not pass G3. Current public devnet wallet/challenger evidence is recorded separately in [I10 evidence](evidence/I10.md).

The user authorized a total provider test budget of **10 USDC**, represented as `10000000` integer micro-USDC, with the explicit test assumption `1 USD = 1 USDC`. No provider request is made by the preflight or credential preparation commands. A configured credential is not evidence that its account has the necessary permissions, available balance, model access, or compatible usage reporting.

On October 5, the configured OpenAI key passed an authenticated model-metadata read and the configured ordinary OpenRouter key passed its current-key metadata read ([OpenAI](evidence/I10-openai-model-access-node-results.json), [OpenRouter](evidence/I10-openrouter-key-access-results.json)). These are read-only authentication observations, not inference or billing acceptance. The current parent campaign has already been initialized once. Keep its existing directory and all reservations; do not run a fresh budget initialization for a new provider or UI profile.

On October 5 at 03:57 UTC, **one actual OpenRouter proxy Chat tools case passed**: HTTP 200, one inference send and zero replays, `PROXY_USAGE`, a charge of 18 micro-USDC, and SDK verification of the signed successor. It used one quote request and 14 recovery attempts for the exact saved AUTH; those are not additional inference sends. The actual devnet deposit → provider use → verified settlement → mutual close completed in nine finalized transactions, maximum 360,266 CU/1,232 bytes. Wallet and treasury ownership coincide in this test, so the final wallet balance of 38,010,000 and Vault zero is consistent with the separately verified 18-micro-USDC charge ([case](evidence/I10-openrouter-tools-case-results.json), [lifecycle](evidence/I10-openrouter-tools-runtime-results.json)). The [immutable campaign report](evidence/I10-openrouter-tools-acceptance-results.json) records three retained reservations totaling **57,831 micro-USDC**, with **9,942,169 remaining**. SSE remains unreserved and UI Chat remains unconsumed. This is a selected-case pass; full G3/I10 and actual Chrome/Phantom acceptance remain incomplete.

The first native OpenAI Responses case stopped at an uncertain AUTH before inference. Its 10,000,000 test micro-USDC deposit was fully recovered through a permanent signed clearance and ordinary SDK mutual close: nine finalized transactions, maximum 338,395 CU, no inference replay. Its 19,277-micro-USDC campaign reservation remains consumed ([failure](evidence/I10-openai-native-auth-initial-failure-results.json), [recovery](evidence/I10-openai-native-auth-recovery-results.json)).

The first OpenRouter proxy plain case did reach the provider. Read-only metadata for that exact generation reports HTTP 200, 14 native input tokens, two native output tokens, and **0.0000033 USD** actual provider cost. Metered acceptance failed; the SDK verified and retained an `UNKNOWN_OPERATOR_LOSS` / `waived_unknown` receipt charging the user zero. The response body was not retained, so the exact prior metering failure cause remains unproven. The 19,277-micro-USDC reservation remains consumed, with no inference replay or retroactive charge from the metadata. A separate verified SDK mutual close subsequently returned the full 10,000,000 test micro-USDC deposit: nine finalized transactions, maximum 355,063 CU, final wallet balance 38,010,000 and Vault balance zero. This is recovery success, not provider acceptance ([failure](evidence/I10-openrouter-native-initial-failure-results.json), [generation usage](evidence/I10-openrouter-generation-usage-results.json), [withdrawal](evidence/I10-openrouter-native-withdrawal-results.json)).

The separate OpenRouter SSE run stopped at [quote HTTP 503](evidence/I10-openrouter-sse-quote-failure-results.json), before proof preparation, budget reservation, AUTH or inference. Its selected case remains **unreserved**; at this recovery checkpoint the full campaign reserved 38,554 micro-USDC for the two earlier cases. Ordinary signed-clearance/mutual-close recovery returned its 10,000,000 test micro-USDC deposit in nine finalized transactions, maximum 338,227 CU/1,232 bytes, with wallet 38,010,000 and Vault zero ([withdrawal](evidence/I10-openrouter-sse-withdrawal-results.json)). This is neither an SSE inference result nor a provider acceptance pass.

## Credentials and account capabilities

Store API/management credentials in the repository's ignored, owner-only `.env`, or use owner-only absolute `_FILE` references. A wallet private key is not a provider credential. Each pair allows one nonempty source; blank placeholders are treated as absent. The tool only reads the listed provider variables and budget. It never copies wallet keys, RPC variables, or the rest of `.env` into reports/configuration.

| Mode | Raw variable; `_FILE` alternative | Required provider capability |
| --- | --- | --- |
| OpenAI proxy | `ZKAPI_OPENAI_API_KEY`; `ZKAPI_OPENAI_API_KEY_FILE` | Inference on the chosen documented model through Chat Completions and/or Responses; returned billable input/output/cache usage. |
| Anthropic proxy | `ZKAPI_ANTHROPIC_API_KEY`; `ZKAPI_ANTHROPIC_API_KEY_FILE` | Messages access for the chosen model, API version `2023-06-01`, supported cache usage fields. |
| OpenRouter proxy | `ZKAPI_OPENROUTER_API_KEY`; `ZKAPI_OPENROUTER_API_KEY_FILE` | Chat Completions inference and complete usage for the chosen model. This is an inference credential, independent of management rights. |
| OpenRouter direct | `ZKAPI_OPENROUTER_MANAGEMENT_KEY`; `ZKAPI_OPENROUTER_MANAGEMENT_KEY_FILE` | Create/list/read/disable/delete restricted keys; exact USD cap, fixed expiry, no periodic reset, BYOK included in the cap, and observable disabled-key usage. |
| OA-org direct | `ZKAPI_OA_ORGANIZATION_KEY`; `ZKAPI_OA_ORGANIZATION_KEY_FILE` | Compatible OA-org issuance, reconciliation, final usage/retirement contract plus its pinned verifier and station. A generic OpenAI or OpenRouter inference key cannot substitute for this organization credential. |

OA additionally requires public `ZKAPI_OA_ISSUER_BASE`, `ZKAPI_OA_VERIFIER_BASE`, `ZKAPI_OA_INFERENCE_BASE`, and `ZKAPI_OA_STATION_ID`. The three bases must be HTTPS without embedded credentials/query/fragment. No endpoint is inferred from a response. Lease TTL is 60, 120, 180, 240, or 300 seconds. The adapter retains the upstream OA verifier contract; acceptance does not introduce or claim an independent attestation verifier.

OpenRouter management/inference are pinned to `https://openrouter.ai/api/v1`. Direct key retirement requires disable, exact usage including BYOK, two stable usage observations separated by the configured drain interval, durable usage checkpoint, then delete. The prepared configuration uses a 60-second drain; actual usage finality remains a live acceptance question. Missing/unavailable usage does not authorize another key or budget refund.

Proxy production destinations are fixed by the existing adapter: `api.openai.com`, `api.anthropic.com`, and `openrouter.ai`. Public-provider dispatcher scope disallows fixture URL overrides. Adapter code rejects redirects, environment proxies, unsupported metering/features, and automatic upstream retries. The explicit devnet profile remains test-only; mainnet/production restrictions remain intact.

## Public case plan and zero-spend preflight

The [reviewed I10 plan](../config/provider-acceptance.i10.json) now contains 18 small requests with a combined conservative reservation of **3,833,884 micro-USDC**, within the authorized 10,000,000. The [review record](../config/provider-acceptance.i10-review.json) pins each factual source summary by SHA-256 and records the unresolved inputs. These summaries contain reviewed public facts and retrieval metadata; they are not raw HTTP archives or authenticated API evidence. All tariffs have operator fee zero and are valid from October 4 through **before October 11, 2026 UTC**. Recheck public prices and availability before use; do not overwrite an initialized campaign when that window expires.

| Selected model | Native cases | Full context / model output limit | USD per million tokens: input / cache read / output | Conservative reservation per case |
| --- | --- | --- | --- | --- |
| OpenAI `gpt-4o-mini-2024-07-18` | Chat and Responses, each plain / SSE / tools / tools+SSE (8) | 128,000 / 16,384 | 0.15 / 0.075 / 0.60 | 19,277 micro-USDC |
| Anthropic `claude-haiku-4-5-20251001` | Messages, plain / SSE / tools / tools+SSE (4) | 200,000 / 64,000 | 1 / 0.10 / 5; 5-minute writes 1.25, 1-hour writes 2 | 400,640 micro-USDC |
| OpenRouter `openai/gpt-4o-mini` | Proxy Chat, plain / SSE / tools / tools+SSE (4) | 128,000 / 16,384 | Standard routing: 0.15 / 0.075 / 0.60 | 19,277 micro-USDC |
| OpenRouter `openai/gpt-4o-mini` | Direct Chat, plain / SSE (2) | Requests limited to 128 output tokens | Provider-reported USD, no fixed token tariff | Entire 1,000,000-micro-USDC lease cap |

Every request limits output to 128 tokens and uses a 300-second session TTL. The OpenAI page lists the pinned snapshot and supported native APIs without a deprecation label; [its model page](https://developers.openai.com/api/docs/models/gpt-4o-mini) and [caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) support the existing inclusive-read tariff. [Haiku's model page](https://platform.claude.com/docs/en/models/haiku-4-5/overview) lists an active model and the five selected rates. Thinking, media, server tools, batch, priority, and regional premium modes are not requested. These short cases do not establish that every cache bucket was exercised.

[OpenRouter's model page](https://openrouter.ai/openai/gpt-4o-mini) supports the selected Standard routing prices. Its model ID remains a routing alias, not an immutable snapshot; account routing/settings must not introduce different pricing. [Its usage contract](https://openrouter.ai/docs/cookbook/administration/usage-accounting) supplies final native usage. Management-key rights and response compatibility still require live verification. Provider-internal routing does not authorize any retry by this coordinator.

The real request circuit requires the current note balance to cover the fixed Pool cap: [native prover](../apps/clientd/prover/src/lib.rs) passes the quote cap to `solvency_bound`, and [RequestCircuit](../vendor/ethereum-zkapi/protocol/rust/crates/zkapi-proof/src/groth16.rs) enforces `balance >= solvency_bound`. A note funded with exactly 1,000,000 micro-USDC could not authorize the next session after a nonzero charge. The planned dedicated devnet note therefore deposits **10,000,000 test micro-USDC**, while the Pool/session cap stays **1,000,000**. Even the aggregate conservative maxima leave 6,166,116 in that note. Testnet collateral and the real external-provider budget are distinct; this is not approval to spend more than the existing 10-USDC provider authorization.

OA remains explicitly undetermined: its issuer/verifier/inference bases, station, compatible model and organization access are not inferred. The 18-case plan therefore cannot establish all of G3 or I10. The parent campaign is already initialized; adding OA requires a later audited extension that preserves the same authorized total and all prior reservations; deleting state or starting a fresh 10-USDC budget is forbidden. The unallocated 6,166,116 micro-USDC is not an additional authorization.

OpenAI model metadata access and OpenRouter ordinary-key authentication are confirmed as described above; complete native API/mode usage acceptance and remaining account capabilities are still pending. The current [Anthropic usage schema](https://platform.claude.com/docs/en/api/typescript/messages) describes `output_tokens_details.thinking_tokens` as a nonnegative subset of the inclusive billed `output_tokens`. The implemented parser accepts this known optional metadata, requires the count not to exceed the inclusive output total, and preserves tariff units and unknown-field rejection. This compatibility work is not a public metered-response pass.

[OpenRouter's response schema](https://openrouter.ai/docs/api_reference/overview) includes optional `completion_tokens_details.image_tokens`. The parser now permits this field **only for OpenRouter Chat and only as the integer zero**; absence remains valid. Positive, null, malformed or unknown usage fields still fail closed. Inclusive output billing and signed tariff units are unchanged. Nineteen adapter tests, including actual loopback JSON/SSE and every two-fragment SSE boundary, passed alongside strict Clippy. These synthetic regressions neither identify the lost prior response's exact failure nor change its signed zero-charge waiver ([compatibility evidence](evidence/I10-openrouter-usage-results.json)).

For a different reviewed plan, start from [the empty public template](../config/provider-acceptance.example.json). Each model entry is:

```json
{
  "profile": {
    "provider": "openai",
    "model": "REPLACE_WITH_VERIFIED_MODEL",
    "endpoints": ["chat_completions", "responses"],
    "context_tokens": 1,
    "max_output_tokens": 1,
    "cache_mode": "inclusive_read"
  },
  "tariff": "REPLACE_WITH_EXISTING_TARIFF_OBJECT",
  "sources": [{
    "url": "https://REPLACE_WITH_PRIMARY_DOCUMENT",
    "retrieved_at": "2026-10-05T00:00:00Z",
    "file": "saved-primary-source.txt",
    "sha256": "REPLACE_WITH_SHA256"
  }]
}
```

The example placeholders are not executable model limits or prices. Use the existing `Tariff` wire structure from [the provider contract](../services/control/PROVIDERS.md) and [API specification](specs/api-proxy.md). `tariff_hash` is SHA-256 over JCS of the tariff body without that field. Integer rate numerators are nano-USDC; denominators are unit counts. Include every applicable cache rate in canonical order. Direct tariffs use `profile: null`, `model: "*"`, `pricing_basis: "provider_reported_usd"`, and empty rates. The selected inference model is still explicit in each direct case.

Each case has exactly these fields:

```json
{
  "id": "openai-chat-plain",
  "mode": "proxy",
  "provider": "openai",
  "model": "REPLACE_WITH_VERIFIED_MODEL",
  "endpoint": "chat_completions",
  "stream": false,
  "tools": false,
  "max_output_tokens": 32,
  "max_cost_micro_usdc": "1000000",
  "session_ttl_seconds": 60
}
```

Supported cases are OpenAI Chat/Responses, Anthropic Messages, OpenRouter Chat, and Chat through either direct mode. Plain, SSE and client tool cases are explicit flags. `count_tokens` is omitted from this spending coordinator until its operator-funded external cost bound is confirmed; the existing local adapter tests cover its protocol. This is not a new G3 requirement or a claim that its public cost is zero.

Use documented **full** context/output limits. The existing proxy reserves full context at the highest applicable input/cache rate plus the requested maximum output, with exact integer rounding. Do not reduce context limits to make a tiny prompt fit a budget. A tariff that cannot faithfully represent a provider's tiered/additional charges is not ready for this adapter. For direct mode, reserve at least the entire signed quote/lease cap. Sum of planned case maxima must fit the 10-USDC campaign; output/request limits are explicit. There is no account-wide enforcement against unrelated activity using the same credentials.

```sh
python3 scripts/provider_acceptance.py preflight --plan config/provider-acceptance.i10.json --env-file .env
python3 scripts/provider_acceptance.py prepare --plan config/provider-acceptance.i10.json --env-file .env
python3 scripts/provider_acceptance.py budget-status --plan config/provider-acceptance.i10.json
```

The full-plan commands above are generic preparation examples; currently available providers should use the selected-profile command below. `budget-init` is first-initialization-only and has already run for this campaign; it is intentionally absent here. `preflight` has zero network calls. Raw values are checked in memory; `_FILE` references get metadata checks without reading credential contents. `prepare` copies only configured, whitelisted credentials to mode-0600 files under ignored `target/i10-provider-acceptance/credentials/`, writes immutable `providers.json` and `tariffs.json`, and never modifies supplied credential files. A changed credential/configuration refuses overwrite. All errors are sanitized; no plaintext key, provider body, or RPC URL is printed. The native configuration validator must still run. Preparation does not issue an upstream key or verify account permissions.

Use **one persistent campaign directory and plan for this authorization**, including restarts. Do not create a new state directory, delete budget state, or reinitialize a budget to recover from uncertainty. Missing/substituted state fails closed. The budget is an external test coordinator, independent of user billing: each maximum is durably reserved before possible provider issuance/inference, and remains consumed even after success. This conservative implementation offers no refunds. Repeating a reserved case is rejected even if the process died before sending. A result without authoritative usage cannot release budget, and inference is never automatically replayed.

The live browser demo also supports an explicitly selected `explicit_demo` request policy. Once the SDK has verified the previous session's signed successor, a user may prepare a **new** authorization and operation using the same pinned OpenAI Chat template. The host uses `reserve-demo --case openai-chat-plain --request-id <new-session-UUID> --operation-id <new-operation-UUID>` before forwarding that operation. This appends a typed `explicit_demo` reservation to the **same** parent budget, retaining the original plan hash, identity and all prior reservations. Each row binds its template, new session and new operation; repeated sessions or operations fail closed, including after restart or an uncertain persistence result. It is not a retry of the consumed acceptance case and cannot become an acceptance-case pass.

Demo reservations consume both the existing 10,000,000-micro-USDC total and the original `max_requests: 18` limit. They do not add capacity or automatically extend the 18-case acceptance campaign; completing all original cases after additional demo operations would require a separately reviewed count extension under the same total authorization. A new authorization also requires balance at least the existing fixed Pool cap. After a positive charge, a note initially funded with exactly 1,000,000 micro-USDC is below that cap and must be withdrawn rather than silently reauthorized. No circuit or cap check is relaxed.

An available provider can run an immutable subset of the original plan without waiting for other providers. `--role`, `--profile`, and repeated `--case` options select execution only. The selector pins the full parent plan hash and writes only matching providers/tariffs under `configurations/<profile>`; it does not create another budget. The native runner validates the selection and exact tariffs before accessing the wallet or depositing. Use the matching profile directory for the backend's `--provider-state` and keep the helper's `stateDir` at the common campaign root.

```sh
python3 scripts/provider_acceptance.py prepare --plan config/provider-acceptance.i10.json --state-dir target/i10-provider-acceptance --env-file .env --role openrouter --profile openrouter-native-sse --case openrouter-proxy-sse
python3 scripts/provider_acceptance.py budget-status --plan config/provider-acceptance.i10.json --state-dir target/i10-provider-acceptance
```

The current `openai-native` profile selects the consumed `openai-responses-plain` case; `openrouter-native` selects the consumed `openrouter-proxy-plain` case. Neither may be rerun. `openrouter-native-tools` now selects the successfully completed, also consumed `openrouter-proxy-tools` case; resume verifies its saved evidence without resending. `openai-ui` exclusively allocates the still-unconsumed `openai-chat-plain` case to Chrome/Phantom; profile allocation is not a consumed budget reservation. Native lifecycle is forbidden on `openai-ui`. The `openrouter-native-sse` command above records the profile used by the failed quote-only run. Its checkpoint and completed withdrawal remain historical; do not interpret this example as an instruction to rerun that lifecycle. The selected `openrouter-proxy-sse` case has no budget reservation, AUTH or inference, and has not passed. Each profile has a separate Pool/manifest/journal while retaining the same full 18-case plan and global budget.

## Actual acceptance execution

1. Pin the plan's tariff hashes into the dedicated devnet manifest before backend identity initialization. Reuse the actual devnet build/IDL/PoolConfig. Keep private signer/ledger state together with its immutable identity; do not replace an existing pool's manifest underneath its ledger.
2. Start the existing backend launcher with its explicit `--provider-state target/i10-provider-acceptance/configurations/<profile>` option for a selected profile. It prepares an isolated dispatcher, validates the explicit devnet/public-provider scope using `dispatcherd CONFIG --check-config`, and keeps provider credentials out of the control process configuration. Preparation/config checks do not prove provider access.
3. Through the existing wallet runner, finalize/import a note and call `runDevnetProviderAcceptance` from [the devnet integration helper](../scripts/i10_devnet_provider.ts). The caller supplies the verified manifest/artifacts, real prover, journal, finalized chain connection, pinned fetch, and native verifier. The helper requires an already initialized budget; it cannot manufacture fresh capacity.
4. Each case uses actual `ControlClient.quote`, `NoteProver.prepareSession`, shared-ledger AUTH, one native inference request, then close/recovery. Before any possible issuance/send, the Python coordinator reserves that exact case maximum. Direct leases may never exceed it. Before proof/reservation, bounded quote availability recovery retries the same quote parameters and verifies the returned signature, pins and times. A successful request signs/stores a fresh quote UUID; a lost ACK can leave an unused quote row, so quote creation is not read-only or idempotent. It creates no session/nullifier reservation, provider key or inference. Once AUTH is prepared, a transient AUTH failure may recover only the exact saved AUTH before its existing quote deadline, bounded by 120 seconds; this does not generate a new quote, proof, reservation or inference. A response is bounded and consumed once; its content is not written to the report.
5. Require the actual signed receipt (`PROXY_USAGE`, `OPENROUTER_USAGE`, or `OA_SIGNED_RECEIPT`), metered reason, evidence digest, verified successor, exact operation/body identity, and bounded charge. A waived/unknown receipt does not pass provider acceptance. Afterwards the caller withdraws through the existing `WalletClient` and independently verifies balances/receipts.

`runDevnetProviderAcceptance` stores immutable campaign/case reports. Completed-case resume revalidates the actual native settlement against the SDK history, exact plan/tariff/body, receipt and budget reservation before skipping it. A reserved-but-unreported case stops for explicit recovery; no new AUTH/inference replaces it. Failed inference attempts still close the same SDK session where possible, retaining its journal and full reservation. The helper itself sends no Solana transaction and reads no wallet fee key. A completed profile report retains its original global-budget snapshot and exact bytes when another profile later adds reservations: resume independently checks the current budget and requires the saved reservations to remain its unchanged prefix.

OpenAI and ordinary OpenRouter credentials are configured. Remaining credential inputs include Anthropic inference access, OpenRouter management rights for direct mode, and OA organization access plus its configured endpoints/station/model. Existing ordinary OpenRouter access does not grant management rights. Full mode/API acceptance still needs compatible actual usage and sufficient account rights/credit; public prices and model availability must remain valid at execution. The 10-USDC budget is already authorized; entering credentials does not require granting another budget. If OA service access is unavailable, its direct gate remains unpassed. The saved local tests below do not substitute for any of these inputs.

## Failure diagnostics and withdrawal recovery

The native transport now emits only a six-field diagnostic projection: fixed event name, HTTP status, enumerated stage, elapsed milliseconds, completion flag and timeout flag. The backend retains stderr in a private owner-only append-only file across restarts; public reports must extract the allowed diagnostic fields, never copy that log. The SDK coordinator durably writes an immutable `provider-case-<case-id>-failure.json` with the parent plan hash, fixed stage/status/timing fields, bounded response byte count, whether SDK send was invoked, settlement status and zero inference replays. It records no response body, key, URL or exception text. These checkpoints provide failure evidence, never replay/refund authority; they cannot reconstruct the earlier lost OpenRouter body. The [offline diagnostic report](evidence/I10-provider-diagnostics-results.json) records 38 Node tests, 12 real loopback HTTP cases and two private-log tests.

For a settled case that failed acceptance, [the read-only recovery verifier](../scripts/i10_devnet_provider_recovery.ts) binds the existing journal to the exact selected parent case, request body, model, tariff, operation, receipt, cap and retained global-budget reservation. It requires no pending session and exactly the recorded settled history, then uses the supplied actual `NativeSessionVerifier` to verify the signed successor against the current state. An existing mutual-close operation or already closed wallet can be revalidated on restart. It accepts a valid metered receipt or the narrowly defined signed zero-charge proxy waiver for withdrawal eligibility; neither turns a failed acceptance into a passed case. It cannot send, edit the journal or bill from external generation metadata. Its [28 offline tests](evidence/I10-settled-provider-recovery-results.json) include invalid receipt/state/case/budget checks with real Ed25519 fixture signatures and explicitly synthetic proof/successor verification.

The native runner's `--withdraw-settled-provider-case` flag requires the existing provider plan/profile, lifecycle journal and campaign. It verifies that recovery evidence before wallet advancement and again on closed resume, skips provider acceptance, and uses ordinary `WalletClient` mutual close without creating another deposit or inference. This differs from `--recover-unaccepted-provider-auth`, which uses `WalletClient.reconcileUnacceptedAuthorization` and a permanent signed clearance to archive an uncertain, unaccepted AUTH in the same journal. HTTP absence or an empty database alone authorizes neither recovery path. Both preserve the original failed case and consumed reservation; their reports explicitly leave provider acceptance and G3 false.

For a quote-only failure, `--withdraw-unstarted-provider-case` instead requires the exact immutable quote-503 checkpoint, no saved AUTH/session history, the original unsigned deposit state, and **absence** of the selected case from the valid parent budget. The existing campaign/manifest/Pool/profile/journal identity must match. This read-only guard creates no reservation and makes no cryptographic absence claim; ordinary `WalletClient` permanent clearance and finalized Note/proof checks still authorize withdrawal. The [corrected 73-test report](evidence/I10-quote-before-reservation-recovery-results.json) preserves all 28 settled-case tests, which still require a reservation. The [initial 73-test report](evidence/I10-unstarted-provider-recovery-results.json) incorrectly assumed a quote-stage reservation and is superseded implementation history; its [actual guard refusal](evidence/I10-unstarted-recovery-initial-guard-results.json) occurred before financial action. The separate [47-test quote-wait report](evidence/I10-provider-quote-retry-results.json) covers bounded pre-AUTH recovery and does not establish public inference success.

## Offline validation commands and scope

```sh
python3 scripts/test_provider_acceptance.py
target/i08-toolchain/bin/node node_modules/typescript/bin/tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --resolveJsonModule --lib ES2023,DOM --types node scripts/provider_acceptance_client.test.ts scripts/i10_devnet_provider.ts scripts/i10_devnet_provider_recovery.test.ts
target/i08-toolchain/bin/node --test scripts/provider_acceptance_client.test.ts scripts/i10_provider_report.test.ts scripts/i10_devnet_provider_config.test.ts scripts/i10_devnet_provider_recovery.test.ts
python3 scripts/test_i10_provider_diagnostics.py
cargo test --manifest-path services/control/Cargo.toml --locked --test proxy_adapters --test proxy_diagnostics
```

Python tests cover private idempotent normalization, environment whitelisting/redaction, exact conservative budget bounds, concurrent reserve-once behavior, missing/corrupt state refusal, and failure before/after persistence. TypeScript tests use actual encrypted SDK journals and `ControlClient`, with explicitly synthetic HTTP/proof/successor fixtures, to verify one-shot inference, close-after-uncertainty, refusal of waived/missing evidence, budget-before-AUTH and completed-report resume binding. These are orchestration regressions; the separately linked actual OpenRouter tools report establishes only that selected public case. Full I10 remains incomplete until its remaining provider and wallet-UI acceptance is satisfied.
