# I10 Chrome / Phantom acceptance host

This local host serves a presentation demo at `/` and `/demo`, and the original devnet-only SDK acceptance UI at `/live`. The `/live` UI discovers the installed **Phantom** through the official Wallet Standard app registry, asks the user to connect and explicitly choose an account, and uses the existing SDK `walletStandardAdapter`, `WalletClient`, `EncryptedJournal`, `IndexedDbJournalStore`, `WorkerProver`, `ControlClient`, `ProverSessionVerifier` and v0 transport. It does not implement another financial state machine or use a native wallet key.

## Presentation demo (2026-10-05)

The default page explains four steps: **deposit → AI use → settlement → withdrawal**. Advance manually, autoplay, pause, or reset the demo. Its fixed sample deposits 1 USDC (1,000,000 micro-USDC), charges 18 micro-USDC (0.000018 USDC), and returns 999,982 micro-USDC (0.999982 USDC). Amounts are projected with `BigInt`; the controller only changes the presentation phase. Sample amounts omit Solana transaction fees and buffer rent.

The demo does not discover/connect a wallet, call APIs/RPC, use SDK/storage/journals, generate proofs, verify receipts or send funds. Its text, response and receipt are explicitly examples. Reset and reload affect only the in-memory presentation. “実接続を開く” navigates to `/live`, which retains the same browser origin, run ID, account and encrypted journal namespace as the original page; route changes do not reset or migrate live state.

Sources: [markup](demo.html), [styles](demo.css), [controller](demo.ts), [entry point](demo-entry.ts), and [controlled-timer tests](demo.test.ts). The tests cover integer conservation, delayed settlement, repeated clicks, stale callbacks after reset/pause/disposal and reduced motion. [Host tests](host.test.ts) and [build tests](build.test.ts) cover the exact routes, unchanged guards, incomplete-demo refusal and production-to-fixture output reuse. A fixture build intentionally keeps `/` on the original fixture UI. The [public demo report](../../docs/evidence/I10-demo-ui-results.json) records the executed checks and their scope; presentation success is not real Phantom/provider acceptance or an I10/release gate.

Build or run the focused checks from the repository root after installing the pinned dependencies below:

```sh
target/i08-toolchain/bin/node --input-type=module -e "import {buildUi} from './scripts/i10-wallet-ui/build.ts'; await buildUi('target/i10-wallet-ui/demo-build');"
target/i08-toolchain/bin/node --test scripts/i10-wallet-ui/demo.test.ts scripts/i10-wallet-ui/build.test.ts scripts/i10-wallet-ui/host.test.ts scripts/i10-wallet-ui/browser.test.ts scripts/i10-wallet-ui/provider.test.ts
target/i08-toolchain/bin/node node_modules/typescript/bin/tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --resolveJsonModule --lib ES2023,DOM --types node scripts/i10-wallet-ui/*.ts
```

## Live SDK UI

The fixed deposit is **1 devnet USDC** (1,000,000 integer micro-USDC). The selected account supplies every signing role and receives the mutual-close withdrawal. Each signature is a separate explicit action; rejecting a signature retains the prepared SDK operation. Reloading the same origin, manifest, run ID and account reopens its encrypted journal. Signing and sending stop on an unavailable/disconnected account, non-v0 message, wire above 1,232 bytes, unavailable fee estimate, or fee above 10,000 lamports. Test SOL buffer rent is separate. Only the existing finalized-expired upload recovery behavior can replace an upload; unknown financial operations remain under the SDK's existing policy.

The AES-256-GCM key is nonextractable and persisted as a structured-cloned CryptoKey in IndexedDB under a Web Lock. This is custody within the same Chrome profile and origin, **not backup/restore or OS-keychain evidence**. Do not clear site data or change the localhost port/run identity while funds remain. No wallet seed or private-key import is exposed.

## Launch

Use the repository's pinned Node and separately pinned UI dependencies:

```sh
PATH="$PWD/target/i08-toolchain/bin:$PATH" npm ci --prefix scripts/i10-wallet-ui --ignore-scripts --no-audit --no-fund
target/i08-toolchain/bin/node scripts/i10-wallet-ui/launch.ts --config /absolute/path/private-ui-config.json
```

The launcher builds separate demo and real SDK entry points, plus the live proof worker, into `target/i10-wallet-ui/<runId>` and binds **127.0.0.1**. Open `/` or `/demo` for the presentation and `/live` for the original SDK UI. It does not start an indexer/backend, read `.env`, read a wallet key, or send a transaction. Reuse the existing devnet indexer/backend launchers. Keep the private configuration out of version control because its `rpcUrl` may contain credentials. Public startup output contains only origin, run ID, wallet and send-enabled flag.

`HostConfig` in `host.ts` is the exact configuration type:

- `runId`, stable `port` (the current acceptance uses 19180).
- `manifestPath` and independently installed `ManifestTrustPolicy` (`policy`) with exact manifest hash/authority and deployment pins.
- `wasmPath`, independently pinned `wasmSha256`.
- `artifacts`: local public-file paths keyed by every SDK artifact name (`idl`, `requestPk`, `requestVk`, `withdrawalPk`, `withdrawalVk`, `treePk`, `treeVk`, `treeSourceBundle`, `treeVerifierConstants`, and every `additional:<manifest.artifact_digests key>`). The server checks the exact key set and all digests before serving.
- `rpcUrl`: HTTPS devnet RPC. It is never returned to the browser.
- `indexerUrl`, `controlUrl`: fixed HTTPS origins or numeric-loopback HTTP origins. Logical HTTPS origins in the authenticated manifest remain unchanged; the browser maps only exact required SDK paths onto same-origin routes.
- Optional `localCaPath` for a fixed loopback HTTPS service; normal public TLS verification remains enabled.
- Optional `provider: {planPath, configurationDir, stateDir}` enables the dedicated `openai-ui` run. The host checks the selected `openai-chat-plain` case and tariff against the parent campaign and manifest; only the public case, tariff and plan hash reach the browser. The provider API key remains with the dispatcher. The existing Python coordinator reserves the case in the shared campaign budget immediately before forwarding, once only, including when the response is lost.
- `allowTransactions`: start with **false** for connection/account inspection. It disables financial UI actions, the signer wrapper, all provider/control POSTs, the permanent-clearance route and the server send route. Enabling it is an explicit operator change followed by host restart/page reload.

