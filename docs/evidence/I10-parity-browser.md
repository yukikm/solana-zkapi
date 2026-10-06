# Browser parity follow-up — 2026-10-06 JST

This follow-up improves browser access and recovery without migrating the funded
demo, changing its manifest pins or fixed provider acceptance case, or creating
another financial state machine. Historical provider and public-chain evidence
remains tied to its original source snapshot.

## Existing funded demo

The live wallet UI now displays the saved note's expiry, the seven-day/one-day
warning, and the risk that an expired active note's entire principal can be
transferred to the treasury. The page refreshes this presentation without
submitting anything. Expired notes disable both preparation and sending of a
new API request; each action rechecks the saved witness immediately before its
budget or provider call. Recovery and withdrawal remain available. The browser
clock is a conservative presentation guard; the SDK and finalized chain checks
remain authoritative.

Three explicit withdrawal controls call the existing `WalletClient` methods:

- Prepare escape withdrawal for an active note with no saved session/operation.
- Switch an unsigned mutual withdrawal to escape when clearance is unavailable.
  Any saved signature prevents this option. The SDK preserves the original
  operation and clearance intent under its encrypted journal lock.
- Check the finalized escape deadline and prepare final withdrawal. The SDK
  refuses premature finalization; the UI never treats elapsed browser time as
  proof that the deadline has passed.

The fixed prompt, test budget, host configuration, funded journal and transaction
recovery protocol are unchanged. Synthetic fixtures have an explicit display
clock which is refused by a live configuration.

## Standalone browser chat

`examples/browser-chat/` now includes an HTML/CSS/TypeScript application using the
existing application SDK. Its reviewed profile list is deliberately empty in
the source distribution: an operator must install real public assets, tariff
configuration and independent trust pins and rebuild. Opening the unconfigured
page makes no deployment or provider request. It does not reuse the funded
fixed-prompt demo or its reservations.

Users explicitly select a deployment/privacy mode, Wallet Standard wallet and
account, custody creation or reopening, configured model and supported API.
Proxy content visibility and direct provider content/metadata visibility are
explained before opening custody. There is no direct-to-proxy fallback.

The application sends arbitrary text and complete prior turns through Chat
Completions, OpenAI Responses (`store: false`) or Anthropic Messages, according
to the reviewed model's configured APIs. Streaming can be selected and
cancelled. Each Send action creates one operation UUID. Incomplete turns are
excluded from later context, and uncertain inference is never replayed.
Conversation history is held in tab memory only; reloading recovers financial
state without regenerating the response. Native JSON/SSE readers reject errors,
incomplete terminal sequences and tool execution output, enforce bounded body
and event sizes, and await body cancellation/SDK cleanup. Provider usage fields
are never interpreted as a signed billing receipt.

Funding suggests twice the authenticated authorization cap, so a first positive
usage charge does not immediately leave the default deposit below that cap.
The user chooses the amount and approves wallet steps. Expiry, pending work,
last verified balance/charge, recovery, mutual withdrawal, explicit escape and
finalization are visible. Browser persistence status is disclosed; persistent
origin storage is not a portable backup and cannot prevent explicit site-data
deletion. Client-executed tools remain an advanced SDK API, not a tool-execution
feature of this text interface.

## Local verification

Commands were run from the repository root using Node 24.19.0:

