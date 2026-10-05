# Finalized tree indexer

`zkapi-indexer` replays the pinned layout 2 Vault from pool initialization, then compares its state with finalized program-owned PoolConfig/TreeState/Note/Pending accounts before serving paths. It preserves the original Poseidon tree. Buffer bytes come from ordered successful create/append/seal/execute/close history, including closed and reused PDA generations. Unknown CPI success, incomplete archives, mismatched events, or inconsistent state stop path delivery.

Run after configuring the deployed program/pool and a trusted archive RPC:

```sh
cargo run --release --locked --manifest-path services/indexer/Cargo.toml --bin indexerd -- /path/to/config.json
```

Configuration is a strict JSON object with `rpc_url`, `program_id`, `pool`, `genesis_hash` (base58), `circuit_profile_hash` (64 lowercase hex digits, no prefix), `start_slot` (at or before initialize), `listen` (for example `127.0.0.1:8080`), `public_origin` (HTTP(S) origin only), and `snapshots_directory`. These deployment pins must come from trusted operator configuration. The current test circuit profile is `ba688d8a2be7647499c98d52c335c381b86f0471f39fa6539f7d451b76dafca1`; it is not production eligible. Do not put an RPC URL containing credentials into a public configuration or source control.

Endpoints follow `docs/contracts/openapi.json`:

- `/zkapi/v1/tree/root`
- `/zkapi/v1/tree/notes/{note_id}/path` (Active only)
- `/zkapi/v1/tree/notes/{note_id}/zero-path` (Pending or the current next deposit ID)
- `/zkapi/v1/tree/snapshot` and its content-addressed download URL

All external integer state is decimal text. Snapshot files use JCS UTF-8 without a newline; their full bytes determine SHA-256. `Indexer::restore_snapshot` requires a separately trusted, reconciled replay at the same slot/blockhash and compares all Active/Pending records. A downloaded hash alone is never a trust anchor. ExitNullifier non-use is not certified by a snapshot.

The process intentionally replays archive history on restart. It does not yet persist an authenticated checkpoint for faster startup. The worker requests finalized blocks with `maxSupportedTransactionVersion: 1` for read-only legacy/v0/v1 envelope decoding; transaction senders remain v0. Unknown versions or malformed supported envelopes fail closed.

`ArchiveRpc::refresh` first replays near the finalized tip, then captures program accounts. The first `getMultipleAccounts` response chooses a finalized slot S at or above the replayed slot. Every later batch must return exactly S; `minContextSlot` alone is not treated as a fixed snapshot. Raw account bytes are retained by address, archive replay advances exactly through S, and only then are the required Active/Pending accounts decoded and compared with that replay. The blockhash is independently checked at S before publication. A live bank advancing while the archive is fetched no longer invalidates the already captured account cut.

If replay discovers a new Note or Pending account that was absent from the captured inventory, the service stays unavailable and retries with the advanced replay inventory. Null accounts remain errors when the resulting state still requires them. Split account batches, missing archive tails, altered state and anchor mismatches remain errors. `observe_chain` retains its exact-slot API for existing callers. Large deployments spanning multiple account batches still require a coherent same-slot read or retry; this change makes no production throughput or disaster-recovery SLO claim.

Each catch-up attempt withdraws the library's previously reconciled root until accounts are checked again. Retry cursors advance only after an applied block; an incomplete `getBlocks` tail is fetched again on the next attempt. A parent/hash mismatch still halts replay and requires rebuilding from trusted history. I05 must treat an unavailable root as unavailable authorization state, and must independently check ExitNullifier/Pending through both RPCs as required by the API and operations specifications; neither `replay_state()` nor a snapshot certifies non-use.

During an in-progress refresh, HTTP root/path/snapshot reads wait up to twenty seconds for the next successfully reconciled cut, within the control client's thirty-second indexer-read timeout. This avoids immediate 503 responses during normal polling without serving the previous cut or adding RPC requests. Failed refreshes, worker loss and an exceeded wait budget still return 503. An invalid note path remains a 400. This bounded wait is not a public latency or availability guarantee.

`blockTime` must be present: Agave v2.2.0 persists `bank.clock().unix_timestamp` as block metadata (`rpc/src/block_meta_service.rs`). Missing timing fails closed because deposit expiry and escape deadline depend on the on-chain Clock. Synthetic finalized envelopes in the local harness contain the LiteSVM Clock value; they do not prove public-cluster finality.

Reproduce with `bash scripts/run_i04.sh`. The indexer tests require the actual `target/i04/sdk-svm-history.json` generated by the SDK/SBF harness; missing fixtures fail, not skip. `tests/runtime.rs` uses a local HTTP RPC adapter with real SBF account bytes, not a live provider. HTTP tests exercise root/path/snapshot wire, checksum, and service-unavailable behavior. Runtime regressions deterministically advance the RPC bank during archive fetch, retry newly created Note/Pending inventory, and reject split cuts, missing tails/accounts, and state/blockhash mismatches.
