# Verification records

Commit source, tests, deliberate test fixtures, specifications, release notes and
user/developer guides. Local commands, test results, captured responses, logs and
operational handoffs belong in **`docs/evidence/` or `target/`**, which are ignored
by Git. Do not force-add these directories. CI publishes generated reports as
workflow artifacts; a fresh clone does not need a retained local report to build
or run its ordinary checks.

## Historical archive

Reports committed before this policy remain in the
[immutable historical archive](https://github.com/yukikm/solana-zkapi/tree/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence).
Public guides link to exact files at that revision. Removing reports from the
current tree does not rewrite Git history, change signed releases or invalidate
historical financial records. Existing local copies are retained.

Each result establishes only its recorded source and scope. Fixture tests do not
prove live-provider acceptance, old HTTP responses do not prove availability,
and a saved hash inventory does not rerun tests. Keep failures and limitations
alongside successes. Summarize supported behavior and release limits in
[SDK status](sdk/status.md) and release notes.

## Reproducing and reviewing results

Follow [Contributing](../CONTRIBUTING.md) for current checks. Runners create their
ignored output directories as needed; review fresh output from the current run.
Never replay historical AUTH, inference, deposits or withdrawals to reproduce a
report. Public-chain or provider acceptance needs its own explicit authorization.

`scripts/check_evidence.py` remains an optional offline validator for a locally
retained historical inventory. It requires the original
`docs/evidence/implementation-source.json`, its report and the pinned Git source
objects. It fails when inputs are absent and is not a required current-source CI
gate. Its independent Git-fixture tests remain in CI. Historical documents and
local scratch files are excluded from `scripts/check_design.py`; public guides
and protocol contracts still undergo structural and link checks.

Tests that need stable regression input use reviewed files under `tests/fixtures/`,
with provenance. These are explicit test dependencies, not new run reports.