| Command | Observed result |
|---|---|
| `node scripts/i10-wallet-ui/live-view.test.ts` | 22 passed, no failures/skips |
| `node node_modules/typescript/bin/tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --resolveJsonModule --lib ES2023,DOM --types node scripts/i10-wallet-ui/*.ts scripts/i10_devnet_pool_instance.ts scripts/i10_devnet_pool_instance.test.ts` | Exit 0 |
| `node scripts/i10-wallet-ui/build.test.ts` | 1 passed, no failures/skips |
| `ZKAPI_TEST_CHROME=/workspace/work/chromium-review node scripts/i10-wallet-ui/browser.test.ts` | 2 passed, no failures/skips; Chrome 151.0.7922.173 |
| `node examples/browser-chat/native-responses.test.ts` | 10 passed, no failures/skips; native JSON/SSE, every byte split and CR/CRLF, terminal checks, redaction, cancellation and limits |
| `node examples/browser-chat/chat-model.test.ts` | 6 passed, no failures/skips; exact amounts, history, explicit operation IDs, no replay, expiry and cancellation locks |
| `node packages/sdk/test/client.test.ts` | 21 passed, no failures/skips; application clearance, durable emergency archive, reopen guards, finalization/challenge visibility and response-lock exclusion |
| `node packages/sdk/test/wallet-clearance.test.ts` | 24 passed, no failures/skips; existing wallet clearance/archive/withdrawal invariants |
| `node node_modules/typescript/bin/tsc --noEmit -p packages/sdk/tsconfig.json` | Exit 0 |
| `node node_modules/typescript/bin/tsc --noEmit -p examples/browser-chat/tsconfig.json` | Exit 0 |
| `node examples/browser-chat/build.mjs` | Exit 0; standalone page/app/CSS and existing integration/worker bundles |
| `ZKAPI_TEST_CHROME=/workspace/work/chromium-review ZKAPI_CHAT_SCREENSHOT_DIR=/workspace/work node examples/browser-chat/browser.test.ts` | 1 passed, no failures/skips; Chrome 151.0.7922.173 |
| `git diff --check` | Exit 0 |

The browser run uses a temporary profile, real IndexedDB and the existing SDK,
with synthetic wallet, prover, RPC and provider fixtures. It verifies that an
old Send handler invoked after expiry cannot call the provider, while session
recovery stays enabled. It also exercises unavailable clearance followed by an
explicit unsigned-mutual-to-escape fallback; the saved SDK operation becomes a
ready escape operation without a transaction or inference send. Existing
wallet rejection, reload, no-replay, response escaping and signed-settlement
presentation checks still pass.

The separate standalone-app Chrome test uses an injected synthetic SDK port to
verify the UI adapter. It makes four explicit Chat Completions calls and two
native API calls within the fixture, retains complete prior-turn context and
renders response text inertly. It checks direct-mode failure without a proxy
fallback, recovery without inference replay, cancellation while cleanup is
delayed, expiry gating, the saved withdrawal destination independently of a
changed input field, escape/finalization controls and zero unexpected network
calls. These counts are fixture interactions, not provider acceptance cases.
Desktop and 390-pixel mobile screenshots were inspected; the browser assertion
confirmed no horizontal overflow. The screenshots under `work/` are labeled
synthetic and are not public transaction evidence.

The focused UI typecheck and funded-demo Chrome scenarios also passed after the
shared SDK session-snapshot interface was updated. This is component verification
of the changed working tree, not a fresh immutable full-I10 aggregate. Historical
source inventories and funded deployment pins were not rewritten.

## Unaccepted authorization recovery follow-up

Review found a missing application route for an expired, possibly sent AUTH
with no observed acceptance or inference. Ordinary session recovery can retain
that pending AUTH, while pending-session withdrawal guards correctly reject a
new wallet operation. The application facade now exposes the existing
`WalletClient.reconcileUnacceptedAuthorization` under the same action and note
locks. Its redacted status hint enables an explicit browser action only for the
eligible saved phase. This action delegates to the existing wallet clearance
protocol without weakening its invariants.

The method verifies permanent signed clearance before archiving the exact saved
AUTH and prior state. It sends no AUTH, inference or wallet transaction. Failed
or invalid clearance retains the pending work; success enables a separate
withdrawal action and still prohibits inference from the cleared note. Expiry
alone never releases the AUTH. The same application lock excludes active streams,
other local actions and overlapping facade instances during clearance.

