# New AWS operator bootstrap checkpoint

Recorded 2026-10-08 JST. This extends the
[infrastructure checkpoint](PD-aws-live-infrastructure.md) with the new private
operator's bootstrap and read-only startup observations. It does not establish
public funded acceptance. Exact private execution records are hash-joined in
the [sanitized JSON record](PD-aws-operator-bootstrap.json).

The initial bootstrap ran once and stopped after PostgreSQL initialization and
migration, before signer configuration or financial writer provisioning. The
cause was an inherited `0077` umask: newly written public deployment and proof
files requested as `0644` were actually `0600`, unreadable by service accounts.
All 31 affected public files retained their authenticated input hashes. The
failed attempt, initialized database and durable marker were preserved.

A separately reviewed continuation corrected only those authenticated public
file modes, added exact `fchmod` handling to the bootstrap helper, and continued
from signer configuration. It did not rerun initialization or recreate the
database. Existing private file bytes and `0600` protection remained unchanged.
The unused challenger database login's first random password had never been
persisted; the continuation privately persisted a replacement and changed only
that unused login. The continuation passed all five remaining commands and
created the completion marker in 0.55 seconds.

PostgreSQL, signer, indexer, control and challenger initially started
successfully under their reviewed systemd units. The signer startup health
check passed. Internal configuration and catalog endpoints returned HTTP200.
At that observation, sessions, dispatch attempts and quotes were zero, Pool
admission was disabled, and the provider grant had not yet been initialized.
Later grant and gateway work belongs to its separate execution record. The
units had been started but not enabled for boot at this checkpoint.

Tree readiness remained HTTP503 while archive replay caught up. Bounded
diagnostics established primary RPC `getBlock` HTTP429, while one secondary
read succeeded. Moving only the indexer to that already configured secondary
preserved the original configuration and all challenger state, but sustained
secondary reads also returned HTTP429 with `Retry-After: 10`. The indexer was
stopped during review of a bounded read-only backoff correction. No replay
start slot was advanced and no archive or financial journal was reset.

A two-minute, 13-sample challenger observation measured RSS between 0.68 and
1.07 GB, with 2.33–2.72 GB of available host memory. Its durable journal reached
725.8 MB. The conservative memory-stop threshold was not reached. These are
startup samples, not a whole-runtime peak or long-term capacity qualification.
Challenger readiness was still false; this checkpoint must not be relabeled as
complete operator or public-preview acceptance.

## Bounded indexer backoff follow-up

The read-only RPC client now shares a bounded cooldown across concurrent
readers when HTTP429 supplies `Retry-After`. The original failed read remains
failed; the caller retains its replay cursor. Tests cover cancellation without
a retry and preservation of the failed slot. The full indexer suite passed
48 tests with one historical ignored microbenchmark; 179 source inputs were
unchanged during the Linux build. The resulting AL2023 binary was independently
checked before host installation.

At 17:41:14 UTC, the stopped host's indexer alone was replaced with SHA-256
`abd02d3a7febc8814e3feefc7f7472289f0e4af5c1e9762e739089f2af6e4e5b`.
The original `4d45f5a39646630ba6bf20e5659a7438cb863d011998fdb99108ef59d48a4d86`
binary remains retained. The encrypted transfer, plaintext hash, actual target
ABI smoke and start succeeded. Temporary exact-object download access was
removed. No profile, budget, replay start slot or challenger journal changed.

The following observation confirms reduced rejected polling, but not completed
catch-up: the secondary RPC advanced only 29 slots in approximately 102 seconds,
while tree readiness remained HTTP503. Further endpoint and progress evaluation
is required. This preserved observation must not be reported as successful
public operator readiness.

After two bounded primary archive reads succeeded, the exact original indexer
configuration was restored and the corrected binary restarted at 17:49:20 UTC.
The replay start remained slot 508520236. A 100-second observation advanced
the indexer by 775 slots, while the challenger's published health advanced by
only 65 slots and its lag increased. Tree readiness was still HTTP503. These
measurements establish partial progress and competing resource demand, not
completed catch-up. Available CPU credits remained positive on both instances;
CPU-credit exhaustion was not observed.

A separate 20-second observation read process and disk counters without loading
the full journal or issuing remote RPC. The challenger wrote 1.148 GB while its
journal grew by only 8.964 MB. Process writes averaged 57.3 MB/s, and the data
disk averaged 67.6 MB/s. Sampled RSS peaked at 2.204 GB with at least 1.220 GB
available host memory. This supports investigating bounded journal batching;
it does not establish that the instance has completed startup or can sustain
long-term operation. No history was skipped and no journal was reset.

## Bounded batching and observed memory stop

The optional archive batch configuration retains the historical 64-block/8-MiB
default and caps an explicit override at 256 blocks/32 MiB. Five unit tests,
two coherent-cut fixtures and one shutdown fixture passed. The locked AL2023
build retained all 179 guarded source inputs. At 18:18:15 UTC, the tested
challenger `a50e39ac725e0331e060021e5db4c16ce9f8fdf0ead9670ebacabc831af2bf81`
was installed after a clean stop, and only that optional batch setting was added
to the existing configuration. The prior binary and configuration bytes remain
retained. Existing journal device, inode, size and modification time were
unchanged across installation. No history, budget, profile or start slot reset
occurred, and temporary download access was removed.

