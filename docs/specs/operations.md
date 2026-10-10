# Operations and recovery contract

This document defines deployment requirements. It does not establish current
service availability or production qualification; see [support status](../support.md).

## Deployment and trust

One deployment has one USDC pool and one authorization writer. Proxy frontends
may scale horizontally, but the writer and primary PostgreSQL serialize operation
admission, budget reservations and signing decisions. Indexer, challenger, proxy
and signer run separately. Caches are never authoritative for balances or nullifiers.

Use a synchronous replica in a separate failure domain. Acknowledge authorization,
clearance, DISPATCHING and signing-target commits only after durable replication.
Before promotion, stop or fence the old primary and writer. Verify split-brain
behavior; primary-only acknowledgements do not meet RPO=0.

The signed deployment manifest pins:

- Deployment ID, genesis, program, pool, mint and token program.
- Signing keys, circuit IDs, PK/VK hashes, layout 2, backend, tag policy, circuit
  profile, setup profile and transcripts.
- Transaction formats, IDL hash, quote/receipt keys, HTTPS origins, supported APIs,
  tariff hashes, TTL and cap.
- Admin and upgrade multisig authorities, program IDs, members, thresholds and
  configuration hashes; binary/image digests and database schema version.

`manifest_hash=SHA256(JCS(manifest excluding manifest_hash and manifest_signature))`.
The distribution Ed25519 key signs those raw 32 bytes. Clients bootstrap from an
independently pinned distribution key or trusted manifest hash, never solely from
a key inside the manifest. Do not automatically accept replacement pools or keys.
Deployment configuration references provider credentials through the secret
manager rather than containing them.

[Tree artifact/profile hashing](tree-transition.md) applies.
`tree_proof_artifacts` and `setup_transcript_hashes.tree` must agree. Mainnet
requires `ceremony_verified`; populated fields alone do not verify a transcript.

### External-send fencing

A database lock cannot stop an old process from sending requests. Restrict provider
credentials and egress to a dedicated dispatcher; network ACLs prevent direct
frontend access. In the same transaction as ISSUING/DISPATCHING, record attempt
ID, writer epoch, owner instance and session/operation in dispatch_attempts.
Apply this to direct-key issuance, inference and count_tokens. Never reassign an
uncertain attempt to another owner.

`finished_at` means the original call is terminal and cannot send/retry.
`fenced_at` requires a verified `FenceCertificate` with all three conditions true:
`process_terminated`, `restart_denied` and `egress_revoked`. Bind the signed
control-plane record through fence_evidence_digest. Timeouts and database flags
alone are not fencing.
Failover fences the old dispatcher as well as writer and database.

Do not enter SIGN_PENDING or publish a successor until every attempt is finished
or fenced; the signer independently verifies this. Direct sessions also require
key disablement, captured final usage under their provider policy and confirmed
deletion. Proxy's 900-second waiver is a target conditional on fencing. If fencing
fails, stop admission, keep settlement pending and alert the operator. Never
silently restore an old owner's send capability after settlement. Test this case
with an owner stopped immediately after dispatch commit.

## Security boundaries

| Risk | Required control and limit |
|---|---|
| Concurrent sessions for one note | Unique pool/N, shared AUTH/CLEARANCE lock, on-chain exit tombstone, challenger |
| Parallel budget races | Session row lock, maximum-cost reservations, integer accounting; operator absorbs over-cap cost |
| Proof/quote/cross-pool replay | Deployment/asset/mode/request/credential bindings and canonical parsing |
| Token disclosure | Short lifetime, separate purposes, redaction, revocation and TLS; exposure can still permit use |
| Signer compromise | Isolated service, separate keys, durable unique signing targets and new-pool migration |
| False proxy usage | Recomputable receipts and audit; no ZK proof of actual provider usage |
| Incorrect or delayed provider charges | Explicit receipt evidence class, provider-specific capture policy, caps and proxy unknown waiver |
| IP/body/timing correlation | No body storage, supported Tor routing and clear privacy limits |
| USDC freeze or price deviation | Fixed mint, operator-loss rules and atomic rollback; issuer powers remain |
| Withheld server signatures | Original escape/challenge rules; no unconditional-exit claim |
| Expiry | Visible expiry and withdrawal warnings; all expired Active principal goes to treasury |