The initial 18-test facade run uses the real encrypted journal and lifecycle with
synthetic clearance-verifier/HTTP ports. It covers successful expired-note
recovery, reopening and idempotency, unavailable/invalid signatures, shared locks,
and rejection for observed acceptance, inference, prepared/closing phases or a
wallet operation. The existing 24-test wallet-clearance suite passed unchanged.
The standalone real-Chrome test additionally checks a retained expired AUTH,
failed clearance with withdrawal still disabled, explicit successful clearance
and the subsequent escape/finalize UI flow. Its six synthetic inference calls
are unchanged: the recovery actions dispatch none. SDK/example typechecks,
example build and `git diff --check` passed after this follow-up.

## Emergency escape application follow-up

The application exposes `prepareEmergencyEscape(destinationOwner)` and
`reconcileChallengedEscape()` through the same action lock. The wallet's durable
emergency-escape archive preserves pending AUTH/inference and the last verified
state; the facade exposes only its latest phase and conservative action hints.
Unresolved archives block new requests. Ordinary withdrawal guards remain in
place; the user must explicitly select a challengeable emergency escape and
its destination when settlement remains unavailable.

Two additional facade tests bring that suite to 20 passing tests. With a real
encrypted journal and the actual wallet API, the test proves the full archive
is persisted before deliberately refused financial chain/proof work, survives
reopening, remains redacted in status and prevents new inference or ordinary
withdrawal. Another test excludes never-sent/unrelated notes. Active-response
tests also exclude both new recovery actions until response cleanup finishes.
These fixtures do not establish public-chain escape or challenge execution.

The updated standalone Chrome scenario passes with the same six synthetic
inference calls and zero external network. It covers an accepted session with
uncertain inference during settlement outage, explicit destination validation,
archive presentation, failed deadline/challenge checks, and a restored pending
session that must settle before ordinary withdrawal. Busy UI state overrides
stale eligible hints. A synthetic verified successor enables normal withdrawal;
the recovery flow adds no inference or privacy-mode switch. SDK/example
typechecks, example build, six conversation tests and `git diff --check` pass.

A further regression covers a challenge arriving after finalization preparation.
The facade now locates the original escape by its archived operation ID instead
of selecting the current finalization operation. The check remains visible in
that state, while the wallet still requires unsigned finalization or definitive
rejection of every signed attempt. The 21-test facade run verifies read-only
eligibility from synthetic saved transport records and that the hint cannot
release state without valid chain evidence. The updated Chrome fixture retains
an unknown signed finalization on a failed check, then restores the original
session only after its synthetic SDK port reports definitive rejection and a
verified challenge. The browser test, SDK/example typechecks, example build and
diff check pass; no additional inference or external calls were introduced.

The funded-demo expired-setup visibility hint was also aligned with the SDK's
ordinary/emergency `initiate_escape` recovery. An active note with its saved
destination can expose this check without operator clearance; ready phase,
matching plan, step zero, only create attempts, no finalized steps, and the exact
current last signature remain required. A new synthetic presentation test covers
both escape forms and rejects altered phases, plans, destinations, signatures or
financial progress. The 22-test presentation suite, strict UI typecheck and diff
check pass. The SDK independently verifies finalized expiry, anchored buffer
absence and unchanged signed payload; this hint does not establish those facts.

`python3 scripts/check_design.py` found two unavailable pre-existing generated
targets referenced by `docs/evidence/I10.md`: `target/i10-live-ui-runtime-results.json`
and `target/i10-live-ui-preview.jpg`. No replacement acceptance evidence was
fabricated for those historical links.

The default sandbox refused the temporary loopback listener with `EPERM`.
The build/host and browser tests then ran successfully with automatically
approved execution permission for their temporary local servers. They used no
provider credentials or existing browser profile. The wrapper relocates
Chromium's cache/configuration under `work/` and uses `--no-sandbox` only for
this isolated container test.

These results are local fixture evidence. They do not add actual Phantom,
provider, public devnet transaction, live streaming or production acceptance.
No mainnet deployment or audit claim follows from this work.
