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

The default [reviewed-profiles.ts](reviewed-profiles.ts) stays empty. An app
maintainer installs each `ReviewedChatProfile` into a reviewed build; one entry
is one explicit deployment and privacy route:

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

### Local OpenRouter direct build

For a reviewed devnet operator running on this computer, the build accepts a
**public profile JSON file and its independently retained SHA256**. It validates
a closed public schema before building. A private host configuration, credential
URL, extra secret field, remote asset replacement or unsupported route fails
closed. Do not obtain the expected digest from an untrusted download. The file
contains the independent manifest/build/WASM pins and public model tariffs,
never the operator's management key, private RPC URL or signing keys.

```sh
target/i08-toolchain/bin/node examples/browser-chat/build.mjs \
  --profile /absolute/path/reviewed-profile.json \
  --profile-sha256 "$REVIEWED_PUBLIC_PROFILE_SHA256" \
  --out-dir target/browser-chat-reviewed
```

Configured builds require a separate output directory; they cannot overwrite
the default unconfigured `target/app-sdk-example`. `profile-build.json` records
the installed profile digest and exact hashes of the five built assets so the
local host can reject a mismatched build. There is no runtime URL/hash input,
runtime configuration download or query parameter that can install trust pins.

The supported local profile selects `direct_openrouter`, the exact public
`https://openrouter.ai/api/v1` base and `relay: {kind: "same_origin_devnet"}`.
Its assets use `/manifest`, `/wasm`, and `/artifacts/<encoded artifact name>`;
additional artifact names are encoded as `additional:<name>`. Logical RPC and
indexer origins are `https://rpc.zkapi.invalid` and
`https://indexer.zkapi.invalid`. The independently pinned manifest control and
inference origins remain unchanged. `preparationCommitment` may explicitly
select `confirmed` or `finalized`; proof/account acceptance remains finalized.

An app-owned adapter maps bounded RPC, indexer and control operations to the
current numeric-loopback HTTP origin's `/rpc`, `/indexer` and `/control` routes.
The corresponding local host keeps private service/RPC configuration on the
server. Provider inference, including streaming, goes directly from the browser
to OpenRouter with the original body and abort signal. Unknown origins, paths,
methods and RPC methods are rejected. Every request omits cookies, refuses
redirects and has a deadline; an error does not retry or switch direct traffic
to a proxy. The loopback mapping cannot be reused as a general public relay.

Use the separately configured
[devnet browser host](../../scripts/browser_chat_devnet_host.ts) to serve this
build and its authenticated assets. A plain `http.server` cannot supply these
service routes. The host's send permission and shared campaign budget remain
independent checks; installing a profile never authorizes inference or funding.
The [local preparation script](../../scripts/prepare_browser_chat_devnet.ts)
creates separate public profile and private host files. Keep the private file
owner-readable only and launch with:

```sh
target/i08-toolchain/bin/node scripts/browser_chat_devnet_host.ts \
  --config /absolute/path/private-config.json
```

Start with `allowTransactions: false` for inspection. After opening a local
note, the UI reads bounded public campaign totals and shows remaining request
capacity and the worst-case reservation for each new session separately from
the SDK-verified actual charge. It refreshes this hint before preparing a new
deposit or sending a new request. A read-only host, exhausted capacity or an
unavailable hint disables those two new actions; opening status, recovery and
withdrawal controls remain available. The hint cannot grant admission or reset
the budget: the host durably checks/reserves again before forwarding AUTH.
Enabling host sends requires its explicit configuration change and restart.

Use a new storage name/note ID for a new deployment, keep its origin stable, and
preserve existing funded journals. A successful build or read-only connection
does not establish actual browser CORS, Phantom funding, streaming or settlement
acceptance.

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
conversation IDs or store Responses. The text readers reject unsupported tool
output, malformed/error events and incomplete streams. Usage events are never
used as billing authority. No successful provider acceptance follows from a
configured model appearing in the picker.

The displayed transcript stays in tab memory and is not restored after reload.
The SDK retains complete request bodies in its encrypted financial journal,
including prompts and prior turns sent as context. These bodies remain in settled
history; clearing the conversation does not erase them. This is a local content
retention difference from the [Ethereum native helper's documented separation
from prompts and responses](../../vendor/ethereum-zkapi/zkapi-clientd/docs/PRIVACY.md).
The UI itself saves only public locator preferences
(profile ID, storage name and local note ID). Clearing the visible conversation
never clears financial state or replays an operation. Recovery can
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
node --test examples/browser-chat/load-deployment.test.ts
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
The build/transport suite checks pinned public configuration, credential-field
rejection, exact build hashes, bounded routing and no direct-to-proxy fallback.
The Chrome fixture also checks exhausted/unavailable admission, a stale visible
send/deposit button, and continued access to saved-state recovery and withdrawal.

The existing funded demo, journal, deployment pins and provider budget are not
migrated by this example. See [verified feature status](../../docs/sdk/status.md)
and the separate provider/devnet evidence before making equivalence claims.

## Files

- [app.ts](app.ts), [shell.ts](shell.ts), [styles.css](styles.css): presentation and explicit user actions.
- [chat-model.ts](chat-model.ts): in-memory transcript, one-send intent and response lifecycle.
- [native-responses.ts](native-responses.ts): bounded native text/stream readers.
- [integration.ts](integration.ts): SDK browser factory integration; `mode` is required.
- [load-deployment.ts](load-deployment.ts), [reviewed-profiles.ts](reviewed-profiles.ts): public configuration and independent trust pins.
