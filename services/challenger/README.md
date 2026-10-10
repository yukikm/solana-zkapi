# I09 challenger — native daemon and emergency CLI

The native daemon now connects the existing evidence/proof/journal foundation to finalized JSON-RPC scanning, restart replay, the I04 signed-v0 transport, and exact-signature recovery. Its local tests include real proofs, real Ed25519-signed v0 transactions, synthetic RPC fault outcomes, and a separate actual Vault SBF test consuming the SDK bridge's signed bytes. Public RPC, production trust/setup, hosted CI and release gates remain unverified.

## Run and recover

```sh
cargo build --locked --manifest-path services/challenger/Cargo.toml --bin challengerd
services/challenger/target/debug/challengerd init /absolute/path/config.json
services/challenger/target/debug/challengerd run /absolute/path/config.json
# The same journal and state machine provide emergency/manual operations:
services/challenger/target/debug/challengerd scan /absolute/path/config.json
services/challenger/target/debug/challengerd prove /absolute/path/config.json
services/challenger/target/debug/challengerd once /absolute/path/config.json
services/challenger/target/debug/challengerd recover /absolute/path/config.json
services/challenger/target/debug/challengerd cleanup /absolute/path/config.json
services/challenger/target/debug/challengerd status /absolute/path/config.json
```

`init` is explicit and refuses an existing journal. `scan` only replays/reconciles finalized history and discovers evidence, without generating/signing new work or recovering/sending saved unknown attempts; `prove` additionally generates the payload; `once` advances one upload step per job; `run` polls continuously. Other commands that advance work first recover saved attempts. `scan` can prewarm the durable archive before a timed challenge. `recover` needs neither the DB nor the proving key; finalized receipt/exact-byte recovery needs no fee secret. Refreshing an expired upload does require its signing key. Every recovery authenticates RPC genesis before any send. `cleanup` recovers and closes buffers from definite failed attempts without the DB/prover. `status` reads only the journal. Successful sign/prepare does not call RPC; the native journal atomically fsyncs the entire I04 attempt and exact signed bytes before the separate recovery/send call. Restart therefore cannot sign a replacement for an unknown execute. Confirmed errors, missing buffers and expired blockhashes are not finalized failures.

Configuration is strict JSON with these fields:

```json
{
  "manifest": "/trusted/test-deployment/manifest.json",
  "manifest_sha256": "<externally pinned JCS manifest_hash>",
  "rpc_url": "http://127.0.0.1:8899",
  "database_dsn_file": "/private/challenger-reader.dsn",
  "start_slot": 1,
  "journal_directory": "/private/challenger-journal",
  "tree_pk": "/trusted/test-deployment/tree.pk",
  "node": "/absolute/path/to/node",
  "transport_bridge": "/trusted/solana-zkapi/packages/sdk/src/challenger-cli.ts",
  "transport_bridge_sha256": "<externally pinned SHA-256 of bridge source>",
  "fee_key_file": "/private/challenger-fee-key.json",
  "payer": "<fee key's base58 public key>",
  "poll_seconds": 2,
  "alert_sink_directory": "/private/challenger-alerts",
  "priority_fee": { "base": 1000, "warning": 10000, "page": 50000, "emergency": 100000, "cap": 100000 }
}
```

The fee key uses the Solana CLI JSON secret-key format and mode 0600; the Node bridge checks its mode and required signer identity. Pass secrets through files/stdin, not process arguments. The bridge inherits no environment variables. Keep the complete Node/SDK distribution immutable to other users: the entrypoint hash is checked, while its local imports are trusted installed code. The local profile accepts HTTPS RPC or numeric-loopback HTTP; it verifies genesis and the actual pinned PoolConfig. The current build remains intentionally limited to the known test-only profile. Local-profile read-only DB connections remain Unix sockets/loopback only; production authenticated transport is a deployment prerequisite.

Omitting `devnet` preserves the local profile and rejects a devnet manifest. An explicit bounded public-devnet test can add the same public-artifact configuration used by the control service:

