# Hosted implementation CI at 1a25289

On 2026-10-08, [implementation run 37743037686](https://github.com/yukikm/solana-zkapi/actions/runs/37743037686)
completed successfully at source
`1a25289a70a9171667be388e6ac18bc1586c1960`. All nine configured jobs passed:
Rust, SVM, Vault, transport, control, contracts, client/challenger, Node and Go.
Both I10 steps passed. This closes the hosted implementation-CI gap **for this
revision**. The [machine-readable record](PD-hosted-ci-1a252.json) preserves
the exact run, job, artifact and log hashes.

The selected runtime artifact's 571,905-byte ZIP independently matched GitHub's
SHA-256 `e4fc6b104c6c80304ec7d060250e3b583e0b19169bfc94bb498b210a347e656c`.
All 100 extracted members matched the ZIP. The seven-stage aggregate passed in
2,682.381 seconds; all 14 component-report/log hash joins passed. Its 546 source
entries match the exact commit: 545 regular Git blobs and the pinned upstream
gitlink. This verification did not substitute current working-tree files.

| Aggregate stage | Recorded passing scope |
|---|---|
| Backend | 95 tests with disposable PostgreSQL and local provider/runtime fixtures |
| SDK | 377 SDK tests, 2 native integration tests and 7 native tests |
| Challenger | 86 native/SDK runtime tests |
| Wallet | 377 SDK tests, 3 actual-browser WASM tests, 1 WASM/SBF, 1 wallet/SBF and 5 native tests |
| clientd | 69 Go tests including subtests, 105 SDK checks and 1 Go/SDK/SBF test |
| Operations | 19 tests |
| Integration | Four passing dispatcher, load, fault and end-to-end test groups |

Counts overlap across stages and are not summed. The following offline-regression
step separately passed 85 Node tests, Python suites of 22, 3 and 4 tests, and
16 native challenger fixture checks. Those 16 checks use a disposable local
database and signed offline fixture, with zero network requests. The
[earlier 9109 failure](PD-offline-challenger-node-followup.md), caused by the
fixture's missing default Node path, remains unchanged; the reviewed successor
passed here.

The later gateway wallet-route correction, service-readiness changes, OpenClaw
gate work and private maintenance helpers are outside this commit's result.
The immutable client release was not rebuilt or repinned. A complete hosted
workflow is distinct from full I10/G1–G4 acceptance, real-provider/public-wallet
results and the currently separate service-recovery attempt.
