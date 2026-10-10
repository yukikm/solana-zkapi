# Public Devnet acceptance and approved supplemental budget

Current scope — 2026-10-09 JST: the user directed completion of ZKAPI core and
stopped demo/chat UI work. **B-01–B-03 / PD-08 are deferred, not core completion
gates.** Existing browser state and failures remain preserved. The
[core evidence audit](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-core-scope-reconciliation.md) joins actual
public-input `.3` setup and production-handler rejection to the completed native
path. E-01 escape/finalize remains underway. The user selected
[OpenRouter Ethereum parity](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-ethereum-parity.md): captured
management USD after disable/grace, persisted before confirmed deletion, capped
immutable settlement, and operator risk for delayed costs. The runtime successor
is a candidate until actual deployment evidence exists. Final-invoice completeness
is not an extra core-preview gate; the observed discrepancy and broader G3 limits
remain explicit. No new reconciliation service, paid matrix, UI work or long-term
qualification is added. The [current checklist](public-devnet-readiness-backlog.md)
credits completed public-input installation, specific readiness reporting and
stream/price/funding guidance checks with their actual or local-test scope. The
latest retained primary-RPC429/indexer503 observation still blocks E-01 receipt
progress; no successful emergency payout or completed parity rollout is inferred.

Recorded 2026-10-07 JST; native closure checkpoint 2026-10-08 14:27 UTC.
**N-01–N-04 now have public native response, conversation, signed-settlement,
interrupted-recovery and finalized mutual-withdrawal evidence.** Four signed
charges total **20 micro-USDC**; the five-USDC Devnet note returned
**4,999,980 micro-USDC** and is closed. N-02/N-03's signed zero amounts match
the observed management counters, but their
[external provider-cost reconciliation remains unresolved](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openrouter-management-usage-limit.md).
This is not full billing acceptance. Funded B-01–B-03 are deferred under the
current scope; the separate zero-AUTH emergency escape/finalize exercise remains
incomplete.

The [separate seven-cap grant](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-detached-budget-initialization.md)
retained four reservations at the final native operator cut: **4,000,000
micro-USDC maximum exposure**, leaving three unused caps. Withdrawal and low
actual charges do not refund those reservations. Preserve every original
attempt and failure; none authorizes inference replay. Use the
[published client/profile pins](sdk/public-devnet-preview.md) and the recorded
release boundaries below. The selected AWS path remains
[the detached V2 authority](../deploy/public-devnet/detached-budget.md), with no
original-capacity transfer. On 2026-10-08 JST the
user approved the roughly USD50/month US East AWS configuration with generated
HTTPS; it supersedes the earlier USD100 proposal. Long-term capacity
qualification is outside this preview's current scope. The original browser and
native matrix below is retained as the authorized historical plan. The current
core queue is the narrower scope above; unused browser capacity does not become
permission for replacement requests. Local fixtures remain separate from live
provider acceptance.

## Recorded native results and remaining scope

| Case | Recorded result | Scope boundary |
|---|---|---|
| [N-01](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N01.md) | Stock public transport, compact deposit, nonstreaming Chat and verified six-micro-USDC settlement | Immutable `.2` native client; its earlier active-note checkpoint is preserved |
| [N-02/N-03](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md) | Actual OpenClaw streamed read-tool exchange and continuation; two distinct AUTHs and verified metered-zero settlements | Running `.3` with the explicit local settlement scheduling adapter; external billing reconciliation remains open |
| [N-04 and final closure](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N04.md) | Process-group kill during an unresolved stream, same-journal `.3` restart, one explicit recovery, 14-micro-USDC settlement and finalized withdrawal | Compatible retained `.2` command/observer tools were separately pinned; upstream packet counts remain unknown |

The final independent chain cut matched all six exact transaction wires and
signatures, closed the note and found Vault zero. Wallet and treasury share an
owner, so the restored wallet balance does not erase the 20-micro-USDC charge.
The operator cut retained four settled sessions and all 25 checkpoint rows.
These observations do not claim another platform, provider/API or funded
browser path.

[Service suspension, capture, same-state restart and resume](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-service-recovery.md)
preserved the earlier one-session N-01 cut. Subsequent
[independent backup verification](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-backup-independent-verify.md)
checked the exact downloaded encrypted archive and restored its logical
PostgreSQL state in an isolated PG16 instance. That backup predates N-02–N-04;
it is not a physical service or latest-four-session restoration. Current
aggregate readiness deployment is recorded separately and is not inferred
from these historical results. Mutual closure does not substitute for emergency
escape/finalize.

## Preserved campaign and read-only observation

