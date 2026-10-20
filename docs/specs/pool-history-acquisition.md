# Pool-scoped current-state acquisition

Status: implemented in source for a fresh PoC, 2026-10-20. This supersedes
`trusted_rpc_financial_v1` and candidate C. Policy: `account_state_poc_v1`;
config v2, challenger journal v3. Local SBF, RPC fault and recovery tests verify
the implementation. Deployment, actual account reset and provider billing have
not been exercised; see the [setup and verification guide](../getting-started/poc-state-sync.md).

Read the [decision](pool-history.md), [protocol](protocol-solana.md),
[operations](operations.md) and [fresh setup](../getting-started/poc-state-sync.md).
The new installation need not read old archives, configurations, financial
journals or client profiles. Runtime financial durability remains mandatory.

## Acquisition model and trust

Use the existing indexer service as the single Pool state acquisition owner.
It obtains finalized PoolConfig, TreeState, Vault token account, Clock and all
allocated Note/Pending accounts. It constructs `VerifiedPoolState` only after
the checks below and atomically publishes an immutable view to HTTP and a private
local challenger interface. The challenger makes no duplicate synchronization
RPC calls. Control keeps its independent request-time checks on two backends.

Normal sync, cold start and restart issue no `getBlocks`, full-transaction
`getBlock`, `getSignaturesForAddress`, `getTransaction` or `getProgramAccounts`.
An exact signed attempt may still require `getTransaction`/receipt lookup during
recovery; that is targeted financial recovery, not a history sync fallback.
Allow `getBlock` with `transactionDetails:"none"`, no rewards and the supported
version ceiling solely for a selected cut's hash/time or a known receipt anchor.

The configured RPC is trusted for finalized account bytes, canonical slot/hash
and receipt results. The pinned program semantics guarantee contiguous Note IDs,
retained Closed Note tombstones, permanent exit nullifiers, and a checked monotonic
sequence increment on every successful financial change, including finalize.
Trust the pinned upgrade authority to preserve those semantics between identity
observations. A local checksum or reconstructed root is not an independent proof
of RPC truth. Do not claim historical transition or buffer-generation coverage.

## Account inventory and bounded capture

Derive addresses using the pinned program and Pool, not caller-supplied account
lists. Enumerate Note and Pending PDAs for every ID in `[0,next_note_id)`.
There is no Pool field in the Note data; a guessed `getProgramAccounts` memcmp
filter is not a substitute for this inventory.

Each `getMultipleAccounts` batch contains these four base accounts plus at most
48 `(Note, Pending)` pairs, for a maximum of 100 addresses:

- PoolConfig, TreeState, the derived Vault USDC ATA and Clock sysvar;
- Note PDA `["note", Pool, u32le(id)]`;
- Pending PDA `["pending", Pool, u32le(id)]`.

The first batch requests IDs `0..min(48,max_note_ids)`, even when not yet allocated.
Its TreeState supplies the exact next ID N and sequence q. Reject N above the
configured capacity before scheduling further reads. If N exceeds that first
range, schedule the remaining pairs, with concurrency at most four and
`minContextSlot` at least the first returned slot. No discovery probe or `getSlot`
is needed. Unallocated lookahead accounts must be absent; allocated Note accounts
must exist. Pending accounts may be absent when the Note is not Pending.

One batch is an exact finalized account cut. For multiple batches, use the
following explicitly different, sequence-stable capture rule:

1. Every response is finalized, has a context slot at least the first slot, and
   passes owner/layout/PDA checks. Repeated base data at the same slot must agree.
2. All responses must have identical TreeState sequence, root, next ID and
   outstanding principal, and identical immutable Pool parameters.
3. Under the monotonic sequence invariant, no financial change occurred between
   the minimum and maximum returned slots. Thus all returned Note/Pending data
   represents the same financial state. Different slots are not silently treated
   as one atomic RPC snapshot.
4. Select S as the maximum returned slot. Use mutable Pool fields, Vault amount
   and Clock from a batch at S. Pause/treasury and unsolicited token transfers
   need not increment sequence, so never reuse those values from an earlier batch.
5. Fetch S's transaction-free header once. Verify its hash/time and the Clock
   checks below. The verified financial state is published at S.

