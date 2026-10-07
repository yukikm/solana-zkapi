# SDK terminal usage SSE correction — 2026-10-07 JST

An independent application using the initial SDK tarball received HTTP 200 and
three text deltas, then `readChatDeltas` rejected a terminal usage frame. The
previously saved private response was examined offline without another request.
Its structural metadata identifies an ordinary terminal choice followed by a
second choice with the same `stop` finish reason, empty content, and top-level
`usage`. The parser had rejected every choice after the first terminal choice.

The [correction](../../packages/sdk/src/chat.ts) accepts this metadata only when
there is one choice at index zero, its finish reason matches the completed
choice, its text is empty, and its usage field is an object. Existing role,
tool-call and function-call validation still applies. Usage remains untrusted
metadata and does not determine billing. Late content, changed finish reasons,
tools, provider errors and malformed metadata remain errors; `[DONE]` remains
mandatory.

The saved capture contains 2,008 bytes with SHA-256
`1d655e565ddad3c816d9ac07474e4785b6af6dab993827e47c745585af282e13`.
It ends after the rejected frame because the earlier parser cancelled reading;
no `[DONE]` was captured. The [offline replay](I10-sdk-sse-parser-components/capture-replay.json)
produces three deltas / 13 characters with either version. Its old outcome is
`invalid_response`; its corrected outcome is `incomplete_stream`. This change
does **not** turn the failed live attempt into successful streaming acceptance.
The private body is not included in this evidence. The first, uncaptured SSE
failure remains unclassified; this captured response does not prove its cause.

## Regression and distribution checks

The new positive regression was run before the fix and
[failed as expected](I10-sdk-sse-parser-components/before-chat-tests.txt).
The sanitized fixture reproduces the observed framing and explicitly adds the
required `[DONE]` for its success cases. It passes at every byte boundary for all
three accepted text finish reasons. Its truncated variant remains incomplete.
A second test rejects late text, a different or null terminal reason, wrong
choice index, tool/function calls, malformed or missing usage and provider errors.

```sh
target/i08-toolchain/bin/node --test --test-reporter=tap \
  packages/sdk/test/chat.test.ts packages/sdk/test/client.test.ts
target/i08-toolchain/bin/node --test --test-reporter=tap \
  scripts/test_external_sdk_live.mjs
python3 scripts/run_external_sdk_acceptance.py \
  --output target/sdk-distribution-sse-fixed --real-provers \
  --asset-bundle target/external-integration/public-assets \
  --asset-bundle-sha256 af5a2eb9e11cf93174d9e1391e523a017f028a1518cd768de102f9e326bde591
```

The [focused chat/client run](I10-sdk-sse-parser-components/after-chat-client-tests.txt)
passed 32 tests, and the [harness fixtures](I10-sdk-sse-parser-components/live-harness-tests.txt)
passed four. The [fresh isolated consumer](I10-sdk-sse-parser-components/results.json)
passed nine stages in 9.696 seconds on Node 24.19.0, with 42 guarded inputs
unchanged: 59 lifecycle/trust/response tests, one real native/WASM test, Node
exports and declarations, browser/worker builds, and authentication/loading of
the independently pinned public artifact bundle. Every test count has zero
failures, skips, cancellations and TODOs. These overlapping suites are not
additive coverage.

The corrected `zkapi-solana-sdk-0.1.0.tgz` has 58 files, is 107,824 bytes, and has
SHA-256 `fc37358ce00fa7bcb5c43367c8f09b3908c617f9235e8646ae78003a21040c91`.
The original `3e601fae...` tarball and its reports remain preserved. The archive
retains the original new result bytes, logs, consumer lockfile and build graphs;
only archived log references are renamed from `.log` to `.txt` in the linked
report. The [follow-up index](I10-sdk-sse-parser-components/followup.json) records
the individual file hashes.

The independent live harness adds a separate `sse-fixed` scenario with a new
operation UUID and a different prompt. It requires all earlier dispatched
operations to be settled, refuses a second attempt for that scenario, and uses
a distinct private response capture. Implementing this scenario and the offline
checks above performs no funding, AUTH, provider inference or replay. Any later
execution, settlement and withdrawal are recorded separately. Neither the
fixture success nor the saved failed response establishes complete I10 or
production release gates.
