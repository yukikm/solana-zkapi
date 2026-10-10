# Build a browser app with the SDK

This walkthrough creates a small local app with wallet/account selectors,
funding controls, one conversation, and recovery. It uses the published
**SDK `0.2.0-devnet.8`**, the pinned revision-6 public Devnet profile and a
bundled proof worker. The public profile selects **direct OpenRouter**: prompts
go from the browser to OpenRouter. Keep that mode; do not override it with proxy.

You need Node **24.19.0**, npm **11.9.0**, `curl`, `shasum`, and a browser wallet
that implements Wallet Standard with Solana Devnet and v0 transaction support.
Use a normal browser profile with IndexedDB and Web Locks available. A fresh
app has no operator management key or provider API key to configure.

Read [support status](../status.md) first. Current funded browser acceptance is
still incomplete; the code below can be typechecked and bundled independently
of that live verification. Existing funded browser notes must reopen their
original app origin, profile, storage and SDK; this tutorial creates a new app.
For an existing AI application rather than your own UI, start with
[clientd](clientd.md).

## 1. Create the app and install the verified package

Obtain this guide and its pins from the trusted repository or authenticate the
[`.8` release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.8).
Run the following in a new directory. Keep `vendor/` and the generated
`package-lock.json` with your app so a clean install can reproduce its inputs.
The SDK is distributed as a tarball; it is not published in the npm registry.

```sh
mkdir zkapi-browser-app
cd zkapi-browser-app
mkdir vendor src
curl --fail --location --proto '=https' --proto-redir '=https' \
  'https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.8/zkapi-solana-sdk-0.2.0-devnet.8.tgz' \
  --output vendor/zkapi-solana-sdk-0.2.0-devnet.8.tgz
printf '%s  %s\n' \
  'cd9226f4526c0b3561a557e4c7beb4f495dcbad6c995c624f4c442b6621414da' \
  'vendor/zkapi-solana-sdk-0.2.0-devnet.8.tgz' | shasum -a 256 -c -
```

Continue only after the checksum reports `OK`:

```sh
npm init -y
npm pkg set type=module \
  scripts.dev='vite --host localhost --port 5173 --strictPort' \
  scripts.build='tsc --noEmit && vite build'
npm install --save-exact ./vendor/zkapi-solana-sdk-0.2.0-devnet.8.tgz \
  @solana/kit@8.4.0 @wallet-standard/app@1.1.0
npm install --save-dev --save-exact vite@7.1.7 typescript@5.9.3
```

Use the repository's small browser adapter and worker from an immutable source
revision. These are application source, separate from the SDK package:

```sh
ZKAPI_EXAMPLE_SOURCE='https://raw.githubusercontent.com/yukikm/solana-zkapi/be8ffc46b7c95d69945e680be7d8bca62eb40fc1/tools/public-devnet-consumer'
curl --fail --location --proto '=https' --proto-redir '=https' \
  "$ZKAPI_EXAMPLE_SOURCE/browser.ts" --output src/zkapi.ts
curl --fail --location --proto '=https' --proto-redir '=https' \
  "$ZKAPI_EXAMPLE_SOURCE/worker.ts" --output src/worker.ts
```

The [adapter source](../../tools/public-devnet-consumer/browser.ts) exports
`openChat`. It loads and authenticates the profile, calls
`publicProfileClientOptions(loaded)` for the deployment, mode and model inputs,
then opens `createBrowserClient` with the verified WASM and its digest. It saves
the original profile digest before creating custody and requires that digest
on reopening. Existing custody can still open for explicit recovery when catalog
preflight is unavailable. It does not submit inference during initialization.

The worker file contains `import '@zkapi/solana-sdk/prover-worker';`. Vite will
bundle it as a module worker; no remote script or guessed worker URL is needed.

## 2. Add the app files

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "ESNext", "moduleResolution": "Bundler",
    "lib": ["ES2023", "DOM"], "strict": true, "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

Create `index.html`:

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Solana zkAPI SDK tutorial</title>
<h1>Solana zkAPI — Devnet</h1>
<p><button id="preflight">1. Check deployment</button></p>
<p><select id="wallet"></select> <button id="connect">2. Connect selected wallet</button></p>
<p><select id="account"></select></p>
<p><button id="create">3. Create new storage</button> <button id="open">Reopen existing storage</button></p>
<p>Deposit in micro-USDC: <input id="amount" value="2000000">
  <button id="fund">4. Prepare deposit</button> <button id="advance">5. Continue / check wallet</button>
  <button id="proof">Resume saved proof</button></p>
