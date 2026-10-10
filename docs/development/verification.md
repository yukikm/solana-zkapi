# Verification

Run current checks from [Contributing](../../CONTRIBUTING.md). Commit source,
tests, intentional fixtures, specifications, release notes and user/developer
guides. Store generated reports, captured responses, logs and operational
handoffs in ignored `docs/evidence/` or `target/`; never force-add them. CI
publishes generated reports as workflow artifacts.

Every result must identify its source revision, commands, inputs and scope.
Distinguish synthetic fixtures, real proof/SBF tests, public Devnet observations
and CI results. A fixture test does not establish live-provider acceptance;
saved HTTP responses do not establish current availability. Preserve failures
and limitations alongside successes, and summarize supported behavior in
[status](../status.md) and release notes.

Use reviewed files in `tests/fixtures/` for stable regression inputs, with their
provenance. A fresh clone must not require an ignored historical report to build
or run ordinary checks. `scripts/check_design.py` checks tracked Markdown and
local links, plus the protocol's structural requirements.

Never replay historical AUTH, inference, deposits or withdrawals to reproduce a
report. Live provider or public-chain acceptance needs its own explicit
authorization and preserves existing journals, reservations and custody.
See [provider acceptance](provider-acceptance.md) for reusable tooling.

Reports previously committed remain in the
[immutable historical archive](https://github.com/yukikm/solana-zkapi/tree/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence).
Removing current-tree reports does not rewrite history or signed releases.
`scripts/check_evidence.py` is an optional offline validator for that archive;
it requires the original `docs/evidence/implementation-source.json`, report and
pinned Git objects. It fails when inputs are absent and is not a current-source
CI gate. Its independent Git-fixture tests remain in CI.
