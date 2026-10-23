# Inference API getting started with the SDK

The TypeScript SDK provides funding, authorization, local proofs, settlement and
recovery for API usage. Start with [General API integration](api-integration.md)
for the shared payment lifecycle and the work required to support a new API type.

This tutorial builds a browser integration for the current public Devnet
**OpenRouter Chat Completions** profile. Its model selection, conversation UI and
`chat()` calls are inference-specific. The SDK's current request facade supports
the documented inference APIs; it is not an arbitrary HTTP request client.
To connect an existing AI client, see [Inference API getting started](inference.md)
or use [clientd](clientd.md).

The [`.14` Node security upgrade](node-security-upgrade.md) supplies Node 24.22.1
and retains the existing authenticated deployment profile and custody bindings.

## 1. Install

These commands install `.14` for the new current-state Devnet Pool. Use a new
browser storage name and the new profile pins below. Existing journals retain
their original Pool binding.

Use Node **24.22.1** and npm **11.19.1** in your application directory. The download
example uses a POSIX shell, an authenticated GitHub CLI with immutable release
verification support, and Node for checksum verification. Use a new directory.

```sh
(
  set -eu
  gh release download v0.2.0-devnet.14 --repo yukikm/solana-zkapi \
    --pattern release-manifest.json --pattern zkapi-solana-sdk-0.2.0-devnet.14.tgz
  gh release verify v0.2.0-devnet.14 --repo yukikm/solana-zkapi
  gh release verify-asset v0.2.0-devnet.14 release-manifest.json --repo yukikm/solana-zkapi
  gh release verify-asset v0.2.0-devnet.14 zkapi-solana-sdk-0.2.0-devnet.14.tgz --repo yukikm/solana-zkapi
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { readFileSync } from "node:fs";
    const file = "zkapi-solana-sdk-0.2.0-devnet.14.tgz";
    const release = JSON.parse(readFileSync("release-manifest.json", "utf8"));
    if (release.version !== "0.2.0-devnet.14") throw new Error("Wrong release");
    const expected = release.assets[file].sha256;
    if (createHash("sha256").update(readFileSync(file)).digest("hex") !== expected)
      throw new Error("SDK checksum mismatch");
  '
  npm install --save-exact ./zkapi-solana-sdk-0.2.0-devnet.14.tgz @solana/kit@8.4.0
)
```

Stop if the checksum fails. This package is distributed as a tarball, not through
the npm registry. Retain the tarball so clean installs can resolve the file
dependency. Use an ESM application (`"type": "module"` in `package.json`).

## 2. Check the deployment

Save `deployment.ts` in your application:

```ts
export const profileUrl =
  'https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261021-state-v1/profile.json';
export const profileSha256 =
  '5e15d66c6f45265951cf1f8dd6cc0dae6574c4b8dd6756f828f7543ecaa97b9a';
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
  const storageName = 'my-zkapi-state-20261021';
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
  maxOutputTokens: 4096,
});
const text = await readChatText(response);
const status = await client.status();
```

The [public Devnet application limit](devnet.md#5-use-and-recover) is 4,096
output tokens per response. Choose a positive `maxOutputTokens` within both
4096 and the selected model's output limit. This application setting is separate from
the authenticated profile and monetary session cap; longer responses can cost
more. A response can still end at the selected token limit.

For streaming, set `stream: true` and consume with `readChatDeltas(response)`.
Always consume or cancel the response body. Keep history in your app and send it
with the next request. Direct sessions can be reused; call `client.settle()`
before switching conversations with an active session.

`chat()` handles text Chat Completions. Use `client.request()` for native
Responses, Anthropic Messages or client-executed tools; see the [API reference](../sdk/api.md).
The SDK does not execute tools. These APIs must be enabled by the selected
deployment's model/profile; the public profile above enables Chat Completions.
Direct mode sends prompts to the provider;
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
