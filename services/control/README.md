# Control service and signer

The control service owns authorization, USDC reservations, quotes, receipts and
session recovery. Provider adapters use the same PostgreSQL ledger. The separate
signer verifies immutable settlement targets and retains an append-only journal.

For installation and startup, follow [Run a ZKAPI operator](../../docs/getting-started/proxy-operator.md).
For models and credentials, use [inference provider setup](../../docs/getting-started/api-provider.md)
and the [adapter reference](PROVIDERS.md).
Registered fixed-price JSON operations are described in the
[local JSON API guide](../../docs/getting-started/json-api.md).

## Processes

| Binary | Responsibility |
|---|---|
| `controld` | Migrations, Pool provisioning, control and API HTTP, and the sole financial writer |
| `signerd` | Settlement and clearance signing, with a separate read-only ledger connection and sign-once journal |
| `dispatcherd` | Provider calls bound to durable ledger attempts and persistent one-use claims |
| `opsd` | Private read-only dashboard, monitoring, checkpoints and restore verification |
| `mtls-bridge` | Authenticated transport between existing private signer sockets |

Build with:

```sh
cargo build --release --locked --manifest-path services/control/Cargo.toml --bins
```

The financial writer holds its advisory lock on the same PostgreSQL connection
used for writes. Losing that connection stops writes. A second writer for the
same Pool cannot start. Losing dispatcher IPC leaves work unknown, never
automatically replayable.

## Configuration

[`RuntimeConfig`](src/config.rs) is strict JSON:

| Field | Purpose |
|---|---|
| `local_test_only` | Must remain `true`; the service supports test/Devnet profiles |
| `devnet` | Explicit Devnet IDL, program, build-manifest and optional setup-profile files with independent hashes |
| `listen` | Loopback HTTP socket |
| `manifest`, `trusted_manifest_hash` | Complete trusted manifest and independent canonical digest |
| `primary_rpc`, `secondary_rpc` | Distinct RPC origins checked against deployment and exit state |
| `indexer_origin` | Ready finalized tree service |
| `signer_socket` | Absolute private Unix socket path |
| `quote_seed_file`, `receipt_seed_file` | Separate owner-only 32-byte Ed25519 seeds matching the manifest |
| `enable_local_adapter` | Enables only the synthetic local adapter; use `false` for real providers |
| `providers` | Direct/proxy inference adapters, registered `api` operations and optional pinned dispatcher process |
| `tariffs` | Exact signed-quote tariff inputs, with hashes listed in the manifest |

Devnet configuration verifies build, IDL, program and setup bindings. It requires
Unix-socket database connections and authenticated public service origins.
Omitting it selects local fixtures; changing an RPC URL alone does not select a
public deployment. Mainnet and production setup are outside this profile.

`controld signer-config control.json` exports the independently pinned
[`SignerConfig`](src/signer.rs). It binds Pool, authorization, role keys and
receipt key; do not derive it from unverified restored ledger rows.
`controld provision control.json` stores immutable Pool settings with admission
disabled. Startup reconciles the signer and ledger and checks chain readiness
before admitting new work.

## HTTP and readiness

`/zkapi/v1` exposes config, catalog, tariffs, quotes, session authorization/status,
operations, receipts, close, withdrawal clearance and nullifier status. The
[indexer](../indexer/README.md) serves tree routes. Configured provider adapters
serve supported `/v1/*` inference routes and registered
`POST /zkapi/v1/api/{service}/{operation}` JSON operations. Generic operation
descriptors and version 2 tariffs carry no model or token billing requirement.
See the [OpenAPI contract](../../docs/contracts/openapi.json).

`GET /zkapi/v1/readiness` samples control, finalized chain, indexer and signer
state with a 45-second deadline and a five-second cache. Limited transient RPC
reads can retry; malformed accounts, identity failures and persistent mismatches
fail closed. Chain observations allow 60 seconds overall and 30 seconds per RPC
read. The public gateway allows 48 seconds for readiness, below its 60-second
upstream transport budget. Five-second observation freshness is unchanged.
It does not check provider credit, gateway admission or challenger readiness.
Its read retries never retry AUTH, inference or transactions.

Proxy failures before provider egress emit bounded `proxy_pre_dispatch_stopped`
diagnostics with stage, fixed reason and elapsed milliseconds. They omit prompts,
credentials, account addresses and request IDs.

