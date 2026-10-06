# Browser chat application

A standalone devnet browser application over the application SDK. It lets users
select a reviewed deployment, privacy mode, wallet account and local note; fund
that note; send arbitrary text with conversation history; and inspect or recover
saved work. There is no default deployment and no mock-success fallback.

## Build and run

From the repository root, with pinned Node/npm and root dependencies installed:

```sh
npm ci --prefix scripts/i10-wallet-ui --ignore-scripts --no-audit --no-fund
npm run typecheck:examples
node examples/browser-chat/build.mjs
python3 -m http.server 4173 --bind 127.0.0.1 --directory target/app-sdk-example
```

Open `http://127.0.0.1:4173`. The build creates `index.html`, `styles.css`, `app.js`,
`integration.js` and `worker.js` in `target/app-sdk-example`. The worker URL is
relative to the bundled module, so the directory can also be hosted at a subpath.
Building and opening the unconfigured application do not connect a wallet,
request an authorization, submit inference or send a transaction.

HTTPS or localhost is required for browser custody and Web Locks. Keep the same
origin, including port, for later recovery. For a public deployment, serve only
this output directory, restrict the document's `connect-src` policy to reviewed
asset/service/provider origins, and protect the application build and origin.
Do not serve the repository or `.env` files. Do not put private RPC credentials or
provider management keys in public assets.

## Install independently reviewed configuration

Edit [reviewed-profiles.ts](reviewed-profiles.ts) and rebuild. Each
`ReviewedChatProfile` entry is one explicit deployment and privacy route:

- A stable ID and label, `chain: 'solana:devnet'`, and a specific `mode`:
  `proxy`, `direct_openrouter` or `direct_oa`.
- Independently installed `trust` and `wasmSha256`, public manifest/artifact/WASM
  URLs, a public `rpcUrl` or app-owned relay, and `indexerOrigin`.
- The actual configured models, allowed APIs and authenticated tariffs. These
  must match the selected mode and the manifest's tariff hashes.
- For direct mode, the pinned `directProviderBases` entry; for `direct_oa`, the
  independently reviewed `oaVerifier` base and station ID as well.

See [deployment inputs](../../docs/sdk/deployment.md) for the exact trust and
artifact contract. [load-deployment.ts](load-deployment.ts) loads bounded public
assets, then the SDK factory verifies manifest/build/tariff/WASM pins, RPC genesis
and finalized PoolConfig. A downloaded manifest cannot establish its own trust.
The application intentionally does not accept runtime URLs or hashes as a shortcut
to reviewed configuration. No example hash or placeholder endpoint is a working
deployment. Direct browser use also requires provider CORS support; an unavailable
direct route stays unavailable rather than falling back to proxy.

## User flow

1. Select a reviewed deployment and privacy mode, read the visibility notice,
   and acknowledge it. Proxy exposes content to the operator and provider.
   Direct sends content to the provider; the operator still issues credentials
   and settles provider usage, and the provider sees network metadata.
2. Find and connect a Wallet Standard wallet supporting Solana v0 transactions.
   Explicitly select its account. Use **Create storage** only for first-time
   custody creation, or **Open saved storage** with the same storage name and
   local note ID. Opening reads and validates state without resuming operations.
3. Review the authorization cap and deposit amount. For an empty note the UI
   suggests twice the cap, allowing a small first charge without immediately
   dropping below the next authorization threshold. Edit the amount if needed,
   prepare the deposit, then approve each **Continue saved wallet step** action.
   SOL transaction fees and rent are separate from USDC usage.
4. Choose a configured model and API. Send arbitrary text, optionally streamed.
   Each explicit send has one UUID and at most one inference dispatch. Complete turns
   form subsequent request context; interrupted answers are excluded. Read the
   verified settlement independently of the displayed answer.
5. Cancel an active response if needed, then inspect saved state. Cancellation
   holds the UI lock while the SDK consumes/cancels the response and attempts
   settlement. It does not prove the provider did no work. Use the explicit
   session or wallet recovery action appropriate to the displayed state.
   If a possibly sent authorization has no observed acceptance or inference,
   **Clear an unaccepted authorization** requests and verifies permanent signed
   clearance. This can release an expired authorization that ordinary recovery
   cannot settle. If clearance is unavailable, keep the saved note and retry
   explicitly later; expiry or a missing session alone cannot release it.
