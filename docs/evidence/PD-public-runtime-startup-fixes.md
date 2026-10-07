# Public runtime startup fixes — 2026-10-08 JST

The public preview's initial full-history replay exposed two concrete startup
problems: repeated HTTP 429 reads and a growing challenger's full-journal write
and memory cost. Three server changes address these observed failures without
advancing the configured start slot, omitting history or changing financial state.
The [verification inventory](PD-public-runtime-startup-fixes.json) records exact
source, binary, test and observation hashes. Hosted readiness remains a separate
observation.

The shared indexer RPC client now honors numeric `Retry-After` on HTTP 429, bounded
to 1–60 seconds with a 10-second fallback for missing or invalid values. Its clones
share the cooldown, including across cancellation. A failed read still returns the
original generic failure; it does not resend the request. Replay retains the same
ordered successful prefix and four-read concurrency limit. The indexer suite passed
48 tests with one existing manual microbenchmark ignored.

The challenger accepts optional `archive_batch` settings up to 256 blocks and
33,554,432 serialized bytes. The default remains 64 blocks and 8,388,608 bytes.
This reduces full-journal rewrite frequency. A larger single block is still
preserved alone, and failures or interruption flush only the validated prefix.
The Scanner advances only after the existing durable commit completes.

Batching did not remove peak memory pressure. The retained host observation at
18:21:08 UTC reported 801,689,600 available bytes, below the 805,306,368-byte guard,
and 2,604,130,304 bytes of challenger RSS. The service stopped cleanly with exit 0
at 18:21:19, retaining a 1,371,322,352-byte journal through slot 508534491. Earlier
read-only counters also observed about 1.148 GB written while the journal grew
about 8.964 MB over 20 seconds. These observations support the write-amplification
and memory diagnosis; they are not a controlled resource benchmark.

The final candidate computes the existing canonical state checksum through a
128 KiB buffered SHA256 sink, then streams the identical v1 envelope through a
128 KiB file buffer. An explicit flush precedes file fsync, rename and directory
fsync. Cold reopen uses a buffered reader and the same streamed canonical checksum.
The State/Envelope types, checksum bytes, owner lock, semantic validation,
full archive, cloned update state and persistence-poison rules are unchanged.

The final Linux x86-64 challenger is SHA256
`e789c2db86636429a552e44605931290b16b68154e3d0424183b5c4e55e64ac0`.
It was built with Rust 1.90.0 and locked dependencies on the pinned Amazon Linux
2023 image. All 179 source inputs and their build copies remained unchanged.
Network-disabled smoke resolved its libraries and required at most GLIBC 2.34.
The CLI's expected missing-argument exit is 2; the intermediate batch smoke's
incorrect expectation of 1 is retained as a test failure, with its correction
recorded separately. The original and intermediate binaries remain preserved.

Current validation passed 28 ordinary challenger library tests, with 11 opt-in
tests initially ignored. Separate selected runs passed both coherent-cut cases,
the native interrupted-scan/persistence-failure case under both batching policies,
and one bounded synthetic timing case. Exact legacy byte comparison includes
unknown signed attempts; new checks cover multiple serializer buffers, a partial
checksum tail, fresh-process reopen, whitespace compatibility and rejection of
tampering, truncation and trailing tokens. The 20,460,095-byte synthetic archive
took 0.179 seconds to persist and 0.167 seconds to reopen on the local test host;
this does not measure the larger hosted journal's peak memory.

No streaming-candidate host RAM, catch-up or readiness result is claimed here.
The retained decoded archive, state clone and Scanner digest maps still grow with
history. These fixes do not establish a total memory or disk bound, long-term
monthly capacity, full integration acceptance or release gates. Published client,
profile and proof-asset pins are unaffected. No provider inference, financial
transaction, history reset or authority/budget reset was performed by these
implementation and fixture checks.
