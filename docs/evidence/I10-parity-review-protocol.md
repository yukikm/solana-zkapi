# Ethereum parity review: native client and provider lifecycle

Date: 2026-10-07 JST. Solana review baseline: `664db46`. Ethereum reference:
`045b444ea1b52538d1b40273c7cb6ed09468a052`.

This review covers the shared `ClientDaemon`, native runtime/model configuration,
loopback/relay boundary, and the control service's direct/proxy dispatch and
recovery integration. It supplements [the previous parity evidence](I10-parity.md).
It is a scoped engineering review with local regressions, not a new provider,
public-chain, Phantom or third-party acceptance result.

## Reproduced and fixed findings

1. **Pending-read cancellation freed native admission too early.** When a stream
   cancellation begins, Web Streams resolves an outstanding `read()` as EOF
   before its asynchronous cancellation callback finishes. `ClientDaemon` used
   that EOF to decrement `inflight`, allowing management/session maintenance or
   a new request while the previous cancellation was still running. Cancellation
   now owns finalization once started. The regression blocks upstream cancellation
   in both proxy and direct modes and checks that a new request and management
   close remain fenced until it finishes. This complements the earlier public
   application lock fix; both layers still use the same lifecycle.
2. **Valid direct client tool schemas were rejected as modalities.** Recursive
   field checks treated application schema properties such as `type`, `image_url`,
   `audio`, `background` and `conversation` as provider instructions. The guard
   now recognizes parameter schemas only inside native function-tool definitions.
   Exact inference bytes are preserved. Actual image inputs and hosted tools
   outside those containers remain rejected before authorization.
3. **Direct text structured output was rejected.** Ethereum's native client
   forwards `response_format`; the Solana recursive type guard rejected
   `json_object` and `json_schema`. Direct Chat now accepts text/JSON selectors at
   `response_format`, and direct Responses at `text.format`, including their
   native schema containers. Misplaced selectors, image formats and hosted tools
   remain rejected. This does not expand the separate proxy metering subset.
4. **Standard identity metadata crossed the direct boundary.** Ethereum clientd
   removes `user`, `metadata`, `safety_identifier`, `prompt_cache_key`,
   `extra_headers` and `provider`. Solana's direct path previously forwarded them.
   It now rejects those top-level fields before proof/AUTH/inference. Explicit
   rejection is an intentional compatibility difference from Ethereum's removal:
   the accepted request stays byte-for-byte identical to its durable intent.
   Proxy service validation already rejects these unsupported top-level fields.
5. **Arbitrary upstream headers reached the local origin.** The daemon cloned
   all response headers, including `Set-Cookie`, CORS and provider correlation
   headers. It now forwards only content type, retry timing and, for proxy mode,
   its operation status/error headers. The local operation ID and `no-store`
   policy replace upstream values. Regression cases cover all three modes.
6. **Direct Responses could silently enable API storage.** Omitting `store`
   previously passed the direct guard. OpenAI documents that Responses defaults
   to stored responses when this field is omitted. Direct Responses now requires
   explicit `store:false` before authorization; omitted/null/true/string/number
   values fail closed, and valid bytes are preserved. Existing proxy code already
   writes `store:false`. This is an application-storage setting, not a promise
   about all provider logging or retention. See the [official Responses API
   reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

Implementation: `packages/sdk/src/clientd-bridge.ts` (`infer`, request guards,
response headers and cancellation finalizer). Regressions:
`packages/sdk/test/clientd.test.ts`. The [native README](../../apps/clientd/README.md)
documents these behaviors and corrects the previous fixed-60-second TTL wording:
nonzero reuse requests that TTL; zero reuse requests 60 seconds and closes after
each request.

The comparison reads are
`vendor/ethereum-zkapi/zkapi-clientd/internal/server/server.go::sanitize/complete`
and its `TestIdentityMetadataIsRemovedAndInferenceExtensionsSurvive` test.
No upstream/vendor file was changed.

## Verification

[Recorded commands, source hashes and log hashes](I10-parity-review-protocol-components/results.json)
identify this review's snapshots. Every new regression was run before its fix and
failed, then passed after the correction. Those `*-before.tap` and `*-after.tap`
files are retained alongside the final suite.

- Final SDK lifecycle command: `target/i08-toolchain/bin/node --test
  --test-reporter=tap packages/sdk/test/clientd.test.ts
  packages/sdk/test/clientd-models.test.ts packages/sdk/test/client.test.ts
  packages/sdk/test/control.test.ts`: **118 passed**, zero failures, skips,
  cancellations or TODOs; 90 top-level tests. This uses the actual encrypted
  journal/locking and shared lifecycle with synthetic provider/proof/settlement
  fixtures. The earlier 116-pass snapshot precedes the storage/structured-output
  tests and remains separate history.
- `target/i08-toolchain/bin/node node_modules/typescript/bin/tsc --noEmit -p
  apps/clientd/tsconfig.json` and the equivalent
  `packages/sdk/tsconfig.json`: passed.
- From `apps/clientd`, `../../target/i08-toolchain/bin/go test -race ./...`:
  all three packages passed, including actual Unix socket and SOCKS5 boundary
  checks. The egress package reused Go's valid test cache; this is not a new
  public Tor observation.
- `git diff --check`: passed.

No Rust service or on-chain implementation was changed. No SBF suite or full
provider service integration was rerun for these TypeScript boundary fixes.

## Reviewed contracts and remaining demonstration work

Per-model tariffs remain bound to manifest hashes, provider, explicit mode and
API allowlists in `clientd-models.ts` and `apps/clientd/runtime.ts`. New-model sends
settle the prior session before authorization and preserve the new operation ID
and exact accepted bytes. Restart recovery, unknown inference, cancellation,
unaccepted AUTH and emergency wallet management continue through the existing
SDK state machines; no inference replay or direct-to-proxy fallback was added.

The inspected service paths retain durable issuance checkpoints before direct
dispatch, saved management handles before verification, and disable/usage/delete
ordering before direct finalization (`services/control/src/direct/runtime.rs`).
OpenRouter recovery lists matching management keys and never yields their runtime
secret. OA key verification and provider evidence remain separate trust steps.
Proxy admission reserves against the fixed tariff, binds exact request bytes by
HMAC and treats duplicate operations as non-replayable
(`services/control/src/inference.rs`, `proxy/request.rs`). These are source review
observations supported by earlier service evidence, not a newly executed live
provider test. Provider metering and OA final receipt authenticity assumptions
remain as described in the existing direct adapter/evidence contracts.

The local fixes make the supported paths more faithful to the Ethereum native
experience. Broad live parity still needs recorded direct OA and direct
OpenRouter issuance, actual inference and settlement, all advertised proxy APIs,
streaming, model switching, restart/cancellation and final withdrawals on the
intended public devnet profile with a real wallet. Mainnet deployment and a
third-party audit are intentionally later milestones and are not findings here.
Supported text/client-tool subsets do not establish complete compatibility with
every OpenAI/Anthropic client, multimodal input, hosted tools or every provider
extension. Provider-side retention and observable network metadata remain trust
boundaries even with `store:false` and header/metadata guards.

This review did not read provider secrets, issue funded transactions or inference,
change deployment/profile pins, modify private journals, restart public services,
or change the authorized global provider budget. Historical public results and
the pre-existing `work/single-deposit-review/` directory were preserved.
