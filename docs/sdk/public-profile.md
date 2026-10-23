# Authenticated public Devnet profiles

A public profile binds the deployment bundle, RPC/indexer routes, mode, selected models and API services,
tariffs and request limits. Install its URL and exact SHA-256 from an
independently authenticated release; a checksum served only beside an untrusted
file does not authenticate it.

The API has been available since `.2`. New consumers should use the
[`.15` clients](../releases/direct-recovery-preview.md) with the
authenticated selection for their deployment.
Existing custody keeps its original profile binding. Profile verification does
not establish service availability or provider capacity; see [status](../support.md).

Release `0.2.0-devnet.13` adds profile schema 2 for registered JSON APIs and
schema 3 for finite HTTP. These profiles must explicitly list `.13`. For legacy
schema 1 only, `.13` also accepts authenticated profiles listing `.8`, `.9`,
`.10`, `.11` or `.12`, retaining their original bytes and hash. Compatibility
does not enable gateway capabilities or replace existing custody bindings.

SDK `.14` also accepts profiles listing `.13` in schemas 1, 2 and 3,
and retains the earlier schema 1 compatibility. This is a compatibility rule in
the client: profile bytes, their SHA-256 and custody bindings remain unchanged.
SDK `.15` accepts authenticated `.13` and `.14` profiles in schemas 1, 2 and 3,
plus the existing legacy schema 1 compatibility. See the
[direct recovery upgrade](../getting-started/direct-recovery-upgrade.md) for
installation and verification.

## Load and inspect before opening custody

```ts
import {
  loadPublicDeploymentProfile,
  preflightPublicDeployment,
  publicProfileClientOptions,
  PublicProfileError,
} from '@zkapi/solana-sdk/public-profile';

const loaded = await loadPublicDeploymentProfile(reviewedProfileUrl, {
  profileSha256: independentlyInstalledProfileSha256,
  // Required by the host when reopening its existing custody namespace:
  installedProfileSha256: savedOriginalProfileSha256,
  signal: abortController.signal,
});
try {
  const diagnostic = await preflightPublicDeployment(loaded);
  renderDiagnostic(diagnostic);
} catch (error) {
  if (error instanceof PublicProfileError) renderFailedComponent(error.component);
  else throw error;
}
```

Loading verifies exact profile bytes before requesting any referenced URL. It
rejects unsupported profile/SDK/protocol versions, extra fields, invalid mode/API
combinations, ambiguous capabilities, unsafe URLs, mismatched bundle/artifact
hashes, wrong deployment identities, and unpinned tariffs. It accepts the
current Devnet genesis, Circle Devnet USDC mint and SPL Token program only.
Supported transaction formats are `v0_buffer` and `v0_inline_deposit_v1`;
compact deposits still require the existing independent build capability pin.
HTTP, credential-bearing URLs, query strings, fragments, literal IP addresses,
loopback and reserved local/invalid hosts are excluded from this public format.
An ordinary DNS name still requires review of its service owner and TLS trust.

Preflight authenticates the current control manifest, checks configured models
and API operations against `GET /zkapi/v1/catalog`, verifies RPC genesis and finalized PoolConfig,
downloads both shared snapshot routes and binds their root/sequence/next-ID to
the same finalized TreeState/Clock cut. The observed chain clock must be within
120 seconds of the client clock. An unchanged tree may use an older snapshot
whose root, sequence and next-ID still match the current finalized tree.

The result keeps `models` (empty for API-only) and adds `apis`, whose entries are
`{service, operation, endpoint, tariffHash}` for the selected operations. It names
the checks and includes `chainAllowsNewOperations` (the Pool
pause flag) and `operatorAdmission: 'unverified'`. It does **not** claim signer
availability, provider credit, subsidy capacity, proof generation, CORS on every
financial route, or a completed funded lifecycle. The catalog is an availability
observation over the reviewed HTTPS route; quotes and signed receipts remain
separately verified at use. Program ELF bytes and ProgramData upgrade authority
must be bound by separate deployment receipts/operational verification.
Preflight checks snapshot syntax and finalized headers, while authorization
still reconstructs the selected membership path in the local pinned prover.