```json
{
  "devnet": {
    "idl_file": "/trusted/devnet/vault-idl.json",
    "program_file": "/trusted/devnet/zkapi_vault.so",
    "build_manifest_file": "/trusted/devnet/build-manifest.json",
    "trusted_build_manifest_hash": "<independently pinned SHA-256 of exact build-manifest bytes>"
  }
}
```

This object is an additional field in the configuration above. The shared control validator checks the IDL/ELF/build digests, unchanged Vault wire schema, role keys, exact devnet genesis and Circle devnet USDC mint, and `test_only` setup. The public manifest still needs its independent `manifest_sha256` pin. Devnet requires HTTPS RPC and public service URLs, and a Unix-socket DB connection with no TCP/`hostaddr` fallback. These checks do not load fee, control or provider keys. Recovery still does not require the fee key unless a new upload must be signed. Mainnet and production setup remain rejected. Offline build pins do not establish which ELF is deployed: deployment acceptance must independently verify the live program/ProgramData and authority. This profile support alone is not evidence of a live challenger transaction.

The complete finalized archive is durably stored with the queue, including buffer generation history. Restart replays it and resumes after its last block. Scanning captures Note/Pending/Tree and PoolConfig from the same finalized account cut, then durably replays any further blocks through that exact slot before reconciliation. It does not chase a newer head with a separate PoolConfig read. If the replay introduces an account absent from the captured inventory, scanning publishes nothing and retries with the advanced inventory; the new history remains durable across restart. Missing/reordered history, forks, mismatched genesis, unequal account-batch slots, missing archive tails and rolled-back tips fail closed. Queue insertion and the consumer checkpoint are one commit; missed/expired Pending candidates remain visible to deadline monitoring. A legacy queue without its full archive cannot silently be resumed as a fresh scanner.

Archive reads use the indexer's bounded four-request window. Responses may finish out of order, but only the ordered successful prefix is verified and durably appended. A failed slot stops replay before any later fetched block, and restart resumes after the last saved block. This reduces startup round trips without changing exact-cut or complete-history requirements.

Persistence defaults to batches of at most 64 validated blocks or 8 MiB of serialized block data. An explicit optional `archive_batch` configuration accepts `max_blocks` from 1 through 256 and `max_bytes` from 1 through 33554432; for example, `{"max_blocks":256,"max_bytes":33554432}` reduces full-journal rewrite frequency during catch-up. A single larger block is preserved and committed alone. Fetch, decode or replay failure flushes only the valid prefix; reconciliation and discovery always wait for its durable commit. A crash can require fetching the uncommitted read-only suffix again, but no proof or send observes that suffix. The Scanner advances only after file fsync, atomic rename and directory fsync. The v1 journal format and checksum bytes remain unchanged; bounded serializer passes compute the checksum and write the same envelope, and restart parses through a buffered reader without retaining the whole encoded file. This option does not bound total archive or process memory, reduce retained history, or guarantee catch-up throughput. Long-term archive growth still needs separate validation.

An explicit offline command can convert an existing v1 archive to the segmented v2 storage candidate:

```sh
services/challenger/target/debug/challengerd migrate-archive /absolute/path/config.json
```

Stop the worker first and use its same authenticated configuration and journal directory. The command validates the manifest and Pool identity, acquires the existing owner lock, retains the exact original file as `legacy-v1.json`, and activates the verified full-history chunks under `archive-v2/` through the journal's durable migration path. Its JSON report contains only format version, byte/block/chunk counts and hashes. It opens no Scanner, RPC connection, database repository, transport bridge or fee key. Ordinary `init` still creates v1; ordinary startup validates and opens the existing format without migration or fallback.

An existing v2 journal, active owner, mismatched Pool, `archive-v2/` directory or `legacy-v1.json` file causes migration to refuse replacement. Retain any partial staging after a failure or cancellation for inspection; do not automatically delete it and retry. Cancellation is checked before staging, between chunks and before activation. Once primary activation starts, it finishes or reports uncertain durability without automatic rollback. Restore decisions require inspecting the retained exact files and failure observation. This conversion preserves all archived blocks, queue identities, unknown signed attempts and the original replay cursor. It reduces full-history rewrite and clone costs; it does not bound retained archive memory/disk or establish hosted catch-up performance.