The authoritative existing campaign was read directly and validated with
`DemoBudget.load()` without invoking its constructor, acquiring/creating a lock,
initializing state or reserving capacity. File hashes before and after that read
were identical. Only aggregate values and hashes are recorded here; reservation
UUIDs, AUTH hashes, credentials and journals are not reproduced.

| Existing campaign fact | Observed value |
|---|---|
| Authorized ceiling | 10,000,000 micro-USDC |
| Retained reservations | 17 |
| Reserved maximum | 9,154,216 micro-USDC |
| Remaining monetary capacity | 845,784 micro-USDC |
| Original request ceiling | 18 |
| Remaining request slots | 1 |
| Canonical original plan SHA-256 | `50f3f10040671f27ecd2ff59db3d3d6474a58de67bb0cf38e7a2cd41d7577167` |
| Original identity file SHA-256 | `9780016f4d9858225194c14f5b72259b3847269bdefe2db0b30937a131ed5668` |
| Current original state file SHA-256 | `513d46d07ac617d07e9620f3aac1d1809a8f5474cb22e442e46481f9055a2e29` |

The public gateway candidate requires the existing one-USDC cap: each new direct
AUTH consumes a **1,000,000-micro-USDC reservation before forwarding**. The
remaining 845,784 cannot admit one such AUTH. A small expected prompt charge
does not change that bound. Historical successful charges, waived receipts,
failed issuance, unused capacity inside an issued key, and returned Devnet
deposits do not refund a reservation.

The original [plan](../config/provider-acceptance.i10.json) has two direct
OpenRouter Chat templates, plain and SSE, both with `tools: false`, a one-USDC
maximum, 128 output tokens and a recorded 300-second test session setting.
The current gateway/client path requests a 60-second session. A new acceptance
record must describe its actual 60-second configuration and any tool use;
reusing an old template must not relabel either fact. The original tariffs
expire before 2026-10-11 UTC. Execution must independently confirm current
model access, provider terms/prices and tariff validity, then freeze the chosen
profile; an expired tariff is not patched into an initialized old campaign.

## Original preconditions before the first reservation

These requirements are retained as the original execution plan. The results
above identify the completed native path; they do not establish the remaining
funded browser path or current service availability.

1. Publish anonymously retrievable, immutable complete assets and a profile with
   an independently authenticated digest. Verify every downloaded hash and
   generate real matching WASM/native proofs. The four inherited setup files'
   exact-hash redistribution review is resolved; the complete bundle now retains
   the reviewed notices, and six fresh matching native/WASM proofs passed
   [local independent verification](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-complete-bundle-proofs.md).
   Verify the actual published bytes and selected deployment joins; those local
   checks do not establish anonymous public downloads or real browser execution.
2. Operate the selected HTTPS gateway/control/indexer/provider path with durable
   database and signer state, a named operator, explicit subsidy owner,
   invitations, request limits, maintenance policy and recovery availability.
   Verify actual finalized program bytes, upgrade authority and Pool against
   reviewed deployment receipts. Preserve existing private services and notes.
3. Select one concrete Chat model and the same explicit direct OpenRouter mode
   for this matrix. Declare streaming and tools only if the actual provider and
   client subset support them. Recheck issuer permissions/credit; an ordinary
   inference credential alone does not prove restricted-key issuance rights.
4. Freeze the actual SDK/native archive, profile, bundle, WASM/prover and tariff
   hashes. Install in an independent browser app and a clean native installation.
   Use Chrome with the explicitly selected Phantom account for the browser;
   respect any browser security block rather than disabling or bypassing it.
5. Match the received seven-USDC approval to the exact supplemental authorization
   record and review its offline failure/concurrency results. Freeze actual
   public pins and the selected single authority before grant initialization.
   Default public admission stays suspended until these conditions hold.

## Original deliberate-operation matrix

B-01–B-03 are now deferred. Keep their original plan and budget accounting below;
do not execute them to satisfy the core-only completion request.

The generated native configuration uses `key_reuse_seconds: 0`; the application
SDK also closes each request's session. Therefore **each deliberately dispatched
inference requires a new full-cap AUTH**, including each half of a tool
roundtrip. Historical OpenClaw's two requests under one reused key do not reduce
this candidate's reservation count. All requests use stable distinct operation
UUIDs, bounded outputs (at most 128 tokens for this proposal), disabled automatic
inference retries and disabled model/privacy fallbacks.

