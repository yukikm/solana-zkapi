# Solana clientd

The Go daemon exposes the supported inference routes, count_tokens, SSE and wallet management on **127.0.0.1:8787**. Note, authorization, billing and recovery state belongs to the existing encrypted SDK journal. Go has no second financial state machine. `runtime.ts` connects the journal to the real native prover/verifier, finalized RPC/indexer observations, v0 buffers and authenticated compact deposits.

For a new installation, follow the [native quickstart](../../docs/sdk/clientd-quickstart.md).
`clientd setup` accepts independently pinned installation/deployment inputs and
creates a private profile with separate random local tokens. `run`, `request`
and `openclaw-config` use that profile. The [OpenClaw integration](../../docs/integrations/openclaw.md)
uses a file SecretRef, a dedicated agent and disabled provider retries. Neither
setup nor configuration generation funds a note or performs inference.

The [application compatibility table](../../docs/integrations/README.md) also
links Claude Code and Codex settings. Their current CLI request formats still
hit deliberate validation guards; the settings are not a funded-use recipe.

The management-authenticated `POST /admin/wallet` also exposes explicit recovery
actions: `clear-unaccepted-auth` obtains signed permanent clearance for an
unaccepted AUTH; `emergency-escape` takes `destination_owner` and `roles` and
preserves unresolved session evidence before preparing a challengeable escape;
`reconcile-challenge` authenticates chain restoration before session recovery.
Continue saved financial steps with `advance`/`prove` and use `finalize` after the
chain-verified deadline. `recover-expired-setup` uses the existing exact-history
and finalized expiry/absence checks before rebuilding an unlanded buffer create.
None of these actions replays inference. An unresolved
emergency escape is reported in management status and blocks new inference
before quote/proof preparation. See [recovery semantics](../../docs/sdk/recovery.md).