Use the isolated Rust signer for Baby-JubJub; do not substitute an Ed25519 KMS
signing API. Store seeds using KMS envelope encryption, decrypt only into limited
process memory and disable swap, core dumps and debug endpoints. Use mutual TLS
for signer RPC and recheck requests against the primary ledger. State, clearance,
quote, receipt, program administration and provider credentials use separate keys.

Program upgrade authority and admin use separate 2-of-3 multisigs, with selected
programs/configuration pinned in the manifest. Disclose upgrade authority as a
trust assumption. An upgrade must not replace an existing pool's immutable keys
or VK; use a new pool with an explicit custody transition.

## Finality and challenge

Deposits and normal authorization roots must be finalized. New authorization also
checks confirmed exits through two independent RPC backends. A tombstone or
Pending seen by either stops new keys and proxy use. Reject responses whose
context slot predates the latest finalized slot. RPC errors or inconsistent
slots never mean unused.

Chain checks and off-chain issuance cannot be atomic. Preserve request proofs for
challenge. The challenger may prepare at confirmed commitment but uses finalized
canonical state and a locally verified current-zero-path proof for submission.
Keep the historical RP/root; after a finalized root-conflict rejection regenerate only the
tree proof. Reconcile any uncertain send before an explicit retry or changed
priority fee.

For a 24-hour challenge window, target detection-to-send within five minutes:
warn at 60 seconds, page at five minutes, and treat one hour remaining as urgent.

Checkpoints contain slot, blockhash, transaction signature, outer instruction
index, CPI execution index and tree sequence. Replay archive history in sequence
and compare with program TreeState. Bind provider receipts to request transcripts;
retain challenge RP/proof after settlement.

## Retention and recovery

Never store secret notes, wallet seeds, prompts/responses or raw tokens in server
logs, databases or backups. Retain authorization transcripts (proof, inputs,
quote, credential hashes), CLEARANCE reservations, signer journals and nullifier
tombstones while a pool operates. TTL alone cannot establish that an anonymous
request's note is closed. Apply retention deletion only after chain verification
that all notes are Closed, admission is permanently disabled and challenges ended.

Do not log raw IPs; expire salted rate-limit keys after 24 hours. Do not retain
unbounded provider error bodies. Restrict audit logs to transitions, deployment,
request/operation IDs, amounts and hashes. Disable automatic HTTP body and
Authorization capture in tracing.

| Failure | Recovery |
|---|---|
| Lost client response | Query using the same request ID, secret and proof; do not create another authorization for N |
| Direct issuance timeout | Persist ISSUANCE_UNKNOWN; inspect key existence/usage, disable and settle; no replacement key |
| Proxy crash after send | Mark usage unknown; no redispatch. Finish/fence sender, inspect usage or apply operator-loss waiver; hold settlement if fencing is uncertain |
| Lost database response after signing | Recover the identical message/signature from signer journal; do not recompute charge or anchor |
| Database failover | Fence old primary/writer/dispatcher, verify replicated LSN and reconcile unsettled state with signer journal |
| Disaster restore | Replay WAL through the last acknowledged commit; no new admission if acknowledged reservations cannot be restored. Chain history cannot reconstruct off-chain N reservations |
| Root conflict or expired blockhash | Reconcile chain outcome first; rebuild financial attempts only after a finalized rejection. Deposit also checks next ID |
| RPC/indexer disagreement | Stop admission/path serving, reconstruct through another RPC and prioritize valid finalize/challenge work |
| Provider outage | Stop that provider's new sessions; continue existing settlement, withdrawals and other providers |
| USDC transfer failure | State rolls back; inspect token accounts and preserve destination/proof conditions for explicit retry |