SIGINT and SIGTERM are latched before journal replay or network access. The worker stops admitting work at safe checkpoints, cancels read-only RPC/DB waits, and durably flushes any already validated archive prefix. It explicitly kills and reaps an active Node bridge before returning success. A bridge recovering a transaction can only send the exact bytes already in the journal; stopping before its response retains the Unknown attempt and first-send timestamp for restart. Signing-only prepare/refresh output that was never saved has not been broadcast. Cancellation never manufactures a finalized outcome or replaces an unknown execute.

Synchronous proof work, journal parsing/serialization and fsync finish before their next checkpoint; these tests do not establish a universal stop deadline. Local process tests cover stalled RPC, DB connection, archive reads and an active bridge under SIGINT/SIGTERM. Failure to flush the validated prefix or reap the bridge is an error. The devnet launcher records native exit code, stop latency and explicit timeout/process-group escalation reasons; a nonzero exit or forced cleanup is never `clean_shutdown:true`. The earlier public `clean_shutdown:false` report remains historical evidence, not a passing graceful-stop result.

Pending generations come from the indexer's verified instruction/buffer replay, including its missing-event-log fallback. Emitted and reconstructed transitions keep the same slot, transaction/instruction/CPI position and tree sequence.

Jobs are processed by deadline then discovery time. Only a definite finalized upload failure or stale/expired-buffer execute failure permits a new tree proof/payload/buffer; historical RP/N/request time remain unchanged. Before replacement, the daemon authenticates the old buffer: it durably signs and recovers an I04 close, or records a finalized account absence together with the already definite failed outcome. Absence never resolves an unknown financial attempt. `cleanup` exposes the same recovery path when the worker is stopped. Unknown close attempts retain their exact signature just like execute.

Cleanup observations must be at or after the failed transaction's finalized slot. A missing account from an older cut cannot establish cleanup; a same-slot absence must also match the failure's blockhash.

Expired uploads reuse I04 `refreshExpiredUpload`: finalized old blockheight expiry and the same buffer's validated owner/digest/prefix/seal are required. The native journal atomically records that reconciliation and any new signed append/seal; exact step indices prevent a retried chunk from skipping the next chunk. An already advanced prefix moves to its verified next step. Missing buffers, unfinalized observations, or unresolved execute/close never authorize a replacement or a new create.

The optional priority-fee policy uses integer micro-lamports/CU and a monotonic capped base/warning/page/emergency schedule (maximum 1,000,000 micro-lamports/CU). The price is selected for each new payload plan from its immutable observation time/deadline. Its entire upload, expired-upload refresh and cleanup retain that price; changing an in-flight plan's policy is rejected. Later safely regenerated plans may escalate. Every price is signed and preserved in the I04 recovery record, and chunk sizes include the extra compute-budget instruction. No fee update can replace an unknown signature. Omitting the policy preserves the original zero-price wire.

Full archive persistence is intentionally simple; long-running archive compaction and large-pool throughput need additional validation.

Each poll emits a redacted JSON metrics record: pending/completed jobs, unknown signatures, proof regenerations, oldest unresolved age, finalized slot/lag, minimum remaining deadline and counts for 60-second warning / five-minute page / one-hour emergency. Severity transitions also enter a durable alert outbox. `alert_sink_directory` delivers them as idempotent, fsynced, mode-0600 JSON files in a mode-0700 directory; a crash between delivery and acknowledgment checks the same event bytes on restart. Connect that private spool and process health to an operator notification collector. No external messages are sent by this implementation. No prompt, provider key or DB DSN is emitted. Production notification routing/delivery is deployment acceptance.

Each run/once tick also atomically writes `journal_directory/health.json` with mode 0600. The redacted schema is `{schema:1,pool,observed_at,ready,oldest_detection_to_send_seconds,minimum_pending_deadline,proof_failure_total,root_conflict_reproves_total,metrics}`. Proof failures and first execute-send timing are durable; root-conflict regeneration counts are derived from saved jobs. Error ticks set `ready=false`. The operations collector must reject missing, mismatched or stale snapshots; the file does not prove that a stopped daemon is alive.