<p><select id="model"></select></p>
<p><textarea id="prompt">Explain zero-knowledge proofs in one sentence.</textarea>
  <button id="send">6. Send</button></p>
<p><button id="status">Refresh status</button> <button id="recover">Recover session</button>
  <button id="settle">Settle session</button> <button id="withdraw">Prepare withdrawal</button>
  <button id="dispose">Close local handles</button></p>
<h2>Result</h2><pre id="result"></pre>
<h2>Wallet status</h2><pre id="state"></pre>
<script type="module" src="/src/main.ts"></script>
</html>
```

Create `src/main.ts`:

```ts
import { getWallets } from '@wallet-standard/app';
import type { StandardWallet, StandardAccount } from '@zkapi/solana-sdk/browser';
import { loadPublicDeploymentProfile, preflightPublicDeployment,
  PublicProfileError } from '@zkapi/solana-sdk/public-profile';
import { openChat } from './zkapi';

const profileUrl = 'https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.8-r6.json';
const profileSha256 = 'ec10c1ab41bb5105222d3e25c7e1eba6b96b1b397abd0f854657030269992a77';
const walletMenu = document.querySelector<HTMLSelectElement>('#wallet')!;
const accountMenu = document.querySelector<HTMLSelectElement>('#account')!;
const modelMenu = document.querySelector<HTMLSelectElement>('#model')!;
const result = document.querySelector<HTMLPreElement>('#result')!;
const state = document.querySelector<HTMLPreElement>('#state')!;
const registry = getWallets();
let wallets = registry.get();
let accounts: typeof wallets[number]['accounts'] = [];
let selectedWallet: typeof wallets[number] | undefined;
let app: Awaited<ReturnType<typeof openChat>> | undefined;
let unsubscribe: (() => void) | undefined;
let running = false;
const history: { role: 'user' | 'assistant'; content: string }[] = [];
const format = (value: unknown) => JSON.stringify(value, (_key, v) =>
  typeof v === 'bigint' ? v.toString() : v, 2);

function menu(select: HTMLSelectElement, labels: readonly string[]) {
  select.replaceChildren(new Option('Choose explicitly…', ''));
  labels.forEach((label, index) => select.add(new Option(label, String(index))));
}
function refreshWallets() {
  if (app || running) return;
  wallets = registry.get().filter(wallet =>
    wallet.features['standard:connect'] && wallet.features['solana:signTransaction']);
  selectedWallet = undefined;
  accounts = [];
  menu(walletMenu, wallets.map(wallet => wallet.name));
  menu(accountMenu, []);
}
registry.on('register', refreshWallets);
registry.on('unregister', refreshWallets);
refreshWallets();
menu(modelMenu, []);
walletMenu.addEventListener('change', () => {
  selectedWallet = undefined; accounts = []; menu(accountMenu, []);
});

function current() {
  if (!app) throw new Error('Select an account and open its storage first.');
  return app;
}
function action(id: string, execute: () => Promise<unknown>) {
  document.getElementById(id)!.addEventListener('click', async () => {
    if (running) return;
    running = true;
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    document.querySelectorAll('select').forEach(select => { select.disabled = true; });
    try { result.textContent = format(await execute()); }
    catch (error) {
      result.textContent = error instanceof PublicProfileError
        ? `Deployment check failed: ${error.component}`
        : error instanceof Error ? error.message : 'Action failed. Inspect status before continuing.';
    } finally {
      if (app) state.textContent = format(await app.client.status().catch(() => 'Status unavailable'));
      document.querySelectorAll('button').forEach(button => { button.disabled = false; });
      walletMenu.disabled = accountMenu.disabled = Boolean(app);
      modelMenu.disabled = false;
      running = false;
    }
  });
}

