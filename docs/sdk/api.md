# Application SDK reference

Import `createZkApiClient` and types from `@zkapi/solana-sdk`. Browser apps normally
use `createBrowserClient` from `@zkapi/solana-sdk/browser`.
This reference describes SDK `.8`; the [source types](../../packages/sdk/src/client.ts)
are the exact contract. Older clients retain their release-specific behavior.

`ClientDeployment.connection` is a native Kit `Rpc<SolanaRpcApi>`. `V0Wallet`
keeps the `publicKey` property name but its value is a Kit `Address` string;
`signTransaction` accepts and returns a Kit `Transaction`. See
[Kit migration](../getting-started/sdk-migration.md) for code and asynchronous lower-level APIs.

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
warning described in [recovery](../getting-started/recovery.md) before funding.

Existing advanced hosts can use `new ZkApiClient(components)` with already
verified components. It is not a trust-checking factory: control, wallet,
store, prover and journal **must belong to the same deployment and note**.
Use the factory for new apps. No additional financial journal is created.

## Core methods

| Method | Behavior |
|---|---|
| `listModels()` | Detached configured IDs/labels/providers/APIs; not live discovery |
| `status()` | Local redacted wallet/session/balance/expiry read; no network mutation |
| `upgradePlan()` | Local guidance for a separate installation; blocks pending recovery and unclosed notes |
| `checkModelAvailability(signal?)` | Explicit keyless ZDR metadata check through the installed transport; no inference |
| `subscribe(listener)` | Initial status and local action-boundary updates; returns unsubscribe |
| `chat({operationId, sessionId?, model, messages, maxOutputTokens, stream?, signal?})` | Text Chat Completions; returns one-use `Response` |
| `request({operationId, sessionId?, model, api, body, anthropicVersion?, signal?})` | Native request; `api`: `chat`, `responses`, `messages` |
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

## Direct-session reuse

`keyReuseSeconds` is optional: direct mode defaults to a 300-second lease with
90 seconds reserved for renewal; explicit 1–300 selects a fixed window and 0
closes each request. Proxy mode defaults to 0. Reuse never extends the original
expiry and never restores a provider key from storage. This policy has been
included since `.6`; `.3` retains per-request settlement.

`sessionId` scopes a direct lease to a local conversation (1–160 characters;
default `default`). Another conversation must settle the current lease first.
Model switches can reuse a lease only with the same tariff; a changed tariff
requires settlement and fresh authorization. Successful responses keep the key
until its fixed expiry; cancellation, stream errors and non-2xx responses retire
it. Renewal waits up to 45 seconds for verified settlement before sending the
new operation.
It never resubmits an old inference. Idle settlement runs only for a session
owned by the current client, waits for active responses and stops on disposal.
Reopened clients require explicit recovery. Initialization/status remain
read-only. Call `settle()` and inspect status before disposal if immediate
retirement is required.

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

`settledBalanceMicroUsdc` is the last verified balance; active usage is deducted
at settlement. `canRequest` allows a current-client reusable direct session or
its verified renewal path, and checks wallet state, pending work, clearance,
expiry and the cap. It does not guarantee availability or that a request fits
its cap. `lastSettlement.chargeMicroUsdc` is verified; do not bill from response
token counts or an answer on screen.
An active `status.session` alone is not a recovery condition; use `canRequest`
for the Send control and show settlement separately from response completion.

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
a [recovery action](../getting-started/recovery.md). Lost response bodies cannot be reproduced.

## Text helpers

`readChatText(response): Promise<string>` accepts one text choice from JSON
Chat Completions with a recognized text finish reason, bounded to 4 MiB. Use
native JSON for tool responses, including tool calls accompanied by text.

`readChatDeltas(response): AsyncGenerator<string>` accepts Chat Completions SSE,
handles split UTF-8/CRLF, comments and multiline data, and requires a terminal
text choice followed by `[DONE]`. Bare `[DONE]`, tool-call deltas, unknown finish
reasons and further choices after termination are rejected.
Limits: 16 MiB total; 1 MiB buffered event text. Breaking iteration cancels the
body. Tool-call deltas need a native SSE consumer instead.

Both cancel unread data on errors. `ChatResponseError` exposes `code`, HTTP
`status` and `operationId` without raw provider text. Billing verification stays
with the signed settlement path, not these parsers.

## Local request-body erasure (.7)

`await client.purgeSettledRequestBodies()` removes inference bodies and fingerprints from
settled history and settled emergency copies, preserving financial and recovery
evidence. It returns `{historyOperations, emergencyOperations}` and performs no
network or wallet action. Active requests and unresolved escape archives remain.
See [retention and backup limitations](../getting-started/recovery.md#local-request-retention).
