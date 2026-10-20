# Challenger: native daemon and emergency CLI

The [current-state runtime](../../docs/specs/pool-history-acquisition.md) consumes
the indexer's verified finalized accounts through its private Unix socket and
identifies Pending jobs by permanent nullifier. It creates a v3 journal without a
block archive, reuses retained AUTH evidence, the proof builder and exact signed
v0 recovery. See [fresh PoC setup](../../docs/getting-started/poc-state-sync.md).
Normal commands require config v2; no old-state importer or automatic fallback
exists. The fresh public Devnet deployment runs this mode; shared-state acquisition
and restart were observed live. Actual challenge sending remains covered by local
tests rather than a new live challenge in this rollout. See
[current support](../../docs/support.md).

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

`init` creates an empty v3 journal and refuses an existing one. `scan` reads the
shared current cut and discovers AUTH evidence without proof/sign/send;
`prove` also generates payloads. `once` advances one upload step per job; `run`
continues polling the local owner. `recover` needs neither DB nor proving key;
receipt lookup needs no fee secret. `cleanup` handles definite failed buffers;
`status` reads the journal locally. The indexer must be running for scan/prove.

Each proof/preparation requires a locally fresh verified view. Signing checks
the pinned deployed program, then saves the complete exact-byte attempt as
Unknown before sending. A program change fences signing/resending while allowing
read-only receipt recovery. Pending disappearance stops new work but never
resolves an Unknown attempt. A later escape with a new N is a distinct job.

Configuration is strict JSON with these fields:

```json
{
  "config_version": 2,
  "chain_state": {"mode": "account_state_poc_v1", "state_socket": "/private/zkapi-poc/state.sock"},
  "program_identity": {
    "program_file": "/trusted/test-deployment/zkapi_vault.so",
    "sha256": "<SHA-256 of exact deployed ELF>",
    "deployment_slot": 1,
    "authority": "<pinned upgrade authority, or null for immutable>",
    "programdata_len": 1000000
  },
  "manifest": "/trusted/test-deployment/manifest.json",
  "manifest_sha256": "<externally pinned JCS manifest_hash>",
  "rpc_url": "http://127.0.0.1:8899",
  "database_dsn_file": "/private/challenger-reader.dsn",
  "journal_directory": "/private/challenger-journal",
  "tree_pk": "/trusted/test-deployment/tree.pk",
  "node": "/absolute/path/to/node",
  "transport_bridge": "/trusted/solana-zkapi/packages/sdk/src/challenger-cli.ts",
  "transport_bridge_sha256": "<externally pinned SHA-256 of bridge source>",
  "fee_key_file": "/private/challenger-fee-key.json",
  "payer": "<fee key's base58 public key>",
  "alert_sink_directory": "/private/challenger-alerts",
  "priority_fee": { "base": 1000, "warning": 10000, "page": 50000, "emergency": 100000, "cap": 100000 }
}
```

The program identity fields must match the indexer; slot and allocation length
above are placeholders to replace from independently verified deployment inputs.
Do not include `start_slot`, `archive_batch` or `poll_seconds`.

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

The v3 queue stores an `AccountCutRef` (deployment, genesis, program, Pool,
slot/hash, sequence, chain time) and immutable current Pending attributes. Queue
insertion, live/absent tracking and checkpoint advancement commit atomically.
Job IDs hash genesis/program/Pool/note ID/N; observation time is not identity.
Each job retains its first account cut separately; payload cuts cannot precede
or fork that durable observation, including after restart.
Restart reads fresh accounts and reuses the same job and exact signed attempts.
There is no archive prewarm, start slot or replay checkpoint in this path.

SIGINT and SIGTERM are latched before journal/network access. The worker stops admitting work at safe checkpoints and cancels read-only RPC/DB waits. It explicitly kills and reaps an active Node bridge before returning success. A bridge recovering a transaction can only send the exact bytes already in the journal; stopping before its response retains the Unknown attempt and first-send timestamp for restart. Signing-only prepare/refresh output that was never saved has not been broadcast. Cancellation never manufactures a finalized outcome or replaces an unknown execute.