Take encrypted daily snapshots and continuously archive WAL. Monthly isolated
restores compare nullifiers, reservations, signer journals and unsettled operations.
Targets are RPO=0 for acknowledged financial reservations and RTO=1 hour; do not
claim an achieved SLO without measurement.

## Setup, builds and release requirements

Compatibility tests use the original single-party setup. Production pools require
reviewed Groth16 setup/contribution procedures and public transcript verification
for request, withdrawal and tree circuits. Include independent participants and
state the assumption that at least one participant discarded their secret. A
single local setup is not a production ceremony. Reusing existing artifacts under
a different trust model requires an explicit ADR.

Use exact pinned Rust, Agave, Anchor, program/transaction SDK and verifier
versions and lockfiles; Arkworks remains on upstream's 0.5 series. Keep SBF and
RPC dependencies in separate crates. Never use mutable `latest` tags for CI or
production builds. Extra transaction formats require real cluster/RPC/wallet
verification, while `v0_buffer` remains required.

Production build/release checks reject `test_only`, known fixture PK/VK hashes,
missing or invalid transcripts and profile mismatches. Sign local/Devnet and
production manifests separately. Enforce these checks in release signing and
deployment; they do not themselves prevent an arbitrary mainnet upload.

Distributions include hashes, signatures, SBOM, licenses, upstream commit and
circuit/PK/VK manifests. Browser proving keys are hash-checked after download.
Native, WASM and SBF verify the same vectors. Role-specific signing keys follow
[ADR-0002](../adr/0002-build-validated-signing-keys.md): validated build constants,
manifest keys and actual PoolConfig must agree.

Production verification covers:

- Real proofs, mutations of all 12/14 public inputs, H2F/Poseidon compatibility,
  worst-case CU/bytes and supported wallet/buffer paths.
- Parallel budgets, crash points, client recovery, withdrawal races and database
  failover without duplicate charge or signing.
- Real credentials, usage and streaming for each advertised direct/proxy provider;
  fixtures do not establish provider acceptance.
- Setup, multisigs, independent review/audit, restore drills, monitoring/on-call
  procedures and authenticated manifests.

Provide reproducible native prover artifacts and local proving when workers fail.
Measure challenge detection-to-execute, proof p50/p95, memory and regeneration
under root conflicts. Monitor proof delays/failures, root/slot lag, challenge time
remaining, authorization/withdrawal failures, nullifier conflicts, absorbed costs,
unknown usage, pending settlements, escrow invariant, signer duplicate-message
rejections, replica lag and SOL fee balance. Pool-wide stop and per-provider
admission stop are separate controls.

## Snapshot wire and reconstruction

TreeSnapshotFile from [OpenAPI](../contracts/openapi.json) is JCS UTF-8 without BOM
or trailing newline. Verify SHA-256 over all downloaded bytes. Require
`schema_version="1"`; snapshot is Root. Sort active_notes and pending_withdrawals
by note_id, reject duplicates and overlap, require every ID<next_note_id and
next_note_id<=2^32. Omit Closed notes without reusing their IDs.

The snapshot cut is the end of a finalized slot. Verify blockhash and trusted
chain history for that slot. Rebuild the original 32-level tree from active
C/D/expiry and compare root. Pending leaves are zero; verify Pending against
chain history too. Matching the snapshot's own hash does not establish chain
correctness.

Replay later successful transactions in protocol order, then compare current
root/sequence/next ID and Note/Pending before serving paths. Where historical
accounts are unavailable, replay from initialization. Follow the protocol's
buffer close/reuse and missing-log rules; stop serving if history is insufficient.
Snapshots omit the complete ExitNullifier set, so independent RPC checks remain
required for unused-nullifier decisions.
