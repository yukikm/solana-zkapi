# I09 process and recovery operations

The local executable paths below are implemented and exercised by
`python3 scripts/run_i09_operations.py`. This is not an approval to deploy the
known-entropy local circuit artifacts or seed files. `controld`, `dispatcherd`
and `signerd` still require the explicit local test profile. Production setup,
independent infrastructure fencing, credentials, platform isolation, on-call
routing and public-cluster acceptance remain release gates.

## Provider isolation

Set `providers.dispatcher` to `{binary,binary_sha256,config_file}`. The control
process retains only public provider profiles. Its credential paths may be absent.
The separate `dispatcherd` configuration uses `{local_test_only,database_url,pool,
claims_directory,providers}` and must not recursively configure another dispatcher.
Use a SELECT-only PostgreSQL role and private configuration/claim directories.
No dispatcher constructs `Ledger`, acquires a writer lock or updates financial
rows. The fixed command has no shell, inherited environment or arbitrary URL RPC.

Each proxy inference/count_tokens or direct issuance is bound to the exact
ledger attempt, current writer epoch, owner, session, operation and provider.
After the control writer claims it, the dispatcher independently validates the
row and creates a fsynced `O_EXCL` claim. That file contains only ownership data,
never prompt/response or credentials. Do not delete or roll back these files.
Interrupted or duplicated claims are permanently non-replayable. Direct management
calls are restricted to saved checkpoints; deletion requires persisted final usage.
The child must exit before its successful terminal result permits `finished_at`.
Lost IPC responses remain unknown. Process cancellation and restart never reissue.

For actual deployment put control/proxy and dispatchers under different OS
identities and network namespaces. Control/proxy must have no provider secret
mount, no permission to alter dispatcher claims/config/binaries, and no provider
network route. Restrict dispatcher routes to provider endpoints and DNS policy;
credentials and egress enforcement cannot be inferred from process separation on
a developer laptop. Do not grant a generic network proxy to the frontend.

## Independent fences

A trusted platform controller must terminate the precise dispatcher resource,
deny its restart and revoke its provider egress before signing a `FenceCertificate`.
Its Ed25519 public key is installed separately from the certificate and ledger.
Canonical JSON excludes `signature`; that field contains the hex signature.
The certificate includes pool, attempt UUID, owner UUID, writer epoch, controller,
immutable resource UID, `process_terminated`, `restart_denied`, `egress_revoked`
and Unix `observed_at`. All three facts must be true and the evidence at most
300 seconds old. A DB flag, timeout, fresh epoch or unverified operator assertion
is not a fence. The test certificate signer is only a local test controller.

After stopping the old financial writer, use the existing single writer:

```
ZKAPI_DATABASE_URL=... controld fence control.json fence.json supervisor-public-key.raw
```

The command verifies the independent signature and immutable attempt identity,
persists the fence, and leaves admission disabled. Never promote while any old
primary/writer/dispatcher can resume. Unknown proxy work can be waived only after
its attempts quiesce; direct work additionally needs stop/final usage/delete.
The provider unknown/loss breaker is derived from durable rows, so restarting
cannot reset it. `Ledger::reset_provider_admission` requires all provider operations to be terminal
(including queued/dispatching/streaming work), takes effect in the running process,
and appends an audited evidence digest through the same writer.

## Recovery and WAL

Configure PostgreSQL `fsync=on`, `full_page_writes=on`, physical streaming
replication and `synchronous_standby_names`. Every financial writer connection
must use `synchronous_commit=remote_apply` (or a deployment-reviewed synchronous
flush policy). Without a synchronous replica acknowledgements must block. The
local drill actually stops the replica, checks a write remains unacknowledged,
restarts it, terminates the primary, promotes the replica and checks all ACKed
rows and replicated financial databases. Local timings are not production RTO.

Stop admission before `opsd checkpoint admin.json witness.json`. Retain this
fsynced digest witness in independent storage with your encrypted base backup,
continuous WAL and independent signer journal. Its SHA-256 detects corruption;
its location and retention provide the trust anchor against whole-store rollback.
It cannot discover acknowledgements newer than itself. Take a final checkpoint
at the fenced last-ACK cut and retain the corresponding PostgreSQL WAL LSN.