New compact deposits are selected by the same `WalletClient` as the browser. The manifest must advertise `v0_inline_deposit_v1`, and the independently installed runtime `policy.build.transactionFormats` must allow it along with `v0_buffer`; IDL and distribution hashes must match the new build. Omission keeps legacy deployments on buffers. Rebuild the distribution with the updated SDK before enabling this capability. Existing journals retain their transport and trust pins, and unknown inline sends remain unresolved until the exact receipt is finalized. See the [SDK contract](../../packages/sdk/README.md#single-signature-deposit).

The browser uses the same `ControlClient`, `WalletClient` and original circuits through a WASM worker. The native prover is an offline stdin/stdout alternative. All three PK/VK pairs and executable hashes are pinned. There is no success-on-unavailable verifier, remote secret prover or implicit proxy fallback.

## Build and verify

Use pinned Node 24.19.0, npm 11.9.0, Go 1.25.0 and Rust 1.90.0. Go has no external module dependencies; Rust binaries have separate locks.

```sh
bash scripts/run_i04.sh
bash scripts/run_i06_i07.sh
python3 scripts/run_i08.py
python3 scripts/run_i09_challenger.py
python3 scripts/run_i08_wallet.py
python3 scripts/run_i08_clientd.py
```

`ZKAPI_GO` and `ZKAPI_NODE` select exact executables. The clientd runner checks Go races, Host/Origin/auth separation, actual SOCKS5 remote DNS, Tor outage on all network classes, passphrase custody, reuse, uncertain inference, stream cancellation, distribution integrity, and **installed Go → SDK → native proof → actual Vault SBF** deposit/withdrawal with transaction-result loss and restart. JSON-RPC/indexer envelopes and provider lifecycle fixtures are local adapters. These tests do not claim public RPC, live provider or live Tor success.

## Distribution and configuration

`python3 scripts/build_clientd_distribution.py` assembles the current OS package under `target/i08-clientd/distribution`; pass `--output /absolute/new-install` to preserve older installations. It includes Node, Go, native binaries, the compiled SDK installed from its tarball, npm dependencies pinned to the repository lock, and upstream license. The package has no workspace-source or demo dependency. A build refuses existing output. The resulting installation is portable on the same OS/architecture; setup binds paths after relocation. `distribution-result.json` supplies these configuration fields:

- `distribution`, `distribution_sha256`: whole-install manifest and independent digest pin.
- `node`, `node_sha256`, `runtime`, `runtime_sha256`: installed runtime paths and hashes.
- Add `runtime_config`, `listen` (default `127.0.0.1:8787`) and `network`.

Trust the distribution digest through an independent channel. Startup checks every installed file, rejects unlisted resolution inputs, symlinks and writable-by-others files. Keep the installation immutable while running. A local hash-pinned build does not claim production code signing/notarization or other-OS packaging.

Example network configuration (placeholder origins, not deployed services):

```json
{
  "mode": "tor",
  "socks5": "127.0.0.1:9050",
  "routes": [
    {"origin": "https://control.example", "prefix": "/zkapi/v1"},
    {"origin": "https://proxy.example", "prefix": "/v1"},
    {"origin": "https://indexer.example", "prefix": "/zkapi/v1/tree"},
    {"origin": "https://rpc.example", "prefix": "/"}
  ]
}
```

An operator using a private CA can explicitly add
`"extra_ca": {"path":"/absolute/reviewed/operator-ca.pem","sha256":"INDEPENDENTLY_REVIEWED_SHA256"}`.
The bounded regular file must be immutable to other users and match its pin.
The CA extends system roots; hostname/certificate verification, TLS 1.2 minimum,
route allowlists and no-redirect behavior stay enabled. Never derive this pin
from an untrusted server certificate or disable certificate checks.

Mode must explicitly be `direct` or `tor`. For direct provider sessions add the independently configured provider origin/API path. For `direct_oa`, also allow the separately trusted verifier's `/submit_key` path: for `oa_verifier.base: "https://verifier.example/api"`, add `{"origin":"https://verifier.example","prefix":"/api/submit_key"}`. Tor uses SOCKS5 domain-name addresses, no direct fallback and no redirect following. **Control, provider, OA verifier, indexer and RPC** use this same private Unix relay. Companion/prover processes are offline and receive secrets through stdin with a cleared environment. This is not a promise of complete anonymity.

`runtime.json` follows the `RuntimeConfig` interface in `runtime.ts`:

- `manifest` file and independently trusted `policy`; exact `artifacts` paths for IDL, all PK/VK files, tree source archive, verifier constants and manifest extras.
- `prover` and `verifier`, each `{path, sha256}`.
- Private `journal` directory, `custody` envelope file, local `note_id`.
- Explicit `mode` (`proxy`, `direct_oa`, `direct_openrouter`), per-model provider/API/tariff configuration, `rpc` URL, `indexer` origin, optional `direct_provider_bases`.
- For `direct_oa`, independently install `oa_verifier: {"base":"https://verifier.example/api","stationId":"trusted-station"}`. Use the canonical HTTPS base without a trailing slash; do not derive these pins from the control server or key response. The SDK verifies the received key and its signed evidence directly with this verifier before saving or using the key. Missing pins, mismatched evidence or verifier rejection close the same session without inference or mode fallback.
- Optional `preparation_commitment`: `confirmed` or `finalized` (default). This controls only blockhash acquisition and preflight; note/account/receipt acceptance remains finalized. A reviewed public deployment can use `confirmed` to avoid an already-old finalized blockhash expiring during a proof/sign/send workflow.
- `key_reuse_seconds`: default 60, range 0–300. A nonzero value also requests that session TTL. Zero requests a 60-second TTL and closes after each request.
- `settlement_wait_ms`: optional, maximum 180000. Current source defaults to 120000 for reusable direct sessions, otherwise 0. Direct OpenRouter and OA can wait for the verified settlement of all fully consumed successful responses in the same process before renewing. The next operation's exact bytes and UUID remain unsent during that wait. Unknown/canceled responses, restarts, errors, disconnects and deadline expiry retain explicit recovery. Published `.3` only supports opt-in waiting with zero-reuse direct OpenRouter; the public `.3` input helper retains that compatible configuration. The `.6` helper generates 60-second reuse with a 120-second wait and requires the `.6` runtime.

Native reuse is a fixed window from key acquisition, shortened by the provider's
expiry. Further requests do not extend it. Successful responses share its one
authorization and settlement. A canceled, failed or interrupted direct response
retires the key; it never retries inference. The browser application facade uses
the separate Ethereum browser policy (300-second lease, 90-second renewal margin).

The runtime checks actual finalized PoolConfig/genesis/keys/profile/artifact hashes before serving. Custody's parent directory must be mode 0700. Never reset missing/corrupt custody automatically.

Configure each model with its own tariff file. Every tariff's canonical hash must
already be pinned by the authenticated manifest. For example, these are
illustrative model IDs and local file paths, not a supplied deployment:

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

`/v1/models` lists those validated IDs and their providers. Unsupported API/model
pairs are rejected before AUTH. Proxy tariffs must match the exact model ID and
provider. Direct OA permits `chat`/`responses`, and direct OpenRouter permits
`chat`; their tariffs use model `"*"` and provider-reported USD pricing. Modes
remain explicit for the entire daemon configuration; model selection never
switches between proxy and direct.

Existing `models: ["model-id"]` plus one top-level `tariff` file remains supported
when the tariff covers every listed ID. A proxy configuration with several
different IDs and one tariff now fails startup instead of advertising models
that cannot be used. Migrate it to the entries above. Direct configurations can
retain several concrete IDs sharing one wildcard tariff. Do not mix the legacy
form with per-model entries. These checks do not rewrite configuration, saved
notes, deployment pins or pending sessions.

Run `bin/clientd serve /private/path/config.json`. Supply one JSON line on **stdin** from a password manager or protected pipe, containing distinct `inference_token` and `management_token` (at least 32 characters), `passphrase` (16–4096 UTF-8 bytes), optional `wallet_seed_base64` (32-byte local wallet seed), and `initialize_key: true` only on explicit first initialization. Secrets must not go in command arguments, environment variables, logs or shared files. The random journal key is wrapped using scrypt-32768-8-1 and AES-256-GCM. This is passphrase custody; OS keychain integration is not claimed. External wallet custody is available through the SDK wallet interface.

## Local API

All calls require the appropriate `Authorization: Bearer …`. Management and inference credentials cannot substitute for each other. Actual peer, Host port, Origin and Sec-Fetch-Site are checked; forwarding headers cannot bypass them. Foreign websites receive no default CORS access.

| Route | Purpose |
|---|---|
| `GET /v1/models` | Pinned model allowlist |
| `POST /v1/chat/completions`, `/v1/responses` | Supported explicit proxy/direct mode |
| `POST /v1/messages`, `/v1/messages/count_tokens` | Anthropic proxy mode |
| `GET /admin/upgrade-plan` | Local separate-installation guidance; no custody migration |
| `GET /admin/model-availability` | Explicit keyless ZDR catalog GET through the configured transport |
| `GET /admin/status` | Balance, wallet/session phase, startup `recovery_required` flag, expiry, unresolved IDs and journal head; no credentials/witness |
| `POST /admin/close`, `/admin/recover` | Existing SDK close/recovery |
| `POST /admin/reconcile` | Explicit missing-operation reconciliation after terminal settlement, authenticated 404 and cryptographic successor/receipt verification |
| `POST /admin/cancel-unsent` | Explicit cancellation of an authorization that was never sent and has no operations, including an expired quote; possibly sent authorizations remain unresolved |
| `POST /admin/wallet` | `deposit`, `withdraw`, `escape`, `finalize`, `advance`, `prove`, `retry-rejected` through shared WalletClient |

Wallet commands specify role public keys and destination. Explicit `escape` switches a blocked mutual-close intent to escape only before any transaction has been signed, preserving the existing nullifier, clearance intent and destination. `advance` performs one durable sign/recover step; `prove` resumes the saved operation. Explicit `retry-rejected` rechecks an exact finalized rejection, cleans up its old buffer and preserves the saved witness/nullifier/destination before reproving; finalize also rechecks the current Pending and deadline. Secret witness and signed bytes are encrypted before sends. Only a finalized receipt plus actual account reconciliation activates a deposit. An unknown execute/close/finalize never gets a replacement signature. Blockhash expiry and confirmed status alone do not establish non-execution.

Inference UUID and phase are durable. SDK .7 keeps an unsent proxy body only until the atomic send transition; direct bodies never enter the journal. Sent bodies are redacted while IDs and financial evidence remain. A supplied `Idempotency-Key` is preserved; otherwise the daemon creates one and returns `X-Zkapi-Operation-Id`. Neither direct nor proxy inference is replayed automatically. IDs in active or settled history cannot be reused. Restart recovers/closes the previous session before new work. Direct 202/missing-key recovery closes the same authorization, never reissues a key or changes mode. Disconnects before upstream headers abort inference transport as well as delivered streams, retaining uncertain intents and running the shared lifecycle finalizer. Graceful shutdown waits for authorization preparation, active streams and close persistence. Go supervisor death closes its private pipe so the SDK exits and releases the journal lock; restart retains and reconciles unresolved operations.

Direct requests use API-specific top-level allowlists before AUTH and again at
the SDK dispatch sink. Unknown fields, identity metadata and arbitrary transport
preferences are rejected. Direct OpenRouter requests always include
`provider: {zdr: true, data_collection: "deny"}`; only those fixed preferences
are accepted from callers. A provider failure causes no retry or relaxed policy.
This restriction concerns direct OpenRouter, not the proxy service or OA.
Provider routing is not cryptographic proof of deletion; providers see content
and network metadata, and OpenRouter permits implicit in-memory caching.
See [OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr).
Client tool
parameter schemas can use arbitrary property names, including `type` and
`image_url`. Direct Chat supports `response_format` text/JSON formats, and direct
Responses supports their `text.format` equivalents, including JSON Schemas.
Those selectors apply only at the named API paths; they do not enable image
inputs or hosted tools. Responses
forward only content type, retry timing, and proxy operation status/error headers.
Upstream cookies, CORS and arbitrary tracking headers are not forwarded. The
locally assigned operation ID and `no-store` cache policy remain authoritative.
Canceling a pending stream read retains its admission slot until upstream
cancellation finishes, then runs the existing settlement maintenance.

Direct Responses requests must explicitly include `"store": false`, for example
`{"model":"gpt-example","input":"Hello","store":false}`. Missing, null or true
values are rejected before authorization because that API stores responses by
default. This disables API application storage; provider logging, retention
policy and network observations remain provider trust assumptions.

An explicit new request selecting another proxy model, or arriving after the
reuse window, closes the old session first. Once the existing receipt/successor
verification makes that session terminal, the daemon continues the original new
request with its original operation ID and bytes. An active response, unfinished
settlement, verification failure, shutdown or canceled request prevents that new
authorization. Previously dispatched inference is never replayed by this handoff.

If startup cannot recover the previous session because control is unavailable or receipts need explicit reconciliation, the management API remains available with `recovery_required: true` and inference returns 409. Status reads and idle maintenance do not clear this hold. Use `recover` or `close` to finish the old session, `reconcile` for terminal absent operations, or `cancel-unsent` for an expired authorization that never left the client. The hold clears only when no pending session remains. Invalid trust/custody/chain configuration, a broken installed verifier pin, and local journal corruption still fail startup.

Proxy operators can read prompts and responses. Status includes expiry, seven-day/one-day warnings, and the rule that an expired Active note's full principal may move to treasury. Encrypted backup restoration requires an independent trusted journal head or authoritative reconciliation: encryption cannot detect whole-device rollback.

## Upstream and boundaries

Pinned upstream is `ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`. SOCKS5 code/tests adapt `zkapi-clientd/internal/relay`, with the MIT license retained at `vendor/ethereum-zkapi/zkapi-clientd/LICENSE`. The local auth/reuse/streaming contract follows upstream; Ethereum wire, plaintext wallet files and ETH billing are replaced with Solana v0, integer USDC and the shared encrypted journal. Rust reuses the original request/withdrawal/Poseidon and successor verification. Vendor/license files are unchanged.

See `docs/evidence/I08.md` for exact results. Production setup, real provider billing, public wallet/RPC, live Tor, hosted CI, other OS packages and production signatures remain separate release evidence.

SDK/native `.8` status also includes structured `privacy` information. CLI commands
`upgrade-plan` and `model-availability` use the management credential and empty
GETs. Existing `.3`/`.6`/`.7` installations can export their original status for
the new offline upgrade helper; never replace an old profile binding. See the
[consumer guide](../../docs/releases/usability-preview.md).

In `.9`, provider response headers may take up to ten minutes, within the existing
ten-minute total response limit. The local frontend waits up to fifteen minutes
for SDK response headers, allowing authorization and settlement around inference.
TCP/TLS connection limits, lease expiry and signed settlement deadlines remain
unchanged. Cancellation still propagates; no uncertain request is replayed.
