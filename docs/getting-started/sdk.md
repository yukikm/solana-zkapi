# Add the SDK to an application

The TypeScript SDK handles funding, authorization, local proofs and settlement.
Your app supplies the wallet picker, model selection and conversation UI.
To connect an existing AI client instead, use [clientd](clientd.md).

## 1. Install

Use Node **24.19.0** and npm **11.9.0** in your application directory:

```sh
(
  set -eu
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output zkapi-solana-sdk-0.2.0-devnet.8.tgz \
    https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.8/zkapi-solana-sdk-0.2.0-devnet.8.tgz
  printf '%s  %s\n' \
    cd9226f4526c0b3561a557e4c7beb4f495dcbad6c995c624f4c442b6621414da \
    zkapi-solana-sdk-0.2.0-devnet.8.tgz | shasum -a 256 -c -
  npm install --save-exact ./zkapi-solana-sdk-0.2.0-devnet.8.tgz @solana/kit@8.4.0
)
```

Stop if the checksum fails. This package is distributed as a tarball, not through
the npm registry. Retain the tarball so clean installs can resolve the file
dependency. Use an ESM application (`"type": "module"` in `package.json`).

## 2. Check the deployment

Save `deployment.ts` in your application:

```ts
export const profileUrl =
  'https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.8-r6.json';
export const profileSha256 =
  'ec10c1ab41bb5105222d3e25c7e1eba6b96b1b397abd0f854657030269992a77';
```

Save `preflight.ts` beside it:

```ts
import { loadPublicDeploymentProfile, preflightPublicDeployment }
  from '@zkapi/solana-sdk/public-profile';
import { profileUrl, profileSha256 } from './deployment.ts';

const loaded = await loadPublicDeploymentProfile(profileUrl, { profileSha256 });
console.log(await preflightPublicDeployment(loaded));
```

Run `node preflight.ts`. This downloads and verifies public artifacts and reads
chain state; it creates no wallet or custody and sends no inference or transaction.
Also check access and obtain test funds using [Devnet setup](devnet.md).
For your own operator, replace both constants with its authenticated inputs.

## 3. Open browser storage

Use HTTPS or localhost and a bundler with module-worker support. Save `worker.ts`:

```ts
import '@zkapi/solana-sdk/prover-worker';
```

Save `zkapi.ts` beside it and `deployment.ts`:

```ts
import {
  createBrowserClient, walletStandardAdapter,
  type StandardWallet, type StandardAccount,
} from '@zkapi/solana-sdk/browser';
import { loadPublicDeploymentProfile, preflightPublicDeployment,
  publicProfileClientOptions } from '@zkapi/solana-sdk/public-profile';
import { profileUrl, profileSha256 } from './deployment.ts';

export async function openZkApi(
  selectedWallet: StandardWallet,
  selectedAccount: StandardAccount,
  initializeStorage = false,
) {
  const storageName = 'my-zkapi-app-v1';
  const binding = JSON.stringify([storageName, selectedAccount.address]);
  const installed = localStorage.getItem(binding);
  if (installed === null && !initializeStorage)
    throw new Error('Restore the original profile binding or explicitly create new storage.');

  const loaded = await loadPublicDeploymentProfile(profileUrl, {
    profileSha256, installedProfileSha256: installed ?? undefined,
  });
  // Existing storage can still open for recovery when catalog preflight fails.
  const preflight = await preflightPublicDeployment(loaded).catch(error => {
    if (installed === null) throw error;
    return null;
  });
  await navigator.locks.request(binding, () => {
    const current = localStorage.getItem(binding);
    if (current !== null && current !== loaded.profileSha256)
      throw new Error('Reopen the original deployment profile.');
    if (current === null) localStorage.setItem(binding, loaded.profileSha256);
  });

  const opened = await createBrowserClient({
    ...publicProfileClientOptions(loaded),
    wallet: walletStandardAdapter(selectedWallet, selectedAccount, 'solana:devnet'),
    noteId: 'primary', storageName, initializeStorage,
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    wasm: loaded.assets.wasm, wasmSha256: loaded.assets.wasmSha256,
  });
  return { ...opened, preflight };
}
```

Connect the wallet and let the user choose an account before calling this
function. The account must support Devnet and version-0 transaction signing.
Call with `true` only from an explicit **Create storage** action. Normal reloads
omit it. Keep the origin, browser profile, wallet account, storage name, note ID
and installed profile digest unchanged while the note exists.

Allow the worker, WASM and profile service destinations in your CSP. The browser
needs IndexedDB, Web Locks and Web Crypto. Storage in one browser origin is not
a portable wallet backup. The [complete browser adapter](../../tools/public-devnet-consumer/browser.ts)
also handles invitations and explicit preflight refresh.

## 4. Deposit

From your UI handlers, using the returned `client`:

```ts
await client.prepareDeposit('2000000'); // 2 test USDC, no signature yet
const progress = await client.advanceWallet(); // one wallet/recovery step
```

Provide a **Continue** action that calls `advanceWallet()` until
`progress.state === 'complete'`. Inspect each result: `proof_required` uses
`resumeWalletProof()`; a rejected operation requires review before
`retryRejectedWalletOperation()`. `pending` and `unknown` do not mean funded.
Use `client.subscribe(...)` to update your balance and progress display.

## 5. Send and consume the response

Enable Send only after preflight permits new operations and
`(await client.status()).canRequest` is true. Select a model from
`client.listModels()` and respect its configured capabilities.

```ts
import { readChatText } from '@zkapi/solana-sdk/chat';

const response = await client.chat({
  operationId: crypto.randomUUID(), // save once per explicit Send action
  sessionId: 'conversation-1',      // stable for this conversation
  model: client.listModels()[0].id,
  messages: [{ role: 'user', content: 'Hello!' }],
  maxOutputTokens: 128,
});
const text = await readChatText(response);
const status = await client.status();
```

For streaming, set `stream: true` and consume with `readChatDeltas(response)`.
Always consume or cancel the response body. Keep history in your app and send it
with the next request. Direct sessions can be reused; call `client.settle()`
before switching conversations with an active session.

`chat()` handles text Chat Completions. Use `client.request()` for native
Responses, Anthropic Messages or client-executed tools; see the [API reference](../sdk/api.md).
The SDK does not execute tools. Direct mode sends prompts to the provider;
proxy mode also exposes them to the operator. Mode comes from the profile.

## 6. Recover and withdraw

Expose separate explicit actions:

```ts
await client.recover(); // inspect status again; settlement may remain pending
await client.prepareWithdrawal(selectedAccount.address, 'mutual_close');
const progress = await client.advanceWallet(); // continue the saved withdrawal
```

Keep the same operation and storage when a result is unknown. Never retry paid
inference automatically, clear custody to fix an error, or change profile/mode
to recover. Use the [recovery guide](../sdk/recovery.md) for pending work and
emergency withdrawal. After consuming all responses, unsubscribe listeners and
call `dispose()`; disposal does not withdraw or erase the note.

For custom deployment inputs, see [deployment configuration](../sdk/deployment.md).
For the profile contract, see [public profiles](../sdk/public-profile.md).