At 18:20:17 UTC the indexer replay was at slot 508534440 against target 508543117,
with 8,677 slots remaining. Its mean replay rate since the primary restoration
was 7.65 slots/second. Logs contained 120 redacted HTTP errors; their category
does not establish an exact HTTP429 count. Actual root and snapshot endpoints
both returned HTTP503. Challenger health remained false, with zero pending jobs
and unknown signatures. New admission remained disabled.

At 18:21:08 UTC, available memory reached 801,689,600 bytes, below the existing
768-MiB protection floor. The guard requested a stop of only the challenger;
the stop command returned zero at 18:21:19. The sampled journal had reached
1.371 GB and RSS was 2.604 GB. State was retained, and neither the threshold nor
instance size changed. The challenger stayed stopped until the separately
verified streaming-serialization correction below. Larger batching alone did
not establish startup capacity or public readiness.

At 18:27:13 UTC the binary-only streaming correction
`e789c2db86636429a552e44605931290b16b68154e3d0424183b5c4e55e64ac0`
was installed. It replaces full encoded-JSON buffers with bounded reads,
checksumming and writes while preserving the exact version-1 envelope bytes,
checksum, full state, atomic persistence and poisoned-write handling. Local
validation passed 28 unit tests, two focused coherent-cut cases, one shutdown
case and one synthetic timing case; 11 other cases were ignored in the broad
unit scope. All 179 inputs remained unchanged during the locked Linux build.
Synthetic local timings are not host capacity evidence.

The host verified that the previous guard stop had actually exited successfully,
retained both earlier binaries, and changed only the challenger binary. The
configuration hash remained unchanged; the same paused journal's device, inode,
size and modification time were checked before restart. Installation and the
service start command completed in 1.834 seconds with exit zero; this does not
measure cold journal loading or prove archive replay or API readiness.
Actual memory and catch-up observations follow separately.

The first two-minute host observation after that correction sampled peak RSS
of 1.498 GB and at least 1.893 GB available memory, with no protection stop.
The retained archive advanced from slot 508534491 to 508534708 and grew from
1.371 to 1.394 GB. Its first new durable prefix was observed by 18:28:27 UTC,
74 seconds after the start command; this is an observation upper bound, not an
exact measurement of cold journal-loading time. The corrected process reopened,
validated and continued the existing archive. The sampled memory reduction is
real host evidence, while completed catch-up and long-term capacity remain
separate.

At the associated 18:28:07 UTC readiness cut, the indexer had 5,600 slots left
to replay. Root and snapshot endpoints still returned HTTP503; challenger
health was false, pending jobs and unknown signatures were zero, and new
admission remained suspended. The temporary exact-object download permission
was removed. No funded/public acceptance follows from this startup checkpoint.

## Unchanged-alert persistence correction

A later 180.27-second observation on the streaming binary added only 40 archive
slots and 3.38 MB of retained history, while the process wrote 9.864 GB. Average
CPU use was 0.557 core. Both readers used the configured primary RPC. Source
review identified an additional full-journal update after each failed scan even
when no alert changed. The correction checks the poisoned-write guard first,
then returns without cloning or persistence when the existing alert predicate
would add nothing. Actual new alerts retain their original durable update;
pending delivery remains independent.

The corrected challenger
`b6c53269c24d67f14b7f19cd29897ac8c93c0ddbe590fbf59d15c4c4c0383183`
passed 31 ordinary library tests, two selected coherent-cut cases and one
shutdown case, with 11 ignored library cases. All 179 inputs remained unchanged
during the locked Linux build. At 18:56:19 UTC, the host replaced only the
binary after a clean stop and retained the previous binary. Its unchanged
configuration and the same 1,470,032,540-byte journal were checked across the
replacement. Temporary download access was removed. No replay start, financial
state or admission setting changed.

At 18:57:41 UTC, canonical tree root and snapshot reads both returned HTTP200
at finalized slot 508552547. The challenger had reopened and continued its
archive through health slot 508535506, with readiness false and no pending jobs
or unknown signatures. The new redacted diagnostic identified `RPC archive
unavailable`, which is a per-slot RPC failure category and does not identify
a particular HTTP status. RSS was 1.606 GB with 1.726 GB available memory.
New admission remained disabled. These observations establish indexer API
readiness and continued same-state challenger operation; challenger catch-up
and funded public acceptance remain separate.

The first three-minute guard after the alert correction retained zero pending
jobs/unknown signatures and did not reach the memory threshold. It advanced
743 archive slots, with sampled RSS at most 1.606 GB and available memory at
least 1.728 GB. A separate 180.25-second steady observation advanced 832 slots
(about 4.62 slots/second); process writes averaged 42.79 MB/s and CPU use
0.43 core. The archive grew by 80.22 MB to 1.574 GB. This is improved progress
relative to the earlier observation, but the remaining prefix writes still
rewrite the full journal and the operator was not yet caught up.

