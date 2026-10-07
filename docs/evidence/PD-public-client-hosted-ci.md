# Public client candidate hosted checks — 2026-10-08 JST

The focused [SDK and clientd workflow](https://github.com/yukikm/solana-zkapi/actions/runs/37680066910)
passed both jobs at exact client source commit
`5ded36bf39de9b9fb6bf27a10d744437abc6a9c7`. It ran on the new candidate branch;
this checkpoint did not create a new GitHub release or change earlier tags.

The hosted SDK build, typecheck, Kit dependency guard and all 377 SDK tests passed
with zero skips, failures or cancellations, including real Chrome custody fixtures.
The independent application installed the generated SDK package and passed 75
lifecycle/trust fixtures, four consumer network cases, six browser-adapter cases,
two native-input installation cases, declaration checks and browser/worker builds.
These overlapping scopes are not one combined test count.

The hosted package report records exactly 121,467 bytes and SHA256
`fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc`, matching the
preserved `.2` SDK. All 58 guarded external-package source inputs remained unchanged
and were independently compared with the exact Git commit. Every downloaded stage
log matches its recorded hash. The [saved report](PD-public-client-hosted-components/sdk-preview-fixtures-browser-package-logs/external-package/results.json)
retains those checks. The workflow uploads logs and results; it does not upload its
SDK tarball as an Actions artifact. The identity join uses the generated tarball's
hash recorded by that successful hosted run.

The clientd job passed the Go race checks for `cmd/clientd`, `internal/daemon` and
`internal/egress`, plus five synthetic secret-helper, seven notice and six
source-provenance tests. The workflow used Node 24.19.0, npm 11.9.0, Go 1.25.0 and
Chrome 154.0.8037.57. All 23 downloaded artifact files are retained as public copies;
`.log` files use `.txt` names without changing bytes. The
[verification inventory](PD-public-client-hosted-ci.json) pins those copies and
the saved job result.

This is hosted client/source verification. It did not build or execute the pinned
macOS native archive or the current Linux operator server. The existing native
archive remains joined to its 551 original guarded inputs; later server fixes
have separate source and build evidence. This workflow did not select real-prover
or public-bundle options, submit funded transactions, contact a live provider or
establish a public browser/native/OpenClaw lifecycle. Comprehensive implementation
CI, release/build attestations, full I10/G1–G4 and operator readiness remain separate
claims.
