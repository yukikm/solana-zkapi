# Chromium prover navigation follow-up

Hosted implementation [run 37730079578](https://github.com/yukikm/solana-zkapi/actions/runs/37730079578)
at `47684a2225f2133153f6e042a268e43b41f0b696` finished with eight successful jobs
and one failed client/challenger job. Its backend, SDK and challenger component
reports passed and match their aggregate hashes. The wallet component's 377 SDK
tests passed with zero failures/skips; its real-Chrome worker test then failed
before browser proof execution with an unresolved `/prover-runtime.ts` module
specifier. Chrome was `154.0.8037.97`. The failed aggregate, wallet log and browser
log are retained with exact hashes. Later component/offline stages were not
reached; this is not a full CI pass.

The [test harness](../../packages/sdk/test/prover-browser.ts) created a browser
target with its destination URL and immediately evaluated relative imports,
before explicitly waiting for that document. The correction first creates
`about:blank`, navigates to the isolated test server, checks the navigation
result, then waits at most 20 seconds for the exact expected URL and completed
document. Only the read-only readiness probe tolerates the specific execution
context replacement error. Unrelated debugger errors still fail immediately.
Proof execution occurs once after readiness; no proof retry or Chrome security
flag change was added. SDK and prover runtime code and published artifacts are
unchanged.

The focused local run passed all three tests with zero failures, skips or
cancellations in 65.345 seconds. Two checks cover navigation
context replacement and immediate rejection of unrelated debugger failure. The
third uses actual Chrome `Chrome/154.0.8037.98` to generate fresh request,
withdrawal, escape and two tree proofs through a dedicated WASM worker, verify
receipts/successor state, reject three invalid cases, and exercise exactly one
native fallback after deliberate worker termination. These are known-public
local cryptographic fixtures, not public-chain transactions or paid inference.

The run used a new isolated working directory containing fifteen authenticated
fixture copies; its 75 source guards and all original inputs/output artifacts
were unchanged. New proof outputs remain separate from earlier fixture evidence.
No broad aggregate rerun, release rebuild, deployment, funding or provider action
was performed by this correction. A future hosted run must establish its own
result. [Exact records and hashes](PD-prover-browser-navigation.json) preserve
the failed hosted observation and successful focused local scope separately.