Historical campaign configuration: direct OpenRouter settlement used a
60-second grace after key disable. The subsequent user-selected Ethereum-parity
candidate uses a 5-second configured grace and one durable usage capture; its
actual rollout is recorded separately. The following describes the original
60-second campaign behavior. Historical zero-reuse runtimes return a conflict when a new request
arrives while the prior session remains pending. The new candidate helper opts
into a bounded `settlement_wait_ms: 120000` admission wait: only a successfully
consumed same-process response qualifies; existing status/close/receipt checks
must verify its signed settlement before the new request's first AUTH/inference.
Unknown/canceled responses, restarts, errors and the deadline preserve explicit
recovery. The old defaults and journal protocol remain unchanged. The original
N-02/N-03 precondition required verifying response consumption through EOF and
the wait plus proof preparation; a client that cancels immediately on an SSE
terminal event may still hit the recovery gate. That original campaign did not authorize an implicit grace change or inference
retry; the later explicit parity instruction is recorded separately. A positive-key-reuse
configuration would be a separately reviewed policy; the seven-cap count here
preserves zero reuse. Local synthetic wait tests are not live client acceptance.

The actual N-01 final settlement completed about 180 seconds after response
completion. The configured 60-second grace is not the total close duration, and
the released native 120-second next-operation wait is unchanged. N-02/N-03
therefore use the explicitly documented
[local settlement scheduling adapter](integrations/openclaw-settlement-adapter.md)
before the stock native endpoint. It holds the second input until authenticated
SDK status verifies completion of the first, with no inference retry. Its local
checks are recorded separately in the
[adapter evidence](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-openclaw-settlement-adapter.md). The
[actual N-02/N-03 result](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md) used that adapter
and completed the read-tool exchange; it does not establish immediate
unmediated continuation to the stock native port. The public egress and
seven-cap matrix were retained, and the separately authenticated `.3` runtime
upgrade preserved the funded profile, custody and journal.

Use one new note per client path and retain each note through its complete
lifecycle. With cap `C`, funding `(planned AUTHs + 1) × C` test micro-USDC leaves
one full-cap remainder even if every session consumes its entire cap. This means
4 test USDC for the three-case browser note and 5 test USDC for the four-case
native tools note. These are Circle **Devnet** token deposits, separate from the
real-provider reservation and from SOL fees/rent. Verify mint, decimals,
recipient and balances before signing; return the actual independently verified
remainder, which may differ from the worst-case illustration.

| Case | Actual client and action | New full-cap AUTHs | Acceptance evidence |
|---|---|---:|---|
| B-01 | Independent app, real Chrome/Phantom and published WASM: deposit, intentional nonstreaming Chat turn | 1 | Real provider JSON text; SDK-verified non-waived metered settlement; finalized deposit and receipt accounting |
| B-02 | Same note: second intentional turn containing B-01's assistant context; consume Chat SSE to completion | 1 | Actual streamed deltas, terminal usage/finish, verified settlement, explicit context linkage without publishing private prompts |
| B-03 | Same note: deliberate streamed request; terminate the page/process after observed inference dispatch and before settlement, then reopen the same origin/storage/note/profile and explicitly recover | 1 | Durable unresolved operation before interruption; original operation remains identified after reopening; no inference replay; verified eventual settlement or preserved unresolved failure; mutual withdrawal and independent final balance |
| N-01 | Independently installed candidate, stock supervisor/Go egress/public HTTPS: deposit and deliberate nonstreaming Chat through local API | 1 | No hidden acceptance relay, modified runtime or disabled TLS; real JSON response, verified metered settlement and actual native proof/chain evidence |
| N-02 | Same native note: actual pinned OpenClaw, one explicitly allowed local file-read tool, streamed tool request | 1 | Real provider tool call; exactly the intended harmless local read; explicit configured tool schema and provider/client version |
| N-03 | Same tool exchange: actual OpenClaw submits the read result in a separate streamed continuation | 1 | Real continuation and terminal usage; second distinct operation and AUTH under zero key reuse; both signed settlements verified |
| N-04 | Same native note: deliberate streamed request; terminate clientd after dispatch/before settlement, restart the same installed stock supervisor/custody/journal and explicitly recover | 1 | Actual clientd process restart, retained unresolved identity, no inferred replay permission, no inference replay, verified settlement/cleanup, native mutual withdrawal and independent final balance |

The full browser-plus-native-tools proposal needs **7 new AUTH reservations =
7,000,000 micro-USDC**. This is a worst-case exposure allowance, not a provider
spend estimate, expected charge or a target amount to spend.

