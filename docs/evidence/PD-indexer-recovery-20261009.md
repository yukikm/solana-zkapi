# Indexer unavailable: investigation and repair — 2026-10-09

The public Devnet API returned **HTTP 200 at 03:16:50 and 03:20:08 UTC**
(12:16:50 and 12:20:08 JST), with indexer, control and signer available.
The installed immutable SDK `.3` passed all **ten read-only preflight checks**
at 03:17:18 UTC; all **7,257 installed files** were unchanged. This is actual
public restoration, without AUTH, inference, wallet transactions or a client
release. The [machine-readable evidence](PD-indexer-recovery-20261009.json)
retains exact source/build, operation and observation hashes.

## What failed, and what the evidence establishes

At **02:21:22.271269 UTC**, the Indexer reported `local archive source unavailable`
and latched `source_halted: true`. Its accepted archive tail froze at slot
**509026064**. Later polls refused to re-read the source, so HTTP503 persisted
while the writer continued advancing. The old source adapter discarded the
underlying error; its exact original reason cannot be recovered from these logs.
Earlier read-only RPC observations returned HTTP200 and valid finalized tips.

A deterministic local regression reproduced a specific concurrency defect:
`regular()` compared a pathname's pre-open inode with the opened descriptor.
If the writer atomically replaced the mutable `journal.json` between those
operations, a normal commit raised `archive file changed during open`, which
would trigger the terminal halt. The old code failed that test. The saved
checkpoint's **22,862 chunk stamps plus its legacy stamp** still matched all
current immutable files. This metadata comparison is not a fresh content rehash.
The race is a plausible explanation of the live failure, not proof of its
historical interleaving or exclusion of every possible I/O error.

The repair captures the mutable head with one `O_NOFOLLOW | O_NONBLOCK` open
and validates the opened regular inode. It retains descriptor metadata and
checksum checks, immutable-file identity checks, exact prefix extension,
rollback rejection and fresh finalized account/block reconciliation. It does
not retry past corrupt history or reset the fail-closed latch. Source failures
now emit a static typed reason and optional numeric OS error without paths,
RPC URLs or raw private errors.

## Validation and actual deployment

The serial challenger library suite passed **85 tests**, with **12 existing
ignored tests** and no failures. Tests cover the exact writer-rename race,
continued rejection of immutable-file replacement, symlink rejection and
private-error redaction. Clippy passed all targets with warnings denied.
An initial over-specific test filter ran zero tests; the corrected pre-fix
regression failed and remains preserved alongside the passing suite.

The offline, pinned Rust 1.90.0 / Amazon Linux 2023 build froze **194 inputs**.
They match published `cf830c3957b7e117134d354fffcb0a4311d96fae` plus the four
repair source/test files. The 13,295,728-byte Linux executable SHA256 is
`b88226baccfff2ff53cfe982ed3958c1ea6f0de6e6d75b005ff16ecde9177284`.
ABI/no-config smoke passed; maximum required GLIBC is 2.34.

SSM `d36798a8-10ab-4f5f-91d8-f2330deb40f8` ran at **03:15:44–03:15:48 UTC**.
It stopped only the old Indexer, which exited with native status **0**, preserved
its executable and exact private checkpoint, installed the repair at
`/opt/zkapi/bin/archive-indexerd`, and started it **once** as PID **120172**.
The dispatch then failed its immediate post-start process predicate. The failed
values were not saved, so the exact transient cause is unproven. This was not
hidden or retried: separate read-only process observation verified the new
binary, followed by complete post-install verification with no additional restart.

The verified remote receipt was independently fetched and matched SHA256
`5a1253e7b2e614c9586d41728f9c0830947980861089cb36628f4aecdc65d09b`.
Across **107 protected files**, only the Indexer executable changed. All five
other process identities and all service policies remained unchanged. Writer
PID **112032**, executable `8ebeef10…89274`, continued running. Configuration,
invitation policy and admission/recovery settings were unchanged. The one
private encrypted upload version was deleted after installation, and an
exact-version HEAD returned404; no IAM policy was added or changed.

The full database remains `49c3b138…60f16`, reservations remain
`29be8a5b…337706`: four settled sessions, four retained reservations and all
25 recovery checkpoints. No grant, AUTH, inference, deposit, withdrawal,
E01 replay, history pruning or financial mutation was performed.

## Follow-up observations and retained limits

The independent direct Indexer root advanced from slot **509040003** to
**509040644**, and public readiness was again HTTP200 at 03:20:08 UTC.
The bounded post-install log sample contained 23 normal incomplete-archive
waits and no recognized source-halted record. Four halted records immediately
before the stop remain preserved. Six writer `RPC finalized tail missing`
messages were separately observed; this repair makes no RPC-behavior fix claim.

The initial read-only collector's optional `transport`-field failure, the
zero-test filter, failing regression, early upload-presence404, local preparation
against an unfinished upload response and post-start guard failure remain
recorded. None is relabeled as a successful operation. SDK/native `.3`, the
immutable `.4` source release, original journals and E01 closure remain intact.
These dated observations do not establish continuous availability, provider
credit, funded acceptance or long-term capacity qualification.
