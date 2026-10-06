# Browser chat integration example

These are complete integration functions, not a hosted chat product. They show
how a UI uses the application SDK without implementing proof, authorization,
wallet recovery or billing logic. There is no mock-success fallback.

- [integration.ts](integration.ts): connect an explicitly selected wallet; send or stream text.
- [load-deployment.ts](load-deployment.ts): load public assets from a reviewed app profile.
- [SDK quickstart](../../docs/sdk/quickstart.md): funding, status and recovery.

## Check and bundle

From the repository root with pinned Node/npm and installed root dependencies:

```sh
npm run typecheck:examples
npm ci --prefix scripts/i10-wallet-ui --ignore-scripts --no-audit --no-fund
node examples/browser-chat/build.mjs
```

This creates `target/app-sdk-example/integration.js` and `worker.js`. Serve the
worker at `/zkapi/worker.js` and import the integration module in your own UI.
The build uses the repository's pinned esbuild; it does not start a server,
read `.env`, connect Phantom or spend funds. Protect served code with your app's
normal build integrity/CSP policy.

## Supply the app profile

`ReviewedBrowserProfile` is app-owned configuration. Obtain the actual manifest,
artifact files, tariff values and independent pins from your deployment operator.
See [deployment inputs](../../docs/sdk/deployment.md). No default live endpoint,
credential or invented trust hash is included.

The UI discovers/connects a Wallet Standard wallet, lets the user select its
account, and passes that exact pair to `connectChat`. It sets `initializeStorage`
only for an explicit new-wallet-storage action. Pass a stable `storageName` and
`noteId` for reloads. Do not import a seed or private key into this example.

After `prepareDeposit` and enough `advanceWallet` steps to reach finalized
funding, create a UUID once for each Send button action and pass it to `sendText`
or `sendStreamingText`. Keep app history separately. Display returned status,
especially a pending session, and use an explicit recovery action before a new
send. Do not wrap sends in generic HTTP retry middleware.

This sample explicitly selects **proxy** and its operator can read content.
Direct integration uses the same factory with explicit direct mode/provider
bases and, for OA, verifier pins. The sample does not switch modes on failure.
