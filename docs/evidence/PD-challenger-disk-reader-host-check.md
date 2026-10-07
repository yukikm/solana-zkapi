# Challenger disk reader: actual offline host check

On 2026-10-08 JST, the existing preview host completed a fresh-process `status`
check using the [locally tested disk reader](PD-challenger-disk-reader-candidate.md).
The process validated the existing v2 archive and retained full legacy prefix,
exited 0 after **382.642 seconds**, and emitted no stderr. The observed process
high-water RSS was **31,084,544 bytes**, with minimum host available memory of
3,392,995,328 bytes over 382 samples. See the [redacted result](PD-challenger-disk-reader-host-check.json).

The installed reader SHA-256 is
`c73d58baebb1ad0d992ba63ca0827af4fb9636d93985440c9dffdd98e9fb7ac2`.
It matches the separately verified Linux build and its 182 guarded source inputs.
No new migration was performed. The 29,844 blocks, 117 chunks, complete head
metadata, original legacy bytes/digest, owner-lock identity, configuration and
archive inventory match the [prior migration checkpoint](PD-challenger-segmented-migration.md).
The committed tail remains slot 508550323. The retained archive storage is
5,824,957,378 logical bytes and 5,825,212,416 allocated bytes across 119 data files;
the separate owner lock is also identity-checked.

The monitor ran the child in its verified private network namespace and retained
the same cooperative cancellation/reap policy. No cancellation signal was sent.
The final observation found control and challenger cleanly inactive and admission
suspended. This check establishes offline validation of the complete existing
archive with bounded payload memory. It does not establish live catch-up, current
snapshot readiness, a running full-stack memory bound, monthly capacity, or any
funded browser/native/provider lifecycle. Restart and subsequent observations are
separate evidence.