action('preflight', async () => {
  if (app) return app.refreshPreflight();
  const loaded = await loadPublicDeploymentProfile(profileUrl, { profileSha256 });
  return { mode: loaded.profile.mode, ...await preflightPublicDeployment(loaded) };
});
action('connect', async () => {
  if (app) throw new Error('Close local handles before changing wallets.');
  if (!walletMenu.value) throw new Error('Choose a wallet.');
  const wallet = wallets[Number(walletMenu.value)];
  const connect = wallet.features['standard:connect'] as { connect(): Promise<unknown> } | undefined;
  if (typeof connect?.connect !== 'function') throw new Error('Wallet cannot connect.');
  await connect.connect();
  selectedWallet = wallet;
  accounts = [...wallet.accounts]; // Keep the exact objects shown to the user.
  menu(accountMenu, accounts.map(account => account.address));
  return 'Select the connected Devnet account next.';
});
async function open(initializeStorage: boolean) {
  if (app) throw new Error('Storage is already open.');
  if (!selectedWallet || !accountMenu.value) throw new Error('Connect a wallet and choose its account.');
  const selectedAccount = accounts[Number(accountMenu.value)];
  app = await openChat({
    profileUrl, profileSha256,
    // The SDK types use Uint8Array; Wallet Standard exposes readonly bytes.
    // Keep the original objects: the adapter checks account membership and v0.
    selectedWallet: selectedWallet as unknown as StandardWallet,
    selectedAccount: selectedAccount as unknown as StandardAccount,
    storageName: 'zkapi-sdk-tutorial-v1', noteId: 'primary', initializeStorage,
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  });
  walletMenu.disabled = accountMenu.disabled = true;
  menu(modelMenu, app.client.listModels().map(model => model.label ?? model.id));
  unsubscribe = app.client.subscribe(status => { state.textContent = format(status); });
  return { persistence: app.persistence, diagnostic: app.diagnostic };
}
action('create', () => open(true));
action('open', () => open(false));
action('status', () => current().client.status());
action('fund', async () => {
  const active = current();
  const diagnostic = await active.refreshPreflight();
  if (!diagnostic.preflight?.chainAllowsNewOperations) throw new Error('New funding is currently blocked.');
  await active.fund(document.querySelector<HTMLInputElement>('#amount')!.value);
  return 'Deposit prepared. Use Continue / check wallet to advance the saved operation.';
});
action('advance', () => current().advance());
action('proof', () => current().resumeProof());
action('recover', () => current().recover());
action('settle', () => current().client.settle());
action('withdraw', () => current().withdraw());
action('send', async () => {
  const active = current();
  if (!modelMenu.value) throw new Error('Choose a model.');
  const model = active.client.listModels()[Number(modelMenu.value)];
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!.value;
  const messages = [...history, { role: 'user' as const, content: prompt }];
  const operationId = crypto.randomUUID(); // One ID for this deliberate Send.
  const response = await active.send({ operationId, model: model.id, messages,
    maxOutputTokens: 128, stream: false, onDelta() {} });
  history.push({ role: 'user', content: prompt }, { role: 'assistant', content: response.text });
  return { operationId, answer: response.text, status: response.status };
});
action('dispose', async () => {
  const active = current();
  active.dispose(); // Does not settle, withdraw or delete storage.
  unsubscribe?.(); unsubscribe = undefined; app = undefined;
  history.length = 0;
  walletMenu.disabled = accountMenu.disabled = false;
  menu(modelMenu, []);
  return 'Handles closed. Reopen the same account, profile and storage to continue.';
});
```

The two type assertions at the adapter boundary preserve the exact selected
wallet/account objects. The published SDK types use mutable `Uint8Array`, while
Wallet Standard exposes readonly key bytes. The adapter still validates account
membership, the Devnet chain, and v0 signing support at runtime.

## 3. Build, start and check the deployment

```sh
npm run build
npm run dev
```

Open **`http://localhost:5173`** and press **Check deployment**. The result should
show the authenticated profile, model list, completed checks and
`chainAllowsNewOperations: true`. A `PublicProfileError` reports its failing
component; fix the original input or service problem rather than skipping a
check. This step only reads public configuration and finalized chain/indexer
state. It creates no wallet storage, transaction or inference request.

Preflight does not establish operator admission or provider credit. Before new
funding, also read the public gateway diagnostics in another terminal:

```sh
curl --fail --silent --show-error 'https://d366buuvadnp3.cloudfront.net/relay-status'
curl --fail --silent --show-error 'https://d366buuvadnp3.cloudfront.net/provider-budget'
```

New admission must be enabled; the current public policy is operator-funded
with no fixed trial allowance or invitation. This is not a promise of provider
capacity. See [funding and access](devnet-funding.md).