Synchronous proof work, journal parsing/serialization and fsync finish before their next checkpoint; these tests do not establish a universal stop deadline. Local process tests cover stalled RPC, DB connection, archive reads and an active bridge under SIGINT/SIGTERM. Failure to flush the validated prefix or reap the bridge is an error. The devnet launcher records native exit code, stop latency and explicit timeout/process-group escalation reasons; a nonzero exit or forced cleanup is never `clean_shutdown:true`.

Current Pending identity and zero paths come from revalidation of the complete account capture. No fabricated instruction position or buffer generation is used.

Jobs are processed by deadline then discovery time. Only a definite finalized upload failure or stale/expired-buffer execute failure permits a new tree proof/payload/buffer; historical RP/N/request time remain unchanged. Before replacement, the daemon authenticates the old buffer: it durably signs and recovers a buffer close, or records a finalized account absence together with the already definite failed outcome. Absence never resolves an unknown financial attempt. `cleanup` exposes the same recovery path when the worker is stopped. Unknown close attempts retain their exact signature just like execute.

Cleanup observations must be at or after the failed transaction's finalized slot. A missing account from an older cut cannot establish cleanup; a same-slot absence must also match the failure's blockhash.

Expired uploads reuse `refreshExpiredUpload`: finalized old blockheight expiry and the same buffer's validated owner/digest/prefix/seal are required. The native journal atomically records that reconciliation and any new signed append/seal; exact step indices prevent a retried chunk from skipping the next chunk. An already advanced prefix moves to its verified next step. Missing buffers, unfinalized observations, or unresolved execute/close never authorize a replacement or a new create.
Replacement signing also requires a fresh shared view of the same live Pending.
If the Pending disappeared or the shared reader is unavailable, receipt recovery
continues while the expired upload and its exact signed bytes remain Unknown.

The optional priority-fee policy uses integer micro-lamports/CU and a monotonic capped base/warning/page/emergency schedule (maximum 1,000,000 micro-lamports/CU). The price is selected for each new payload plan from its immutable observation time/deadline. Its entire upload, expired-upload refresh and cleanup retain that price; changing an in-flight plan's policy is rejected. Later safely regenerated plans may escalate. Every price is signed and preserved in the transport recovery record, and chunk sizes include the extra compute-budget instruction. No fee update can replace an unknown signature. Omitting the policy preserves the original zero-price wire.

Lifetime account capacity is bounded by the state reader. Large-pool throughput and public-provider billing require separate validation.

Each poll emits a redacted JSON metrics record: pending/completed jobs, unknown signatures, proof regenerations, oldest unresolved age, finalized slot/lag, minimum remaining deadline and counts for 60-second warning / five-minute page / one-hour emergency. Severity transitions also enter a durable alert outbox. `alert_sink_directory` delivers them as idempotent, fsynced, mode-0600 JSON files in a mode-0700 directory; a crash between delivery and acknowledgment checks the same event bytes on restart. Connect that private spool and process health to an operator notification collector. No external messages are sent by this implementation. No prompt, provider key or DB DSN is emitted. Production notification routing/delivery is deployment acceptance.

Each run/once tick also atomically writes `journal_directory/health.json` with mode 0600. The redacted schema is `{schema:1,pool,observed_at,ready,oldest_detection_to_send_seconds,minimum_pending_deadline,proof_failure_total,root_conflict_reproves_total,metrics}`. Proof failures and first execute-send timing are durable; root-conflict regeneration counts are derived from saved jobs. Error ticks set `ready=false`. The operations collector must reject missing, mismatched or stale snapshots; the file does not prove that a stopped daemon is alive.

`daemon-performance.json` records local end-to-end samples for normal, lost response, stale-root cleanup/regeneration, restart before send, confirmed-only hold, expired-upload refresh, expired execute buffer and rejected upload, p50/p95, regeneration/attempt counts, and the resident KiB of the native test process after each sample. The RSS sample includes the test harness/prover and is not a peak bound for the whole process tree. The RPC outcomes are synthetic; the actual-Vault signed-v0 case is a separate test. These local samples do not establish production five-minute SLO, outage/load/queue capacity, or public-RPC behavior.

## Explicit legacy archive utilities