Neither call opens storage, prompts a wallet, initializes custody, requests a
quote, submits AUTH, executes an API operation or inference, or retries a request. Preflight only
uses the listed GET routes and `getGenesisHash`, `getAccountInfo`,
`getMultipleAccounts`, and `getBlock` RPC reads. Errors expose a component name,
never a server body, URL, credential or private exception. Loading has a
180-second overall deadline. Preflight in source and `.9` or later releases also
allows 180 seconds (`.8`: 60 seconds); `timeoutMs` may explicitly select up to
300 seconds. Abort applies to stalled custom fetches and streams.
Downloads omit credentials, refuse redirects and enforce byte bounds.

Bundle schema 2 also authenticates public license/provenance notices. Loading
fetches and hash-verifies every notice; `loaded.assets.notices` returns detached
byte copies keyed by the descriptor's notice labels. Schema 1 returns an empty
map. Keep these notices with redistributed artifacts; their presence records
the supplied texts, not an independent legal determination of redistribution
rights. The native input installer retains every notice under a generated
filename and writes a hashed `notices.json` index.

## Use the existing browser lifecycle

```ts
import { createBrowserClient } from '@zkapi/solana-sdk/browser';

const assets = loaded.assets;
const instance = await createBrowserClient({
  ...publicProfileClientOptions(loaded),
  wallet: explicitlySelectedWallet,
  noteId: stableNoteId,
  storageName: stableStorageName,
  createWorker: () => new Worker(workerUrl, { type: 'module' }),
  wasm: assets.wasm,
  wasmSha256: assets.wasmSha256,
  // initializeStorage: true only for an explicit new-storage action.
});
```

`publicProfileClientOptions` returns detached copies of authenticated inputs and
a Kit RPC client using bounded, credential-free, redirect-refusing transport.
Each RPC attempt in source and `.9` or later releases has a 60-second deadline
(`.8`: 30 seconds) and a 4-MiB response limit. It never
retries automatically. Supplied custom fetch implementations must honor the
request's origin, body, abort, credential and redirect policy.
Returned `models`, `services` and nested tariffs are detached copies. The profile
is recursively frozen; `assets` and `deployment` getters return
fresh copies so mutations cannot replace the internally authenticated values.

The application must bundle its own trusted module worker from
`@zkapi/solana-sdk/prover-worker`. The published WASM is checked during loading
and again when creating the browser client. Follow the existing
[quickstart](../getting-started/sdk.md) for explicit funding, conversation context, response
consumption, status, recovery and withdrawal. The profile never selects a
wallet, changes privacy mode, permits automatic inference retries, or supplies
an operator management credential.

Each model's reviewed `streaming` and `tools` restrictions are installed into
the application and native daemon model configuration. Unsupported request
features fail before quote/proof/AUTH admission. These booleans describe the
advertised subset; they do not substitute for separately published live
provider acceptance evidence.

## Versioned wire contract

The exact supported top-level fields are:

| Field | Contract |
|---|---|
| `schema` | Integer `1` (inference) or `2` (selected models and/or API services); `PUBLIC_PROFILE_SCHEMA` is `2` |
| `id`, `revision` | Lowercase stable profile identifier and positive integer revision |
| `sdkVersions` | Exact SDK build versions, subject only to the explicitly documented release compatibility rules above; profile bytes remain immutable |
| `protocolLayoutVersion` | Integer `2` |
| `bundle` | `{url, sha256}` of the existing immutable `bundle.json` format |
| `rpcUrl`, `indexerOrigin` | Reviewed browser-safe HTTPS RPC URL and canonical HTTPS indexer origin |
| `mode` | `proxy`, `direct_openrouter`, or `direct_oa`; never inferred or switched |
| `models` | Up to 32 `ModelConfiguration` entries: `id`, optional `label`, `provider`, `apis`, complete `tariff`; schema 1 requires at least one |
| `services` | Required in schema 2, forbidden in schema 1; up to 64 entries of exactly `{tariff: ApiTariff}` |
| `modelCapabilities` | Exactly one `{streaming: boolean, tools: boolean}` entry for each model ID |
| `directProviderBases` | Required only for direct mode, with exactly the selected mode's reviewed provider base |
| `oaVerifier` | Required only for `direct_oa`: independent `{base, stationId}` |
| `preparationCommitment` | Optional `confirmed` or `finalized`; financial observations remain finalized |

