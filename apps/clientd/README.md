# Solana clientd

For installation, funding and application setup, use
[getting started](../../docs/getting-started/clientd.md).
See [support](../../docs/support.md) for verified platforms and client compatibility.

The Go frontend serves inference, SSE and wallet management on
`127.0.0.1:8787`. [`runtime.ts`](runtime.ts) connects it to the SDK's
`ClientDaemon`, `ControlClient`, `WalletClient` and encrypted journal. Those
components own authorization, accounting and recovery; Go adds no financial
state machine. Native prover/verifier processes run offline with pinned binaries
and the original circuits.

## Build and verify

Use Node 24.19.0, npm 11.9.0, Go 1.25.0 and Rust 1.90.0. From the repository root:

```sh
npm ci --ignore-scripts
python3 scripts/build_clientd_distribution.py --output /absolute/new-install
```

`ZKAPI_GO` and `ZKAPI_NODE` select exact executables. The builder refuses an
existing output directory. It packages Node, clientd, native proof binaries,
the compiled SDK, locked npm dependencies and third-party notices. The package
does not require a checkout or npm at runtime.

For the local acceptance suite, prepare the pinned proof/SBF prerequisites in
[CONTRIBUTING.md](../../CONTRIBUTING.md), then run:

```sh
python3 scripts/run_i08_clientd.py
```

The suite checks Go races, authentication, SOCKS5 remote DNS, transport failure,
custody, session reuse, cancellation, distribution integrity, and installed
Go → SDK → native proof → Vault SBF deposit/withdrawal. RPC/indexer/provider
envelopes are local fixtures; this does not test public providers or live Tor.
The runner rebuilds its generated `target/i08-clientd/distribution`; do not use
that directory for a funded installation.

## Distribution and configuration

`distribution-result.json` beside the built installation provides:

- `distribution`, `distribution_sha256`: the full installation manifest and pin.
- `node`, `node_sha256`, `runtime`, `runtime_sha256`: runtime paths and pins.

A low-level daemon config also needs `runtime_config`, `network` and optional
`listen` (default `127.0.0.1:8787`). Normal users create this through
`clientd setup` in the installation guide. Startup verifies every installed file
and rejects unlisted files, symlinks and files writable by other users. Authenticate
the manifest digest independently and keep the installation immutable. Build and
verify separately for each OS/architecture.

### Network policy

Example routes, to replace with the deployment's reviewed origins:

```json
{
  "mode": "tor",
  "socks5": "127.0.0.1:9050",
  "routes": [
    {"origin":"https://control.example","prefix":"/zkapi/v1"},
    {"origin":"https://proxy.example","prefix":"/v1"},
    {"origin":"https://indexer.example","prefix":"/zkapi/v1/tree"},
    {"origin":"https://rpc.example","prefix":"/"}
  ]
}
```

`mode` must be `direct` or `tor`. Direct provider sessions need their provider's
origin/API route. `direct_oa` also needs the independently trusted verifier's
`/submit_key` route: a verifier base of `https://verifier.example/api` requires
`{"origin":"https://verifier.example","prefix":"/api/submit_key"}`.

All control, provider, verifier, indexer and RPC traffic uses this relay policy.
Tor uses SOCKS5 domain-name addresses with no direct fallback. Redirects are
refused. A private CA requires an explicit
`extra_ca: {path: "/absolute/operator-ca.pem", sha256: "REVIEWED_SHA256"}`;
hostname validation and TLS 1.2 minimum remain enabled. The policy does not
promise complete anonymity.

### Runtime inputs

[`RuntimeConfig`](runtime.ts) defines `runtime.json`:

| Field | Purpose |
|---|---|
| `manifest`, `policy` | Manifest path and independent trust policy |
| `artifacts` | Absolute paths for IDL, all PK/VK pairs, tree source, verifier constants and manifest extras |
| `prover`, `verifier` | `{path, sha256}` for each native binary |
| `journal`, `custody`, `note_id` | Private journal directory, encrypted custody file and local note ID |
| `mode` | Explicit `proxy`, `direct_oa` or `direct_openrouter` |
| `models` | Model/provider/API/tariff entries described below |
| `rpc`, `indexer` | Finalized chain and tree services |
| `direct_provider_bases` | Optional independently configured direct provider bases |
| `oa_verifier` | For `direct_oa`: independently trusted `{base, stationId}` |
| `preparation_commitment` | `confirmed` or `finalized` (default); affects preparation only |
| `key_reuse_seconds` | Fixed direct-key reuse window, default 60, range 0–300 |
| `settlement_wait_ms` | Maximum wait before a new request; default 120000 for reusable direct sessions, otherwise 0; maximum 180000 |

The runtime verifies finalized Pool/genesis, keys and artifact pins before
serving. `preparation_commitment` never lowers finalized acceptance of notes,
accounts or receipts. The custody parent must be mode `0700`.

For OA, use a canonical HTTPS verifier base without a trailing slash. Do not
derive its identity from a control response. Received keys and signed evidence
must pass that verifier before use; failure closes the same session without
inference or mode fallback.

### Models and tariffs

Each model uses an authenticated tariff file. For example:

```json
{
  "mode": "proxy",
  "models": [
    {"id":"gpt-example","provider":"openai","apis":["chat","responses"],"tariff":"/private/tariffs/openai.json"},
    {"id":"claude-example","provider":"anthropic","apis":["messages","count_tokens"],"tariff":"/private/tariffs/anthropic.json"},
    {"id":"openai/gpt-example","provider":"openrouter","apis":["chat"],"tariff":"/private/tariffs/openrouter.json"}
  ]
}
```