`POST /zkapi/v1/sessions/retire` resolves an unaccepted AUTH with an immutable
request/quote fence and signed receipt, preserving the note for a new request.
Migration 0003 and matching SDK/gateway support are required; permanent clearance
is still withdrawal-only. See [the recovery contract](../../docs/specs/api-proxy.md#retiring-a-never-admitted-authorization).

## Recovery rules

Restart with the original manifest, primary ledger, role keys, signer journal and
dispatcher claims. A stale socket may be removed only after its previous signer
has exited and cannot resume; never remove its journal. Applied migration
checksums and journal identities must match.

The signer persists a target before signing and fsyncs the signature before
returning it. A conflicting target, missing history, unquiesced dispatch or
inconsistent charge stops signing. An epoch change, lease expiry or timeout does
not prove an old dispatcher is stopped. Use independently verified fencing and
the [operations procedures](../../docs/getting-started/operations.md).

## Local verification

Use the pinned Rust/SBF toolchains, Python 3 and PostgreSQL binaries on `PATH`.
The runners create disposable databases and write local results under `target/`:

```sh
bash scripts/run_i05.sh
bash scripts/run_i06_i07.sh
python3 scripts/run_i09_operations.py
python3 scripts/run_general_api.py
```

These cover real local proofs/signatures, Vault SBF, synthetic provider HTTP,
process interruption, signer transport and database recovery. They do not make
paid provider calls or establish public-service availability.
See [testing](../../docs/testing.md) for prerequisites and test scopes.
The JSON API runner creates a unique `target/general-api-local/run-*` directory
for each run and verifies actual local proofs and Vault SBF execution with
synthetic provider HTTP and RPC finality. It does not open funded profiles or
reuse historical journals.

## Finite HTTP gateway source capability

`providers.gateway` registers v2 bindings for
`POST /zkapi/v2/execute/{service}/{operation}`. Each entry has `api`,
`transport_artifact_sha256`, `meter_artifact_sha256`, and `credential_file`
when its authentication policy requires a secret. The source adapter pins are
SHA-256 of `src/gateway/http.rs` and `src/gateway/meter.rs`, respectively; they
must equal both the binding and independently provisioned runtime values.
The dispatcher executable remains independently hash-pinned. LLM registrations
also pin `fixtures/gateway-meter-mappings.json` through
`meter.config.provider_contract_sha256`. Runtime downloads are not supported.

Credentials are owner-private files. Bearer/API-key files contain the exact
header credential; Basic files contain a closed JSON object with `username` and
`password` strings. Account/tenant replacement requires a new binding. Public
Devnet gateway configurations require the separate dispatcher and HTTPS; numeric
loopback HTTP is restricted to synthetic local fixtures.

The carrier preserves raw targets, ordered header octets and body bytes using a
fresh HTTP/1.1 connection. It performs no redirects, retries or implicit header
injection. Declared binding trailers are required for completion. The fixed
meter does not decode opaque representations. LLM meters inspect a bounded
identity/gzip/zlib-deflate/Brotli shadow stream. An incomplete decoder or missing
terminal usage leaves accounting unknown even if the HTTP carrier completed.

Admission authenticates before buffering and uses a separate upload deadline of
`min(header_seconds, 30)` seconds. Execution retains the immutable ledger deadline
and the existing 610-second dispatcher IPC limit. Lost responses and downstream
disconnects never permit another upstream send. Every outcome uses the shared
ledger, v3 receipts and existing sign-once settlement.

Both provider APIs default omitted `service_tier` to `auto`. That selection
requires `operator_absorbs_unpriced` in the initial mapping. Explicit OpenAI
`default` and Anthropic `standard_only` select the ordinary tier. Requests are
never rewritten to add a tier. These rules describe the installed mapping,
not acceptance of any particular native-client version or public provider.

Synthetic carrier tests run with `cargo test --locked --manifest-path
services/control/Cargo.toml --test gateway_carrier`. The ignored
`gateway_http_receipt_hmac_disconnect_unknown_and_no_replay` test in
`provider_http_runtime` additionally uses disposable PostgreSQL, real request
proofs, signed settlement and a local SBF-exported account fixture. The fresh
installed native proof/SBF lifecycle is `python3 scripts/run_general_api.py
--gateway`; its reports stay under ignored `target/gateway-native-local/`.
The `--gateway-clients` mode additionally runs pinned Codex and Claude Code
binaries through the installed native gateway. Each client uses three fresh
database/custody lifecycles, each ending at the existing three-unknown provider
circuit breaker; admission is never reset. It distinguishes attempted client
retries from provider dispatches and records client compatibility separately from
financial safety. All providers and RPC finality remain local fixtures.
