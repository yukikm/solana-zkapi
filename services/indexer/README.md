# Finalized current-state indexer

`indexerd` implements [`account_state_poc_v1`](../../docs/specs/pool-history-acquisition.md).
One owner reads finalized Pool/Tree/Vault/Clock and every allocated Note/Pending
account, reconstructs the existing Poseidon tree and verifies principal. HTTP
clients and the challenger share its acquisition through a private Unix socket.
Cold start and restart need no block history or archive.

Use a [fresh PoC setup](../../docs/getting-started/poc-state-sync.md). Normal daemon
commands reject old configuration. Local SBF/mock-RPC tests and the fresh public
Devnet deposit/restart/withdrawal check cover this mode. See
[current support](../../docs/support.md) for the deployed scope.

```sh
cargo run --release --locked --manifest-path services/indexer/Cargo.toml --bin indexerd -- /absolute/path/indexer.json
```

Strict configuration example (replace all trust pins and paths):

```json
{
  "config_version": 2,
  "manifest": "/trusted/poc/manifest.json",
  "manifest_sha256": "<independently pinned JCS manifest_hash>",
  "program_identity": {
    "program_file": "/trusted/poc/zkapi_vault.so",
    "sha256": "<SHA-256 of exact deployed ELF>",
    "deployment_slot": 1,
    "authority": "<pinned upgrade authority, or null for immutable>",
    "programdata_len": 1000000
  },
  "rpc_url": "http://127.0.0.1:8899",
  "listen": "127.0.0.1:8080",
  "public_origin": "http://127.0.0.1:8080",
  "snapshots_directory": "/private/zkapi-poc/snapshots",
  "chain_state": {
    "mode": "account_state_poc_v1",
    "poll_idle_seconds": 10,
    "poll_active_seconds": 2,
    "max_note_ids": 4096,
    "rpc_concurrency": 4,
    "max_response_bytes": 16777216,
    "max_chain_time_age_seconds": 120,
    "state_socket": "/private/zkapi-poc/state.sock",
    "cache_file": "/private/zkapi-poc/current-state.json"
  }
}
```

`deployment_slot` and `programdata_len` are example numbers, not defaults. Pin the
actual deployment metadata independently. The latter includes the 45-byte loader
metadata and the entire allocation, including zero padding. Startup checks genesis,
Program/ProgramData linkage, owner, authority, slot and exact ELF; periodic checks
read only loader metadata. An observed identity mismatch fences publication until
operator review and restart. The optional `devnet` object uses Control's existing
IDL/ELF/build-manifest validation; see the [challenger README](../challenger/README.md).
Keep RPC credentials in the private config, never in source control.

Use a private parent directory (0700) and the same operating-system user for the
indexer/challenger socket (0600). The daemon obtains its socket owner lock before
RPC work. It atomically writes a disposable cache, but always reacquires accounts
on restart. Deleting this cache is unrelated to financial journal recovery.

At most 48 Note/Pending pairs plus four base accounts fit each 100-key read.
Batches may use different finalized slots only with identical financial sequence,
root, next ID and principal. All allocated IDs, including Closed tombstones, must
be present. Verification fails closed on a missing zero-leaf Pending, partial
inventory, root/principal mismatch, stale Clock or capacity overflow. Lifetime
allocated IDs are capped at 4096. The contract documents the finalized-RPC and
pinned-program trust assumptions; this is not proof of historical transitions.

Normal one-batch refresh costs one `getMultipleAccounts` plus one light `getBlock`
with `transactionDetails:"none"`. Startup adds genesis and full code identity;
metadata checks run every 60 seconds. No history RPC can pass the state client's
method allowlist. Refreshes coalesce, retry at most three times, have bounded
response/deadline limits and share 429 cooldown. Idle polling is ten seconds;
Pending work/Unknown recovery uses two seconds. Fresh HTTP/proof reads require
an observation no older than five seconds and can trigger one shared refresh.

Endpoints retain the existing wire format:

- `/zkapi/v1/tree/root`
- `/zkapi/v1/tree/notes/{note_id}/path` (Active only)
- `/zkapi/v1/tree/notes/{note_id}/zero-path` (Pending or next deposit ID)
- `/zkapi/v1/tree/snapshot` and its content-addressed download
- `/health` (local ready/age/pool/genesis and secret-free RPC counters; no RPC)

HTTP waits at most 25 seconds for a usable current view; unavailable state returns
503 and invalid paths return 400. Control still checks admission independently
through its two backends. A snapshot does not certify ExitNullifier non-use.

## Verification

Generate real account fixtures with `bash scripts/run_i04.sh`, or rerun
`cargo run --locked --manifest-path tests/svm/Cargo.toml --bin sdk_transport`
after building the pinned local test ELF. Then run:

```sh
cargo test --locked --manifest-path services/indexer/Cargo.toml --test current_state -- --nocapture
cargo test --locked --manifest-path services/indexer/Cargo.toml --test current_state_service
```