`/v1/models` advertises validated IDs and providers. Unsupported API/model pairs
are rejected before authorization. Proxy tariffs match the exact provider/model.
Direct OA supports `chat` and `responses`; direct OpenRouter supports `chat`.
Direct tariffs use model `"*"` and provider-reported USD pricing. Selecting a
model never changes the configured mode.

The legacy `models: ["model-id"]` with a top-level `tariff` remains supported
only when that tariff covers every listed ID. Do not mix it with object entries.
OpenClaw configuration generation requires object entries with explicit `chat`
capability. Existing journals and custody are never migrated by configuration.

Compact deposits require manifest capability `v0_inline_deposit_v1` and an
independently installed `policy.build.transactionFormats` allowing it and
`v0_buffer`, with matching IDL/distribution pins. Without this capability,
deposits use buffers. Saved operations keep their original transport and pins.

### Secret input

The low-level `clientd serve /absolute/config.json` command reads one JSON line
from a private stdin pipe:

- Distinct `inference_token` and `management_token`, each at least 32 characters.
- `passphrase`, 16–4096 UTF-8 bytes.
- Optional `wallet_seed_base64`, a 32-byte wallet seed.
- `initialize_key: true` only for explicit first custody initialization.

Never put wallet secrets or the data password in arguments, environment
variables or logs. The journal key uses scrypt-32768-8-1 and AES-256-GCM password
wrapping. Missing/corrupt custody is not automatically reset. Native helpers use
private pipes and a cleared environment; OS keychain custody is not implemented.

## Local API

All routes require the appropriate Bearer token. Inference and management
tokens are not interchangeable. Peer, Host, Origin and Sec-Fetch-Site checks
reject cross-site access; forwarded headers cannot bypass them.

| Route | Purpose |
|---|---|
| `GET /v1/models` | Validated model allowlist |
| `POST /v1/chat/completions`, `/v1/responses` | Inference in the configured mode |
| `POST /v1/messages`, `/v1/messages/count_tokens` | Anthropic proxy API |
| `GET /admin/status` | Redacted financial/recovery state, expiry, unresolved IDs, privacy information and journal head |
| `GET /admin/upgrade-plan` | Local upgrade guidance without custody migration |
| `GET /admin/model-availability` | Keyless ZDR catalog read through the configured transport |
| `POST /admin/close`, `/admin/recover` | Session settlement and explicit recovery |
| `POST /admin/reconcile` | Missing-operation reconciliation after authenticated terminal settlement |
| `POST /admin/cancel-unsent` | Cancel an authorization that was never sent and has no operations |
| `POST /admin/purge-settled-bodies` | Explicit deletion of eligible settled legacy request bodies |
| `POST /admin/wallet` | Shared WalletClient deposit, withdrawal and recovery actions |

### Wallet actions

`deposit` and `withdraw` take role public keys; withdrawal also takes a mode and
destination owner. `advance` continues one saved sign/recovery step and `prove`
resumes its proof. Only finalized receipts and account reconciliation activate
a deposit. Unknown transactions retain their exact signed bytes; blockhash expiry
or confirmed status alone does not establish non-execution.

Additional explicit actions are `escape`, `finalize`, `retry-rejected`,
`recover-expired-setup`, `clear-unaccepted-auth`, `emergency-escape` and
`reconcile-challenge`. They retain the existing note and financial history.
An unresolved emergency escape blocks new inference. See the
[recovery reference](../../docs/sdk/recovery.md) for their preconditions.

### Inference and settlement

A supplied `Idempotency-Key` becomes the durable operation UUID; otherwise
clientd creates one and returns `X-Zkapi-Operation-Id`. Used IDs cannot be reused.
Inference is never automatically replayed. Direct bodies never enter the journal;
unsent proxy bodies are retained only until the atomic send transition. Financial
records and IDs remain after sent bodies are redacted.

Successful direct responses share the fixed key lease, shortened by provider
expiry. New requests do not extend it. Zero reuse closes after each response.
A new request may wait for verified settlement of fully consumed same-process
responses before authorization. Its original bytes and UUID stay unsent during
that wait. Cancellation, uncertainty, restarts and failed settlement require
explicit recovery. A model change in proxy mode also closes the old session
before authorizing the new request.

Disconnects cancel transport, retain uncertain intents and run settlement
maintenance. Graceful shutdown waits for preparation, streams and close
persistence. Supervisor death releases the runtime and journal lock; restart
reconciles the original operations. A recovered direct session with a missing
key is closed without issuing another key.

When startup cannot settle an existing session, management remains available
with `recovery_required: true` and inference returns HTTP 409. Status reads do
not clear this hold. Use the explicit recovery action for the saved operation.
Invalid trust, chain, binary pins or local custody still fail startup.

### Request and privacy limits

Direct requests pass API-specific field allowlists before authorization and
dispatch. Unknown fields, identity metadata and arbitrary transport preferences
are rejected. Direct OpenRouter fixes
`provider: {zdr: true, data_collection: "deny"}`; provider failure does not relax
this policy. Provider routing is not proof of deletion, and the provider sees
request content and network metadata. Proxy mode additionally exposes content
to its operator.

Direct Responses requires `"store": false`. Text/JSON output selectors and
client-executed tool schemas are supported; images and hosted tools are not.
Only content type, retry timing and proxy operation status/error headers are
forwarded. Cookies, CORS and arbitrary upstream tracking headers are dropped;
local operation ID and `no-store` remain authoritative.

Status warns before note expiry. An expired Active note's full principal may
move to treasury. Keep encrypted backups plus an independently trusted journal
head or authoritative reconciliation; encryption alone cannot detect rollback
of the entire device.

## License

SOCKS5 code adapts the pinned upstream relay; cryptographic helpers reuse its
proof and successor verification code. Preserve [source provenance](../../vendor/README.md)
and [third-party notices](../../THIRD_PARTY_NOTICES.md).
