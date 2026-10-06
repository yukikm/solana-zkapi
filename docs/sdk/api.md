# Application SDK reference

Import `createZkApiClient` and types from `@zkapi/solana-sdk`. Browser apps normally
use `createBrowserClient` from `@zkapi/solana-sdk/browser`.
The [source types](../../packages/sdk/src/client.ts) are the exact contract.

## Factories

`createZkApiClient(options): Promise<ZkApiClient>` takes a deployment bundle,
`{store, key}` custody, an offline `ClientProver`, selected `V0Wallet`, stable
`noteId`, explicit `mode` and model configurations. It constructs the original
wallet, control, journal and session lifecycle. It validates manifest,
PoolConfig and artifacts; the prover runs the existing cryptographic verifier.
The factory provides no caller-supplied “always accept” verifier.

`createBrowserClient(options): Promise<{client, persistence, dispose}>` replaces `storage`
and `prover` with `storageName`, optional `initializeStorage`, `createWorker`,
WASM bytes and independent `wasmSha256`. Custody is scoped by app name, selected
account, deployment ID and pool. The installed worker is part of your trusted
app build. Disposal rejects while an action/response is active.
`persistence` reports `persistent`, `best_effort` or `unknown`; show the retention
warning described in [recovery](recovery.md) before funding.

Existing advanced hosts can use `new ZkApiClient(components)` with already
verified components. It is not a trust-checking factory: control, wallet,
store, prover and journal **must belong to the same deployment and note**.
Use the factory for new apps. No additional financial journal is created.

## Core methods

| Method | Behavior |
|---|---|
| `listModels()` | Detached configured IDs/labels/providers/APIs; not live discovery |
| `status()` | Local redacted wallet/session/balance/expiry read; no network mutation |
| `subscribe(listener)` | Initial status and local action-boundary updates; returns unsubscribe |
| `chat({operationId, model, messages, maxOutputTokens, stream?, signal?})` | Text Chat Completions; returns one-use `Response` |
| `request({operationId, model, api, body, anthropicVersion?, signal?})` | Native request; `api`: `chat`, `responses`, `messages` |
| `settle()` | Ask saved session to close; inspect status afterward |
| `recover()` | Reconcile/close saved AUTH; never replay inference |
| `cancelUnsentAuthorization()` | Cancel an AUTH proven locally never sent |
| `reconcileUnacceptedAuthorization()` | Verify permanent signed clearance for an uncertain AUTH with no observed acceptance or inference; archive it without replay or wallet signing |
| `reconcileAbsentOperations()` | Explicit terminal-session reconciliation with receipt/successor verification |
| `dispose()` | Disable new actions/observers; preserve journal and caller-owned dependencies |

Requests require a UUIDv4 `operationId`. Keep it with the user's send intent.
Duplicate recorded IDs are refused, including after settlement/restart. A new
ID is a new billable operation and must follow an explicit user action.
The response carries `X-Zkapi-Operation-Id`. Raw responses can have non-2xx
status; inspect `response.ok` or use the helpers. Do not log raw provider errors.

Native `body` omits `model`, selected separately. Supply `anthropicVersion` only
for Messages. The protocol supports text and client-executed tools, not arbitrary
media, hosted tools or persisted Responses. Shape validation remains with the
established adapters. There is no cross-provider conversion or mode fallback.

## Wallet methods

| Method | Behavior |
|---|---|
| `prepareDeposit(amountMicroUsdc)` | Save witness/prepare proof; no signing or sending |
| `prepareWithdrawal(destinationOwner, mode = 'mutual_close')` | Prepare mutual close or explicit `initiate_escape` |
| `prepareEmergencyEscape(destinationOwner)` | Preserve an unresolved session and prepare a challengeable escape from the last verified state |
| `reconcileChallengedEscape()` | Verify the exact escape receipt and authenticated chain restoration before restoring the archived session for settlement |
| `advanceWallet()` | One existing wallet sign/recovery step; returns transport result |
| `resumeWalletProof()` | Resume saved proof work |
| `retryRejectedWalletOperation()` | Explicit finalized-rejection recovery |
| `recoverExpiredWalletSetup()` | Create-only anchored-absence recovery, not unknown financial replacement |
| `fallbackToEscape()` | Explicit switch from unsigned blocked mutual close to escape |
| `prepareFinalizeEscape()` | Prepare after the chain-verified challenge deadline |

The facade uses the selected wallet for funding and all payer roles. Sponsored
or multiple-signer roles remain available through `WalletClient`. Methods do
not loop signature requests. Unknown compact sends remain observation-only on
later `advanceWallet()` calls; legacy buffers retain exact-byte retransmission
rules. No wallet recovery action sends inference.

## Status and errors

`settledBalanceMicroUsdc` is the last verified balance, not spendable capacity
during a session. `canRequest` also checks wallet state, pending work, clearance,
expiry and the cap. It does not guarantee availability or that a request fits
its cap. `lastSettlement.chargeMicroUsdc` is verified; do not bill from response
token counts or an answer on screen.

`canReconcileUnacceptedAuthorization` enables the explicit clearance action only
for an active note with an uncertain AUTH, no observed acceptance or inference,
and no wallet operation or local action in progress. It is a visibility hint;
the method rechecks the journal and verifies permanent signed clearance. Expiry
does not disable this recovery, and clearance does not enable new inference.

`emergencyEscape` exposes only the latest archive's phase (`escaping`,
`challenged`, `settled`). `canPrepareEmergencyEscape` and
`canReconcileChallengedEscape` are visibility hints for their explicit actions;
the wallet rechecks all durable and chain evidence. An unresolved escape archive
blocks new inference. The archive's original AUTH, inference bytes and state
remain private in the encrypted journal.

Status omits secrets, proofs, signed wire, prompts and keys. It is a snapshot;
call again for another tab's changes. Subscriptions are local notifications,
not network polling or cross-tab broadcasts. Observer exceptions do not interrupt work.

`ClientActionError.code`: `busy`, `not_ready`, `invalid_request`, `closed`.
Lower-layer errors retain their existing types. Do not retry based on exception
class: a transport failure can follow a successful send. Read status and select
a [recovery action](recovery.md). Lost response bodies cannot be reproduced.

## Text helpers

`readChatText(response): Promise<string>` accepts one text choice from JSON
Chat Completions, bounded to 4 MiB. Use native JSON for tool-only responses.

`readChatDeltas(response): AsyncGenerator<string>` accepts Chat Completions SSE,
handles split UTF-8/CRLF, comments and multiline data, and requires `[DONE]`.
Limits: 16 MiB total; 1 MiB buffered event text. Breaking iteration cancels the
body. Tool-call deltas need a native SSE consumer instead.

Both cancel unread data on errors. `ChatResponseError` exposes `code`, HTTP
`status` and `operationId` without raw provider text. Billing verification stays
with the signed settlement path, not these parsers.
