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
state with a 25-second deadline and a five-second cache. Limited transient RPC
reads can retry; malformed accounts, identity failures and persistent mismatches
fail closed. It does not check provider credit, gateway admission or challenger
readiness. Its read retries never retry AUTH, inference or transactions.

Proxy failures before provider egress emit bounded `proxy_pre_dispatch_stopped`
diagnostics with stage, fixed reason and elapsed milliseconds. They omit prompts,
credentials, account addresses and request IDs.

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
