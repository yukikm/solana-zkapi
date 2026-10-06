# Application SDK review — 2026-10-06 JST

Reviewed the application facade, browser custody/factory, response helpers,
package exports, example and public documentation from the
[initial implementation](I10-app-sdk.md). Three defects were reproduced and
fixed without adding another financial state machine.

## Fixed findings

1. **P2 — Cancelling an outstanding response read released the application lock
   before the close attempt finished.** Web Streams cancellation resolves a
   pending `read()` as EOF before asynchronous cancellation finishes. The
   facade's EOF handler therefore released its action lock while the shared
   lifecycle was still settling. In particular, `dispose()` could terminate
   the browser prover/storage during that work. Cancellation now owns lock
   release once it starts; the competing read cannot release it. The regression
   blocks the existing close request, cancels a pending read, and checks that
   busy state, disposal and new actions remain blocked until close completes.
2. **P2 — Response cleanup could expose the original private error.** A rejected
   `reader.cancel()` in `finally` replaced the intended `ChatResponseError` with
   the stream's original error. HTTP/content-type rejection had the same issue.
   Cleanup now preserves an existing redacted error and normalizes new cleanup
   failures, while still awaiting cancellation and releasing the reader lock.
   Tests cover JSON/SSE read failures, parser/size errors followed by failed
   cancellation, HTTP rejection, `[DONE]` and early iterator exit.
3. **P2 — A valid CR-terminated SSE stream was rejected as incomplete.** The
   parser deferred a trailing CR to distinguish CRLF, then rejected it at EOF
   without processing it. EOF now flushes that delimiter through the same
   bounded event parser. A regression splits a CR-only response at every byte
   boundary, including the final `[DONE]` delimiter. Truly truncated streams
   remain rejected.

Implementation changes are in `packages/sdk/src/client.ts` and
`packages/sdk/src/chat.ts`; four new test cases are in their matching test files.
The existing `ControlClient`, `WalletClient`, `ClientDaemon`, encrypted journal,
explicit operation IDs and no-inference-replay policy remain in use.

## Verification

The focused command
`target/i08-toolchain/bin/node --test packages/sdk/test/client.test.ts packages/sdk/test/chat.test.ts`
first reproduced the cancellation and redaction failures (17 passed, 2 failed).
After those fixes, the same 19 cases passed. The subsequent CR-only regression
failed before its parser fix (6 passed, 1 failed). These development snapshots
are separate from the final suite; their logs are retained in the
[archive](I10-app-sdk-review-components/archive.json).

`python3 scripts/run_app_sdk_acceptance.py` then passed all **six stages** in
**12.633 seconds**, using **Node 24.19.0**, with **477 source inputs unchanged**:

- **237 SDK tests passed**, zero failures, skips, cancellations or TODO cases.
- SDK and public-export example TypeScript checks passed.
- The example and worker browser bundles built with the existing pinned esbuild.
- Actual isolated headless **Chrome/154.0.8037.98** exercised browser storage,
  custody, locks and restart checks; this was not a Phantom wallet test.
- Design/document and diff checks passed.

The [aggregate](I10-app-sdk-review-results.json) records exact commands, source
hashes, output hashes and durations. Each referenced log has a byte-identical
copy in the archive. A separate [public document check](I10-app-sdk-review-components/public-doc-check.json)
checked all 12 application documents for English-only text and all 62 local
file links. The quoted implementation summary's English/Japanese description
is stale: current public documentation is English-only, as required by `AGENTS.md`.
Historical evidence retains its original language.

The prior 233-test report and its original source hashes are preserved.
`implementation-results-before-app-sdk-review.json` retains the prior inventory;
refreshing the current inventory does not rerun or rebind historical evidence.

## Boundaries

Application lifecycle tests use synthetic provider/chain/proof fixtures with
the real encrypted journal and shared SDK lifecycle. No new real-provider,
public-chain, actual Phantom, SBF or production acceptance was performed.
No funded journal, deployment pin, service, credential or global budget changed.
Live multi-model/streaming acceptance, npm publication, portable browser backup,
repository-wide license selection and full I10/G1–G4 remain separate.
