# Compact deposit implementation review — 2026-10-06 JST

Reviewed the uncommitted ADR-0003 implementation in `solana-zkapi`, including
the Vault/codec, SDK trust and journal recovery, control/challenger configuration,
and finalized indexer replay. Two defects were fixed. Unrelated demo work was
preserved. This report follows the [initial implementation](I10-single-deposit-implementation.md);
its earlier reports remain historical evidence.

## Fixed findings

1. **Existing buffer-only deployments could not restart with the new service
   build.** `RuntimeConfig` required the new local IDL hash, and `DevnetConfig`
   required the new 16-instruction contract. Previously authenticated
   15-instruction manifests therefore failed startup, even though their wire
   contract remains supported. Configuration now accepts the exact historical
   IDL only without the compact capability, retaining the original manifest,
   IDL, program and build pins. The historical compiler artifact from
   `94b4116728d3e9ee111dd161d16f50eeba592e46` is checked in as an independent test
   fixture. Tests cover both local and devnet, reject old IDL plus compact
   capability, and reject changed arguments/accounts or missing/unknown
   instructions even after those altered artifacts are repinned.
2. **Reproving an unsigned deposit could silently change its priority fee.**
   `setUnsentPriorityFee` updated only the prepared plan; refreshing its
   root/ID/expiry discarded the plan and reused the current client's default.
   A proof interruption and restart could also change the fee. The regression
   reproduced an explicit zero choice becoming 999 micro-lamports/CU. The inline
   operation now persists the fee before proving, retains it through refreshes
   and explicit finalized-rejection retries, and recovers it from older saved
   plans/attempts. Journal validation enforces canonical u64 values and equality
   with the saved plan and attempts. Signed transactions remain immutable.

Changed implementation: `services/control/src/config.rs`,
`packages/sdk/src/wallet.ts`, and `packages/sdk/src/control.ts`. Regression tests
are in `services/control/tests/devnet_config.rs` and
`packages/sdk/test/inline-deposit.test.ts`; the local acceptance runner now also
format-checks `config.rs`. The SDK documentation records durable fee selection.

No additional actionable defect was found in the compact Vault/codec or
indexer replay. Full schema 2 lifecycles were added to the permanent SDK suite:
compact deposit to mutual close, escape/finalize, and unavailable-clearance
fallback to escape/finalize. These tests reopen encrypted storage before each
receipt transition and preserve the original inline history through closure.
They use synthetic chain/proof/clearance fixtures and real Ed25519/journal
operations; they do not establish public wallet acceptance.

## Final verification

`python3 scripts/run_single_deposit_acceptance.py` passed all **20 stages** in
**44.970 seconds** with **456 runtime source inputs unchanged** and the existing
wrong-VK fixture unchanged. The [aggregate](I10-single-deposit-review-results.json)
retains exact commands, tool versions and source hashes. Its referenced logs
and JSON artifacts are copied byte-for-byte into
`I10-single-deposit-review-components/`; the
[archive index](I10-single-deposit-review-archive.json) maps original paths to
saved files and SHA-256 hashes.

| Check | Result |
|---|---|
| SDK | 214 passed, no failures/skips; 25 inline tests |
| UI/browser | 67 passed, no failures/skips; synthetic wallet/provider fixtures |
| Compact actual-proof SBF | 61 cases, maximum 179,148 CU |
| SDK saved wire to actual SBF | One signature request, one durable save, 1,007 bytes |
| Legacy Vault | 366 transactions: 203 successes and 163 expected rejections |
| Indexer | 45 passed; one existing manual benchmark ignored |
| Control configuration | 7 passed; one existing PostgreSQL integration test ignored |
| Other checks | Codec 5/Vault 9 tests, fresh compiler IDL, IDL mutation tests, SDK/clientd/UI typechecks, OpenAPI/design, Rust formatting and diff checks passed |

Stage counts overlap and must not be added into one end-to-end test count.
The previous implementation inventory is preserved as
`implementation-results-before-single-deposit-review.json`; refreshing the
current file-hash inventory does not rerun historical public/provider evidence.

No public deployment, service restart, funded-journal migration, provider
request or real Phantom test was performed. Public compact-deposit finality,
Phantom acceptance, hosted CI, full I10 and release gates remain unverified.

## Selected commit verification

Commit `26ebc27` includes the compact Vault/codec, SDK and required legacy recovery,
indexer replay, authenticated capability/configuration, review fixes and evidence.
Pre-existing live-demo UI/provider/diagnostic/readiness changes were excluded
from that commit and are recorded separately in the
[demo commit verification](I10-demo-commit-results.json). The earlier 67-UI/45-indexer results above describe that larger
mixed source snapshot; UI presentation changes described in the original
implementation report are not part of this commit.

A separate checkout of the selected Git tree passed all **20 stages** in
**115.386 seconds**, with **440 runtime source inputs unchanged**:
SDK **214**, existing UI **19**, indexer **42** and control configuration
**7** tests passed; the indexer manual benchmark and PostgreSQL integration
case remain intentionally ignored. Compact SBF **61 cases**, legacy Vault
**366 transactions**, compiler IDL, typechecks and design/format checks passed.
See the [selected-tree aggregate](I10-single-deposit-commit-results.json) and
[byte-exact archive index](I10-single-deposit-commit-archive.json). Every tested
runtime input was also compared to the final staging index before committing.
No public deployment or real Phantom test follows from this local run.