Always return to **the same origin and port**, browser profile, wallet account,
`storageName` and `noteId`. `--strictPort` prevents Vite silently changing the
origin when the port is occupied. Browser origin storage is custody, not a
portable backup; clearing site data can lose the note secrets. For hosted use,
serve the built `dist/` over HTTPS and configure worker/WASM and service origins
in your CSP before creating any new custody there.

## 4. Select the wallet, create storage and fund

1. Set the wallet to **Devnet**. Choose its name, press **Connect selected
   wallet**, then choose the connected account. The app never chooses the first
   wallet or account automatically. If no wallet appears, enable a compatible
   Wallet Standard extension for this site and reload.
2. For this new app/account, press **Create new storage** once. This explicitly
   passes `initializeStorage: true` and requests persistent origin storage.
   Later visits use **Reopen existing storage**. A missing original binding or
   key is a recovery problem, not permission to reset or create replacement
   custody. The persistence result describes browser retention, not backup.
3. Give the selected account **Devnet SOL** for fees/rent and **Circle Devnet
   USDC** using the steps in [funding and access](devnet-funding.md). Other tokens
   with the same display name are not accepted. No mainnet funds are needed.
4. Press **Prepare deposit**, then **Continue / check wallet** for each saved
   step. `2000000` is 2 USDC. Read `authorizationCapMicroUsdc` in wallet status:
   the note must cover that cap after prior charges. Do not treat this example
   amount as a universal minimum or repeatedly prepare deposits while one is
   pending.

Inspect each progress result:

| Result | Next action |
|---|---|
| `complete` | Funding or withdrawal has finalized; refresh status. |
| `ready` | Press **Continue / check wallet** for the next saved step. |
| `expired_reconcile_required` | Keep the operation and follow [expired setup recovery](recovery.md). |
| `pending`, `unknown` | Use **Continue / check wallet** to inspect the same saved operation. |
| `proof_required` | Press **Resume saved proof**, then continue. |
| `rejected` | Review the rejection; use the explicit retry procedure in [recovery](recovery.md). |

The manifest selects compact or buffer transaction transport. One-signature
deposits require the authenticated compact capability; older deployments can
need multiple wallet signatures. Never count a signature prompt or a pending
response as finalized funding.

## 5. Send one request and inspect settlement

When wallet status has `canRequest: true`, choose a model and press **Send**.
The app creates one UUID for that deliberate action, sends the displayed prompt
and previous successful messages, then consumes the entire response with the
adapter's `readChatText` path. It displays both the answer and wallet status.
There is no automatic inference retry or fallback to another model or mode.

`canRequest` reflects SDK readiness, not a provider-credit guarantee. An answer
does not establish final billing. Direct mode can reuse its bounded session;
press **Settle session** when you are done and inspect `session` and
`lastSettlement`. Settlement may remain pending; use explicit recovery. The app
keeps chat history only in memory; financial recovery does not restore lost
answers. For multiple conversations, use `client.chat({ sessionId, ... })` and
settle the active lease before switching conversations.

The [API reference](../sdk/api.md) covers streaming, native Responses/Anthropic
requests and tools. If you add streaming, consume the response once with
`readChatDeltas`, or cancel it explicitly. The SDK does not execute tools or
manage your chat-history storage.

## 6. Reopen, recover, withdraw and close

After a reload, reconnect **the same wallet/account** and press **Reopen existing
storage**. Refresh status first. **Continue / check wallet** resumes a saved
wallet operation; **Recover session** resumes authorization/settlement handling
and does not replay inference. If preflight has a catalog outage, the adapter
keeps recovery available while new sends remain blocked. Press **Check
deployment** again when service recovers. Keep the original profile and custody
through the interruption.

To withdraw, press **Prepare withdrawal** and then **Continue / check wallet**
until `complete`. The destination is the explicitly selected connected account.
If mutual close cannot complete, follow [recovery and emergency
withdrawal](recovery.md); do not create a replacement note or guess a new
operation ID to replay uncertain inference.

**Close local handles** calls the browser factory's `dispose()`, terminates its
worker, closes storage handles and unsubscribes from status. It neither settles
nor withdraws, deletes custody, or disconnects the wallet extension. Use it only
after response bodies are consumed/cancelled; retain the same storage identity
for reopening.

For other deployments, use [deployment inputs](deployment-inputs.md) and the
[public-profile API](../sdk/public-profile.md). For package builds and upgrades,
see [SDK distribution](sdk-distribution.md) and [SDK migration](sdk-migration.md).
