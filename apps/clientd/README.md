# Solana clientd

The Go daemon exposes the supported inference routes, count_tokens, SSE and wallet management on **127.0.0.1:8787**. Note, authorization, billing and recovery state belongs to the existing encrypted SDK journal. Go has no second financial state machine. `runtime.ts` connects the journal to the real native prover/verifier, finalized RPC/indexer observations and mandatory v0 buffers.

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

`python3 scripts/build_clientd_distribution.py` assembles the current OS package under `target/i08-clientd/distribution`: Node, Go, native binaries, SDK, locked npm dependencies and upstream license. `distribution-result.json` supplies these configuration fields:

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

Mode must explicitly be `direct` or `tor`. For direct provider sessions add the independently configured provider origin/API path. For `direct_oa`, also allow the separately trusted verifier's `/submit_key` path: for `oa_verifier.base: "https://verifier.example/api"`, add `{"origin":"https://verifier.example","prefix":"/api/submit_key"}`. Tor uses SOCKS5 domain-name addresses, no direct fallback and no redirect following. **Control, provider, OA verifier, indexer and RPC** use this same private Unix relay. Companion/prover processes are offline and receive secrets through stdin with a cleared environment. This is not a promise of complete anonymity.

`runtime.json` follows the `RuntimeConfig` interface in `runtime.ts`:

- `manifest` file and independently trusted `policy`; exact `artifacts` paths for IDL, all PK/VK files, tree source archive, verifier constants and manifest extras.
- `prover` and `verifier`, each `{path, sha256}`.
- Private `journal` directory, `custody` envelope file, local `note_id`.
- Explicit `mode` (`proxy`, `direct_oa`, `direct_openrouter`), `models` allowlist, `tariff` file, `rpc` URL, `indexer` origin, optional `direct_provider_bases`.
- For `direct_oa`, independently install `oa_verifier: {"base":"https://verifier.example/api","stationId":"trusted-station"}`. Use the canonical HTTPS base without a trailing slash; do not derive these pins from the control server or key response. The SDK verifies the received key and its signed evidence directly with this verifier before saving or using the key. Missing pins, mismatched evidence or verifier rejection close the same session without inference or mode fallback.
- `key_reuse_seconds`: default 60, range 0–300. Zero closes after each request; server TTL remains 60 seconds.

The runtime checks actual finalized PoolConfig/genesis/keys/profile/artifact hashes before serving. Custody's parent directory must be mode 0700. Never reset missing/corrupt custody automatically.

Run `bin/clientd serve /private/path/config.json`. Supply one JSON line on **stdin** from a password manager or protected pipe, containing distinct `inference_token` and `management_token` (at least 32 characters), `passphrase` (16–4096 UTF-8 bytes), optional `wallet_seed_base64` (32-byte local wallet seed), and `initialize_key: true` only on explicit first initialization. Secrets must not go in command arguments, environment variables, logs or shared files. The random journal key is wrapped using scrypt-32768-8-1 and AES-256-GCM. This is passphrase custody; OS keychain integration is not claimed. External wallet custody is available through the SDK wallet interface.

## Local API

All calls require the appropriate `Authorization: Bearer …`. Management and inference credentials cannot substitute for each other. Actual peer, Host port, Origin and Sec-Fetch-Site are checked; forwarding headers cannot bypass them. Foreign websites receive no default CORS access.

| Route | Purpose |
|---|---|
| `GET /v1/models` | Pinned model allowlist |
| `POST /v1/chat/completions`, `/v1/responses` | Supported explicit proxy/direct mode |
| `POST /v1/messages`, `/v1/messages/count_tokens` | Anthropic proxy mode |
| `GET /admin/status` | Balance, wallet/session phase, startup `recovery_required` flag, expiry, unresolved IDs and journal head; no credentials/witness |
| `POST /admin/close`, `/admin/recover` | Existing SDK close/recovery |
| `POST /admin/reconcile` | Explicit missing-operation reconciliation after terminal settlement, authenticated 404 and cryptographic successor/receipt verification |
| `POST /admin/cancel-unsent` | Explicit cancellation of an authorization that was never sent and has no operations, including an expired quote; possibly sent authorizations remain unresolved |
| `POST /admin/wallet` | `deposit`, `withdraw`, `escape`, `finalize`, `advance`, `prove`, `retry-rejected` through shared WalletClient |

Wallet commands specify role public keys and destination. Explicit `escape` switches a blocked mutual-close intent to escape only before any transaction has been signed, preserving the existing nullifier, clearance intent and destination. `advance` performs one durable sign/recover step; `prove` resumes the saved operation. Explicit `retry-rejected` rechecks an exact finalized rejection, cleans up its old buffer and preserves the saved witness/nullifier/destination before reproving; finalize also rechecks the current Pending and deadline. Secret witness and signed bytes are encrypted before sends. Only a finalized receipt plus actual account reconciliation activates a deposit. An unknown execute/close/finalize never gets a replacement signature. Blockhash expiry and confirmed status alone do not establish non-execution.

Inference UUID and exact bytes are durable. A supplied `Idempotency-Key` is preserved; otherwise the daemon creates one and returns `X-Zkapi-Operation-Id`. Neither direct nor proxy inference is replayed automatically. IDs in active or settled history cannot be reused. Restart recovers/closes the previous session before new work. Direct 202/missing-key recovery closes the same authorization, never reissues a key or changes mode. Disconnects before upstream headers abort inference transport as well as delivered streams, retaining uncertain intents and running the shared lifecycle finalizer. Graceful shutdown waits for authorization preparation, active streams and close persistence. Go supervisor death closes its private pipe so the SDK exits and releases the journal lock; restart retains and reconciles unresolved operations.

If startup cannot recover the previous session because control is unavailable or receipts need explicit reconciliation, the management API remains available with `recovery_required: true` and inference returns 409. Status reads and idle maintenance do not clear this hold. Use `recover` or `close` to finish the old session, `reconcile` for terminal absent operations, or `cancel-unsent` for an expired authorization that never left the client. The hold clears only when no pending session remains. Invalid trust/custody/chain configuration, a broken installed verifier pin, and local journal corruption still fail startup.

Proxy operators can read prompts and responses. Status includes expiry, seven-day/one-day warnings, and the rule that an expired Active note's full principal may move to treasury. Encrypted backup restoration requires an independent trusted journal head or authoritative reconciliation: encryption cannot detect whole-device rollback.

## Upstream and boundaries

Pinned upstream is `ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`. SOCKS5 code/tests adapt `zkapi-clientd/internal/relay`, with the MIT license retained at `vendor/ethereum-zkapi/zkapi-clientd/LICENSE`. The local auth/reuse/streaming contract follows upstream; Ethereum wire, plaintext wallet files and ETH billing are replaced with Solana v0, integer USDC and the shared encrypted journal. Rust reuses the original request/withdrawal/Poseidon and successor verification. Vendor/license files are unchanged.

See `docs/evidence/I08.md` for exact results. Production setup, real provider billing, public wallet/RPC, live Tor, hosted CI, other OS packages and production signatures remain separate release evidence.
