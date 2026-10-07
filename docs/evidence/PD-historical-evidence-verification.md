# Historical evidence source verification

Date: 2026-10-08 JST (local checks completed 2026-10-07 UTC).

The historical implementation inventory now has an explicit source binding in
[implementation-source.json](implementation-source.json). Its original
[report](implementation-results.json) and all 811 recorded hashes are unchanged.
The [machine-readable checkpoint](PD-historical-evidence-verification.json)
records the source, verification results and limits.

## Why the check changed

Implementation CI [37689991621](https://github.com/yukikm/solana-zkapi/actions/runs/37689991621)
at `340b043760919782b563b1f0598f8af75083a2b9` rejected 139 changed hashes and
38 moved or missing paths because the old checker compared a historical source
inventory to the latest checkout. That failed observation remains valid and is
preserved. The Rust commands after that gate were not executed by that job.

All 811 expected hashes match the exact regular Git blobs at
`a9c3364a89990e22b0a3c3d0bddee82493017987`, the commit that last changed the
inventory. The report bytes at that commit and the failing CI commit are equal:
SHA-256 `96ab495d58e351883ac2660b75ad4b50955e81c6b84186e6e52602c728d079e0`.
This is a source-identity correction; it does not update historical hashes to
match current code.

The [source migration map](../source-migrations.json) covers all 38 removed
paths, but 16 of those map hashes describe a later source revision. The verifier
therefore uses the original commit, without substituting migrated files or
ignoring missing entries.

## Verification contract

`python3 scripts/check_evidence.py` verifies the sidecar's report-byte pin,
the same report blob in the exact source commit, and every recorded artifact's
SHA-256 against that commit's tree-selected blob. Only regular Git file modes
`100644` and `100755` are accepted. Invalid paths, symlinks, gitlinks, duplicate
JSON fields, missing objects and hash mismatches fail verification.

The checker never fetches objects or falls back to current files. Git object
replacement and lazy fetching are disabled; all Git transports are disallowed
inside the validator. A missing commit produces an actionable error. The Rust
CI job explicitly fetches only the pinned historical commit before validation:

```sh
git fetch --no-tags --depth=1 origin a9c3364a89990e22b0a3c3d0bddee82493017987
python3 -m unittest discover -s scripts -p 'test_check_evidence.py'
python3 scripts/check_evidence.py
```

## Local result and boundaries

The 15 local Git-fixture tests passed with zero skips, including a shallow
checkout that fails before an explicit local fetch, unchanged Git index/HEAD/refs,
report and source tampering, missing blobs, unsafe paths and unsupported modes.
The real repository check passed all 811 hashes. The original report, actual
checkout HEAD/index/refs and all 187 frozen archive-indexer build inputs remained
unchanged. Initial 14-test success before the additional transport-denial test is
retained separately; counts are overlapping, not additive.

This checkpoint establishes historical inventory integrity only. Current
source/design checks, builds and runtime tests remain separate CI steps. It does
not establish current-source equality, execution of historical tests, SVM/CU
results, comprehensive hosted CI success, public readiness, funded acceptance or
a release gate. No hosted run of this checker change is claimed here.
