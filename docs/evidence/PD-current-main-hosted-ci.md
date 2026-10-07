# Current main hosted CI checkpoint

On 2026-10-08 JST, read-only GitHub observations confirmed two completed runs at published source `6e8ecac61a1ef6f3299f7611efb351c65b7771a9`. The focused SDK/clientd workflow passed; the comprehensive implementation workflow failed. The [machine-readable report](PD-current-main-hosted-ci.json) retains exact job URLs, decoded-log hashes, GitHub artifact metadata and local correction checks.

The [focused run 37685365855](https://github.com/yukikm/solana-zkapi/actions/runs/37685365855) passed both jobs: **377 SDK tests, zero failures or skips**, real Chrome custody, typechecking/build, the isolated package runner, three Go race-test packages, and separate synthetic Python suites of 5, 7 and 6 tests. The job explicitly selected the hosted runner's `google-chrome` executable through `ZKAPI_TEST_CHROME`.

Its current-source SDK tarball hash is `e5da3b8294ae3394c0876df4d29a7af1afc96e8ef1b32fb1cd4b7c4e2efd2282`. Later documentation is part of this source snapshot, so these bytes differ from the immutable released archive `fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc`. This run does not replace that archive or its source `5ded36bf39de9b9fb6bf27a10d744437abc6a9c7`; the [release-specific hosted evidence](PD-public-client-hosted-ci.md) and [publication evidence](PD-public-client-publication.md) remain separate. The current tarball pass/digest are reported by the saved job log; this review did not download its artifact ZIP or promote any bytes.

The [implementation run 37685365958](https://github.com/yukikm/solana-zkapi/actions/runs/37685365958) finished with four successful and five failed jobs:

| Jobs | Observed outcome |
| --- | --- |
| `go`, `vault`, `svm`, `contracts` | Successful within their workflow scopes. |
| `rust`, `control` | `check_design.py` rejected three links in `PD-zkchat-integration.md` pointing into ignored private `target/` evidence. |
| `node`, `transport`, `client-challenger` | Each SDK run reported 376 passed, one failed and zero skips. The real browser journal test stopped because Chromium did not start in approximately 4.76–4.88 seconds. |

The initial hosted failures remain unchanged. No complete implementation, historical-evidence gate, or funded acceptance pass follows from the focused result.

Two narrow local corrections were prepared after these observations, without a push or hosted rerun:

- The three private-evidence Markdown links now name retained files as code and direct readers to the existing published JSON digests. All original dates, counts and result scopes remain intact; `PD-zkchat-integration.json` is unchanged. The exact `check_design.py` passed locally. In a fresh archive of the published commit with its exact submodule and no ignored `target/`, the original document reproduced precisely the three failures; overlaying only the corrected Markdown passed **582 JSON documents and 1,296 local links**. An earlier archive-only diagnostic lacking the submodule is retained separately.
- The `node`, `transport` and `client-challenger` workflow jobs now require `command -v google-chrome`, check the executable, print its version and export `ZKAPI_TEST_CHROME` before their first SDK/browser stage, matching the successful focused workflow. Static YAML comparison confirms every other workflow node is unchanged; the three shell bodies pass `bash -n`. No runtime/test source, sandbox flag or browser protection changed. This aligns the environment; the failed logs do not establish executable selection as the exclusive launch cause, and no hosted success for this correction is claimed.

No inference, AUTH, reservation, wallet transaction, release update or deployment action was performed by this review. Current server startup and eventual public consumer lifecycle evidence remain separately scoped.