If any financial base field differs, discard the tentative capture and restart
from the first batch within the attempt/time bounds. Do not combine accounts
across differing sequences, chase historical snapshots, or repair via block
history. `minContextSlot` is a lower bound, not an exact-slot selector. A sustained
write rate can prevent a stable multi-batch capture; this mode becomes unavailable
and reports that condition. The PoC cost target below is for the one-batch case.

## Current-state verification

Reuse existing account decoding, canonical fields, `Note::leaf`, `Tree`, Pool
binding and build validators, extracting pure functions where currently tied to
replay. All checks use checked integer arithmetic and existing monetary limits.

| Input | Required checks |
|---|---|
| Pool | Exact owner/discriminator/layout/PDA; genesis, mint, token program, decimals, role keys, TTL/challenge/cap and circuit/build/profile bindings; use current pause/treasury |
| Tree | Exact owner/layout/PDA, canonical root, `N <= 2^32`, configured capacity, no sequence/N regression within the deployment |
| Note | Exactly one for each allocated ID, correct PDA/bump/ID/layout, valid commitment/deposit/expiry and status Active/Pending/Closed |
| Pending Note | Matching Pending PDA with `exists=true`, canonical nullifier/old_root, nondefault destination, balance within principal, valid deadline; no duplicate live nullifier |
| Other Note | Pending absent or valid retained record with `exists=false`; an active Pending with Active/Closed Note is an error |
| Tree reconstruction | Active leaves use existing `Note::leaf`; Pending and Closed leaves are zero; exact reconstructed root equals TreeState.root |
| Principal | Sum of Active and Pending deposits equals TreeState.outstanding_deposits, without overflow |
| Vault | Derived ATA, pinned SPL owner/mint/vault authority, supported token layout and amount at least outstanding principal |
| Time | Correct Clock sysvar identity/encoding, nonnegative Unix time, Clock.slot equals S in the selected batch, header blockTime agrees with that bank's Clock |

Root equality alone does not verify Pending completeness. All allocated Note
statuses must be inspected, including zero-leaf Notes. Reject missing accounts
instead of interpreting them as Closed. Closed Note IDs are never recycled.

Within one process, equal sequence and equal financial accounts permit reuse of
the constructed tree. Still inspect the fresh account response, reconcile all
financial fields, update time/current Pool/Vault values and serve a fresh cut.
Never reuse a previous successful read after an RPC failure. Sequence change
requires rebuilding the current state, not finding or counting intervening events.

## Deployment checks and recovery ordering

At startup and after endpoint/configuration changes, authenticate genesis and the
actual Program/ProgramData against the independently pinned build. Initially
support the pinned upgradeable loader, including an immutable deployment of it.
Verify loader ownership, executable flag, Program-to-ProgramData linkage, code,
deployment slot and authority. For the code comparison, skip the loader's 45-byte
ProgramData metadata, match the exact pinned ELF bytes, and require the remaining
allocated code bytes to be zero; bind both ELF length/hash and ProgramData length.
Reject unsupported loaders and mismatches.

Cache verified code bytes in memory. Only the acquisition owner performs periodic
identity reads: every 60 seconds, read Program/ProgramData metadata together with
`getMultipleAccounts` and a 45-byte prefix slice, checking owner/executable/linkage/
slot/authority/allocated-space metadata. Use finalized commitment and a minimum
slot at least the latest accepted account cut; reject older responses. This is
one request, not a full ELF download per poll. Any observed change fences the
process; do not automatically re-pin or approve even an upgrade back to the same
ELF. The authority trust assumption includes the interval between these checks.
Other idle daemons use the owner's identity-health result rather than repeating
this periodic read. Their startup and operation-specific checks are counted separately.

Read-only receipt/status recovery may run after genesis authentication. Before
any operation that signs a new on-chain attempt, prepares an upload replacement or can
broadcast saved bytes, require a successful deployment verification in this
process and a metadata check no older than five seconds. Reuse a recent check;
otherwise perform one. This gate applies to standalone recovery/cleanup commands
as well as the worker loop. It does not depend on successful history acquisition.
An identity fence permits read-only inspection, never a replacement signature or
rebroadcast. Keep an uncertain attempt Unknown until its normal terminal evidence.

## Shared view, freshness and scheduling

