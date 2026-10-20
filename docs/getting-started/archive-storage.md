# Retained archive storage and disk exhaustion

This guide covers the retained legacy full-history utilities. The implemented
[fresh PoC design](../specs/pool-history.md) acquires current accounts and does not
require this archive, its conversion or its restart caches. Normal daemon commands
require current-state config v2; only explicit archive utilities use this guide.

A full archive volume can stop the chain follower and also prevent PostgreSQL
from serving requests when both share a filesystem. An empty control catalog
is not sufficient evidence of an OpenRouter outage: provider admission reads
require the local financial ledger. Check disk availability, archive progress,
PostgreSQL and signer reconciliation before changing provider settings.

The archive writer now stores new v2 payload chunks as single-member gzip files.
Their existing content-addressed `.json` names, uncompressed byte counts,
SHA-256 identities, complete block payloads and predecessor references are
unchanged. Both compressed and original uncompressed chunks are supported.
Readers reject bad checksums, truncation, concatenated members, trailing bytes,
wrong uncompressed lengths and altered filesystem identities. Checkpoint stamps
track physical file metadata; logical references still authenticate full JSON.
The legacy backup, mutable journal, jobs, signed transactions and financial
ledger retain their existing formats.

Before each chunk, the writer requires at least 2 GiB plus one ordinary chunk
of free space. A low-space stop preserves room for database/recovery operations;
it does not establish inference availability or an infinite retention horizon.
Compression reduces growth but cannot make finite storage last forever. Monitor
available bytes and growth, and plan additional capacity before reaching this
floor. RPC/provider failures remain possible and still fail closed.

## Existing archive conversion

1. Stage and test a reader/writer binary supporting compressed chunks. Preserve
   the original binaries, configuration, complete journal and financial records.
2. Suspend new admission. Stop the archive writer and follower and verify both
   process groups are empty. Do not initialize or reset any journal.
3. Run `python3 scripts/compress_archive_chunks.py /absolute/journal` under the
   journal owner (or the administrator preserving ownership). It takes the
   existing exclusive owner lock. Every chunk is checksummed before conversion,
   compressed losslessly, read back and compared byte for byte, fsynced, then
   atomically replaced with unchanged permissions and ownership. Incomplete
   staging files remain untouched. The journal/head and legacy backup do not
   change. Record the conversion output privately under `target/`.
4. Restart with the new binary and original inputs. Changed chunk metadata
   invalidates the old optional replay cache, causing a full authenticated replay.
   Retain those caches. The explicit revalidation procedure below can preserve
   their runtime payload after complete content verification. Without it, keep
   the normal cold replay path and allow catch-up to finish before admission.
5. Verify the original financial records, fresh tree, catalog, signer and public
   preflight. A successful conversion is not a funded inference test.

An old binary cannot read gzip chunks. Rollback requires decompressing each
chunk to its original checksum-verified bytes while both processes are stopped;
never roll back the financial journal or replace funded client custody.

## Revalidating a retained restart cache

For a large archive, cold replay after a storage-only conversion can take much
longer than checksum verification. `scripts/revalidate_archive_checkpoint.py`
stages a separate cache candidate from an original cache whose SHA-256 was
recorded from retained maintenance inputs. Stop both writer and follower and
keep their original cache bytes privately before using this optional tool:

```sh
python3 scripts/revalidate_archive_checkpoint.py /absolute/journal \
  --checkpoint /absolute/journal/archive-runtime-checkpoint-v1 \
  ORIGINAL_CACHE_SHA256 /absolute/journal/revalidated-writer.next \
  --checkpoint /absolute/snapshots/.archive-runtime-checkpoint \
  ORIGINAL_FOLLOWER_CACHE_SHA256 /absolute/snapshots/revalidated-follower.next
```

The tool takes the existing owner lock, verifies the original cache pin and
internal checksums, retains the exact runtime bytes and all non-storage
metadata, and authenticates every referenced chunk against its original SHA-256
and uncompressed length. It rechecks full file identities before staging and
refuses changes to chunk custody/device, legacy-file identity, directory
identity, journal/head or original cache. Only verified raw-to-gzip replacements
can receive changed stamps. Candidates use new owner-only files; source caches
are not activated, overwritten or deleted by the tool.

After verifying the reported candidate hashes and preserving original caches,
an operator can atomically rename each candidate over its corresponding cache
and fsync its directory while both services remain stopped. Normal runtime
binding, reference-chain, anchor and state-codec checks still apply on restart;
an invalid cache still falls back to cold validation. Fresh finalized chain
reconciliation and public preflight are still required. A cache candidate is
not evidence of current chain readiness and contains no financial journal state.

Private v1 restart caches accept at most 256 MiB of metadata and 512 MiB of
runtime state. The metadata contains every retained chunk reference and file
stamp; runtime state includes every accepted block digest. The former 64 MiB
metadata and 256 MiB state bounds could leave an older cache in place while the
archive continued growing. Raising these bounds preserves the same format,
checksums, custody checks and complete-history authentication. The offline
revalidation tool uses the same bound. Existing caches remain readable; older
binaries reject caches exceeding their metadata or state bounds and take their normal
cold-validation path, without rolling back the archive or financial journal.

This is finite restart-cache capacity, not archive compaction or a total process
memory bound. Metadata serialization and parsing still use an additional JSON
buffer; the scanner also wraps a separate copy of the indexer's encoded state.
Saving retains the previous cache until atomic replacement and requires
space for a complete candidate (at most 768 MiB plus framing), in addition to
the previous cache and retained archive. Monitor cache size, successful saves,
memory and free disk space as the archive grows; reaching the new bound again
leaves the previous cache intact and makes the uncached suffix longer to replay.

## Catch-up read concurrency

The writer's optional `archive_batch.rpc_concurrency` selects 1–16 finalized
block reads in flight. Omission retains four; it does not change the batch's
block/byte commit limits. Operators can use a bounded higher value during
recovery after measuring RPC latency, host load and provider rate limits.
Responses are reordered before replay, and the first failed slot still ends
the durable prefix. Shared HTTP429 cooldown, cancellation and no immediate HTTP
retry remain unchanged. This setting never changes inference concurrency,
signed transactions, account reconciliation or replay/checkpoint bindings.
