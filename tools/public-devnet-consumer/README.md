# Independent public-profile consumer

This small integration imports only published SDK exports. Copy this directory
to an independent application and install the **reviewed SDK tarball matching the
authenticated profile's `sdkVersions`** and containing `@zkapi/solana-sdk/public-profile`.
The immutable `v0.2.0-devnet.1`
package does not contain these APIs. Use the
[current public deployment guide](../../docs/sdk/public-devnet-preview.md) for
the authenticated profile, exact downloads, access policy and service status.

The [2026-10-09 public restoration](../../docs/evidence/PD-public-restoration-20261009.md)
records public HTTP 200 at 00:54:37 UTC and all ten installed `.3` preflight
checks passing at 00:55:26, with all 7,257 installed files unchanged. Separate
relay status reported admission/recovery enabled. No AUTH, inference or wallet
action ran in this check; run fresh preflight before use. The separate
[E01 emergency withdrawal](../../docs/evidence/PD-E01-emergency-withdrawal-20261009.md)
completed from its original journal, returning one micro-USDC with zero AUTH
history. The [core completion record](../../docs/evidence/PD-core-completion-20261009.md)
adds fresh public readiness at 01:43:23 UTC and the unchanged operator financial
cut. Final evidence is linked and versioned in this documentation update. The operator's
[retained 80 GiB capacity](../../docs/evidence/PD-capacity-retained-20261009.md)
has measured headroom; no storage rollback or long-term qualification is claimed.

## Install and diagnose

Use Node 24.19.0. Verify the tarball digest through the release's
authenticated channel, then install that exact file:

```sh
npm install --save-exact /absolute/reviewed/zkapi-solana-sdk.tgz @solana/kit@8.4.0
node cli.mjs --help
node cli.mjs preflight --profile-url REVIEWED_HTTPS_PROFILE_URL \
  --profile-sha256 INDEPENDENTLY_REVIEWED_PROFILE_SHA256
```

The two profile values must come from an authenticated release. They are
installation inputs, not cryptographic constants for end users to assemble.
Preflight reads public configuration, assets and finalized chain/indexer state.
It does not create browser storage, connect a wallet, submit AUTH, reserve
provider spend, infer, sign or send a transaction. Its component errors omit
remote response bodies and credentials. It cannot prove provider credit or
replace a funded lifecycle test.

## Browser integration

Bundle `browser.ts` and `worker.ts` with your application bundler. For example,
pass `createWorker: () => new Worker(new URL('./worker.ts', import.meta.url),
{ type: 'module' })` to `openChat`. Serve the app over HTTPS with worker/WASM
and the exact configured service destinations allowed by CSP. See the
[public transport runbook](../../deploy/public-devnet/README.md).

Your UI explicitly selects a Wallet Standard wallet and account before calling
`openChat`. Preserve `storageName`, `noteId`, the same browser origin/profile and
the installed profile digest. Use `initializeStorage: true` only for an explicit
first-storage action. An absent original binding on reload is an error; it never
silently creates replacement custody. Origin storage is not a portable backup.

An invitation-gated operator may give the tester a private admission token.
Let the user enter it and pass it as `openChat({ admissionToken, ... })`; the
adapter keeps its own copy only in memory and clears that copy on disposal.
Do not put the invitation in the public profile, URLs, browser storage,
analytics, error reports or logs. Clear the UI's copy when it is no longer
needed. An optional `fetch` override is a trusted application transport and
must not log private headers. The adapter removes any supplied invitation
header from other requests and adds `x-zkapi-admission` only to the exact
authenticated control-origin `POST /zkapi/v1/sessions` route. Public profile,
asset, preflight, RPC and provider requests never receive it. The gateway
requires a valid invitation when its invitation gate is enabled before reserving subsidy for a new AUTH, while
the exact previously reserved AUTH and applicable recovery remain usable
without it. An invitation is access permission, not provider credit or a
promise of availability; obtain it through the operator's documented access
process. Native public-service acceptance remains separate.

Use `fund` then an explicit `advance` action until finalized completion; inspect
the returned state after each step. A proof pause uses `resumeProof`; a rejected
transaction needs reviewed `client.retryRejectedWalletOperation()`. An unknown
send is inspected through the same operation. Do not repeat a new deposit.

For each deliberate Send, create one UUID with `crypto.randomUUID()` and keep
it with that send intent. Pass conversation history, model, output bound and
an AbortController signal to `send`. Use advertised `modelCapabilities` to
control streaming/tool UI. Consume the response once. Only committed assistant
messages belong in subsequent context. Display `status.lastSettlement` and
unresolved sessions independently from generated text. Never retry inference
automatically. Cancellation attempts settlement; it does not promise a refund.