Define an explicit `VerifiedPoolState` containing deployment binding, N, sequence,
current Pool/Vault values, Active/Pending maps, current tree, slot/hash/Clock and
capture timing. Only current-state verification constructs it. Use a separate
constructor for the existing public ReadView; do not fabricate Indexer replay
coverage, old checkpoints or invocation positions.

Expose the complete bounded account capture and verification metadata over a
permissioned private Unix socket in v1 (owner-only directory, authorized service
user/group). The challenger independently runs the same
pure state checks on those bytes and uses the same trusted acquisition owner;
it does not add a second RPC observer. The internal record includes all batches,
slots and the selected header, so the multi-batch rule is verifiable. Bind records
to a schema version, policy, deployment and capture digest, reject unknown fields,
and validate decoded records again; a serialized `verified` flag grants no trust.
Transmit capture age using the local host's monotonic clock domain and invalidate
it across host restart; reading cached bytes cannot restart the freshness timer.
Do not expose this private record as a public root-only trust assertion. Existing public
path/snapshot encoders can be reused.

Use one in-flight refresh per Pool. HTTP, challenger and readiness requests join
it instead of spawning their own chain reads. Defaults are ten seconds between
completed idle refreshes and two seconds while an unexpired Pending or an Unknown
attempt needs attention. The challenger conveys that activity over the local
interface. Merely having an old inactive job does not pin the fast cadence.

An ordinary root/path request can use a successfully verified view captured within
five seconds; otherwise it joins/triggers one refresh, waiting at most 25 seconds.
A new challenge proof/send needs the same five-second fresh financial view plus
its normal validity/recovery gates. The shared refresh avoids a separate safety
poll per consumer. Financial state changes after a read remain possible; normal
on-chain root checks and exact-byte outcome recovery still apply.

Background health reads report local state and age; they make no RPC calls.
Any failed verification clears readiness immediately. A stalled worker, expired
30-second capture budget or last successful observation older than 30 seconds
also clears readiness. A same-slot repeat cannot refresh age indefinitely: require
Clock/header time within the configured chain-time freshness bound as well.

Enforce 10-second RPC deadlines, a 25-second capture attempt deadline, at most
three capture attempts per refresh and a 30-second total refresh deadline.
Whichever expires first wins. Count failed/429/time-out attempts. Retry only
read-only work; respect bounded Retry-After, apply backoff with jitter and skip
missed timer ticks. Do not launch catch-up bursts or an automatic history fallback.
Limit combined acquisition concurrency to four and bound decoded response bytes.

## Challenger jobs and durable state

The existing challenger still looks up permanent AUTH evidence by Pending
nullifier and verifies the original RP unchanged. Prepare the restoration proof
from current Note/Pending data and the current zero path with the existing prover.
No proof of prior buffer upload or escape transaction position is needed by that
proof. New transactions still use the existing upload/execute transport.

Replace history-position job identity with
`SHA256("zkapi-pending-job-v2" || 0x00 || genesis32 || program32 || pool32 || u32be(note_id) || nullifier32)`.
The permanent consumed exit nullifier distinguishes repeated escape generations.
Deadline, note commitment/principal/expiry, destination, balance and old root are
immutable recorded job attributes; a conflicting observation for the same key
fences discovery. Neither observation slot nor sequence is part of the job key.
Repeated polls and restarts therefore discover the same job exactly once.

Replace financial payload/checkpoint references with explicit `AccountCutRef`
records (deployment, slot, hash, sequence, Clock time). Obtain upload expiry and
fee/deadline inputs from that record, never from `archive_block_time`. Persist job
creation and its observation watermark atomically in the existing single-writer
journal machinery. Retain AUTH evidence, signed payloads, buffers, attempts and
Unknown recovery. Do not introduce another ledger or settlement state machine.

If a later view no longer has that Pending, stop creating new challenge steps for
the job and record the observation. This is not proof that an Unknown attempt
succeeded or failed; continue targeted receipt recovery and retain its exact
bytes. Missing Pending cannot authorize a new signature or erase an old attempt.

Use a new journal version for this fresh installation. The state cache is separate:
one replaceable bounded cache with deployment/policy/schema/hash bindings, written
by temporary file, fsync, atomic rename and directory fsync. It is disposable and
never restores readiness by itself. No append-only per-poll evidence archive or
history-sized accepted-block map is required. Financial journal loss still fences
the existing Pool; account snapshots cannot reconstruct off-chain authorizations.