6. Prepare mutual withdrawal or explicitly choose escape, then continue its
   saved wallet steps. Finalizing an escape requires the SDK's chain-verified
   challenge deadline. Expired notes block new inference but retain recovery
   controls. Read the principal-to-treasury expiry warning before funding.
   If a pending session cannot settle, **Prepare emergency escape from pending
   session** uses the last verified state and the entered destination. The
   original authorization and inference operations remain archived, new sends
   stay blocked, and the operator can challenge the escape on chain. Continue
   the saved wallet steps, then finalize after the verified deadline or use
   **Check for a challenged escape**. A verified challenge restores the original
   session for explicit recovery or settlement; it does not settle usage or
   replay inference. Failed challenge checks keep the archive and pending escape.
   This check also remains available after finalization is prepared. A signed
   finalization can be set aside only after its exact finalized rejection is
   verified; an unknown or successful attempt stays protected.

The UI never rotates a funded or unresolved note to another ID while it is open.
After an empty or completed note, explicitly close the view before selecting a
new ID. Reload and account disconnection recovery use the same account, origin,
storage name and note ID; reconnect and reopen them without creating replacement
custody. Missing keys, corrupt records and ambiguous sends must not be “fixed” by
clearing site data.

## APIs and history

| Configured API | Request | Text/stream reader |
|---|---|---|
| Chat Completions | SDK `chat()`, `max_completion_tokens` | SDK `readChatText` / `readChatDeltas` |
| OpenAI Responses | SDK `request()`, `input`, `max_output_tokens`, explicit `store: false` | Bounded native JSON / Responses SSE |
| Anthropic Messages | SDK `request()`, `messages`, `max_tokens`, version `2023-06-01` | Bounded native JSON / Messages SSE |

The UI is text-only. Tool calls remain an advanced SDK integration concern; it
does not execute tools, request media, enable hosted tools, reuse provider-side
conversation IDs or store Responses. The native readers reject unsupported tool
output, malformed/error events and incomplete streams. Usage events are never
used as billing authority. No successful provider acceptance follows from a
configured model appearing in the picker.

Conversation text stays in tab memory and is lost on reload. Only public locator
preferences (profile ID, storage name and local note ID) are saved by the UI.
The SDK alone owns the encrypted financial journal. Clearing the visible
conversation never clears financial state or replays an operation. Recovery can
repeat an exact saved authorization, but it cannot recover a lost response body
or replay inference.

Browser custody is bound to the selected account/deployment and stored with a
nonextractable key in the same origin/profile. The UI displays the SDK's storage
persistence result and warns about eviction when persistence is not confirmed.
Even persistent storage does not survive deliberate site-data clearing or device
loss. Portable backup is not implemented, and same-origin malicious code remains
inside the trust boundary. See [recovery](../../docs/sdk/recovery.md).

## Local verification

```sh
node examples/browser-chat/chat-model.test.ts
node examples/browser-chat/native-responses.test.ts
npm run typecheck:examples
node examples/browser-chat/build.mjs
ZKAPI_TEST_CHROME=/path/to/chromium node examples/browser-chat/browser.test.ts
```

The Chrome test uses an isolated browser profile and loopback server with explicit
synthetic wallet/SDK/provider ports. It checks unconfigured startup without
network effects, account/mode consent, exact amounts, model/API selection,
repeated conversation context, safe text rendering, cancellation through delayed
cleanup, expired-note signed-clearance recovery, explicit emergency escape during
a settlement outage, challenge reconciliation and escape/finalization controls. Native-reader
tests cover JSON/SSE completion, UTF-8/chunk boundaries, cancellation, bounds,
provider errors and rejection of unsupported tool output. These checks do not
establish real-provider, cryptographic, Phantom or public-chain acceptance.

The existing funded demo, journal, deployment pins and provider budget are not
migrated by this example. See [verified feature status](../../docs/sdk/status.md)
and the separate provider/devnet evidence before making equivalence claims.

## Files

- [app.ts](app.ts), [shell.ts](shell.ts), [styles.css](styles.css): presentation and explicit user actions.
- [chat-model.ts](chat-model.ts): in-memory transcript, one-send intent and response lifecycle.
- [native-responses.ts](native-responses.ts): bounded native text/stream readers.
- [integration.ts](integration.ts): SDK browser factory integration; `mode` is required.
- [load-deployment.ts](load-deployment.ts), [reviewed-profiles.ts](reviewed-profiles.ts): public configuration and independent trust pins.
