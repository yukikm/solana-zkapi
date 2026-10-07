# Ethereum parity review and corrections

Date: 2026-10-07 JST. The requested pull brought the review baseline to Solana
`664db46e00f77659203b81482f2859ca04d25fc8`. The reference is
[ethereum/zkapi at `045b444ea1b52538d1b40273c7cb6ed09468a052`](https://github.com/ethereum/zkapi/tree/045b444ea1b52538d1b40273c7cb6ed09468a052),
also preserved under `vendor/ethereum-zkapi`, and the official
[Introducing zkAPI article](https://blog.ethereum.org/2026/10/01/introducing-zkapi).
This report records scoped engineering review, local verification and two
actual public-devnet OpenRouter direct cases for the resulting working tree. It is not an independent third-party audit, a claim of
complete upstream API compatibility, or a production release gate.

## Assessment

The implementation supports the principal zkAPI workflow: fund private credits,
authorize API use without selecting a public deposit in ordinary authorization
queries, use direct or proxy routes, verify the resulting balance transition,
and recover or withdraw through the existing journal and Vault lifecycle. The
browser conversation and native client now expose the relevant supported text
workflows, with explicit recovery when an operation is uncertain. The findings
below were corrected and the combined local SDK and UI checks passed. Actual
OpenRouter direct JSON and SSE also completed funding, inference, signed
settlement and withdrawal on a fresh public devnet deployment.

This supports describing the project as a **Solana devnet implementation of the
zkAPI workflow, with the supported scope and evidence stated explicitly**. The
current record does not support “every Ethereum feature works identically,”
“the entire live parity matrix has passed,” or “trustless/private against every
observer.” Mainnet deployment and third-party audit are planned later milestones;
their absence is not a defect for this devnet target.

The article describes unlinkable payment authorization, a short-lived API key
held in device memory and direct provider calls; it also recognizes network and
content correlation limits. Those are the comparison criteria here. The pinned
source, this project's deliberate USDC scope and actual recorded tests determine
the concrete compatibility claim. Neither the article's general architecture
nor a successful local fixture establishes a new live provider capability.

## Functional and UX comparison

| Capability | Current implementation and evidence | Limit of the claim |
|---|---|---|
| Funding and private authorization | USDC Vault, compact or legacy buffered deposit, common authenticated snapshots and local native/WASM proofs. The new privacy review reran shared-selector, pin and genuine path reconstruction checks. | Solana USDC settlement and transaction UX differ from the pinned Ethereum native-ETH path. Two new public native SDK cases each finalized a compact deposit and mutual close. This does not establish compact Phantom UX. |
| Native direct use | Direct OpenRouter and OA adapters, per-model provider/API/tariff bindings, volatile keys, bounded request validation and the existing management lifecycle. Native structured text output and client-tool schemas now pass the appropriate guards. | OpenRouter Chat JSON/SSE now have actual issuance, inference, management-checkpoint and signed-settlement evidence. OA and other advertised combinations still require their own live cases. Standard identity fields are explicitly rejected rather than silently removed as upstream does. |
| Third-party proxy | Shared metered proxy, exact request binding, operation UUIDs, bounded readers and signed successor validation. Historical actual OpenAI text and OpenRouter Chat tools cases exist. | A result for one provider/API/mode does not establish another. The supported metering subset does not include every provider extension. |
| Browser conversation | Standalone arbitrary text, prior turns, model/API selection, streaming, cancellation, expiry and recovery controls. Actual Chrome fixture scenarios exercise the current application. | A separately pinned local devnet build is now installed and serving. Existing Chrome blocks its localhost page with ERR_BLOCKED_BY_CLIENT; actual standalone Phantom, provider CORS and repeated live conversation remain unverified. |
| Repeated requests and model switching | Existing ControlClient, WalletClient and ClientDaemon settle/fence prior work before the next admitted request. Model changes retain their new request identity and exact accepted bytes. | Historical fixed-prompt Phantom demonstrations do not establish repeated conversation on the same note or all model/API combinations. |
| JSON/SSE consumption | Native APIs and bounded text consumers; terminal completion is required, cancellation holds admission through cleanup, and partial or tool-bearing output cannot become a completed text turn. | The text UI does not execute tools. Advanced applications must consume the native tool response. Images, audio, hosted tools, Realtime and arbitrary HTTP are outside this supported text scope. |
| Withdrawal and operator outage | Mutual close, unaccepted-AUTH clearance, same-journal emergency escape, challenge reconciliation, expiry/reproof and finalization. The host relay now accepts SDK escape uploads and finalization. | Earlier real-proof/SBF and public recovery receipts remain scoped historical evidence. The current full public application sequence still needs its own observation. |
| Recovery and local custody | Encrypted journal, explicit operation IDs, no automatic uncertain-inference replay and no direct-to-proxy fallback. New direct keys are memory-only; a fresh client recovers by closing the existing session. | Browser custody depends on the same origin/profile/account. Persistence is not portable backup; visible transcript clearing does not erase journaled requests. |
| Distribution and other upstream surfaces | Typechecked source SDK, browser example, native daemon and preserved upstream license. | npm publication, portable browser backup and production distribution remain separate. Ollama and native SOL billing are intentional exclusions from the initial release. |

## Findings corrected in this review

The detailed reproductions, exact commands and saved log hashes are in the
[protocol review](I10-parity-review-protocol.md),
[application review](I10-parity-review-ux.md) and
[privacy review](I10-parity-review-privacy.md). The corrections reuse the existing
financial state machines and do not migrate historical funded state.

| Finding | Correction and verification |
|---|---|
| Native pending-read cancellation released admission before cancellation finished. | `ClientDaemon` cancellation owns finalization; a new request and management close remain fenced. Direct and proxy regressions exercise delayed cancellation. |
| Valid function-tool parameter schemas were recursively mistaken for unsupported modalities. | Native function-schema containers are recognized without changing accepted request bytes; actual unsupported modalities and hosted tools still fail before AUTH. |
| Direct structured text output was incorrectly rejected. | Native Chat `response_format` and Responses `text.format` accept supported text/JSON formats and their schemas; misplaced formats remain rejected. |
| Direct requests forwarded identity metadata that upstream removes. | Top-level `user`, `metadata`, `safety_identifier`, `prompt_cache_key`, `extra_headers` and `provider` fail before AUTH. Explicit rejection preserves the accepted durable request's exact bytes. |
| The local daemon forwarded arbitrary provider response headers. | A narrow header allowlist replaces unrestricted cloning. Cookies, CORS and provider correlation headers are not relayed; local operation identity and `no-store` remain authoritative. |
| Direct Responses allowed an omitted `store`, enabling the provider's default API storage behavior. | Explicit `store:false` is required before AUTH. Tests reject omitted and invalid values. This setting does not promise the absence of provider logging; see the [official Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create). |
| Ordinary text readers accepted mixed tool calls and discarded their context. | JSON/SSE text readers reject actual tool/function calls, unsupported roles and unknown finish reasons. Native tool consumers remain available separately. |
| Chat SSE accepted a bare `[DONE]` or unfinished text as successful completion. | A recognized terminal choice is required; subsequent choices are rejected. Interrupted output is not included in the next turn's history. |
| Conversation copy implied memory-only content retention. | The app, clear-conversation result and docs now explain encrypted request-body history, including prior conversation sent as context. Clearing the transcript preserves custody and recovery evidence. |
| Direct-provider keys were durably stored, and emergency archives could retain them. | New keys live only in the current ControlClient, bound to note ID, request UUID and exact AUTH. Journal writes and new archives omit them, CAS failure clears the usable cache, and fresh clients ignore legacy durable keys. OA evidence is still verified against the current key. Existing archives are preserved. |
| The devnet host rejected the escape/finalize operations exposed by the recovery UI. | The relay now permits `initiate_escape` payload uploads and `finalize_escape`, using their correct Pool account positions and exact instruction lengths. Signed SDK transactions pass; wrong pools, unsigned sends, foreign origins, non-devnet genesis and unknown/excessive fees fail. |
| The host rejected SDK-selected compact deposits. | SDK-signed 1,007-byte wire reproduced HTTP 400. The relay now admits the strict compact codec and correct account shape only for authenticated manifest/build capability pins; old or copied/unverified manifests remain denied. |
| The live acceptance helper created a different client for AUTH and inference. | Memory-only keys correctly cannot transfer through the journal. The helper now reuses the authorizing client, with per-call quote/AUTH cancellation that does not expire later inference or close. Exact AUTH recovery and the single-inference rule remain enforced. |
| The public launcher dropped the shared AUTH snapshot method and its TLS routes. | The bounded read-only chain wrapper now preserves `sessionSnapshot` and `bufferObservation`; pinned transport admits only canonical shared snapshot descriptor/file routes with separate size limits. It never falls back to selected-note financial reads. A funded but pre-quote/pre-AUTH failure was preserved and the same journal continued after correction. |

The first six corrections are in
[`clientd-bridge.ts`](../../packages/sdk/src/clientd-bridge.ts); text-consumer
corrections are in [`chat.ts`](../../packages/sdk/src/chat.ts). Key custody is in
[`control.ts`](../../packages/sdk/src/control.ts),
[`client.ts`](../../packages/sdk/src/client.ts) and
[`wallet.ts`](../../packages/sdk/src/wallet.ts). The relay correction and
regressions are in [`host.ts`](../../scripts/i10-wallet-ui/host.ts) and
[`host.test.ts`](../../scripts/i10-wallet-ui/host.test.ts).

The relay change retains the existing Vault/ComputeBudget instruction boundary,
single Vault instruction, signatures, origin, genesis and fee checks. It forwards
the admitted signed bytes unchanged, with preflight enabled and RPC automatic
retries disabled. An independent reviewer checked the escape correction. The later
[compact relay review](I10-parity-review-compact-relay.md) records the SDK-wire
red/green regression, 73 UI tests and 63 compact/trust/transport tests.
The [acceptance custody follow-up](I10-parity-review-provider-custody.md) records
131 provider/coordinator tests and 138 shared lifecycle tests, with independent
review of uncertainty, timeout and same-instance key boundaries. The
[launcher follow-up](I10-parity-review-launcher-snapshot.md) records 22 snapshot/transport
tests, strict launcher typechecking and independent review of the wrapper and
TLS routing; those changes subsequently ran in the actual direct cases.

The final UX review also found that the default standalone app had no installed
real deployment, and the older host only supported the fixed OpenAI demo. This
was an actionable integration gap, not merely a missing test. A new offline
packager, configured build, bounded localhost host and direct-demo budget adapter
now connect the actual fresh public devnet deployment. Direct inference stays
browser-to-OpenRouter. Public capacity checks gate new funding/requests while
preserving recovery and withdrawal. See the browser follow-up below.

## Privacy and trust comparison

| Boundary | Alignment or deliberate difference |
|---|---|
| Deposit-to-AUTH linkage | Both select the private membership witness locally from common data. Solana ordinary AUTH uses common snapshot routes and shared PoolConfig/TreeState/Clock selectors, with no selected-note financial-read fallback. Independent pins, finalized account cuts and original Poseidon reconstruction authenticate the data. |
| Content route | Direct requests go to the configured provider; proxy requests expose content to the proxy as well. AUTH carries authorization data, not prompts. Neither model proves provider honesty, model output correctness or usage accuracy merely by signing a receipt. |
| Ephemeral direct keys | Newly delivered client keys now follow memory-only custody. Saved OA evidence is not a reusable key or persisted trust assertion. Close/settlement/disposal forget the usable cache. Local forgetting is not provider revocation or attested erasure; management cleanup is a separate lifecycle. |
| Local prompt retention | Solana retains exact request bodies in the encrypted pending journal and settled history, including earlier turns when sent as context. Incoming responses are not separately journaled, but can reappear in a later request. This is a disclosed retention difference; there is no selective prompt-erasure API. Historical encrypted keys/backups are not silently migrated or erased. |
| Network and application trust | IP addresses, timing, funding/withdrawal activity and content correlation remain observable. App/native/worker distribution, the browser origin and device integrity are trusted. Encryption does not protect from authorized same-origin code using its local key. No new live Tor observation was made. |
| Provider and operator trust | Direct issuance, usage measurement and disable/delete depend on provider management behavior. Proxy content and metering depend on the relay. Signed receipts and ZK authorization establish their stated bindings, not the absence of provider logs or collusion. |
| Circuit setup | Request/withdrawal artifacts retain the upstream single-party setup assumption. Solana adds a tree circuit and setup. Fresh profiles use OS randomness and independent role/build pins, rejecting fixture material by default; this is not a multiparty ceremony or proof of setup-secret erasure. |
| Settlement and administration | Solana USDC issuer controls and program upgrade authority are explicit additional trust points relative to upstream native-ETH settlement with immutable verifiers. Deployment checks and client pins identify configured artifacts; they do not eliminate the authority's powers. |
| Anonymity and availability | A small devnet anonymity set, bounded snapshots and a configured RPC constrain the demonstration. Snapshot size limits fail closed. Financial recovery has expiry/challenge timing and independent evidence requirements; service availability is not guaranteed by the proof. |

The [deployment guide](../sdk/deployment.md),
[recovery guide](../sdk/recovery.md#local-request-retention) and
[SDK internals](../../packages/sdk/INTERNALS.md) describe these boundaries. The
[independent custody follow-up](I10-parity-review-protocol-custody.md) found no
additional actionable issue in its reviewed scope. It checked cache admission,
failed persistence, restart-close, current-key OA evidence, emergency archives
and application disposal. JavaScript garbage collection is not secure erasure.

## Fresh local verification

The [final six-stage application SDK aggregate](I10-parity-review-final-components/final-browser/app-sdk-results.json)
passed in **19.389 seconds** with Node **24.19.0**: SDK and example typechecks,
**304 SDK tests with zero failures or skips**, browser/worker build, design/link
checks and `git diff --check`. All **517 guarded source inputs were unchanged**
during the run. The read-only lifecycle collector has its own four-test
validation with 22 negative subcases. The aggregate's public-chain, live-provider, Phantom and full-I10 flags remain
false, with no release gates asserted. The command is
`python3 scripts/run_app_sdk_acceptance.py`; the report records exact stage
commands, input hashes and saved log hashes.

The earlier [UI aggregate](I10-parity-review-ux-final-components/results.json)
separately passed all **72 wallet UI tests**, **17 standalone conversation/native
reader tests**, strict typechecks, a fresh build and **one actual Chrome
154.0.8037.98 standalone scenario**. Its **115 guarded inputs were unchanged**.
The browser runs use isolated profiles and synthetic wallet/provider/chain
ports; the wallet suites include two further actual Chrome fixture scenarios.
These exercise browser execution, not real Phantom or provider acceptance.
After the compact-relay correction, the newer
[relay aggregate](I10-parity-review-compact-relay-components/results.json) passed
73 UI tests, 63 compact/trust/transport tests, typechecking, the example build and
the standalone actual Chrome scenario; all runs had zero skips.

The privacy component additionally passed 28 snapshot/trust/profile transport
tests, three Rust sparse-tree tests, fresh native and WASM builds, one actual
native/WASM reconstruction test and two focused Rust public-profile config tests.
The memory-key correction passed 138 focused lifecycle tests before the full
aggregate. An independent follow-up passed 72 selected custody tests, native
TypeScript checking and uncached `go test -count=1 -race ./...` in all three
native daemon packages. These overlapping suite counts must not be summed as
unique coverage. See the component reports for filtered cases, exact commands
and the preserved initial failures.

Earlier real-proof and SBF records remain useful separate evidence: the compact
61-case suite, legacy 366-transaction matrix, fresh-profile eight-case SBF run
and ten-transaction emergency escape integration are linked from
[the preceding parity handoff](I10-parity.md). They were not freshly rerun as part
of this TypeScript/UI correction aggregate and do not establish new public
transactions. This review did not alter the on-chain program or circuits.

## Historical live evidence and what it establishes

- The [actual Chrome/Phantom OpenAI fixed-prompt observation](I10-phantom-openai-success-observation.json)
  records HTTP 200 and the SDK-observed successor with a four-micro-USDC charge.
  The [separate runtime collector](I10-phantom-openai-success-runtime.json)
  verifies the committed attempt, usage/receipt binding and charge arithmetic;
  it does not independently repeat every browser verification. These artifacts'
  aggregate acceptance flags are preserved.
- The [finalized withdrawal collector](I10-repeat-demo-withdrawal-finalized.json)
  records nine finalized deposit/close transactions, including five withdrawal
  transactions, and the closed note/Vault-zero outcome. It does not erase the
  charge: the observed wallet also owns the treasury. Unknown historical send
  counts and fees remain unknown.
- A [second fixed-demo observation](I10-repeat-demo-api-observation.json) uses
  a separate two-USDC note. It is not proof of repeated arbitrary conversation
  on the same note, streaming or model switching in the standalone app.
- The [OpenRouter proxy Chat tools case](I10-openrouter-tools-case-results.json)
  establishes its recorded single real inference, 18-micro-USDC charge and signed
  successor. Earlier native usage/waiver and SSE quote-failure reports remain
  preserved; neither becomes a pass because a different proxy case succeeded.

These results are stronger than fixture-only evidence for their exact scenarios,
but cannot be reassigned to a different deployment, mode, API or application.
Existing historical journals, deployment identities and global provider-budget
reservations remain authoritative; a fresh profile does not reset that budget.

## Actual direct-provider and public devnet follow-up

The [live aggregate](I10-parity-review-live-components/results.json) records two
successful **OpenRouter `openai/gpt-4o-mini` Chat Completions direct** cases, one
ordinary JSON and one SSE. Each uses a separate note and Pool, the existing native
SDK harness, real provider credentials and the same immutable parent budget.

| Result | JSON | SSE |
|---|---:|---:|
| HTTP status | 200 | 200 |
| Actual inference sends / replays | 1 / 0 | 1 / 0 |
| SDK-verified signed charge, micro-USDC | 4 | 4 |
| Finalized deposit + mutual-close transactions | 6 | 6 |
| Maximum CU | 349,435 | 344,935 |
| Compact deposit / maximum transaction bytes | 995 / 1,232 | 995 / 1,232 |
| Finalized Vault balance, micro-USDC | 0 | 0 |

The public transactions use compact funding without a priority-price instruction;
the 1,007-byte wire in the separate local relay test includes that instruction.
Both public runs saved signed attempts before send and report zero automatic
resends. The wallet returned to 36,010,000 micro-USDC after each close. The wallet
also owns the treasury, so this balance observation does not cancel either
four-micro-USDC provider charge. The total new verified charge is **8 micro-USDC**,
not two USDC: two USDC is the retained worst-case reservation for these cases.
See the [JSON runtime](I10-parity-review-live-components/direct-plain-runtime.json)
and [SSE runtime](I10-parity-review-live-components/direct-sse-runtime.json).

The deployed program is `8iwjnYVNuRQhyijbcYGWGctyty7d8FEt8JnT8dWmCjSd`, with
finalized ELF SHA-256
`42febb6f9e6e373f318fb596611af842a0c95271831f77ec0fe70eccc79803a1`.
The OS-random public profile hash is
`3933fcae97f544f0be368532cc9c2127af8f7fc008cbebcf2ddd0f803abfd311`;
legacy fixture opt-in is false. This is a fresh program, not an upgrade of an
old funded deployment. The single-party tree setup and retained upgrade
authority remain explicit trust points. The initial
[preparation record](I10-parity-review-live-components/preparation-results.json)
includes an unused SSE Pool; the actual SSE pass uses `parity-direct-sse-fresh`,
whose [separate preparation record](I10-parity-review-live-components/direct-sse-fresh-preparation.json)
pins its own Pool and manifest. The unused Pool had no funding, AUTH, inference
or reservation and is not counted as a passed case.

The management-key [read-only access check](I10-parity-review-openrouter-management-results.json)
established authenticated list access before any key mutations. The subsequent
[JSON](I10-parity-review-live-components/direct-plain-management-lifecycle.json)
and [SSE](I10-parity-review-live-components/direct-sse-management-lifecycle.json)
collectors corroborate one completed key-issuance attempt per case, disable,
stable provider-reported usage, final usage persisted before deletion confirmation
and a settled session with matching charge. In the SSE case, the first usage
observation was zero, followed by 3,300 nano-USDC and a later equal observation;
it was not prematurely settled at zero. These SELECT-only collectors inspect
bounded scalar projections of saved runtime checkpoints. They do not independently
capture provider HTTP responses, attest deletion/erasure, reverify signatures or
establish the second HTTP poll's exact time. Their explicit limitations are part
of the evidence; inference count and successor verification come from each saved
SDK case. The [collector validation](I10-parity-review-live-components/direct-lifecycle-collector-validation.json)
passed four offline tests including 22 negative lifecycle subcases.

The first attempts and their recovery remain visible. A read-only prewarm was
stopped before funding while correcting acceptance-client custody. A later
300-second read wait expired before any signed deposit. After compact funding,
the missing shared-snapshot wrapper failed before quote, AUTH or reservation.
The failure report was archived byte-for-byte, and the same funded journal
continued after correction; no inference was replayed. The private indexer archive
is preserved. Startup replay and snapshot wait observations are not latency/SLO
passes; the indexer still needs its documented local archive replay on restart.

The [preservation check](I10-parity-review-live-components/preservation-results.json)
compared 41 explicitly snapshotted old manifest/build/deployment/budget files.
Only the expected budget-state file changed: its identity and all eight earlier
reservations remain equal. There are now ten reservations totaling **2,154,216
micro-USDC**, with **7,845,784 micro-USDC** remaining under the authorized ten-USDC
cap. Reservations are retained even for failed/uncertain cases and are not an
account of actual expenditure. Both new notes are closed and the two new test
backends [stopped cleanly](I10-parity-review-live-components/shutdown-results.json);
indexer termination is recorded separately without a graceful-stop claim.

These passes establish the stated native public-devnet workflows. They do not
establish a hosted application, actual Phantom for this profile, browser CORS,
repeated conversation on one note, model switching, every provider/API route,
full I10/G3 or release gates.

## Configured standalone browser follow-up

The [browser follow-up](I10-parity-review-browser.md) records the new concrete
local application and its remaining browser blocker. Its offline packager first
verifies the signed manifest against the independently pinned OS-random profile,
including quote/receipt roles, checks every artifact and WASM, then compiles the
exact reviewed manifest hash into the app. The public profile is
`270ff0fea81bed8b809b3d4335af7392a95dc122a12414ed0f058abd6af2eaf4`.
Private RPC configuration and management credentials are not browser assets.
The host provides fixed local RPC/indexer/control routes, preserves the logical
manifest authority and exposes no provider-inference proxy.

The [budget extension](I10-parity-review-demo-budget.md) uses the existing ledger
and full one-USDC cap per fresh direct AUTH. Exact AUTH recovery remains bound
to its original UUID and bytes. Existing rows, uncertainty and withdrawal paths
are preserved. The frozen native acceptance coordinator deliberately fails
closed on this new row kind; its source pins were not silently rewritten. No new
browser reservation has been made at this checkpoint.

Final validation includes [73 wallet UI tests](I10-parity-review-browser-components/final-local-results.json),
[26 host/relay tests](I10-parity-review-browser-host-results.json),
[22 browser helper/conversation tests and one actual isolated Chrome scenario](I10-parity-review-browser-provisioning-components/results.json),
five actual offline packaging checks, strict typechecks and the six-stage SDK
aggregate above. Overlapping suite counts are not additive. An actual
[read-only startup check](I10-parity-review-browser-components/configured-readonly-results.json)
passed 17 HTTP checks of the configured build, pinned public assets, devnet RPC
genesis, shared snapshots and control configuration without funding, AUTH or
inference. This establishes service wiring, not wallet acceptance.

The app is running at `http://127.0.0.1:4174` using a separately initialized,
unfunded Pool. The existing user Chrome profile shows
[ERR_BLOCKED_BY_CLIENT](I10-parity-review-browser-components/chrome-current-block.json).
No browser protection was disabled or bypassed; the user was asked to open the
local page. The new browser backend/indexer/host remain available for that
follow-up. The two completed native-case backends remain stopped. No hosted
public URL or actual standalone Phantom acceptance is asserted.

## Remaining evidence for a broad public demonstration

After the existing Chrome block is resolved, the installed profile should be
exercised through the standalone application with actual Chrome/Phantom: compact funding, repeated
requests on one note, configured model/API changes, JSON and SSE, direct and
proxy routes, cancellation, reload and settlement/withdrawal. Record supported
provider modes separately, including management cleanup and final signed usage.
Demonstrate operator-outage escape/challenge/finalization through the configured
host, preserving exact journals and uncertain requests without replay.

Use the existing authorized parent provider budget and retain reservations for
failed or uncertain cases. Report actual inference attempts separately from
AUTH recovery attempts and HTTP metadata checks. Successful local tests and the
historical fixed demo already support a useful devnet prototype; the remaining
matrix determines how broadly its public compatibility claim can be stated.
Mainnet deployment, third-party audit and production operational gates remain
subsequent work, as requested.