After interruption, reopen the same binding and use explicit `recover`. After
settlement, `withdraw` prepares mutual close and `advance` continues the saved
withdrawal. Keep recovery and withdrawal actions available when admission is
suspended. Emergency escape/finalize uses the existing
[recovery API](../../docs/sdk/recovery.md). Dispose only after all response
bodies have been consumed or canceled; disposal does not withdraw funds.
An existing binding may open for recovery when preflight fails because the
catalog/provider is unavailable. Show `diagnostic.unavailableComponent`; new
sends remain blocked until an explicit `refreshPreflight` succeeds. Original
assets, trust and finalized chain checks still run when opening the client.

## Derive native setup files

The `.6` native distribution includes this directory and the compiled SDK.
Use `/absolute/install/bin/node /absolute/install/tools/public-devnet-consumer/cli.mjs`
in place of `node cli.mjs`; no source checkout or additional npm install is
needed. Verify the installation manifest before executing its contents.

This writes a new directory only. **Installation downloads and preflight use
direct HTTPS.** `--runtime-network` selects only the generated clientd runtime
transport. Runtime Tor additionally requires `--runtime-socks5 127.0.0.1:9050`
and has no runtime direct fallback. This utility does not offer installation
downloads over Tor.

If the operator requires an invitation, save the received token in a private,
owner-only regular file outside the installation and public artifact directory.
Pass `--admission-token-file /absolute/private/invitation` to the command below.
The helper records the path and authenticated control origin in `network.json`;
it never reads, copies or prints the token. The native relay checks the
file's owner, permissions, canonical path and token encoding at startup, then
adds it only to that origin's exact `POST /zkapi/v1/sessions` request. It never
sends it to RPC, indexer, provider or other control routes. The file contains
only the 43-character base64url invitation (optionally one trailing newline),
not a provider key or local clientd management token. Keep it out of backups
intended for public distribution. This capability was introduced in `.2` and is
retained in `.6`; earlier immutable releases do not gain it retroactively.
[Native N-01](../../docs/evidence/PD-native-public-N01.md),
[OpenClaw N-02/N-03](../../docs/evidence/PD-native-public-N02-N03.md) and
[N-04 recovery/withdrawal](../../docs/evidence/PD-native-public-N04.md) record
actual public acceptance in their dated scopes.

```sh
node cli.mjs install-native --profile-url REVIEWED_HTTPS_PROFILE_URL \
  --profile-sha256 INDEPENDENTLY_REVIEWED_PROFILE_SHA256 \
  --output /absolute/new-deployment-inputs --runtime-network direct
```

The command first runs read-only preflight, then writes verified public
artifacts, per-model tariffs, `runtime.json`, `network.json`, `notices.json` and
`installation.json`. Authenticated bundle notices are copied to generated
filenames; `notices.json` maps their original labels to local filenames, byte
counts and hashes (an empty map for legacy bundles). The receipt records exact
local hashes, including the notice index. Existing or partial
directories are never overwritten. No token, wallet key, journal, custody or
provider credential is created. Preserve this directory while the profile uses
its absolute paths. New consumers use the `.6` native release and matching
[revision-4 profile](../../docs/releases/session-reuse-preview.md). Existing custody keeps its
original profile and recovery inputs.

Pass the output paths and `runtimeSha256` to the existing `clientd setup` command
in the [native quickstart](../../docs/sdk/clientd-quickstart.md). The native
installation's `release.json` digest is still independently reviewed. Setup
binds prover executables and creates local tokens; run performs its own full
chain/trust checks. An external AI client receives only the local inference
token. Keep automatic retries and model fallbacks disabled.

For direct OpenRouter, `.6` generated runtime inputs use 60-second key reuse and opt in
to `settlement_wait_ms: 120000`. After the reuse window ends and its successful responses are fully consumed
in the same process, the next explicit request may wait up to two minutes for
the old session's verified settlement before its own first AUTH/inference.
Only existing status/close/receipt operations are polled. This accommodates the
provider's settlement grace without replaying an inference. A canceled or
unknown response, process restart, failed verification, deadline or disconnect
blocks admission and retains explicit recovery. The client must permit that
response-header wait and consume the previous response to its end.
[Actual OpenClaw N-02/N-03 acceptance](../../docs/evidence/PD-native-public-N02-N03.md)
verified text and read-tool continuation using the explicit
[settlement scheduling adapter](../../docs/integrations/openclaw-settlement-adapter.md).
That dated result does not establish arbitrary AI-client compatibility or current
service availability; consult the current deployment guide and run preflight.

Reopening an existing installation requires its original profile digest with
`--installed-profile-sha256`; do not install a new profile over unresolved
state. A successful file generation is not public native transport acceptance.
