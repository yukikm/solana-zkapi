# Public-profile consumer reference

This directory contains a CLI, a browser adapter and native-input generation
helpers built against the SDK's public exports. Setup procedures are maintained
under `docs/getting-started/`:

| Task | Procedure |
|---|---|
| Install clientd and generate its deployment inputs | [clientd](../../docs/getting-started/clientd.md) |
| Build an independent browser application | [SDK application](../../docs/getting-started/sdk.md) |
| Obtain the current downloads and authenticated profile | [Public Devnet](../../docs/getting-started/public-devnet-preview.md) |
| Use a custom reviewed deployment | [Deployment inputs](../../docs/getting-started/deployment-inputs.md) |
| Check models, recover or upgrade | [Models](../../docs/getting-started/public-models.md), [recovery](../../docs/getting-started/recovery.md), [upgrading](../../docs/getting-started/upgrading.md) |

The native distribution includes these helpers and the matching compiled SDK.
An independently packaged application must use the SDK versions allowed by its
authenticated profile. Existing custody retains its original profile digest;
current release defaults never migrate an older installation.

## CLI contract

[`cli.mjs`](cli.mjs) exposes the following commands. `--help` prints exact syntax.
Profile commands require `--profile-url` and an independently trusted
`--profile-sha256`; `--installed-profile-sha256` additionally preserves an
existing binding.

| Command | Effect |
|---|---|
| `preflight` | Authenticate public configuration and assets; inspect finalized chain/indexer state and model inputs. No custody, authorization, inference, signatures or transactions. |
| `model-availability` | Load the authenticated profile and inspect the public provider ZDR catalog. It does not test account permissions or credit. |
| `install-native` | Run preflight and generate a new directory of verified native runtime inputs. It does not create local tokens, wallet keys or journals. |
| `upgrade-plan --status-file …` | Read a bounded regular JSON status file from the original runtime and produce offline upgrade guidance. It neither opens custody nor performs migration. |

Download, preflight and CLI model-metadata traffic use direct HTTPS.
`install-native` requires `--output` and `--runtime-network direct|tor`; the latter
configures subsequent clientd traffic only. Tor additionally requires
`--runtime-socks5`. The helper does not offer installation downloads over Tor.

`--admission-token-file` is an optional native-input reference for an
invitation-gated operator. The helper records its absolute path and the
authenticated control origin without reading, copying or printing the token.
The native runtime validates file ownership, permissions, canonical path and
token encoding. It adds the token only to that origin's exact
`POST /zkapi/v1/sessions` request. The public preview's current access policy is
defined in the deployment guide, not by this option's existence.

`install-native` refuses existing or partial output directories. It writes
verified artifacts, per-model tariffs, `runtime.json`, `network.json`,
`notices.json` and `installation.json`. The receipt binds exact local hashes;
`notices.json` maps authenticated notice labels to local filenames, sizes and
hashes. Preserve that directory while its absolute paths are in use.
`clientd setup` subsequently binds installed executables and creates private
local tokens and custody paths.

CLI diagnostics expose bounded component failures without response bodies,
credentials, URLs or raw nested errors. Preflight success does not establish
provider credit, paid inference, withdrawal, admission policy or continuous
availability. See the [public-profile API](../../docs/sdk/public-profile.md)
for individual check semantics.

## Browser adapter contract

[`browser.ts`](browser.ts) exports `openChat`; [`worker.ts`](worker.ts) is the
module-worker entry point. The application owns wallet selection, origin,
conversation history and presentation. The
[SDK walkthrough](../../docs/getting-started/sdk.md) supplies a complete bundling
and usage example.

`openChat` accepts an independently pinned profile URL/digest, the explicitly
selected Wallet Standard wallet/account, stable `storageName` and `noteId`, and
a worker factory. `initializeStorage: true` denotes an explicit first-storage
action. The adapter retains the original profile digest and refuses an absent
binding on ordinary reopening. Origin storage is custody, not a portable backup.

The returned object includes the browser factory's `client`, persistence and
disposal handles, plus these convenience methods:

| Member | Contract |
|---|---|
| `diagnostic` | Current preflight result and unavailable component, if any |
| `refreshPreflight()` | Recheck the original authenticated deployment |
| `fund(microUsdc)` | Prepare a deposit through the existing WalletClient |
| `advance()` / `resumeProof()` | Continue the saved wallet operation or proof |
| `recover()` | Recover the existing control session without replaying inference |
| `withdraw()` | Prepare mutual withdrawal to the explicitly selected account |
| `send({operationId, model, messages, maxOutputTokens, stream, signal?, onDelta})` | Issue one Chat request and consume its response, returning text and status |

Each send needs one UUID retained for that explicit user intent. The adapter
does not execute tools, retry inference or reconstruct lost responses. Direct
lease reuse and settlement follow the installed SDK and profile; applications
inspect `client.status()` and retain explicit recovery/withdrawal controls.

Existing custody may open for recovery when preflight reports an unavailable
component. Original asset, trust and finalized chain checks still apply, and
new sends require successful preflight plus SDK request readiness. `dispose()`
closes local handles and clears the adapter's invitation copy; it does not
settle, withdraw or delete custody. Consume or cancel responses first.

An optional `admissionToken` stays in the adapter's memory and is added only to
the exact authenticated session-creation route. It is removed from all other
requests. The application must protect and clear its own copy; neither profile,
URL, browser storage, analytics nor logs should contain it. A supplied `fetch`
override is trusted application transport and must preserve credential
redaction and the no-retry policy.
