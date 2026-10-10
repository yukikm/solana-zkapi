# Retained archive storage and disk exhaustion

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

## Migrate a v1 journal to v2

Fresh `challengerd init` creates a v1 journal. Ordinary startup opens its
existing format without migration or fallback. Migration to segmented v2 is an
explicit offline operation, separate from compressing already-v2 chunks below.
Use the original authenticated challenger configuration, journal and a tested
binary that supports v2; do not initialize another journal.

1. Suspend admission, stop the challenger and any archive follower, and verify
   their process groups have exited. Follow the
   [same-state backup procedure](same-state-restart.md#capture-a-coherent-protected-backup)
   to retain the complete original directory, configuration and binary.
2. Run the following as the original journal owner. These paths are the
   [Linux bootstrap](service-units.md) defaults; substitute the actual installed
   binary and original config for another deployment:

   ```sh
   /opt/zkapi/bin/challengerd migrate-archive /srv/zka/challenger/config.json
   ```

3. Retain the JSON report privately with the backup and require successful exit.
   It reports format version, byte/block/chunk counts and hashes. Verify that
   the original file remains as `legacy-v1.json`, that `archive-v2/` contains the
   committed chunks, and that the new `journal.json` head is included in every
   subsequent backup. Never restore only the head.
4. Restart with the same configuration and a v2-capable binary. Check journal
   continuity, finalized catch-up, challenger health and a fresh indexer root
   before restoring admission. Migration itself is not a provider or funded
   inference test.

The command authenticates the manifest and Pool, takes the existing owner lock
and preserves all archived blocks, queue identities, unknown signed attempts
and the original replay cursor. It opens no scanner, RPC connection, database,
transport bridge or fee key. An existing v2 journal, active owner, mismatched
Pool, `archive-v2/` directory or `legacy-v1.json` file makes it refuse replacement.

After a failure or cancellation, preserve all partial staging and observations;
do not delete files and retry. Cancellation is checked before staging, between
chunks and before activation. Once activation starts, it finishes or reports
uncertain durability without automatic rollback. Inspect the retained exact
files before deciding on recovery. Segmentation reduces full-history rewrite
costs; it does not bound retained history, memory or disk usage.

## Run an indexer from the shared v2 archive

`challengerd archive-indexer` serves the existing tree API using committed
challenger blocks instead of fetching those full blocks again. It requires an
already-v2 archive and the original complete indexer configuration. It still
uses the configured RPC for independent finalized account and anchor checks.

1. Keep the archive writer on its original configuration. Choose a separate
   snapshot directory outside the archive and preserve the original indexer
   `start_slot`, Pool, program, genesis, profile, RPC and public origin. Do not
   advance the start slot to avoid replay. If replacing the existing indexer,
   stop that indexer before using its listener; a parallel trial needs its own
   listener and output directory.
2. Create a private wrapper configuration. The example below uses Linux
   bootstrap paths and a new snapshot directory; adjust paths to the actual
   deployment. Run configuration preparation as the selected indexer service
   account, with permission to read the original configuration:

   ```sh
   umask 077
   python3 - <<'PY'
   import json
   from pathlib import Path

   original = Path('/srv/zka/indexer/config.json')
   output = Path('/srv/zka/indexer/archive-indexer.json')
   archive = Path('/srv/zka/challenger/journal').resolve(strict=True)
   snapshots = Path('/srv/zka/indexer/archive-snapshots')
   indexer = json.loads(original.read_text())
   indexer['snapshots_directory'] = str(snapshots)
   with output.open('x') as stream:
       json.dump({'archive_directory': str(archive), 'indexer': indexer}, stream)
       stream.write('\n')
   PY
   ```

   The strict wrapper accepts only `archive_directory` and `indexer`.
   `archive_directory` must be canonical and absolute. Output/source overlap,
   parent traversal and aliases into the archive are rejected. Give the process
   read access to the archive, preferably through a read-only mount, and write
   access to its separate snapshot directory. The bootstrap's separate indexer
   user does not automatically have access to the challenger-owned archive;
   configure that access before starting the follower. Preserve existing file
   ownership and authenticated metadata during subsequent restarts.
3. Start under that service identity and retain this command in its supervisor:

   ```sh
   /opt/zkapi/bin/challengerd archive-indexer /srv/zka/indexer/archive-indexer.json
   ```

4. Allow cold validation and replay to complete before admitting traffic. Check
   `/zkapi/v1/tree/root` at the configured indexer origin for the expected Pool,
   fresh finalized state and normal control readiness. Preserve the source
   archive and separate snapshots/cache for every restart.

This mode does not initialize or migrate storage, create or take `owner.lock`,
write challenger health, or load a database or fee key. Cold validation occurs
before the HTTP listener and Ctrl-C handler are installed; a signal then uses
default process termination, with no source writes to flush. It never fills
missing full blocks from RPC. Incomplete committed history remains unavailable;
source corruption, rollback or replacement requires operator review and restart.
The [component reference](../../../services/challenger/README.md#read-only-indexer-over-an-existing-v2-archive)
describes full-history validation, cache bindings and continuity checks.

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
   change. Record the conversion output privately under `docs/evidence/` or
   `target/`.
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

## Catch-up read concurrency

The writer's optional `archive_batch.rpc_concurrency` selects 1–16 finalized
block reads in flight. Omission retains four; it does not change the batch's
block/byte commit limits. Operators can use a bounded higher value during
recovery after measuring RPC latency, host load and provider rate limits.
Responses are reordered before replay, and the first failed slot still ends
the durable prefix. Shared HTTP429 cooldown, cancellation and no immediate HTTP
retry remain unchanged. This setting never changes inference concurrency,
signed transactions, account reconciliation or replay/checkpoint bindings.