## Actual RPC rate-limit diagnosis and empty-control pause

At 19:22:09 UTC, the diagnostics-only challenger
`4c41d3ec99e5e320ee0e4ae886542801141cc0413b1337999610cc217d79dd56`
was installed after a clean stop. The same 2,088,950,194-byte journal and exact
configuration were retained, and temporary download access was removed. Seven
HTTP fixtures, the fixed-label redaction check, the Linux smoke and all 179
guarded inputs passed. The change adds safe failure labels and numeric fields
without changing request, retry, concurrency, history or validation behavior.

The first actual failure cut at 19:24:15 UTC recorded four `getBlock` HTTP429
responses, each returning in 8–12 ms, with the existing ten-second shared
cooldown. They were not timeouts or JSON-RPC errors. This establishes rate
limiting on actual daemon reads; the earlier successful probes did not establish
the cause. The configured provider was classified as Alchemy without exposing
its URL, hostname or credentials. The account quota and unrelated account
consumption remain unmeasured.

At 19:30:18 UTC, a repeatable-read database cut confirmed zero sessions,
operations, dispatch attempts, chain transactions and outbox entries in the
new operator. The finalized snapshot at slot 508560747 had zero active notes
and pending withdrawals. With admission suspended and no challenger jobs or
unknown signatures, only the new AWS control daemon was temporarily stopped
to measure RPC contention. It exited successfully with an empty cgroup and
unchanged configuration hashes. Signer, PostgreSQL, indexer, challenger and
the original local services remained untouched. Control restoration is still
pending at this checkpoint; this is not funded restart or public availability
evidence.

One separately authorized `getBlocks` read of the latest 1,000 finalized slots
returned exactly 1,000 produced blocks, HTTP200 in 127 ms. It requested no full
blocks. This measures the block density for that range, not an account quota
or a sustained throughput guarantee.

The post-pause 180.33-second observation advanced only 684 slots (3.79
slots/second), with process writes averaging 39.10 MB/s. Ten actual `getBlock`
HTTP429 events remained between 19:30:19 and 19:34:57 UTC. Pausing the empty
control daemon did not establish enough catch-up capacity. At the later
19:43:19 UTC guard cut, the unchanged-format journal had grown to 2.497 GB,
RSS was 2.229 GB, and available memory was 1.177 GB. The original protection
threshold remained in force, new admission stayed disabled, and no archive
migration had been executed at this checkpoint.

## Explicit same-authority archive migration

The independently reviewed storage-conversion report is
[PD-challenger-segmented-migration](PD-challenger-segmented-migration.md).

After an initial read-only snapshot returned HTTP503 without stopping anything,
a fresh complete check succeeded. The new challenger stopped cleanly at
20:05:02 UTC with an empty cgroup. Its original 2,912,440,894-byte v1 archive,
configuration and existing authority-lock identity were pinned before any
conversion. No active notes, pending withdrawals, sessions, operations, dispatch
attempts, chain transactions, outbox work or challenger jobs were present.

The exact reviewed Linux candidate
`271628332f24c0d60eb1bc105bf372e8a418aab2e87e002168e3f2ce1c80b0fe`
was transferred as pinned ciphertext; the temporary exact-object read policy was
removed. A separately reviewed one-attempt monitor ran the explicit offline
conversion with a private network namespace, direct child ownership and
cooperative cancellation without kill escalation or rollback. The conversion
finished successfully in 199.349 seconds. It retained the original bytes with
SHA256 `fbec86b6c8dfd6ddda5ee9aaa9c6be408098440449720b57baedd4042e37aa2b`
and validated 29,844 full blocks into 117 immutable chunks.

A separate offline process then reopened and verified the entire committed
archive, including the retained legacy prefix, in 212.358 seconds. It returned
nonempty metrics at the unchanged slot 508550323, with zero jobs and unknown
signatures. The raw primary-head SHA256 was
`ab82591dc87c46e50ece3afa1fc59afe6a6013c71ca9a8b0688679548daa3da6`;
this byte hash is distinct from the typed head digest. Original owner-lock and
configuration checks passed. The independent final cut at 20:26:40 UTC confirmed
119 retained files totaling 5,824,957,378 logical bytes and 5,825,212,416 allocated
bytes, including legacy and chunks; the small head alone is not archive size.

Observed process high-water marks were 1.847 GB during migration and 1.855 GB
during cold validation. These are process observations, not an assurance that
the growing current chain will fit. Challenger and control remain stopped,
new admission remains suspended, and no financial action occurred. A separate
disk-backed v2 reader change is being reviewed before resuming, while preserving
the committed format, complete archive and existing authority. RPC constraints
and throughput remain distinct from this successful storage conversion; see
[the measured capacity chronology](PD-aws-rpc-capacity.md).
