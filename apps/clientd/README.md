# clientd component reference

For installation, first startup, funding, application configuration and restart,
use **[Install and run clientd](../../docs/getting-started/clientd.md)**. This page
covers source builds, deployment configuration and the local API. See the
[application compatibility table](../../docs/integrations/README.md) and
[current support status](../../docs/status.md) before choosing an integration.

## Architecture

The Go supervisor serves loopback HTTP on `127.0.0.1:8787`, separates inference
and management credentials, and provides the allowlisted network relay.
[`runtime.ts`](runtime.ts) connects the compiled SDK to native proof/verifier
processes, finalized RPC/indexer observations and Solana transaction transport.
`ControlClient`, `WalletClient`, `ClientDaemon` and their encrypted journal own
authorization, accounting and recovery; Go adds no financial state machine.

Proofs run locally. All three PK/VK pairs, native executables and deployment
artifacts are pinned. The runtime checks the finalized Pool, genesis and
manifest before serving. Direct/proxy mode is explicit; failure never selects
a different mode or replays an uncertain inference/transaction.

## Build and verify

From the repository root, use Node 24.19.0, npm 11.9.0, Go 1.25.0 and Rust
1.90.0. Initialize the pinned submodule and install dependencies as described in
[CONTRIBUTING.md](../../CONTRIBUTING.md). The build also requires the upstream
proof sources and locked Rust dependencies.

```sh
python3 scripts/build_clientd_distribution.py --output /absolute/new-install
```

`ZKAPI_GO` and `ZKAPI_NODE` select the exact executables. The builder refuses
existing output, compiles Go/Rust, builds the SDK tarball and installs it with
`npm ci`, preserving repository-lock versions and integrities. The package
includes Node, the native tools, helper scripts and third-party notices. It can
run without the checkout on the same OS/architecture. A local build does not
establish release signing or verified support for another platform.

For the installed native lifecycle matrix:

```sh
python3 scripts/run_i08_clientd.py
```

This checks Go races, local authentication, SOCKS5 remote DNS/no direct fallback,
passphrase custody, streaming/recovery, distribution integrity and installed
Go → SDK → native proof → local Vault SBF deposit/withdrawal. Public RPC/provider
and live Tor acceptance are separate. Follow the contributor guide for broader
SDK/protocol checks; report missing proof/SBF prerequisites as unavailable.

## Distribution and configuration

`release.json` lists every installed file. Obtain its digest through an
independent trusted channel. Setup/startup reject changed/unlisted files,
symlinks and files writable by other users. Keep the installation immutable and
profiles outside it. The sibling `distribution-result.json` from a source build
records the installation manifest, Node/runtime paths and their digests.

Prefer the public-profile helper in the [installation guide](../../docs/getting-started/clientd.md).
For a private operator, supply reviewed `runtime.json` and `network.json` to
`clientd setup`; it binds native executables and private custody/journal paths.
Every manifest, artifact, additional-artifact and tariff path must be absolute.
The complete runtime shape is `RuntimeConfig` in [`runtime.ts`](runtime.ts):

| Field | Deployment requirement |
|---|---|
| `manifest`, `policy`, `artifacts` | Signed manifest, independent trust policy, IDL/PK/VK/tree/additional artifact paths |
| `mode`, `models` | Explicit `proxy`, `direct_oa` or `direct_openrouter`; per-model provider, API/capability and tariff policy |
| `rpc`, `indexer` | Reviewed endpoints; financial acceptance uses finalized observations |
| `direct_provider_bases` | Explicit provider base for direct mode |
| `oa_verifier` | For `direct_oa`: independently installed HTTPS `base` and trusted `stationId` |
| `prover`, `verifier` | `{path, sha256}` pins; bound by setup to the installed tools |
| `journal`, `custody`, `note_id` | Private local state; bound by setup, never silently replaced |
| `preparation_commitment` | Optional `confirmed` or `finalized` (default), only for transaction preparation; receipt/account acceptance remains finalized |
| `key_reuse_seconds` | Default 60; range 0–300, fixed from key acquisition and shortened by expiry; zero closes after each response |
| `settlement_wait_ms` | Up to 180000; current reusable direct sessions default to 120000 |

Each model uses a tariff whose canonical hash is in the authenticated manifest.
Proxy tariffs match the exact ID/provider; direct tariffs use `"*"` and
provider-reported USD pricing. A legacy string model list with one tariff is
accepted only when that tariff covers every model; do not mix legacy and object
entries. The OpenClaw configuration generator requires explicit object entries
with `chat` support. API/model mismatches fail before authorization.

Settlement waiting applies only to successful responses fully consumed in the
same process. The next intentional request keeps its own bytes/UUID unsent
until the old session settles. A restart, unknown/canceled response, timeout or
verification failure retains explicit recovery. Existing runtime files and
custody are not migrated by source or SDK updates.