The relay accepts a small read-only RPC method allowlist and signed transactions only after independently checking devnet genesis, exact signatures, no ALTs, pinned program and the actual instruction pool account position, one allowed Vault buffer instruction and the fee ceiling. New payload creation is limited to deposit or mutual close. The fixed 1-USDC amount is enforced by the reviewed UI input and existing SDK plan; the relay does not reconstruct uploaded proof payloads or claim a general per-account spending budget. It forwards identical wire bytes with preflight enabled and `maxRetries: 0`. It never signs or retries. Origin, Host, Fetch Metadata and route checks reject foreign sites and arbitrary destinations. HTTP and JSON-RPC errors are redacted so an upstream error cannot echo its credential-bearing URL. When configured, the provider relay permits only the selected OpenAI Chat plain request with the exact fixed prompt, model and 128-token output limit. The inference Host comes from the authenticated manifest. It cannot forward arbitrary requests or switch provider/mode. The browser uses the same WASM worker to prepare AUTH and verify signed receipts/successor state; no native prover or wallet signer is substituted. Snapshot retries are read-only, limited to known coherence/unavailability errors and a 300-second elapsed deadline; they do not establish a public-RPC latency SLO.

## Acceptance procedure and evidence

1. Open `/live`, inspect the installed Phantom version and select the intended existing devnet account in Chrome. Record extension version explicitly. Check the displayed pool/hash against the operator's public manifest.
2. With sends enabled, prepare the fixed deposit using the local WASM prover. Reject the first Phantom signature. Record the unchanged operation ID, zero attempts and retained revision. Reload, reconnect and select the same account.
3. Continue the saved operation with explicit Phantom approval for each next transaction. Continue to recover pending receipts; no automatic button action is scheduled. Confirm SDK status `active`.
4. In the dedicated `openai-ui` run, prepare the OpenAI authorization. The coherent note snapshot is obtained before requesting the 120-second signed quote. Send the saved request once promptly. The fixed prompt is “Reply with the single word ok.” Inspect the response as plain text, then use “Recover / close session” until the signed charge, receipt IDs and successor balance appear. A lost response remains uncertain and cannot be resent. After reload the response text is deliberately not retained; recovery uses the original encrypted AUTH/operation. A never-sent authorization can be cancelled through this control. If a terminal zero-charge session excludes an operation that never reached the backend, use the separate existing SDK “Reconcile unaccepted operation” action; it cannot infer absence from an active-session 404.
5. Prepare mutual close to that same account. The existing SDK verifies permanent signed clearance and proof bindings. Continue each explicit signature/recovery until SDK status `closed`.
6. Download public observations and independently join finalized signatures, balances, exact message/fee/CU, installed extension identity and browser version. The UI deliberately keeps `wallet_UI_verified: false` and `live_provider_verified: false`; a self-reported page is not independent acceptance evidence.

The browser fixture uses a separately built `Fixture Wallet`, synthetic prover and synthetic RPC. It checks real Chrome Wallet Standard discovery, explicit second-account selection, SDK journal encryption and rejection/reload/persist-before-send ordering. The separate provider fixture imports a synthetic finalized note through `WalletClient`, uses actual encrypted journal and `ControlClient`/`ProverSessionVerifier` orchestration with an explicitly synthetic proof/receipt verifier, and exercises response/reload/no-replay, inert response text and rejected-successor withdrawal blocking. Real Ed25519 quote checks are used in the control fixtures. Its deterministic public seeds never enter the real app bundle. It does **not** prove real Phantom behavior, real proof validity, SBF execution, live RPC/provider availability or a release gate.

```sh
target/i08-toolchain/bin/node --test scripts/i10-wallet-ui/host.test.ts scripts/i10-wallet-ui/browser.test.ts scripts/i10-wallet-ui/provider.test.ts
target/i08-toolchain/bin/node node_modules/typescript/bin/tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --resolveJsonModule --lib ES2023,DOM --types node scripts/i10-wallet-ui/*.ts
```

Primary API sources: [Wallet Standard app registry](https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/app/src/wallets.ts), [standard:connect](https://github.com/wallet-standard/wallet-standard/blob/master/packages/core/features/src/connect.ts), [Phantom Solana integration](https://docs.phantom.com/solana/integrating-phantom). The versions are pinned in this directory's lockfile; no root dependency or SDK state machine was changed.

A new pool/manifest/run ID uses a separate journal namespace while preserving the same browser origin. The previous `wallet-ui` run is retained; do not repin an existing funded journal. Only one session and one inference operation are available in the dedicated OpenAI case. The server reservation is shared with native provider acceptance, so a browser reload or host restart cannot reset the campaign budget. Confirmed micro-USDC amounts are shown as integers; response content is not billing evidence.

Browser compatibility regression: the SDK encodes credential bytes through base64 followed by the canonical URL-alphabet substitutions and padding removal. This produces exactly the same token bytes as Node `base64url` while supporting the pinned browser Buffer package; deterministic equivalence tests and the actual Chrome provider fixture exercise it.
