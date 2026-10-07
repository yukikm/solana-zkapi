# Public Devnet runtime capacity review

Recorded 2026-10-07 UTC. This is a read-only source and local metadata review,
not a load test or a cloud deployment. The current implementation does **not**
establish sustainable operation on 4, 8 or 16 GiB RAM, a 20 GiB data volume,
or a USD 50 monthly budget. No 30-day capacity claim follows. The
[machine-readable record](PD-runtime-capacity-review.json) pins 16 public source
and evidence files and records the metadata-only observations.

## What was observed

The full server stack was not running during inspection. The existing
`target/pd-chat/postgres` instance had ten processes with summed RSS of about
20.95 MiB at idle. Named control, signer, dispatcher, indexer and challenger
executables were absent. Codex/tooling Node processes were excluded. This
macOS host has 16 GiB physical RAM and ten logical CPUs; idle RSS, compressed or
nonresident pages and shared pages do not establish workload peaks. Process
inspection used executable names and cwd metadata, without arguments or
environment values. These were ephemeral tool observations, not a saved raw
process capture. Docker was installed but its daemon was unavailable; no Linux
runner was started.

The existing [challenger harness report](I10-provider-wallet-local-components/challenger-results.json)
records eight post-case native test-process samples of 301,968–304,880 KiB
(about 295–298 MiB), p50 5.521 seconds and p95 10.842 seconds. These include the
harness/prover and synthetic RPC outcomes. They are neither peak process-tree
memory nor full-stack measurements, as the [challenger README](../../services/challenger/README.md)
already explains. The newer [six actual bundle proofs](PD-complete-bundle-proofs.md)
establish native/Node WASM byte compatibility, with no memory-peak measurement.

Only file size and modification metadata were read from the following existing
private journals; their contents were neither read nor hashed:

| Existing journal directory under `target/` | `journal/journal.json` bytes |
| --- | ---: |
| `i10-devnet-challenger` | 447,569 |
| `i10-devnet-challenger-batched` | 873,480,914 |
| `i10-devnet-challenger-final` | 132,452,035 |
| `i10-devnet-challenger-live` | 166,482,346 |

The largest is about 833 MiB. These are different histories, not a time series;
no bytes/day rate or month-long storage estimate can be derived from them.

## Growth that prevents a capacity claim

The challenger [journal](../../services/challenger/src/journal.rs) owns the full
`Vec<FinalizedBlock>`. Opening reads, deserializes and reserializes it to verify
the checksum. Every journal mutation clones the complete state and serializes
the next state before the existing fsync/rename/directory-fsync commit. Even an
alert or send timestamp update pays the archive cost. JSON file size is not a
direct RAM multiplier, but the allocations grow with retained history.

The [RPC decoder](../../services/indexer/src/rpc.rs) retains all decoded
transactions in each queried finalized block. A fresh Pool reduces initial
catch-up; quiet application use does not stop subsequent chain-history growth.
The [runtime's](../../services/challenger/src/runtime.rs) 64-block/8-MiB batching
limits apply to the pending append, not total retained history. A single larger
block is deliberately allowed. Separately, [RPC response parsing](../../services/indexer/src/runtime.rs)
materializes JSON and clones its result without an explicit byte limit, with up
to four block reads in flight. The batch setting does not bound that peak.

The [indexer](../../services/indexer/src/replay.rs) also retains one digest per
accepted block for exact duplicate/fork detection. Although its internal apply
path avoids copying that map, outer [Scanner](../../services/challenger/src/scan.rs)
clones copy it during challenger catch-up. Segmenting only the archive would
leave this memory and copy-work growth. Tree, note, buffer, exit and job state
also scale with financial activity and need separate accounting.

Disk is a separate gate. Full journal rewrites temporarily require both old and
next files. Segmentation can reduce that write amplification and archive RAM,
but still retains every block. A finite 20 GiB data allocation is not qualified
for a month of this history, database/WAL, indexes, proof assets, backups and
crash tails. Increasing RAM alone does not address continuing disk growth.

## Smallest safe next implementation scopes

1. Add an opt-in archive version for a **new empty directory**, keeping v1
   reader/writer/checksum compatibility. Use immutable bounded segments and a
   compact checksummed committed head. Fsync the segment and archive directory
   before the head commit; install the checked scanner only after the head is
   durable. Stream replay and provide tail/count and indexed slot lookup,
   without a growing in-memory segment manifest. The historical block clock is
   still required for payload priority-fee planning.
2. Replace the retained digest map/outer-clone cost with exact disk-backed
   history lookup, or a separately reviewed strict-forward mode backed by that
   verified history. Preserve existing duplicate/fork rejection, financial and
   buffer semantics. Keep unreferenced crash tails without adopting them;
   missing, corrupt, reordered or wrong-pool committed data fails closed.
   Uncertain persistence must still prevent further mutation until reopen.
3. Design disk retention separately from RAM. Measure bytes/slot/day and budget
   backlog, WAL, temporary space, backups and recovery reserve. Evaluate
   lossless compression; a versioned replay projection or cold-storage policy
   needs separate proof that all required evidence remains recoverable.
   Casually dropping foreign transactions would change transaction positions,
   CPI attribution, buffer-generation evidence and byte identity. A deliberate
   projection may be possible, but requires format/provenance and replay
   equivalence review. RPC response bounds and valid oversized-block behavior
   likewise require explicit semantics.

Any later migration must be an explicit offline copy into a new directory with
independent verification and the original preserved. No unresolved job, signed
attempt, unknown outcome or recovery evidence may be pruned to meet a size
target. Restart must not replay inference or silently resend transactions.
No migration or runtime implementation was performed in this review.

## Required qualification

Use streaming synthetic history generation, with fixed financial activity and
increasing history sizes such as 0.25, 1 and 4 GiB. Measure process-tree peaks,
steady RSS versus retained bytes, append bytes/latency, clone/serialization CPU,
startup replay and slot lookup. Include skipped slots, large foreign payloads,
CPI/buffer generations, old duplicates and conflicting forks. Compare final
roots, positions, jobs, fees and signed attempt bytes against legacy replay.
Inject failures at each segment/head write, fsync and rename boundary; verify
v1 compatibility, orphan handling, fail-closed corruption and no resend, then
run the existing real-proof/SBF regressions.

After those changes, qualify the exact Linux architecture and binaries with
the complete required stack: ingress/gateway, PostgreSQL, control, signer,
dispatcher children, indexer, challenger and observer. Direct provider inference
and client request proofs are off-host; server verification and challenger
proof work remain. Start with a 4-GiB/2-vCPU cgroup, no swap, and record
`memory.peak` including children during cold start, catch-up, proof generation,
load and restart/recovery. Catch-up must exceed incoming-history rate with
measured memory/CPU/disk headroom; a larger-machine rerun is a separate result.
Measure representative bytes/slot/day and account for all storage consumers
before making a 30-day disk claim. Segmentation alone cannot validate the
monthly budget.

Compile/link peaks are unmeasured and distinct from runtime. Build pinned Linux
artifacts on a separate builder and verify installed hashes; do not infer
production-host memory from this macOS development machine. Required services
cannot be stopped while funds need protection merely to reduce the estimate.

Only these two evidence files were added. Existing private state, budgets,
services and runtime source were not changed; no provider/chain request,
funding action or paid provisioning occurred.