## Control and remaining RPC consumers

Keep the existing ledger, signer and request-time dual-backend exit/Pending checks.
Do not replace them with a cached indexer snapshot. Group the account addresses
needed by one request into `getMultipleAccounts` per backend where possible;
preserve confirmed/finalized commitment and minimum-slot checks and backend
independence. A JSON-RPC batch is not assumed to cost one provider credit.

Remove unconditional chain startup probes from idle background recovery ticks.
Run endpoint/genesis/bootstrap verification on startup/config change; perform the
existing operation-specific fresh checks when real recovery/admission work exists.
Empty ledger recovery, metrics and local readiness reads make no Solana calls.
Explicit deep readiness may request one coalesced fresh view and existing backend
checks; give it a five-second cache and include it in the measured cost.

SDK and native clients retain deposit/receipt confirmation and exact transaction
recovery. Poll outstanding operations with bounded backoff rather than adding a
second global chain scanner. Measure their calls separately. No provider request,
funded inference, wallet transaction or new grant is part of validating this spec.

## Configuration and fresh setup

New indexer and challenger configurations require `config_version:2` and an
explicit `chain_state.mode="account_state_poc_v1"`. There is no implicit
legacy/full-history mode when these fields are absent. Keep existing
manifest/build/IDL pins, RPC credentials and private path conventions. The
following is the strict state-reader section, alongside those existing pins:

```json
{
  "config_version": 2,
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

Require idle interval 1–10, active interval 1–2 and at most the idle interval,
capacity 1–4096, concurrency 1–4, response limit 1–16 MiB, and chain-time age
30–120 seconds. A timestamp over five seconds in the future is rejected.
Use monotonic time for elapsed capture/freshness and a synchronized wall clock
for chain-time age/deadlines. The chain-time allowance includes finalization lag;
it does not extend the five-second local observation freshness requirement.

The 100-address batch bound, five-second fresh-view limit, 60-second metadata
cadence and time/retry bounds above are versioned constants in v1. Bound the
complete decoded capture/cache to 32 MiB; reject oversize evidence without
truncating it. N is lifetime allocated Note count, including Closed Notes.
Capacity exhaustion is an explicit unsupported-capacity result, not permission
to skip IDs or reset a Pool.

The challenger's `chain_state` object contains only `mode` and `state_socket`;
its remaining trust/ledger-reader/journal/prover/transport fields retain their
existing purposes. It uses its RPC only for deployment checks and
operation-specific transport/recovery. Control retains `indexer_origin` and its
two RPC backends; it does not need a second state-reader configuration.
Remove `start_slot`, archive batching, archive directories and history credit/repair configuration
from the new runtime path. Use the updated component README configuration examples.
The [setup guide](../getting-started/poc-state-sync.md) is the clean-install
contract; implementing this design does not require migrating an old installation.

## Cost and acceptance

Let C be refresh cycles, K the account batches per stable capture
(`max(1,ceil(N/48))`), I periodic identity checks, R retries and Q actual admission,
deep readiness, transport and recovery calls across all processes:

```text
sync calls   = C * (K + 1 header) + I + startup + R
billed total = C * (K*c_accounts + c_header) + I*c_identity + startup + retries + Q
```

There is no produced-block-rate term, no signature-page term and no backlog
proportional to downtime. Multi-batch retries and high account counts can still
dominate; reject unsupported scale rather than claim a universal fixed cost.

For a 31-day idle one-batch PoC at ten-second cadence and 60-second identity
checks, the upper-rate estimate is 535,680 account/header calls plus 44,640
identity calls: **580,320**, before startup, retries, clients and deep checks.
If all are one credit, that is 580,320 credits; if the light header is ten credits
and the other calls are one, it is **2,990,880**. These are models, not billed
observations. Account-based pricing or other provider weights must be included.

The offline idle acceptance target is at most 600,000 operator sync calls per
31-day equivalent for N <= 48, including routine identity checks and ordinary
background health. No other idle daemon may continuously poll Solana. Acceptance
also requires a strictly lower measured weighted cost than the same baseline
workload, including provider failures and all configured processes. Record the
provider-specific allowance/headroom before rollout; no fixed allowance fit is
asserted without those weights. The existing `scripts/rpc_budget.py` models the
old full reader and must not be presented as the new reader's estimate.

Use the existing secret-free RPC counters, adding method/purpose and response-byte
coverage for this path. Include targeted receipt calls, both Control backends and
SDK/native traffic in the deployment report. Alert on projected allowance pressure.
Do not introduce a daily history cutoff that disables the account reads required
for Pending protection. Ordinary traffic/admission can be shed while protection
and Unknown recovery continue within available provider capacity. Provider quota
exhaustion still causes unavailability and deadline escalation; do not buy credit,
switch trust sources or replay financial work automatically.

| Acceptance case | Required result |
|---|---|
| Empty Pool, cold start and restart with no archive | Current view becomes ready from accounts; zero history sync methods |
| Existing local SBF lifecycle cuts | Current root, paths, Active/Pending data and principal equal the full-replay reference; finality is synthetic |
| Pending omission with unchanged root | Inventory/status/principal checks reject; root-only acceptance prohibited |
| New Note; multiple operations between polls; unchanged-root finalize | Refresh current state correctly without acquiring intermediate transactions |
| Multi-batch writes, differing base fields, old response slots | No mixed financial view; bounded retry/unavailable; no history fallback |
| Stable sequence across different slots with pause/treasury/donation changes | Financial capture valid; mutable fields and Vault/Clock from maximum slot |
| Wrong owner/PDA/layout, missing allocated Note, live Pending on wrong status | Unavailable; no path/proof publication |
| Same Pending observed twice, restarted, or at a later sequence | One durable job and unchanged identity; no duplicate signing/send |
| Re-escape with a different nullifier | Distinct job; original attempts remain bound to their original job |
| Crash before/after journal fsync; cache missing/corrupt | Journal durability and Unknown semantics preserved; rebuild only disposable state |
| Program/authority change with a valid Unknown attempt | Observation-only recovery allowed; zero broadcast/replacement signing |
| Long downtime | Work depends on current account count, not elapsed blocks; currently Pending jobs resume; missed historical lifecycles are not invented |
| Many simultaneous HTTP/health/challenger requests | One refresh in flight; ordinary health makes zero additional RPC calls |
| Idle, active Pending, request load, 429/timeouts and restart | Exact method/byte counts, finite retries, backoff and whole-system weighted cost measured |
| Protection deadline | Full detection/read/proof/exact-byte-send path retains five-minute target and existing warning/page/emergency thresholds |

Use synthetic RPC fault fixtures, real local SBF/proof tests and separately labeled
read-only provider compatibility measurements. A design or structural-check pass
does not establish these results. No new paid inference or funded lifecycle is
required to implement and validate the local contract.

## Implementation boundaries

| Component | Change |
|---|---|
| Indexer runtime | Account acquisition owner, bounded sequence-stable batches, coalesced refresh and explicit current-state validator |
| Indexer tree/snapshot | Reuse tree/path/encoder code; construct views from verified current state without replay flags |
| Challenger scanner/runtime | Consume local verified state, discover current Pending, use AccountCutRef for proof timing |
| Challenger journal | New job/cut representation and journal version; retain existing atomic job/attempt persistence |
| Control | Remove idle chain probes; batch request checks while retaining dual-backend admission semantics |
| RPC metrics | Include every native purpose and weighted comparison; no secrets or request bodies |
| Configuration/setup | New strict configuration and fresh PoC state; no archive importer or compatible rollout bridge |

The legacy decoder/replay/projector can remain as offline reference/test utilities.
They are not prerequisites on the new runtime path. Implementation, local
acceptance and actual setup remain separate from this design edit.

Primary references checked 2026-10-20:

- [Ethereum filtered acquisition and state verification](https://github.com/ethereum/zkapi/blob/29624ba0cc790d2d8d1e5cc6bfb00edaedd96064/crates/zkapi-indexerd/src/poller.rs).
- [Solana getMultipleAccounts](https://solana.com/docs/rpc/http/getmultipleaccounts): up to 100 keys, context slot, data slices and minimum context slot.
- [Solana getBlock](https://solana.com/docs/rpc/http/getblock): transaction-free header requests.