If tools are not advertised or cannot be supported, omit N-02/N-03 and substitute
one streamed **text-only** native/OpenClaw turn with tools explicitly disabled.
That branch needs **6 new AUTH reservations = 6,000,000 micro-USDC** across both
clients and must not claim tool compatibility. Verify beforehand that the chosen
OpenClaw configuration sends no disallowed tool fields; otherwise its native
client compatibility remains blocked rather than silently substituting a mock.
If SSE itself cannot pass live acceptance, do not advertise streaming or call
this matrix complete; revise the scoped preview and its approval explicitly.

A clearly browser-only preview can execute B-01 through B-03 with **3 new full
caps = 3,000,000 micro-USDC**, while PD-09 remains open. This is a smaller product
scope, not completion of the requested browser-plus-native acceptance.

## Interruption, failures and zero-additional-reservation checks

Both interruption cases target an observed send followed by a durable unresolved
operation, before a verified signed settlement. A graceful stream cancellation
or restart after settlement is useful evidence but does not substitute for that
boundary. If timing misses the boundary, retain the failed observation and do
not automatically issue another request to obtain a better result.

Recovery may resend only the exact saved AUTH under the existing protocol when
applicable; it never regenerates the inference operation. Count distinct AUTH
identities, observed AUTH HTTP packets, intentional inference operations,
observed provider dispatches and exact-signature transaction resends separately.
If an independent packet count is unavailable, report it as unknown rather than
derive it from UUID counts. Keep raw credentials, provider keys, prompts,
responses and private journals out of public reports.

The following checks add **zero planned provider reservations**:

- Wrong/missing invitation, unsupported model/API/capability, empty note or
  insufficient balance fails before new AUTH reservation. Check invitation
  refusal with controlled valid test inputs; do not run an uncontrolled flood.
- Suspended/exhausted new admission blocks new work while an exact previously
  reserved AUTH and applicable status/settlement/withdrawal remain available.
  Reserve capacity already consumed by a failed AUTH stays consumed.
- Browser and native reload/backup-identity checks preserve original profile
  pins, custody and journal. Missing keys or replaced pins fail closed.
- Finalized withdrawal/receipt collection, indexer catch-up, service outage and
  same-ledger/signer-journal restart observations perform no new inference.
- PD-10 emergency escape/finalize may be exercised on the retained note using
  its existing session/state where possible. Additional wallet transactions
  still need SOL and must be separately recorded. A challenge-specific case
  needing another fresh AUTH is outside these seven caps and needs a separately
  approved addition; mutual withdrawal alone is not emergency readiness.

Never automatically replace a failed paid case, switch provider/model, start a
new note, shrink the cap, refund a reservation or reset state to finish the
matrix. The seven-case allowance has **no automatic retry contingency**. Stop
new admission on uncertainty or exhausted capacity, retain recovery, and report
the exact unfinished case for the next deliberate decision.

## Selected AWS authority: detached V2

The selected AWS implementation is
[`supplemental-detached-v2`](../deploy/public-devnet/detached-budget.md).
It initializes one **new seven-cap authority** after final pin review and leaves
the original local ledger, services, signer state and recovery paths unchanged.
The existing original helpers have no budget top-up API: editing their plan,
cap/count or rows, creating another ten-USDC campaign, or resetting a ledger
would not implement the received approval.

The V2 workflow is:

1. Immediately before final deployment review, explicitly export the original
   ledger under its existing lock. The exporter reads original plan/identity/
   state bytes and creates no original files. Install the exact reviewed
   snapshot on AWS as a root-owned read-only file under protected ancestors.
   The non-root runtime cannot modify or initialize that snapshot.
2. Record one unique grant UUID, the existing seven-USDC approval reference/date,
   exact snapshot and original anchors, selected fresh deployment/profile,
   release/bundle/tariff/model pins, cap 1,000,000, TTL 60 seconds and output limit
   128. Bind one new canonical host/volume directory and its existing lock
   identity. Validate the exact authorization bytes and independently install
   their digest. No actual snapshot export or grant initialization occurred in
   the local implementation tests.
3. Initialize the new grant once. Its permanent marker precedes the single-grant
   index and reservation ledger; partial initialization, additional grants,
   changed identity or an occupied authority refuses reset. Gateway startup
   never initializes a grant and its adapter can invoke only status/reserve.
4. Reserve one full cap under the new lock and fsync files/directories before
   acknowledging AUTH. The grant has exactly seven slots and never refunds one
   for failure, cancellation, low actual usage or withdrawal. An uncertain
   persistence result permits no forward; exact current-grant recovery re-syncs
   the same consumed reservation without authorizing inference replay.