`daemon-performance.json` records local end-to-end samples for normal, lost response, stale-root cleanup/regeneration, restart before send, confirmed-only hold, expired-upload refresh, expired execute buffer and rejected upload, p50/p95, regeneration/attempt counts, and the resident KiB of the native test process after each sample. The RSS sample includes the test harness/prover and is not a peak bound for the whole process tree. The RPC outcomes are synthetic; the actual-Vault signed-v0 case is a separate test. These local samples do not establish production five-minute SLO, outage/load/queue capacity, or public-RPC behavior.

## Read-only indexer over an existing v2 archive

The explicit `archive-indexer` mode lets the public indexer replay the challenger's committed blocks without fetching the same full blocks from RPC:

```sh
services/challenger/target/debug/challengerd archive-indexer /absolute/path/archive-indexer.json
```

Its strict configuration has two fields: `archive_directory`, the canonical absolute path to an existing v2 challenger journal, and `indexer`, the complete existing indexer configuration. Preserve the original `start_slot`, Pool, program, genesis and profile pins. Use a separate snapshot output directory; source/output overlap, parent traversal and aliases into the archive are rejected. Grant this process read access to the source, preferably through a read-only filesystem mount, and write access only to its separate indexer snapshots. It does not initialize or migrate storage, acquire or create `owner.lock`, write challenger health, load a DB or fee key, or construct the financial challenger runtime. Ordinary writer commands and the default RPC indexer remain separate modes.

Cold open checks the fixed head, its state checksum and Pool, the retained complete legacy prefix, and every referenced chunk. It streams the stored `FinalizedBlock` values through the existing indexer replay; these are decoded evidence, not reconstructed original RPC responses. Incremental refresh accepts only an authenticated extension of the exact prior tail. Already verified immutable files use trusted Unix device/inode/size/mtime/ctime continuity; new and replayed chunks are always hashed. Missing or changed files, rollback and replacement fail closed. This metadata shortcut does not defend against a privileged actor able to forge filesystem metadata. Unreferenced files are never adopted or removed.

The indexer retains a fixed finalized target and account cut while waiting for committed history. It still obtains and validates the independent finalized account cut and block anchor; it never fills missing full blocks from RPC or advances the configured start. Captured account cuts older than 30 seconds must be recaptured before publication. Source validation failures latch the process unavailable until operator review and restart. A newer atomic head does not alter the snapshot currently being replayed.

The mutable `journal.json` head is captured through one no-follow, nonblocking regular-file open. A normal writer rename between pathname inspection and open must not be classified as immutable-file replacement. Descriptor metadata, head checksums, prior-prefix continuity, immutable-file identities and fresh finalized reconciliation remain required. A source validation failure emits an `archive_source_failure` record containing only a static reason and optional numeric OS error, then retains the terminal fail-closed behavior. See the [2026-10-09 Indexer incident and repair](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-indexer-recovery-20261009.md).

Continuity checks for already authenticated immutable files use one no-follow metadata observation, comparing all eleven saved fields including permissions, ownership and link count. They do not open each historical payload just to obtain its attributes. Actual payload reads retain the regular-file descriptor checks and hashing. This reduces repeated system calls as the archive grows; it does not shorten retained history, extend the HTTP wait deadline or permit a stale root during reconciliation. See the [follow-up 503 repair](src/journal_readonly_tests.rs).

Cold validation is synchronous and occurs before the HTTP listener and its Ctrl-C handler are installed. A signal during that phase uses default process termination; this mode does not inherit the writer runtime's latched shutdown behavior, and no graceful cold-open cancellation is claimed. It performs no source writes to flush. The [local candidate evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-shared-archive-indexer-candidate.md) records the frozen source, tests and Linux build separately from host installation, catch-up and funded acceptance.

## Reproduce

```sh
# Required if actual Vault history/ELF is absent:
bash scripts/run_i04.sh
python3 scripts/run_i09_challenger.py
```

The runner executes native tests with fsync-enabled disposable PostgreSQL/SELECT-only evidence, SDK challenger signing/recovery tests, fresh native CLI processes at every upload step, readonly-DB discovery, lost response, confirmed execute hold, finalized recovery without the fee key, and the actual Vault SBF harness. Artifacts under `target/i09-challenger/` include `runtime-report.json`, `runtime.log`, `daemon-performance.json`, `native-cli-results.json`, `proof-generation.json`, `generated-challenge.bin`, `svm-results.json`, and the known-test-entropy `test-tree.pk`. The report records exact commands, counts, source/lock/binary and input/output SHA-256 hashes. Old proof/performance/SBF reports are removed before a run.