`migrate-archive`, `archive-indexer` and `project-history` retain their legacy
configuration and library paths for explicit offline/archive work. They do not
initialize or migrate the new v3 financial journal. Normal commands accept only
current-state config v2. See [archive storage](../../docs/getting-started/archive-storage.md)
and [projection](../../docs/getting-started/pool-history-projection.md).

For an offline v1-to-v2 archive conversion, stop its old owner and run
`challengerd migrate-archive /absolute/path/legacy-config.json`. The utility
retains `legacy-v1.json`, takes the owner lock, validates Pool/manifest and writes
verified archive chunks without RPC, DB or signing. Keep incomplete staging after
a failed conversion for inspection. This is unnecessary for a fresh PoC.

### Read-only indexer over an existing v2 archive

The explicit `archive-indexer` mode lets the public indexer replay the challenger's committed blocks without fetching the same full blocks from RPC:

```sh
services/challenger/target/debug/challengerd archive-indexer /absolute/path/archive-indexer.json
```

Its strict configuration has two fields: `archive_directory`, the canonical absolute path to an existing v2 challenger journal, and `indexer`, the complete existing indexer configuration. Preserve the original `start_slot`, Pool, program, genesis and profile pins. Use a separate snapshot output directory; source/output overlap, parent traversal and aliases into the archive are rejected. Grant this process read access to the source, preferably through a read-only filesystem mount, and write access only to its separate indexer snapshots. It does not initialize or migrate storage, acquire or create `owner.lock`, write challenger health, load a DB or fee key, or construct the financial challenger runtime. This is an explicit legacy mode, separate from normal current-state commands.

Cold open checks the fixed head, its state checksum and Pool, the retained complete legacy prefix, and every referenced chunk. It streams the stored `FinalizedBlock` values through the existing indexer replay; these are decoded evidence, not reconstructed original RPC responses. Incremental refresh accepts only an authenticated extension of the exact prior tail. Already verified immutable files use trusted Unix device/inode/size/mtime/ctime continuity; new and replayed chunks are always hashed. Missing or changed files, rollback and replacement fail closed. This metadata shortcut does not defend against a privileged actor able to forge filesystem metadata. Unreferenced files are never adopted or removed.

The indexer retains a fixed finalized target and account cut while waiting for committed history. It still obtains and validates the independent finalized account cut and block anchor; it never fills missing full blocks from RPC or advances the configured start. Captured account cuts older than 30 seconds must be recaptured before publication. Source validation failures latch the process unavailable until operator review and restart. A newer atomic head does not alter the snapshot currently being replayed.

The mutable `journal.json` head is captured through one no-follow, nonblocking regular-file open. A normal writer rename between pathname inspection and open must not be classified as immutable-file replacement. Descriptor metadata, head checksums, prior-prefix continuity, immutable-file identities and fresh finalized reconciliation remain required. A source validation failure emits an `archive_source_failure` record containing only a static reason and optional numeric OS error, then retains the terminal fail-closed behavior.

Continuity checks for already authenticated immutable files use one no-follow metadata observation, comparing all eleven saved fields including permissions, ownership and link count. They do not open each historical payload just to obtain its attributes. Actual payload reads retain the regular-file descriptor checks and hashing. This reduces repeated system calls as the archive grows; it does not shorten retained history, extend the HTTP wait deadline or permit a stale root during reconciliation. See the [follow-up 503 repair](src/journal_readonly_tests.rs).

Cold validation is synchronous and occurs before the HTTP listener and its Ctrl-C handler are installed. A signal during that phase uses default process termination; this mode does not inherit the writer runtime's latched shutdown behavior, and no graceful cold-open cancellation is claimed. It performs no source writes to flush.

## Reproduce