The tests compare real SBF account cuts with full replay, count cold/restart calls,
reject malformed/partial cuts, cover retries/429, HTTP/snapshot/socket sharing,
program changes and cache corruption. Finality and loader metadata are simulated.
The same fixture uses 24 legacy calls versus two current calls; these are local
method counts, not measured provider credits. See [whole-service verification](../../docs/getting-started/poc-state-sync.md#local-verification).

## Retained legacy replay library

The following describes retained `Indexer`/`ArchiveRpc` library APIs and explicit
legacy archive utilities, not the normal `indexerd` command. These paths support
offline reference tests, archive inspection and the separate
[history projector](../../docs/getting-started/pool-history-projection.md).
They are never an automatic fallback from current-state verification.

All external integer state is decimal text. Snapshot files use JCS UTF-8 without a newline; their full bytes determine SHA-256. `Indexer::restore_snapshot` requires a separately trusted, reconciled replay at the same slot/blockhash and compares all Active/Pending records. A downloaded hash alone is never a trust anchor. ExitNullifier non-use is not certified by a snapshot.

The standalone RPC indexer intentionally replays archive history on restart. The archive-backed mode can reuse the writer's local history and private authenticated replay checkpoint; see [archive storage](../../docs/getting-started/archive-storage.md). The worker requests finalized blocks with `maxSupportedTransactionVersion: 1` for read-only legacy/v0/v1 envelope decoding; transaction senders remain v0. Unknown versions or malformed supported envelopes fail closed.

`ArchiveRpc::refresh` bootstraps the inventory from history, then captures program accounts. Warm refreshes capture directly from the replayed inventory without a separate `getSlot` or preliminary catch-up. The first `getMultipleAccounts` response chooses a finalized slot S at or above the replayed slot. Every later batch must return exactly S; `minContextSlot` alone is not treated as a fixed snapshot. Raw account bytes are retained by address, archive replay advances exactly through S, and only then are the required Active/Pending accounts decoded and compared with that replay. The blockhash is independently checked at S before publication. A live bank advancing while the archive is fetched no longer invalidates the already captured account cut.

Optional `poll_seconds` sets the delay between refresh attempts (1–10, default 2).
It does not change HTTP wait or account-cut freshness bounds. See
[RPC budgeting](../../docs/getting-started/rpc-budget.md) for the ten-second
profile, secret-free method counters and the complete-history consumption floor.

If replay discovers a new Note or Pending account that was absent from the captured inventory, the service stays unavailable and retries with the advanced replay inventory. Null accounts remain errors when the resulting state still requires them. Split account batches, missing archive tails, altered state and anchor mismatches remain errors. `observe_chain` retains its exact-slot API for existing callers. Large deployments spanning multiple account batches still require a coherent same-slot read or retry; this change makes no production throughput or disaster-recovery SLO claim.

Each catch-up attempt withdraws the library's previously reconciled root until accounts are checked again. Retry cursors advance only after an applied block; an incomplete `getBlocks` tail is fetched again on the next attempt. A parent/hash mismatch still halts replay and requires rebuilding from trusted history. Control must treat an unavailable root as unavailable authorization state, and must independently check ExitNullifier/Pending through both RPCs as required by the API and operations specifications; neither `replay_state()` nor a snapshot certifies non-use.

During an in-progress refresh, HTTP root/path/snapshot reads wait up to twenty-five seconds for the next successfully reconciled cut, within released SDKs' thirty-second indexer-read timeout. This avoids immediate 503 responses during normal polling without serving the previous cut or adding RPC requests. Failed refreshes, worker loss and an exceeded wait budget still return 503. An invalid note path remains a 400. This bounded wait is not a public latency or availability guarantee.

HTTP publication copies only the tree, Active/Pending records and cut metadata
needed for these responses. The replay worker retains the complete accepted-block
digest history, exit state and payload buffers; public views do not duplicate
them. Public snapshot bytes and private checkpoint formats are unchanged. This
removes a history-sized publication allocation, but private checkpoint encoding
and replay still require memory proportional to retained history.

Private checkpoint restore compares canonical JSON directly against the input
bytes without allocating another encoded copy. Save counts the encoded length
before allocating its exact output capacity, retaining the same bytes and
512 MiB limit. This adds a serialization pass when saving; the temporary `Saved`
history and other replay/checkpoint allocations remain proportional to history.

The archive follower defers a due private-cache save while a captured finalized
account cut remains within its 30-second reconciliation budget. Deferral changes
neither that deadline nor the last checkpoint-completion time. A completed or
expired cut permits the next due save. Attempts are spaced at least 300 seconds
from the completion of the previous attempt, including a failed save; the first
eligible attempt is unchanged. A long save therefore cannot make another save
immediately due. All replay, account and publication checks remain unchanged.

The private cache accelerates restart and is separate from committed history and
financial journals. A restart may replay a larger retained local suffix since the
last successful cache, without fetching that history again from RPC. Five minutes
is a minimum save spacing, not an upper bound on restart replay: live-cut deferral
or failed saves can retain an older cache. Existing cache bytes remain protected
by the same authenticated format and atomic replacement. Saves are still
synchronous, so this spacing provides longer refresh windows without promising
continuous availability during a save or reducing the native freshness checks.

`blockTime` must be present: Agave v2.2.0 persists `bank.clock().unix_timestamp` as block metadata (`rpc/src/block_meta_service.rs`). Missing timing fails closed because deposit expiry and escape deadline depend on the on-chain Clock. Synthetic finalized envelopes in the local harness contain the LiteSVM Clock value; they do not prove public-cluster finality.

Reproduce with `bash scripts/run_i04.sh`. The indexer tests require the actual `target/i04/sdk-svm-history.json` generated by the SDK/SBF harness; missing fixtures fail, not skip. `tests/runtime.rs` uses a local HTTP RPC adapter with real SBF account bytes, not a live provider. HTTP tests exercise root/path/snapshot wire, checksum, and service-unavailable behavior. Runtime regressions deterministically advance the RPC bank during archive fetch, retry newly created Note/Pending inventory, and reject split cuts, missing tails/accounts, and state/blockhash mismatches.