## Preserved evidence and trust contracts

- `Trust::from_pinned_manifest` starts from an externally pinned manifest hash and reuses the I05 build's PoolConfig/role-key/profile checks. The current build intentionally accepts only the pinned local `test_only` deployment. `load_tree_key` checks both PK and VK hashes.
- `Scanner` continuously accepts finalized archive blocks through the existing I04 indexer, tracks each Pending generation's slot/blockhash/signature/instruction/CPI position and tree sequence, and requires the actual PoolConfig plus a reconciled finalized Note/Pending/Tree cut before exposing a view. Use `ArchiveRpc::observe_chain` to obtain the independent account cut; passing `replay_state()` back as an account observation is only a synthetic test technique, never a production finality check. Runtime now supplies the polling/restart orchestration described above.
- `ReadRepository::connect_local` uses a dedicated connection and explicit read-only repeatable-read transactions. Provision a role with only `SELECT` on `pools`, `nullifier_reservations`, `sessions` and `USAGE` on their schema. It never constructs `Ledger`, takes its writer lock, updates epochs, consumes direct checkpoints or marks outbox delivery. Lookup includes **SETTLED** sessions. Missing permanent AUTH evidence fails closed. Local Unix/loopback DB connections only, including any `hostaddr` override; authenticated production DB transport is a follow-up.
- `PreparedChallenge` verifies the archived RP with the existing fixed VK, binds `(pool, Pending.N)` to the immutable transcript, prepares the current zero path with the host tree prover, verifies the new real tree proof and applies the same `zkapi-layout2` challenge binding used by Vault. It does not reapply quote freshness or require historical RP root equality to current root or Pending.old_root. Pause permits challenges; deadline equality rejects them.
- `Journal` independently stores immutable evidence, candidate generations, per-consumer checkpoints, all payloads/buffers and exact signed attempts. The directory uses mode 0700 and files 0600 on Unix. A process lock, file fsync, atomic rename and directory fsync protect each transition. Open requires an existing intact journal and matching pool; initialization is explicit. Both open and updates check job keys, pool/evidence/N/digest bindings, unique N/Pending generations and checkpoint ordering. A valid checksum from an older writer cannot bypass those invariants. Queue updates and cursor advancement are one durable operation. Persistence errors poison the handle until reopen.
- A signed attempt is persisted as `Unknown` **before** sending. While any attempt remains unknown, a new signature or payload is rejected. A Pending generation and permanent N cannot be rekeyed into another job by changing its deadline, note or generation. Restart exposes the same signed bytes for status lookup/rebroadcast. Payload checkpoints must follow the Pending generation without forks, and signature strings are not used to order chain positions. Finalized execute success alone completes a job; a finalized failure of the current payload/buffer can permit rebuilding only the tree/payload while preserving the RP. Blockheight expiry, buffer absence, timeout and confirmed status are not terminal outcomes.


The DB test inserts a synthetic archived envelope around an existing real RP into the real I05 schema; it does not rerun authorization/settlement. Proof tests reuse the immutable I02 PK/VK hashes and known-public test entropy; this is never production setup evidence. Actual Vault SBF coverage includes historical-root challenge, pause, exact-deadline rejection, buffer create/append/seal/execute, restored root/Note/Pending, USDC preservation, permanent nullifier/tombstone, and replay rejection. The new SDK case executes the freshly generated payload using the I04 bridge's exact signed v0 bytes, including the extra priority-fee instruction. A subsequent definite failure is followed by a bridge-signed close, checking buffer removal and rent return.

I09 C–E dispatcher/fencing, DB/WAL/signer restore, dashboard and production secret boundaries are separate components. See the [I09 evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I09.md) for their current status. No vendored upstream files, circuit/hash semantics, applied control migration or financial-writer ownership were changed by the challenger. It reuses pinned `ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052` proof code through existing crates.
