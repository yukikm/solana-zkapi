# Build your first integration

This guide targets a browser app with a Wallet Standard wallet. It is a
development preview: you need an operator-supplied, reviewed deployment bundle.
No supported public production bundle or npm release is advertised yet.

## 1. Install the SDK in your own repository

Obtain an independently reviewed `zkapi-solana-sdk-0.2.0-devnet.2.tgz` and verify its
published SHA256 through your trusted distribution channel. Then install it in
your application with Node 24.19.0/npm 11.9.0:

```sh
npm install --save-exact /absolute/path/zkapi-solana-sdk-0.2.0-devnet.2.tgz @solana/kit@8.4.0
```

The package contains compiled ES modules and TypeScript declarations. No source
checkout or demo UI is required. Keep the tarball in your artifact store or
repository when using a file dependency so a clean install can retrieve it.
For upgrades, read the [native Kit migration guide](kit-migration.md).
See [building and checking the distribution](../../packages/sdk/DISTRIBUTION.md).
Bundle `@zkapi/solana-sdk/prover-worker` as a browser module worker; public proof
artifacts and the independently pinned WASM are separate deployment inputs.

The [separate reference application](https://github.com/yukikm/solana-zkapi-client) has
complete integration and build instructions. Provider secrets stay with the
operator; the browser does not need the operator's API key.

## 2. Configure the deployment once

The released `0.2.0-devnet.2` preview offers a
[public-profile loader and read-only preflight](public-profile.md) that supplies
these inputs from one authenticated profile. The
[independent consumer](../../tools/public-devnet-consumer/README.md) shows durable
profile binding, browser integration and native input generation. Use the
[current public deployment](public-devnet-preview.md) for its authenticated
profile and availability status. Explicit deployment inputs are described below
for application maintainers and self-hosted operators.

Your app supplies a `ClientDeployment`: raw manifest bytes, an independently
installed trust policy, public proof/IDL artifacts, an Kit `Rpc<SolanaRpcApi>` and an
indexer origin. The [deployment guide](deployment.md) explains every input and
the example loader. End users do not enter these pins.

Select a Wallet Standard wallet and connected account in your UI, then adapt
that exact account. Do not automatically select the first installed wallet.

```ts
import { createSolanaRpc } from '@solana/kit';
import { createBrowserClient, walletStandardAdapter } from '@zkapi/solana-sdk/browser';

// rpcUrl is a reviewed browser-safe endpoint; no wallet/provider secrets.
const connection = createSolanaRpc(rpcUrl);
const wallet = walletStandardAdapter(selectedWallet, selectedAccount, 'solana:devnet');
const { client, dispose } = await createBrowserClient({
  deployment: { ...deployment, connection }, // reviewed pins and assets
  wallet,
  noteId: 'primary',          // keep stable across reloads
  storageName: 'my-chat-v1',   // keep the browser origin and this name stable
  mode: 'proxy',              // explicit privacy choice
  models,                    // IDs, APIs and manifest-pinned tariffs
  createWorker: () => new Worker('/zkapi/worker.js', { type: 'module' }),
  wasm,
  wasmSha256,                // independently installed WASM hash
  // initializeStorage: true // ONLY for an explicit new-storage action
});
```

On a first visit, the default throws `BrowserStorageMissing`. Offer “Create
wallet storage” and call again with `initializeStorage: true`. Normal reload
omits it. Missing keys with existing ciphertext or invalid keys are errors,
never reset requests. A changed account has separate storage. This is custody
in one browser origin/profile, not a portable backup.

Initialization checks configuration and chain state without transaction
signatures, AUTH submission or automatic recovery of pending work.

## 3. Fund and show progress

```ts
const unsubscribe = client.subscribe(status => renderWallet(status));
await client.prepareDeposit('2000000'); // 2 USDC, prepare only
const progress = await client.advanceWallet(); // one sign/recovery step
```

Call `advanceWallet()` from your continue/check action until it returns
`{ state: 'complete' }`. It may request a signature, check a saved receipt or
advance an upload. `pending` and `unknown` are not finalized funding.
`proof_required` needs `resumeWalletProof()`; `rejected` requires review before
`retryRejectedWalletOperation()`. See [recovery](recovery.md).

Compact-enabled deployments can use one deposit signature. Older deployments
use several buffer transactions. The authenticated deployment selects this;
your app must not promise one signature for every deployment.

Only enable Send when `status.canRequest` is true. The note must cover the
authorization cap **after** previous charges; depositing exactly the cap can
make a second request unavailable after the first paid request. For the demo's
1-USDC cap, 2 USDC leaves headroom. Read the configured cap rather than treating
these example amounts as universal requirements.

## 4. Send text or stream it

```ts
import { readChatText, readChatDeltas } from '@zkapi/solana-sdk/chat';

// Create once per explicit user Send. Keep it with the app's send intent.
const operationId = crypto.randomUUID();
const response = await client.chat({
  operationId,
  model: client.listModels()[0].id,
  messages: [{ role: 'user', content: 'Explain zero-knowledge proofs in one sentence.' }],
  maxOutputTokens: 128,
});
const answer = await readChatText(response);
renderAnswer(answer);
renderWallet(await client.status());
```

For streaming, supply `stream: true` to `client.chat()` and consume with:

```ts
for await (const delta of readChatDeltas(response)) appendText(delta);
```

These are alternatives: consume the response once. Always consume or cancel
its body. Breaking the iterator cancels it. Direct mode retains a successfully
consumed session for subsequent requests; cancellation retires the key. A close
or verification failure stays pending in `status.session`; use `recover()` if
`status.canRequest` is false. An answer on
screen alone does not establish verified billing. Live streaming compatibility
is provider-specific; see [status](status.md).

The app owns history. For the next turn, pass prior messages, the assistant
answer and the new user message. There is no server-side chat history API.
Direct mode requests a 300-second lease and reuses it within the same client and
conversation. Pass a stable `sessionId` in `chat()` or `request()` (default:
`default`); call `settle()` before switching conversations with an active lease.
A follow-up with 90 seconds or less remaining retires the old lease and waits up
to 45 seconds for its verified successor before authorizing the new request.
Idle expiry also triggers settlement while the client is alive, and never while
a response is still being consumed. Reloaded clients require explicit recovery.
`keyReuseSeconds: 0` preserves per-request settlement; values 1–300 select a fixed
window instead. Proxy mode defaults to per-request settlement.

This policy is included in SDK/native `.6`. Published `.3` files and existing
custody bindings are unchanged. The `.6` native-input helper selects 60-second
reuse with a 120-second settlement wait; use it with the `.6` native runtime.

`chat()` handles text Chat Completions on configured OpenAI/OpenRouter/OA routes.
For native Responses, Anthropic Messages or client-side tool calls, use
`request()` and consume provider-native JSON/SSE. The SDK does not execute tools.

## 5. Recover and withdraw

```ts
if ((await client.status()).session) await client.recover(); // explicit action
// Inspect status again: recovery can remain pending.
await client.prepareWithdrawal(selectedAccount.address, 'mutual_close');
const progress = await client.advanceWallet(); // continue until complete
```

Reopen the same settings after reload. Never recover an uncertain request by
generating a new operation ID, changing mode, clearing browser data or funding
a replacement note. [Recovery guide](recovery.md) covers cancellation and escape.

After consuming/cancelling every body, unsubscribe and call the browser factory's
`dispose()`. It releases worker/storage handles; it does not settle or delete a
note. Retain the same storage identity for your next visit.
