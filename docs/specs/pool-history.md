# Pool-scoped state synchronization

Status: implemented in source for a fresh PoC, 2026-10-20; not deployed.
The implementation contract is [current-state acquisition](pool-history-acquisition.md).
This replaces the earlier candidate C financial-history acquisition proposal.
Normal indexer/challenger commands now require config v2 and current accounts.
Legacy replay remains available for offline validation and explicit archive utilities.

## Decision

Make RPC cost depend on this Pool's accounts and activity, not the number of
blocks produced by Solana. One state reader obtains finalized account batches,
reconstructs the current Merkle tree and publishes a verified current view for
the HTTP indexer and challenger. Startup reads current accounts; it does not
replay from Pool initialization. Normal synchronization makes no `getBlocks`,
full `getBlock`, `getSignaturesForAddress` or `getTransaction` calls.

The owner selected a fresh, single-user PoC installation. Compatibility with old
configuration, archive/checkpoint formats, financial journals and client profiles
is not an acceptance requirement for this redesign. Do not build a composite
old/new archive, rehydration path, custody importer or rollback converter. Use a
new Pool and empty service/client state for acceptance. The [fresh setup guide](../getting-started/poc-state-sync.md)
defines what is recreated and what can be reused. This is a design decision;
editing this document does not reset a host, delete a journal or move funds.

Reuse the existing wallet, ControlClient, WalletClient, ClientDaemon, accounting
ledger, authorization proof checks, tree code, signer and transaction recovery.
New PoC state still uses integer amounts, durable reservations, idempotent AUTH,
sign-once settlement and exact signed bytes. Permission to discard the old test
installation is not a retry policy for uncertain operations in the new one.

## Alignment with Ethereum zkAPI

The [reference poller](https://github.com/ethereum/zkapi/blob/29624ba0cc790d2d8d1e5cc6bfb00edaedd96064/crates/zkapi-indexerd/src/poller.rs)
requests Vault-address event ranges, applies them to its local mirror and checks
that mirror against block-pinned contract state. It stores a checkpoint for
restart. It does not download the complete transactions of every network block.
It does acquire event history; it is not a history-free implementation.

Adopt its bounded, deployment-scoped acquisition, verified local state,
checkpoint and backoff principles. Solana already exposes the required current
Note and Pending state in accounts, so use those accounts instead of reproducing
Ethereum's log transport. This is a deliberate Solana adaptation, not a claim
that Ethereum uses account snapshots or that the two verification scopes match.

Keep the [pinned upstream dependency](../../vendor/README.md), circuits and current
Solana financial protocol. Do not port the reference's newer concession protocol,
append-only tree or key setup as part of RPC optimization. No Vault account-layout
or instruction change is required by this design.

| Concern | Selected PoC behavior |
|---|---|
| Tree paths | Reconstruct from current Active Notes; compare exact root |
| Pending discovery | Enumerate allocated Note/Pending PDAs; inspect current Pending state |
| Challenge evidence | Existing permanent AUTH evidence from the shared ledger |
| Buffer uploads | Needed for sending a new operation, not for replaying old operations |
| Restart | Current account read plus durable jobs/Unknown recovery |
| Synchronization storage | One replaceable validated state cache, not an append-only block archive |
| Old test deployment | Fresh setup; no compatibility/migration implementation required |

## Verification and changed scope

The new `account_state_poc_v1` policy trusts the configured finalized RPC for
account data and the pinned program/authority for its semantics. Verify ownership,
PDA seeds, layout, deployment identity, field encodings, complete allocated Note
inventory, Pending consistency, exact Merkle root and outstanding principal.
Keep independent Control nullifier/exit checks and exact transaction receipt
recovery. A current-state snapshot does not prove a nullifier was never used.

This policy no longer independently replays every financial instruction or
reconstructs consumed payload-buffer generations. It does not supply a complete
historical audit, exact historical execution positions, or evidence of an escape
that started and finished entirely during downtime. Pending protection requires
monitoring within the existing challenge window; history replay could report a
missed deadline afterwards but could not recover that deadline.

Do not label this evidence `financial_history_complete`, pass it as fabricated
`FinalizedBlock` values, or weaken the legacy full-replay validation to accept it.
Use explicit current-state types and shared pure account/tree validators. Reuse
the financial ledger and challenger machinery rather than adding another
financial state machine.

## RPC and acceptance priorities

1. One account acquisition owner; local consumers share its verified view.
2. Batch Note and Pending PDAs with Pool, Tree, Vault and Clock. For up to 48
   allocated Notes this fits one standard 100-address call per refresh.
3. Use one transaction-free block header for the published cut. Avoid a preliminary
   `getSlot`; the account response supplies the cut.
4. Poll every ten seconds when idle, every two seconds with actionable Pending or
   Unknown work, and coalesce fresh-view requests. Use verified sequence equality
   to reuse tree computation, not to skip Pending discovery on a changed sequence.
5. Cache deployment checks and local readiness work as specified in the contract;
   keep transaction admission checks fresh and independent.
6. Test exact method counts, retry limits and restart without any history source.
   Measure billed credits separately from calls; publish no unmeasured saving.

The contract fixes batching, freshness, job identity, persistence, failure behavior,
configuration and executable acceptance cases. Its cost model includes light
header calls, deployment checks, Control, recovery and monitoring. There is no
history budget that can prevent the account reads needed to protect a Pending.

## Existing offline projection

Candidate A's [offline projector](../getting-started/pool-history-projection.md)
is implemented and remains useful for inspecting retained complete archives.
It preserves complete block coverage and original transaction positions. It is
not part of the new PoC runtime, a prerequisite for reset, or a credit-saving
mechanism. Its existing readiness fences and tests remain unchanged.

Candidate B's per-block account screening and candidate C's signature/dependency
history acquisition are not selected implementation paths. The new PoC does not
require live projection, sparse interval storage, prefix/suffix binding, financial
history repair, or archive compatibility to be completed first.