Schema 2 requires at least one model or service. API-only uses `mode: "proxy"`,
`models: []`, `modelCapabilities: {}` and nonempty `services`. Mixed selections
use proxy mode too. Direct mode requires at least one model and `services: []`,
with the existing independent provider/verifier pins. The exported
`PublicDeploymentProfile` union discriminates `PublicDeploymentProfileV1` and
`PublicDeploymentProfileV2`; loading schema 1 preserves its original bytes,
digest and displayed schema. See the [machine-readable schema](../contracts/public-profile.schema.json).

A service's tariff contains its complete operation descriptor. The loader checks
unique `(service, operation)` identities, bounded POST JSON and public HTTPS,
canonical validity times, JCS tariff hashes and authenticated manifest membership.
Its fixed request price must fit `cap_micro_usdc * 1000` nano-USDC. Historical
validity may load for recovery; preflight requires every selected tariff to be
active at the check time. Service failures use the `services` error component.
The endpoint is derived with `apiOperationPath()`, never supplied separately.

The catalog accepts exactly `{models, apis?}` with at most 256 entries per array.
It validates every entry and rejects duplicates, including malformed entries
outside the selection. An omitted `apis` normalizes to `[]` and passes only when
no selected operation is missing. Selected operations must match the entire
canonical descriptor, tariff hash and derived endpoint. Extra valid entries are
not added to client options. Control and execution origins may be separate;
catalog reads use the control origin while execution retains the authenticated
manifest's `inference_api_origin` field.

Registration can call `validatePublicProfileSelection()` for the pure public
selection contract. Native and local configuration use
`validateClientConfiguration()` and `validateClientSelectionPins()` from the SDK
root export before custody. These validate inputs without creating an
authenticated loaded profile; `publicProfileClientOptions()` still requires an
object returned by the public loader. No local-HTTP escape hatch exists in that
loader; local financial fixtures use the separate explicit local test path.

The manifest already enumerates genesis/program/Pool/mint, role keys, circuit,
setup, IDL and artifact identities, capabilities, cap, note TTL, challenge
period, service origins and authorities. Those values are not copied into a
second profile list. Tariff bytes must hash to a manifest-pinned entry; proxy
rates and direct provider accounting retain their existing contracts. Public
profiles include no consumer-local paths, custody, note IDs or tokens.

## Updates, revocation and recovery

Persist the original profile URL/digest with the app's deployment configuration
before creating custody. Reopening a funded or uncertain namespace must pass
that digest as `installedProfileSha256`; a changed proposed digest fails before
the first fetch. The SDK does not enumerate browser custody namespaces or infer
whether an omitted pin belongs to a new user. Hosts must enforce this rule.

Publishing a newer revision does not update existing state. A new SDK must
explicitly support the installed profile version; a profile change requires
review of exact bytes and a new independent digest. Never reuse a namespace
with changed pins, silently roll back, or migrate an unresolved note to a new
Pool. Preserve the original artifacts, deployment identity, journal and
recovery route. A separate new profile/namespace is for an explicitly new note.

Profiles are immutable snapshots, not a revocation discovery protocol. Operators
must publish authenticated admission-suspension/retirement notices and keep
applicable recovery and withdrawal routes available. A compromised or revoked
profile must not be replaced inside an unresolved journal. Restore only an
independently authenticated original configuration for its recovery; deliberate
rotation, retirement and recovery drills remain operational work.

## Schema 3 finite HTTP selection

Schema 3 adds explicit `gateway.capabilities` and authenticated mounts to schema 2.
Each version 3 service tariff pins its version 2 binding, transport and meter.
Independent installed adapter digests live in `trust.build.gatewayAdapters`.
Gateway-only profiles have empty `models` and `modelCapabilities`; native discovery
derives model identities from mounted meter resources. Mixed selections require
disjoint native routes and unambiguous model identities. No existing funded
profile is rewritten. See the [finite HTTP guide](../getting-started/finite-http-api.md).
