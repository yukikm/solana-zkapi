# Challenger alert no-op persistence — 2026-10-08 JST

A read-only observation of the preceding streaming candidate found about 9.864 GB
of process writes over 180.27 seconds while its archive grew about 3.38 MB and
advanced only 40 slots. Both readers used the same configured primary RPC. Source
inspection identified an additional cause of write amplification: every failed
worker iteration called `enqueue_alerts`, which cloned, hashed and persisted the
complete journal even when there were no jobs or no severity changes. The
[verification inventory](PD-public-runtime-alert-noop.json) pins the aggregate
observation files without publishing their private contents.

`enqueue_alerts` now checks the persistence-poison guard first and computes the
existing per-job severity changes before cloning the journal. If no event would
be added, it returns zero without touching the archive file. Actual changes still
use the original validation and atomic persistence path. Event order, identifiers,
monotonic timestamps and the completed-job transition to `Alert::None` remain
unchanged. Pending spool delivery still runs independently after enqueueing.

The worker also reports the existing redacted `Error` display category instead of
one generic message. Static RPC archive and account-cut reasons remain distinct;
underlying I/O, JSON and database details stay hidden. It does not log inner error
objects, RPC URLs or response bodies. Batch defaults and bounds remain unchanged.

The ordinary library suite passed 31 tests, with 11 opt-in tests ignored. Separate
selected runs passed both coherent-cut fixtures and one native interrupted-scan
fixture. New tests verify unchanged inode, modification time and exact bytes for
no-job and unchanged-severity cases, including a write trap; new severity and
completion events still persist. They also cover independent delivery, cold
reopen, persistence-poison rejection and redaction for every error variant. The
initial sandbox run's two loopback permission failures remain preserved; the
unrestricted run passed. These scopes overlap and are not a live acceptance total.

The Linux x86-64 candidate is 11,471,488 bytes, SHA256
`b6c53269c24d67f14b7f19cd29897ac8c93c0ddbe590fbf59d15c4c4c0383183`.
It built in 120 seconds using Rust 1.90.0 and locked dependencies on the pinned
Amazon Linux 2023 image. All 179 fixed source inputs and their build copies were
unchanged before and after the build. Network-disabled, read-only smoke resolved
all libraries, required at most GLIBC 2.34 and confirmed the expected missing-config
exit code 2. The original and preceding streaming binaries remain preserved.

This checkpoint establishes the source change, fixture behavior and built bytes.
Host catch-up, RAM and readiness after installation require separate observations.
Successful archive commits still rewrite retained history, and decoded archive,
state clones, Scanner maps and disk usage remain unbounded over time. No provider
request, AUTH, funding, transaction send, history skip/reset or authority/budget
change occurred in these implementation and fixture checks. The preceding
[startup-fixes checkpoint](PD-public-runtime-startup-fixes.md), including earlier
HTTP 429, smoke-test and memory-guard observations, remains unchanged.
