# Recovery and user-facing states

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
| `session` is present | Offer `recover()`/`settle()`; disable new sends |
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