Recovery witnesses use version 2. They include pool identity/epoch, referenced
tariffs, quotes, provider evidence, chain checkpoints/events/transactions and
all reservation/settlement/outbox rows. Timestamp hashes use UTC independently
of the observer's session timezone. Version 1 witnesses omitted some tables and
are rejected; recapture a version 2 cut from the authoritative quiesced primary,
never relabel an old witness or regenerate it from an unverified restore. The
verification command also requires the witness pool to match `admin.json`.

Recover base backup plus WAL through that cut in isolation, then run
`opsd verify-restore admin.json witness.json`. Missing ACKed reservations,
operations, attempts, receipts or signing targets, schema checksum changes and
unquiesced attempts fail closed. Never initialize an empty signer journal to make
a restore appear healthy. Start the existing signer with its original journal;
its mandatory reconcile compares all intents/signatures to the recovered ledger.
Finally start the writer, which increments epoch and performs its existing
signer recovery before admission. Chain replay alone cannot restore off-chain N.
Measure last-ACK RPO and complete restore RTO monthly on independent hardware.

## Private administration and monitoring

`opsd serve admin.json` provides `/admin/v1/dashboard/summary`,
`/admin/v1/dashboard/recent`, `/admin/v1/dashboard/events`, using the existing
OpenAPI response shapes and opaque `cursor` pagination for both event lists.
Configuration requires an explicit loopback listener, numeric peer allowlist and
a separate owner-only alphanumeric admin Bearer token of at least 32 bytes.
Authorization and socket peer are both checked; proxy forwarding headers never
bypass the ACL, browser Origin is refused, and responses are `no-store`.
Recent/events expose only allowlisted operational fields, never transcript,
credential hashes, nullifiers, provider management references or event metadata.
Set `health_file` to the live collector's private `health.json`. Summary reads
active sessions, pending settlements, signed integer micro-USDC charges and
unknown operations from one read-only DB snapshot, and root lag from a fresh,
matching collector report. Missing/stale/unavailable chain observations return
503 instead of reporting zero lag. The collector retains budget/unknown/loss/
unfenced/deadline alerts across restarts; the dashboard never returns raw metadata.

The monitor policy in `monitoring.json` is the acceptance inventory for metrics
produced by the indexer, challenger, signer, PostgreSQL and chain fee-payer probes.
Missing/stale measurements must page as unavailable, not display healthy zero.
Wire delivery to an independently tested on-call receiver before production.

## KMS envelope and mutual TLS

`signerd --local-test --custody-config custody.json` replaces raw state/clearance
seed files with AES-256-GCM envelopes. Every envelope authenticates deployment,
pool, role and KMS key reference. A hash-pinned, non-writable helper unwraps the
32-byte data key through private pipes, with no inherited environment and a
10-second deadline. A helper failure, wrong role/context/tag or key pin refuses
startup; there is no plaintext fallback. The helper receives only wrapped key,
key reference and encryption context. Supply an authenticated cloud-KMS/workload
identity implementation as that helper; the local test helper is not cloud KMS.
The signer still validates distinct Baby-JubJub role public keys against its
build/pool and uses the existing immutable sign-once journal. KMS does not sign
Baby-JubJub messages. Quote/receipt envelope support uses the same loader API.

`mtls-bridge` supplies server TCP→private signer socket and client private socket→TLS
modes so the existing `SignerClient` needs no financial protocol changes. Both
ends verify a configured CA and an independent peer certificate SHA-256 for the
specific role. The client additionally checks the server DNS name. No plaintext
fallback or unauthenticated-client mode exists. DER certificate/PKCS8 private-key
files and socket parent permissions are validated. The local test performs actual
TLS handshakes, rejects a different CA-signed client role and plaintext, and checks
that only the accepted request reaches the backend.

Deploy signer/helper/bridge with no debug endpoint, core dumps or swap, protected
memory policy and least-privilege KMS identity. Root compromise and live process
memory are outside envelope-at-rest protection. Test those OS/cloud controls in
the target environment before asserting the production secret boundary.

