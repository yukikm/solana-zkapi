# Application SDK and public documentation — 2026-10-06 JST

Adds an application-facing API over the existing `ControlClient`, `WalletClient`,
`ClientDaemon` lifecycle, offline prover and encrypted `NoteJournal`. No second
financial state machine, manifest/profile change or journal schema was introduced.

## Changes

- A factory verifies independent manifest/build pins, public artifacts, model
  tariff hashes, RPC genesis and finalized PoolConfig, then composes the existing
  clients. Creation/status reads never submit AUTH, inference or transactions.
- Chat/native requests use an explicit UUID, configured provider/API and the
  selected tariff. Session preparation/dispatch/close use the shared lifecycle;
  one request per session is the initial application policy. No inference retry.
- The application lock spans response consumption/cancellation. The existing
  lifecycle now finishes its close attempt before surfacing a stream error,
  matching its EOF/cancellation ordering and preventing premature lock release.
- Redacted local status/subscription, one-step wallet operations and explicit
  recovery delegate to the same journal. Unknown compact sends remain observation-only.
- Browser setup composes the Worker and durable same-origin CryptoKey custody.
  New custody requires explicit initialization; existing ciphertext without its
  key is never reset. Existing I10 UI custody is not migrated.
- Bounded text/SSE readers, a source-import integration example, English
  onboarding, API/deployment/recovery/status guides, contributor guidance and a
  navigable root README. Original SDK detail is retained in `INTERNALS.md`;
  previous README status prose is preserved in its linked archive.

## Initial implementation validation

`python3 scripts/run_app_sdk_acceptance.py` passed all six serial stages in
**12.533 seconds**, using **Node 24.19.0**, with **478 source inputs unchanged**.
The [aggregate](I10-app-sdk-results.json) records exact commands, input hashes,
bundle hashes and log hashes. [Archived components](I10-app-sdk-components/archive.json)
map each original log to its byte-identical saved copy.

| Check | Result |
|---|---|
| SDK TypeScript | Passed |
| Example TypeScript | Passed through public package exports |
| Full SDK suite | 233 passed; zero failures, skips or cancelled tests |
| Browser example + worker bundle | Passed with pinned esbuild |
| Design/document checks | Passed |
| Diff whitespace | Passed |

SDK tests use synthetic provider/chain/proof fixtures with real encryption,
locks and quote/transaction signatures. The existing browser test was extended
with explicit custody creation, concurrent opens, nonextractability, reopening
and missing-key refusal; it ran in **Chrome/154.0.8037.98** in an isolated headless
profile. Factory tests validate trust failures; they do not generate real request
proofs. Nineteen new test cases bring the historical 214-case SDK suite to 233;
the additional browser custody assertions are inside an existing test case.

A separate local check covered 12 application documentation files and 71 local
links, including package/example documents outside the design check's scan.
The existing source inventory initially reported nine changed tracked hashes,
as expected. Its prior bytes are preserved in
`implementation-results-before-app-sdk.json`; the new inventory records this
local SDK report without rerunning or rebinding historical public evidence.

Early development checks found unsupported TypeScript constructor parameter
properties under Node's strip-only runtime and readonly test-fixture assignments.
Those were corrected before the final run. They are not reported as passing checks.

## English-only documentation follow-up

Removed the Japanese quickstart and its navigation links at the user's request.
Public documentation, examples and UI copy must use English; this is recorded in
`AGENTS.md`. Historical evidence retains its original language and source hashes.

An inline Python check verified that all 11 current application documentation
files contain no Japanese text and that their 61 local links resolve. Comparing
`run_app_sdk_acceptance.snapshot()` with the saved aggregate found only three
changed public documents and the removed translation; all implementation and
test inputs are unchanged. `python3 scripts/check_design.py` and
`git diff --check` passed. Runtime tests were not rerun for this documentation-only
correction. The original 478-input runtime report remains an immutable record of
the initial implementation snapshot, including the then-present translation.

## Boundaries

No `.env` credentials, public deployment, provider request, actual Phantom
extension, funded journal, manifest pin, service or global budget was changed.
No new live provider, browser wallet or production release acceptance follows.
Existing evidence remains source-specific. General multi-model live chat, live
streaming, public compact rollout, portable browser backup, npm distribution,
repository-wide licensing and full I10/G1–G4 remain outside this change's pass claim.
