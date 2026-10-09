# Actual checkpoint population and warm restart

Recorded 2026-10-09 JST. Both private checkpoints exist, and one measured
same-binary writer/follower restart completed. This is the installed
`0037eca87a656aeae06f8c01fa4102d90f15dbacee4bf1074caf2292ed7c8f49`
checkpoint from [the earlier installation](PD-restart-checkpoints.md), before any
throughput successor. The restart changed no executable or configuration.
The [JSON record](PD-warm-restart-20261009.json) retains exact source, receipt,
observation and stop-record hashes. It does not claim equality with later
working-tree changes.

At **08:43:16 JST** (2026-10-08 23:43:16 UTC), the independent read-only
observation found both owner-only cache envelopes, about 42.48 MB each, with
approximately 8.46 MB metadata and 34.02 MB runtime state. Both authenticated
anchors were slot `508954204`; both original installed processes remained active.
This closes the earlier unknown initial-population result without changing the
historical observation that caches were absent immediately after installation.

The one restart command ran from **08:45:21 to 08:47:16 JST** and retained the
exact current journal, closed four-session database and four reservations.
Both new processes replaced their private cache, and the follower advanced its
cached prefix to the writer's retained anchor:

| Observation | Writer | Follower |
| --- | ---: | ---: |
| New process `rchar`, bytes | 83,033,296 | 141,732,945 |
| Prior committed archive payload, bytes | 46,673,163,486 | 46,641,714,386 |
| Elapsed since start at observation, seconds | 57.85 | 54.71 |
| Process CPU at observation, seconds | 8.9 | 8.8 |
| Cache anchor before restart | 508955516 | 508955208 |
| Cache anchor after observation | 508955516 | 508955516 |

The elapsed values are **observed upper bounds**, including startup and the
collector's work; they are not isolated cache-load timings or API-ready times.
`rchar` counts process reads, including cached reads, and is distinct from
physical disk `read_bytes`. The cache replacements, authenticated anchors and
read counts below one full retained archive support the observed fast-resume
result with the reviewed cache/suffix implementation. This is not a per-file
kernel audit or a cold-versus-warm benchmark under identical conditions.

The successful command reported receipt SHA-256
`e6d05884e36fc678d35611a49b7cce1ced7115430d7bc459d304cbfd60909f95`.
A separate read-only fetch at **08:48:08 JST** downloaded the complete receipt,
attempt and both stopped-service records. The downloaded bytes and SHA-256
match the successful remote output; no failure receipt was present. The writer's
native exit metadata was unavailable, so no clean or zero-exit assertion is made
for it. The follower's native exit status was **0**. The helper's explicit
follower SIGKILL was not used.

The stopped and final journal bytes were identical, with zero jobs and zero
transport records, 431,907 retained blocks and 19,311 chunks. Database SHA-256
remained `49c3b1387f2916e8fe94c4672ebb848f22b73b98787f99e2483bfb9c06260f16`;
reservation SHA-256 remained
`29be8a5b46f7efc666b8ad623093ab83a133365ef42cee036ea533453c337706`.
PostgreSQL, signer and control process identities remained unchanged. There was
no new AUTH, inference, transaction request, reservation reset, archive pruning,
configuration change or automatic retry.

**Public readiness remains unverified, and the gateway remains stopped.**
The separate pre-restart control readiness request completed at **08:44:31 JST**
with HTTP **503**, reporting `indexer: unavailable`; control and signer were
available. The initial cache anchor was already 7,673 seconds behind the cache
observation's wall clock. The stored writer health was itself stale and reported
`ready: false`; its saved lag must not be presented as a fresh current lag.
The capacity observation measured 84,358,758,400 filesystem bytes and
33,854,193,664 available bytes; this is a dated headroom observation, not
long-term capacity qualification. The warm restart did not perform a fresh
post-restart readiness check or establish catch-up throughput. E01 and any
subsequent throughput or gateway continuation require their own evidence.