`opsd monitor sample.json [previous-sample.json]` executes the fixed threshold
policy. Samples contain `observed_at` and a `measurements` mapping of known metric
names to canonical unsigned integer strings. Stale/missing measurements and
counter rollback page; output contains metric/severity/reason only. Feed those
redacted JSON alerts to the deployment's authenticated notification collector.
The runner also starts the real signer with envelope-only seeds and routes all
five control/provider integration cases through the actual mutual TLS bridge.

Physical restore verification requires the original PostgreSQL system identifier
and a numerically parsed WAL flush LSN at least as new as the independently
retained last-ACK checkpoint. A different cluster, malformed LSN, earlier WAL,
or incomplete mutable financial rows refuses admission. Checkpoint capture is
only a recovery cut after admission and financial mutation workers are quiesced;
it is not a live incremental backup catalog or an automatic admission override.

## Live collector

`opsd collect monitor.json` writes one private, atomic `health.json` report;
`opsd watch monitor.json` repeats it at a configured 1–30 second interval until
SIGINT. An exclusive directory lock prevents two collectors from overwriting
counter baselines. The report contains only numeric measurements, fixed source
states, service instance IDs and redacted alert reasons. It never sends a human
notification or mutates the financial ledger. Retain this private output across
collector restarts; signer instance changes page because in-process refusal
counters reset on signer restart.

The owner-only configuration uses these fields (see
`services/control/src/monitoring.rs::Config` for the exact JSON types):

- `local_test_only: true`, `database_url`, and `synchronous_replica_application`.
- `trusted`: the same validated `TrustedPool` fields extracted from the pinned
  control manifest; `signer_config`: the existing signer JSON object. Their pool
  Vault binding, cap and role signing keys must agree. The collector also checks
  the ledger's exact stored signer configuration in the same read-only snapshot
  as the counters; a different ledger with the same pool address is unavailable.
  `fee_payer` is its public key, never a seed.
- `rpc_url` and `indexer_origin`: numeric loopback HTTP origins in this local
  implementation. No DNS, ambient proxy, redirect, URL credentials or query
  parameters are accepted. Public-network deployment remains gated.
- `signer_socket`: the existing owner-only signer or local mutual-TLS client
  bridge socket. The health RPC performs the existing read-only reconciliation
  and authenticates its configuration digest; it never signs a new message.
- `challenger_health_file`: `journal_directory/health.json` produced by the real
  challenger. Pool/schema/ready status and a maximum 30 second age are checked.
- `output_directory`: an existing directory with mode 0700;
  `interval_seconds`: an integer from 1 through 30.

Provision a **separate** PostgreSQL login with `GRANT zkapi_control_reader,
pg_monitor TO operations_reader` and only CONNECT to the control database.
The reader role has SELECT access to ledger tables; `pg_monitor` exposes the
configured synchronous replica's `pg_stat_replication.flush_lsn`. The collector
sets `default_transaction_read_only=on` and never takes the pool writer lock.
An absent/hidden/non-synchronous replica pages as unavailable; it cannot become
zero flush lag. Active attempts page while admission is disabled (recovery),
while the ordinary live-attempt gauge alone does not page.

Every poll gathers ledger unknown/loss/recovery counters, finalized RPC genesis,
slot and block identity, the indexer root, finalized fee balance, and Pool/Tree/
USDC vault accounts from one `getMultipleAccounts` finalized bank. It authenticates
account ownership/layout/PDA/mint/authority and tests `vault.amount >=
outstanding_deposits`. The signer reports all rejected immutable signing requests
as `signer_refused_requests_total`; emergency alerts deliberately cover message
conflicts as well as other refusals. Challenger deadline, proof failure and root
reproof counters come from its durable journal-backed health export. Missing,
stale, malformed or mismatched source data remains missing and pages; no failed
source can report a healthy zero. Persisted samples also detect counter rollback.

`operations_collector_live_sources_watch_and_failure_alerts` runs actual opsd
and signerd processes with PostgreSQL, AES-GCM custody and the mutual-TLS bridge.
Its local RPC fixture uses actual SBF-exported Pool/Tree bytes and controlled
fee/escrow responses to test healthy reads, low SOL, root lag, escrow deficit,
wrong genesis, stale challenger, rejected signing requests, signer loss, collector
locking and private redaction. The separate challenger runner verifies the actual
health producer. These local observations do not validate public RPC, deployment
network isolation, cloud KMS or an on-call delivery channel.