Compact deposits require both manifest capability `v0_inline_deposit_v1` and
runtime trust policy `build.transactionFormats` allowing it and `v0_buffer`,
with matching IDL/distribution pins. Omission retains buffers. Existing journals
keep their original transport and trust; see the
[SDK contract](../../packages/sdk/README.md#single-signature-deposit).

### Network policy

Example only; these are not deployed service origins:

```json
{
  "mode": "tor",
  "socks5": "127.0.0.1:9050",
  "routes": [
    {"origin": "https://control.example", "prefix": "/zkapi/v1"},
    {"origin": "https://provider.example", "prefix": "/v1"},
    {"origin": "https://indexer.example", "prefix": "/zkapi/v1/tree"},
    {"origin": "https://rpc.example", "prefix": "/"}
  ]
}
```

Mode must be `direct` or `tor`. Control, provider, OA verifier, indexer and RPC
all use this relay. Tor uses SOCKS5 domain-name addresses with no direct fallback.
Redirects are rejected. Native proof/companion processes are offline and receive
secrets on stdin with a cleared environment. This does not promise anonymity.

For `direct_oa`, also allow the independently installed verifier's submit path:
base `https://verifier.example/api` requires prefix `/api/submit_key` at that
origin. Missing or mismatched verifier evidence closes the same session without
inference. An invitation-gated deployment adds
`"admission":{"origin":"https://control.example","token_file":"/absolute/private/invitation"}`;
the private token is sent only to that origin's session-creation route.

Public routes use HTTPS with trusted system roots. A reviewed private CA can add
`"extra_ca":{"path":"/absolute/operator-ca.pem","sha256":"REVIEWED_SHA256"}`.
The pinned, bounded file extends system roots; hostname verification, TLS 1.2
minimum and route restrictions remain enabled. Do not derive trust from an
untrusted server certificate.

### Supervisor entry points

`clientd setup`, `run`, `request` and `openclaw-config` use a private profile; run
`clientd --help` for their arguments. The user-facing steps are in the installation
guide. Advanced supervisors can use `clientd serve /absolute/config.json` with
`distribution`, `distribution_sha256`, Node/runtime paths and digests,
`runtime_config`, `listen` and `network` from the build/configuration above.

`serve` accepts bounded JSON on stdin containing distinct `inference_token` and
`management_token` (at least 32 characters), `passphrase` (16–4096 UTF-8 bytes),
optional `wallet_seed_base64` (32-byte seed) and `initialize_key: true` only for
first custody initialization. `run` reads local tokens from the profile, so its
stdin contains only the latter custody fields. Keep secrets out of arguments,
environment variables and logs. Custody uses scrypt-32768-8-1 and AES-256-GCM;
OS keychain integration is not provided. The custody parent must be mode `0700`.

## Local API

All calls require the correct `Authorization: Bearer …` credential. Inference
and management tokens cannot substitute for each other. The frontend validates
peer, Host/port, Origin and Sec-Fetch-Site; forwarding headers do not bypass these
checks. Foreign websites receive no default CORS access.

| Route | Credential / purpose |
|---|---|
| `GET /v1/models` | Inference: validated model allowlist |
| `POST /v1/chat/completions`, `/v1/responses` | Inference: configured API/mode |
| `POST /v1/messages`, `/v1/messages/count_tokens` | Inference: Anthropic proxy mode |
| `GET /admin/status` | Management: balance, wallet/session phase, recovery state, unresolved IDs and journal head |
| `GET /admin/upgrade-plan` | Management: read-only separate-installation guidance |
| `GET /admin/model-availability` | Management: explicit public ZDR metadata through configured transport |
| `POST /admin/close`, `/admin/recover` | Management: existing SDK settlement/recovery |
| `POST /admin/reconcile`, `/admin/cancel-unsent` | Management: explicit missing-operation reconciliation / definitely-unsent AUTH cancellation |
| `POST /admin/purge-settled-bodies` | Management: remove eligible legacy settled bodies without changing financial evidence |
| `POST /admin/wallet` | Management: shared `WalletClient` actions |

Wallet actions include `deposit`, `withdraw`, `advance`, `prove`, `escape`,
`finalize`, `retry-rejected`, `recover-expired-setup`, `clear-unaccepted-auth`,
`emergency-escape` and `reconcile-challenge`. See
[recovery semantics](../../docs/getting-started/recovery.md) for their preconditions.
`advance` continues one saved financial step. Unknown sends retain their exact
operation; only finalized receipts and account reconciliation establish success.

An `Idempotency-Key` UUID is preserved; otherwise the daemon generates one and
returns `X-Zkapi-Operation-Id`. Active/settled IDs cannot be reused. Restarts close
or recover the old session before new inference. When remote recovery is blocked,
management may remain available with `recovery_required: true` and inference
returns 409; invalid trust, custody or local journal corruption fails startup.
SIGINT/SIGTERM initiates graceful shutdown, waiting for active work and close
persistence within the supervisor's timeout. Preserve state after interruption.

Direct requests use API-specific field allowlists. OpenRouter requires
`provider: {zdr: true, data_collection: "deny"}`. Direct Responses requires
`"store": false`. These policies do not prove provider deletion or anonymity;
providers see content and network metadata. Proxy operators also see content.
There is no retry, relaxed privacy policy, provider/model switch or replay on
failure. See the [privacy guide](../../docs/releases/privacy-preview.md) for
journal minimization, legacy data and external-backup limits.

Upstream provenance and retained licenses are documented in
[vendor/README.md](../../vendor/README.md) and
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).
