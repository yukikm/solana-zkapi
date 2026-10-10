# Recover a request or wallet operation

Use this guide after an interrupted response, pending settlement, wallet error
or daemon restart. Keep the same installation, deployment inputs, profile,
wallet and journal. The goal is to resolve the saved operation, not create a
replacement deposit or repeat inference. Normal funding and withdrawal commands
are in [clientd setup](clientd.md); SDK applications use the
[SDK section below](#sdk-and-browser-recovery-states).

## 1. Inspect clientd before acting

If needed, restart the original daemon using the [restart procedure](clientd.md#stop-restart-and-withdraw)
without `--initialize`. In a separate terminal, select its profile:

```sh
ZKAPI_PROFILE='/absolute/path/to/your-original-clientd-profile'
clientd request "$ZKAPI_PROFILE" status
```

Stop new application requests and finish or cancel active response bodies.
Wait until `in_flight` is zero before management actions. Record the unresolved
operation ID and inspect `phase`, `recovery_required`, `wallet_status`,
`wallet_operation` and `wallet_emergency_escape`. Do not print or share private
journals or credentials while collecting diagnostics.

## 2. Resume the right kind of work

| Observed state | Action |
|---|---|
| `wallet_status: "unfunded"`, no note created | There is no session to close; return to initial funding if intended |
| Interrupted inference or pending session after restart | Run the session recovery command below, then inspect status again |
| Completed responses with a session still active | Run `clientd request "$ZKAPI_PROFILE" close`, then inspect settlement |
| `wallet_operation` present | Continue that saved operation with `advance`; do not prepare a new deposit |
| Wallet result `proof_required` | Resume with `prove`, then continue with `advance` |
| Finalized rejected wallet operation | Inspect and resolve the rejection before explicitly using `retry-rejected` |
| Wallet result pending/unknown, missing history or expired blockhash | Keep the same operation; use its saved checks, without creating another signature/transaction |
| Storage, trust or custody failure prevents startup | Preserve files and original inputs; a fresh profile is not recovery |

For session recovery:

```sh
clientd request "$ZKAPI_PROFILE" recover
clientd request "$ZKAPI_PROFILE" status
```

Recovery may repeat the exact saved authorization to determine its result, but
never repeats inference. It can remain pending while operator services or usage
records are unavailable. A successful management HTTP response alone does not
mean settlement completed.

For an existing wallet operation:

```sh
printf '%s\n' '{"action":"advance"}' | clientd request "$ZKAPI_PROFILE" wallet
clientd request "$ZKAPI_PROFILE" status
```

If that saved operation requires proof generation, use this instead before its
next `advance`:

```sh
printf '%s\n' '{"action":"prove"}' | clientd request "$ZKAPI_PROFILE" wallet
clientd request "$ZKAPI_PROFILE" status
```

Inspect each result. Do not put financial recovery into an unconditional retry
loop. The SDK checks finalized history, exact signed bytes and actual accounts;
a timeout or missing account is not proof that the prior send failed.

## 3. Resolve exceptional states deliberately

The actions below are alternatives with different prerequisites. Choose only
the applicable action, save its JSON in an owner-only file outside the install,
and submit it as follows:

```sh
clientd request "$ZKAPI_PROFILE" wallet < /absolute/path/to/selected-recovery.json
clientd request "$ZKAPI_PROFILE" status
```

| Required condition | JSON wallet command |
|---|---|
| Exact finalized rejection, with its cause addressed | `{"action":"retry-rejected"}` |
| Only buffer creation/setup expired; definitive financial failure is not inferred | `{"action":"recover-expired-setup"}` |
| Expired unaccepted authorization needs verified permanent clearance before withdrawal | `{"action":"clear-unaccepted-auth"}` |
| Mutual withdrawal blocked before a financial signature and you explicitly choose escape | `{"action":"escape"}` |
| An existing escape was challenged; verify exact finalized restoration | `{"action":"reconcile-challenge"}` |

These commands enforce their preconditions and leave unresolved state intact
when verification fails. `clear-unaccepted-auth` does not submit a new AUTH,
inference or financial transaction. After verified clearance, use a separate
withdrawal action; that cleared note cannot start new inference.

When an accepted or uncertain inference prevents settlement and you explicitly
choose a challengeable exit, prepare an emergency escape. Save the following as
`selected-recovery.json`, replacing every public-key placeholder with your own
wallet's public address:

```json
{
  "action": "emergency-escape",
  "destination_owner": "WALLET_PUBLIC_KEY",
  "roles": {
    "payer": "WALLET_PUBLIC_KEY",
    "feePayer": "WALLET_PUBLIC_KEY",
    "uploader": "WALLET_PUBLIC_KEY",
    "rentPayer": "WALLET_PUBLIC_KEY",
    "tokenOwner": "WALLET_PUBLIC_KEY"
  }
}
```

Submit it once and continue its saved `prove`/`advance` steps. This preserves the
original session and last verified state; it does not cancel provider work or
claim settlement. The operator may challenge the escape. When the wallet is
`pending_escape`, wait for the SDK's chain-verified challenge deadline, then
prepare finalization with:

```json
{
  "action": "finalize",
  "roles": {
    "payer": "WALLET_PUBLIC_KEY",
    "feePayer": "WALLET_PUBLIC_KEY",
    "uploader": "WALLET_PUBLIC_KEY",
    "rentPayer": "WALLET_PUBLIC_KEY",
    "tokenOwner": "WALLET_PUBLIC_KEY"
  }
}
```

Save that command to a separate selected file, submit it through the same wallet
management route and advance its saved steps. An unresolved signed finalization
cannot be discarded after a challenge; use `reconcile-challenge` only when its
chain conditions can be verified. See the SDK explanations below for those
conditions.

Inspect both the finalized wallet state and `wallet_emergency_escape`. If an
emergency escape finalizes without a challenge, the wallet can be `closed` while
the emergency archive remains `escaping`. The current CLI cannot clear that
closed archive; `reconcile-challenge` requires a challenged escape and cannot
resolve this case. Preserve the original installation, profile and recovery
material, and obtain operator/developer review before replacing custody or
upgrading. Do not repeatedly invoke challenge reconciliation or delete the
archive. Funds withdrawn does not mean all recovery state is resolved.

For other completed lifecycles, success is the expected finalized wallet state
and no remaining unresolved session/emergency work. Preserve original recovery
material after closure. If the original passphrase/custody is lost, these
commands cannot recreate it from the chain.

## SDK and browser recovery states

Use the same browser origin/profile, storage name, account, deployment pins and
note ID after reload. Creation and `status()` never resume network operations.
Present saved work first; do not issue a fresh chat request in a startup effect.

| Observation | UI/action |
|---|---|
| `wallet: "empty"` | Offer explicit deposit preparation after custody initialization |
| `walletOperation` is present | Continue the saved wallet operation; do not create another deposit |
| `advanceWallet()` returns `pending` or `unknown` | Keep waiting/checking the same signature; do not infer failure from expiry |
| `proof_required` | Offer `resumeWalletProof()` |
| Finalized `rejected` | Review the error, then offer `retryRejectedWalletOperation()` |
| Create-only setup expired | `recoverExpiredWalletSetup()` checks exact history, anchored expiry and buffer absence |
| An unresolved `session` is present and `canRequest: false` | Offer `recover()`/`settle()`; disable new sends. A healthy reusable session with `canRequest: true` can accept another explicit request |
| AUTH prepared but never sent | Explicit `cancelUnsentAuthorization()` can discard it; possibly sent AUTH cannot be cancelled this way |
| `canReconcileUnacceptedAuthorization: true` | Offer `reconcileUnacceptedAuthorization()` to obtain and verify permanent signed clearance before a separate withdrawal action |
| `canPrepareEmergencyEscape: true` | Offer explicit `prepareEmergencyEscape(destinationOwner)` when the user chooses a challengeable exit despite unresolved session work |
| `canReconcileChallengedEscape: true` | Offer `reconcileChallengedEscape()` to verify chain restoration; absence or a missing response alone is insufficient |
| Terminal settlement has absent proxy operations | Explicit `reconcileAbsentOperations()` checks authenticated absence and original signed settlement |
| `canRequest: true` | Enable an explicit new Send action with a fresh operation ID |
| `pending_escape` | Wait for the chain-verified challenge deadline, then prepare/advance finalization |

`recover()` can repeat the exact saved authorization to resolve a lost response.
It never repeats inference. It may leave settlement pending if the operator is
unavailable, usage is unresolved, or signature verification fails. Show that
state; do not label a displayed AI response as verified payment.

An expired, possibly sent AUTH with no observed acceptance or inference can stay
unresolved after ordinary recovery. `reconcileUnacceptedAuthorization()` uses
the existing wallet clearance protocol under the same application/note locks.
Only verified permanent clearance can archive the exact saved AUTH and release
its pending slot; expiry, an unavailable server or a missing session cannot.
No AUTH, inference or transaction is sent by this action. A failed clearance
leaves the same pending authorization for an explicit retry. After success,
choose a withdrawal action; the cleared note cannot start new inference.

When accepted or uncertain inference prevents settlement, ordinary withdrawal
remains unavailable. `prepareEmergencyEscape(destinationOwner)` archives every
original authorization/inference byte and the last verified state before
preparing the existing escape wallet operation. It does not claim settlement or
cancel upstream work. Continue its saved wallet steps, then wait for the
chain-verified challenge deadline before finalizing. The operator can challenge
this escape with a valid successor state.

If challenged, `reconcileChallengedEscape()` checks the exact finalized escape
receipt and a later authenticated Active-note/absent-Pending account cut. Only
then does it restore the archived session for close/settlement recovery; that
recovery sends no new AUTH or inference. A verified successor settles the archive
and permits normal actions. Unknown execution or incomplete challenge evidence
keeps the financial fence. Expose `emergencyEscape.phase` and keep new sends
disabled while it is unresolved; never create replacement custody to bypass it.

The challenge check remains available if finalization was already prepared.
An unsigned finalization can be cancelled and retained in history after verified
challenge restoration. Every signed finalization must instead have a definitive
finalized rejection; an unknown, expired or successful attempt cannot be
discarded. The status hint only offers the check and never asserts that these
chain conditions are satisfied.

## Response handling

Always consume the returned body or call `response.body?.cancel()`. An unread
response holds the application's operation lock. To stop an in-flight request,
pass an `AbortSignal` and consume/cancel the resulting response. After interruption,
inspect SDK status. Cancelling display is not proof that the provider did no work.

Use the same operation ID when referring to an uncertain request. Its response
is not replayable. A new ID is an explicit new billable request, not recovery.
Avoid generic retry middleware around `chat()` or `request()`.

## Local request retention

SDK/native .7 never persist new direct inference bodies. For proxy operations,
only the unsent `prepared` phase retains the exact body needed for explicit
dispatch after reopen. Before any send, one atomic journal commit records
`send_unknown` and replaces the body with `bodyBase64: ""`, `bodyRedacted: true`.
If that commit fails, no request is sent. The transmitted bytes remain in memory. A SHA-256 fingerprint of the exact sent
bytes remains for independent acceptance checks; identical or guessable content
can be recognized from that fingerprint by someone who can decrypt the journal.
Every redacted operation is permanently non-replayable, regardless of phase.

Verified settlement also removes any remaining bodies from that session and its
matching emergency archive, including unsent proxy operations. IDs, phases, AUTH
bytes, receipts, signatures, balance and wallet transaction evidence remain.
The SDK does not separately journal response content.

Newly received direct provider keys stay in the current `ControlClient`'s memory
and are omitted from journal writes and new emergency-escape archives. Only a
successful durable session commit permits that in-memory key to be used. Close,
settlement and application disposal forget it. After restart, the SDK closes and
settles the same saved session without reviving a key or replaying inference.
OA verification evidence may persist, but it cannot replace a live verified key.

Earlier versions saved direct provider keys in encrypted pending sessions and
emergency archives. Those historical records remain readable without automatic
migration; their keys never authorize inference in a fresh client. Expiry or
revocation does not erase old local bytes. Existing backups may retain request
bodies and credentials. Control/proxy recovery credentials and financial evidence
remain encrypted in the journal.

Reading a legacy journal does not migrate it. To remove bodies from existing
settled history and its settled emergency copies, including their fingerprints, explicitly call
`await client.purgeSettledRequestBodies()` (application SDK) or
`await control.purgeSettledRequestBodies(noteId)` (low-level SDK). Native users can
run `clientd request /absolute/profile purge-settled-bodies`; it requires the
management token and accepts no request body. Results count history and
emergency operation copies whose body or fingerprint was erased separately. Repeating the call is harmless.

This operation keeps active pending requests and unresolved emergency archives,
including an unchallenged escape archive on a closed wallet. It does not erase
external backups, old ciphertext/filesystem snapshots, app transcripts or provider
copies. It never clears funds, recovery credentials or financial history.
Reloading, disposal and clearing displayed chat do not invoke it automatically.
Browser encryption does not hide data from app code running in the same origin
or a compromised device.

## Withdrawals and expiry

Mutual close uses signed permanent clearance and saves the destination before
wallet signing. If it is blocked before any financial signature, the user can
explicitly choose `fallbackToEscape()`. Standalone `initiate_escape` is also an
explicit withdrawal mode. The SDK verifies challenge deadlines before finalizing.

Render `status.expiry` and `privacyNotice`. The protocol warns at seven days and
one day before expiry. An expired Active note's full principal can move to the
treasury; balances do not remain available indefinitely. Do not hide expiry
behind an “account balance” label. See [protocol rules](../specs/protocol-solana.md).

This initial facade manages one stable local note ID. After a completed withdrawal,
the app may explicitly select a new local ID for a new deposit, retaining the old
journal. Never rotate IDs to escape unresolved operations.

## Storage failures

`BrowserStorageMissing` permits explicit first-time creation. Invalid keys,
ciphertext, rollback evidence or a missing key alongside existing records stop
work. They do not permit deleting storage. The browser keeps a nonextractable
AES key and ciphertext in the same origin/profile. This protects stored records,
not a compromised running app or whole-device rollback.

Explicit first-time storage initialization requests browser persistence once.
The browser factory returns `persistence`: `persistent`, `best_effort`, or
`unknown`. Reopening existing custody only checks its current grant. Show a
warning before funding when persistence is unavailable or unknown. A persistence
grant reduces automatic eviction risk; it does not protect against clearing site
data, losing the device, or losing the browser profile.

Portable backup/recovery UX is not provided by the new browser factory. The
advanced journal API requires separately retained custody and trusted checkpoints;
see [SDK internals](../../packages/sdk/INTERNALS.md). Do not clear site data or
switch origins while a note remains funded. A full-device deletion cannot be
detected by a new empty browser profile.

## Upgrade guidance

Use `await client.upgradePlan()` for local guidance, or the new offline helper to
inspect status exported by the original runtime. The plan never changes a
profile/custody binding, signs, withdraws or sends inference. Keep the original
installation until its pending operations and note are closed. Missing older
status fields remain unknown. Follow [the upgrade procedure](upgrading.md).