For the new runtime use [local verification](../../docs/getting-started/poc-state-sync.md#local-verification).
The retained archive/SBF suite below is reference coverage; its historical native
CLI configurations need the corresponding legacy binary and do not configure
normal v2 daemon commands.


```sh
# Required if actual Vault history/ELF is absent:
bash scripts/run_i04.sh
python3 scripts/run_i09_challenger.py
```

The runner executes native tests with fsync-enabled disposable PostgreSQL/SELECT-only evidence, SDK challenger signing/recovery tests, fresh native CLI processes at every upload step, readonly-DB discovery, lost response, confirmed execute hold, finalized recovery without the fee key, and the actual Vault SBF harness. Artifacts under `target/i09-challenger/` include `runtime-report.json`, `runtime.log`, `daemon-performance.json`, `native-cli-results.json`, `proof-generation.json`, `generated-challenge.bin`, `svm-results.json`, and the known-test-entropy `test-tree.pk`. The report records exact commands, counts, source/lock/binary and input/output SHA-256 hashes. Old proof/performance/SBF reports are removed before a run.

## Trust and journal contracts

- `Trust::from_pinned_manifest` starts from an externally pinned manifest hash and reuses the build's PoolConfig/role-key/profile checks. The current build intentionally accepts only the pinned local `test_only` deployment. `load_tree_key` checks both PK and VK hashes.
- The legacy `Scanner` accepts finalized archive blocks through the existing indexer, tracks each Pending generation's slot/blockhash/signature/instruction/CPI position and tree sequence, and requires the actual PoolConfig plus a reconciled finalized Note/Pending/Tree cut before exposing a view. Use `ArchiveRpc::observe_chain` to obtain the independent account cut; passing `replay_state()` back as an account observation is only a synthetic test technique, never a production finality check. Current runtime uses `FinalizedView::from_current` and verifies the socket capture independently.
- `ReadRepository::connect_local` uses a dedicated connection and explicit read-only repeatable-read transactions. Provision a role with only `SELECT` on `pools`, `nullifier_reservations`, `sessions` and `USAGE` on their schema. It never constructs `Ledger`, takes its writer lock, updates epochs, consumes direct checkpoints or marks outbox delivery. Lookup includes **SETTLED** sessions. Missing permanent AUTH evidence fails closed. Local Unix/loopback DB connections only, including any `hostaddr` override; authenticated production DB transport is a follow-up.
- `PreparedChallenge` verifies the archived RP with the existing fixed VK, binds `(pool, Pending.N)` to the immutable transcript, prepares the current zero path with the host tree prover, verifies the new real tree proof and applies the same `zkapi-layout2` challenge binding used by Vault. It does not reapply quote freshness or require historical RP root equality to current root or Pending.old_root. Pause permits challenges; deadline equality rejects them.
- `Journal` independently stores immutable evidence, current Pending identities, per-consumer checkpoints, all payloads/buffers and exact signed attempts. The directory uses mode 0700 and files 0600 on Unix. A process lock, file fsync, atomic rename and directory fsync protect each transition. Open requires an existing intact journal and matching pool; initialization is explicit. Both open and updates check job keys, pool/evidence/N/digest bindings, unique N/Pending generations and checkpoint ordering. A valid checksum from an older writer cannot bypass those invariants. Queue updates and cursor advancement are one durable operation. Persistence errors poison the handle until reopen.
- A signed attempt is persisted as `Unknown` **before** sending. While any attempt remains unknown, a new signature or payload is rejected. A Pending generation and permanent N cannot be rekeyed into another job by changing its deadline, note or generation. Restart exposes the same signed bytes for status lookup/rebroadcast. Payload checkpoints must follow the corresponding observation without forks, and signature strings are not used to order chain positions. Finalized execute success alone completes a job; a finalized failure of the current payload/buffer can permit rebuilding only the tree/payload while preserving the RP. Blockheight expiry, buffer absence, timeout and confirmed status are not terminal outcomes.


The DB test inserts a synthetic archived envelope around an existing real RP into the real ledger schema; it does not rerun authorization/settlement. Proof tests reuse the pinned PK/VK hashes and known-public test entropy; this is never production setup evidence. Actual Vault SBF coverage includes historical-root challenge, pause, exact-deadline rejection, buffer create/append/seal/execute, restored root/Note/Pending, USDC preservation, permanent nullifier/tombstone, and replay rejection. The new SDK case executes the freshly generated payload using the transport bridge's exact signed v0 bytes, including the extra priority-fee instruction. A subsequent definite failure is followed by a bridge-signed close, checking buffer removal and rent return.

See [operator monitoring and recovery](../../docs/getting-started/operations.md)
for dispatcher fencing, database restore and signing-key isolation.
