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
| Terminal settlement has absent proxy operations | Explicit `reconcileAbsentOperations()` checks authenticated absence and original signed settlement |
| `canRequest: true` | Enable an explicit new Send action with a fresh operation ID |
| `pending_escape` | Wait for the chain-verified challenge deadline, then prepare/advance finalization |

`recover()` can repeat the exact saved authorization to resolve a lost response.
It never repeats inference. It may leave settlement pending if the operator is
unavailable, usage is unresolved, or signature verification fails. Show that
state; do not label a displayed AI response as verified payment.

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

Portable backup/recovery UX is not provided by the new browser factory. The
advanced journal API requires separately retained custody and trusted checkpoints;
see [SDK internals](../../packages/sdk/INTERNALS.md). Do not clear site data or
switch origins while a note remains funded. A full-device deletion cannot be
detected by a new empty browser profile.