5. Reject every historical snapshot UUID/AUTH-hash match, including exact old
   AUTH recovery. Those requests belong to the original authority. Only exact
   AUTHs already recorded in the new grant may recover there during suspension
   or without an invitation. The gateway additionally verifies the selected
   deployment ID, Pool, signed quote, tariff and cap before reservation.
6. Report only active V2 capacity: **7,000,000 micro-USDC, at most seven new
   reservations**, with history explicitly labeled a non-live snapshot and zero
   original capacity transferred. Do not expose private rows or represent the
   frozen original checkpoint as a live combined balance.

The original 10-USDC authorization plus the new 7-USDC authorization amounts to
**17 USDC of human-approved ceilings across two separate authorities**. That
arithmetic is not a live ledger aggregate and does not make the old 845,784
available to AWS. If the original snapshot remains unchanged and all seven new
slots are consumed, independently collected records would show 17 original rows
plus seven new rows and 9,154,216 plus 7,000,000 micro-USDC reserved. Future
original lower-cap admissions may change its actual totals; final accounting
must collect and label both observations rather than assume the snapshot is
current.

Snapshot collision checks cover only the captured original rows. They do not
provide live cross-authority deduplication, distributed fencing, remote clone
detection or safe stale-backup promotion. Use fresh reviewed deployment/Pool
pins, distinct operation UUIDs, one recorded grant and one selected writer.
Changed lock/inode identities fail closed; restore requires explicit consumed-
capacity reconciliation. A new budget never authorizes a second writer for an
existing funded Pool or cloning its private financial service state.

[Local validation](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-detached-budget-local.md) passed 35 provider-budget
tests, including 14 detached tests, plus four V1/V2 gateway boundary fixtures and
strict gateway TypeScript checks. The fixtures establish preservation, exact
recovery rules, count limits, collision rejection, partial-initialization
refusal, uncertain-fsync behavior and concurrency using synthetic ledgers.
Later [hosted admission](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-public-admission-recovery.md),
[same-state service recovery](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-N01-service-recovery.md), and
[native interrupted recovery](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N04.md) provide their
separate actual scopes. Selected client archive pins and the output limit are
reviewed acceptance records; AUTH cannot remotely attest the client's binary
or inspect its private direct-provider body.

## Earlier local alternative: V1 under the original campaign lock

[`supplemental-v1`](../deploy/public-devnet/supplemental-budget.md) is the earlier
implemented local alternative, **not the selected AWS configuration**. Its
constructor creates no campaign/lock. It binds the original path/device/inode,
freezes exact original plan/identity/state hashes and adds one supplemental grant
under `extensions/<grant-digest>/` using the existing campaign flock. Its index,
identity and full-cap reservations remain durable and exact old direct AUTHs
can recover under that same local authority. A subsequent original-state change
stops V1 for reconciliation; original helpers are not silently made grant-aware.

V1 status sums the frozen original and local supplemental records, while new
availability uses only the supplemental slots. Those local aggregate semantics
and cross-ledger recovery rules do **not** apply to detached V2. Copying a V1
campaign to AWS is not an implemented authority migration and must not be used
to obtain capacity.

The received seven-USDC approval is for **one selected grant**, so never
initialize both V1 and V2, another V2 directory, or a replacement grant to finish
failed cases. Six-cap text-only and three-cap browser-only scopes above describe
possible reduced acceptance plans, not additional grants or permission to
initialize another authority. Neither version transfers the original remainder,
and no rollover mechanism authorizes reassigning it today.

## Concrete approval and completion record

The received approval is: **up to seven additional one-USDC AUTH reservations
(7 USDC total supplemental worst-case provider exposure, using the existing
1 USD = 1 USDC test accounting assumption), for B-01 through B-03 and N-01
through N-04, with no automatic replacement requests, preserving the original
ten-USDC campaign and all its reservations**. The selected grant is initialized;
the 14:27 UTC native cut records four consumed caps and 20 micro-USDC of signed
charges, with the external-cost limitation above. This approval does not provide
unlimited public subsidy, replacement paid cases or broader provider/client
combinations. The separately approved hosting scope remains roughly USD50/month.

After the matrix, publish exact client/profile/artifact/source identities,
deliberate versus observed send counts, redacted SDK receipt verification,
per-case timings and failures, actual finalized signatures/slots/CU/wire bytes,
deposit/return accounting and separately timed original/new grant observations.
Any combined accounting must be labeled as arithmetic over those observations,
not live aggregate capacity reported by V2. Link the operator restart/emergency
exercise separately. Mark core PD-09/10 items complete only for the supported
evidence and current contract. Keep PD-08 explicitly deferred rather than checked
complete; preserve every untested combination, financial accounting limitation
and historical CI/release-gate boundary.
