# Register a JSON API for a new Devnet deployment

The source registration tool describes each operation once and generates its
fixed-price tariff, authenticated schema 2 consumer profile, public proof bundle
and complete private operator configuration. It supports synchronous POST JSON,
Bearer authentication upstream and one fixed charge for a complete valid HTTP
2xx JSON response. It requires a new, unused deployment namespace. Existing
funded Pools, profiles, journals and published `.8` packages remain unchanged.

An API provider supplies the ordinary HTTPS endpoint, response contract and a
credential. It does not implement ZK proofs when the operator runs the proxy.
The operator supplies the new Devnet program/setup, provider account and budget,
private service keys, database roles, persistent storage and reviewed HTTPS
frontend. A provider running its own proxy takes both responsibilities.

## Prepare the source and reviewed inputs

Use pinned Node 24.22.1/npm 11.19.1 and the Rust toolchain in
[Contributing](../../CONTRIBUTING.md). Build the SDK and control binaries from the
same reviewed checkout:

```sh
npm ci --ignore-scripts
npm run build:sdk
cargo build --release --locked --manifest-path services/control/Cargo.toml --bins
```

Follow [new deployment setup and builds](deployment.md) to prepare a new public
setup, deployment description, IDL, program, build manifest, prover WASM,
distribution decision and notices. The registration command consumes those
independently pinned public files. It does not generate a trusted setup, deploy
a program, initialize a Pool or prove that a live Pool is unused.

Review [the registration contract](../specs/general-api-onboarding.md) and the
[project](../contracts/api-project.schema.json) and
[operator](../contracts/operator-preparation.schema.json) schemas. Copy the
tracked templates into an owner-private directory:

```sh
umask 077
mkdir /absolute/private/new-api
cp tests/fixtures/api-onboarding/staging.template.json /absolute/private/new-api/staging.json
cp tests/fixtures/api-onboarding/operator.template.json /absolute/private/new-api/operator.json
node scripts/zkapi_api.ts init --output /absolute/private/new-api/project.json
chmod 600 /absolute/private/new-api/*.json
```

Replace every `REPLACE` value. Templates are deliberately invalid until reviewed.
All file paths must be canonical absolute paths. Compute and independently review
SHA-256 pins after finishing the referenced files; changing them requires a new
pin. Do not put secret contents into command arguments or public files.

The schema 2 staging input retains the existing public setup/build/authority,
notice, origin and provenance inputs. It removes `privateRpcUrl`,
`indexerListen`, `snapshotsDirectory` and `startSlot`; those belong only to the
operator file. Leave `consumer.services: []`: registration fills this in memory.
For API-only use `mode: "proxy"`, `models: []` and `modelCapabilities: {}`. A mixed
proxy selection includes explicitly reviewed inference models and capabilities.

Set `noDeploymentOrFundingOrServiceState: true` only for genuinely unused
staging. An already deployed program instead requires the existing
`program_deployed_pool_uninitialized` provenance and independently hashed
finalized program/Pool-absence evidence. Neither declaration authorizes changing
an active Pool. Chain observation and later deployment transactions are separate
operator actions.

The operator's `targetRoot` is the final installation directory. Generated paths
refer to that root even when preparation runs elsewhere. Its inspection binary
is a locally installed, independently hash-verified `controld`. Dispatcher and
challenger Node/bridge references point to their destination-host installations;
verify those pins when installing/startup. Keep state and credentials in explicit
separate private locations.

`control.indexerOrigin` may reference the private numeric-loopback listener;
`indexer.publicOrigin` is the public HTTPS origin embedded in the consumer
profile. `indexer.startSlot` also becomes the challenger's start slot. Select and
independently verify the intended finalized Pool initialization/replay slot before
startup; a placeholder zero is not evidence of an initialization observation.
Private RPC URLs remain private except for the explicit public restricted RPC
relay at the staging origin's `/rpc` route.

Only `dispatcher.databaseUrl` embeds a private database connection string, as
required by the existing dispatcher ABI. Other DSN fields are file references.
Registration never reads those files, provider credentials or service seeds.
The manifest authority key is read only by `prepare`, when signing the new
manifest. API-only `inferenceProviders` is empty. Mixed proxy configurations must
cover exactly the selected models using the existing Rust provider configuration,
including its `credential_file`, `local_test_base`, model endpoints and cache
policy. Public providers require `local_test_base: null`.

## Declare and validate operations

The project contains the independent staging/operator pins and the declarations:

```json
{
  "api": {
    "version": "1",
    "service": "weather",
    "operation": "lookup",
    "method": "POST",
    "origin": "https://weather.example",
    "path": "/v1/current",
    "request_max_bytes": "4096",
    "response_max_bytes": "65536",
    "timeout_seconds": "30",
    "billing": "http_2xx_json"
  },
  "priceMicroUsdc": "250",
  "validFrom": "1791673200",
  "validUntil": "1794265200",
  "credentialFile": "/absolute/private/weather-api-key"
}
```

Replace the example host and validity interval for your own deployment. Price is
a positive integer **string** in micro-USDC. The compiler converts it exactly to
nano-USDC (`"250000"` here), computes the JCS tariff hash and enforces the Pool cap.
Do not edit generated tariffs or hashes. Credential references may point to files
that exist only on the destination host; startup checks their owner, mode and
contents. Unknown fields, extra authentication objects, GET/query templates,
redirects, binary responses and streaming are rejected.

```sh
node scripts/zkapi_api.ts validate --config /absolute/private/new-api/project.json
node scripts/zkapi_api.ts prepare --config /absolute/private/new-api/project.json \
  --output /absolute/private/new-api-staging
node scripts/zkapi_api.ts verify --directory /absolute/private/new-api-staging \
  --inventory-sha256 INDEPENDENTLY_REVIEWED_INVENTORY_SHA256
```

`validate` performs public input checks without signing or creating output.
`prepare` creates a new owner-private directory, runs the real offline public
loader, asks pinned `controld inspect-config` to validate public configuration
and obtain its signer configuration, then writes the inventory and completion
marker last. These commands make zero network/provider/transaction/service
actions. They never read an existing note or initialize custody.

Success prints bounded JSON containing operation identities, counts, public
artifact hashes and zero action counters. Errors use stable codes and fixed
reasons. Exit 2 denotes invalid configuration; exit 1 denotes I/O/artifact or
verification failure. No `--force`, deployment, live-test or update command exists.
A failed preparation keeps its partial directory without a completion marker.
Inspect it privately and select a new output directory for the next attempt.

## Install and start the generated configuration

Only `public/` is publishable. Keep `private/`, `provenance/`, the inventory and
reports owner-only. The tree includes:

| Path | Use |
|---|---|
| `public/profile.json`, `public/assets/` | Immutable schema 2 profile, bundle, artifacts and notices |
| `private/control.json`, `dispatcher.json` | One shared set of tariffs/descriptors and authenticated Devnet scope |
| `private/indexer.json`, `challenger.json` | Matching program/Pool, public origins and replay start slot |
| `private/signer.json`, `signer-inputs.json` | Actual inspected signer configuration and separate key/state references |
| `private/startup.json` | Config paths, DSN file/environment mappings and initialization/start order |
| `private/frontend-routes.json` | Non-executable frontend contract; TLS/CORS/frontend remain operator-provided |
| `inventory.json`, `complete.json` | Exact output hashes and last-written completion marker |

Copy the complete tree intact to `targetRoot`, preserving private modes, then
verify it using the independently reviewed inventory digest. The completion
marker alone is not a trust anchor. Changing the destination root or generated
configuration requires new preparation, not ad hoc JSON edits.

After independent finalized deployment and initialization-slot verification,
provision a new database and separate roles as described in
[operator startup](proxy-operator.md#3-configure-the-database-and-daemons).
Use `startup.json` and `signer-inputs.json` for the exact destinations and private
DSN/key files: migrate; provision the Pool with admission disabled; initialize the
new signer journal and challenger exactly once; start signer and indexer;
reconcile; then start control and challenger. No registration command performs
these actions. Never initialize replacement journals to repair an old installation.

Implement the generated frontend routes in order. All five indexer GET routes
must select the indexer before the shared control prefix, including note paths
and zero paths used for deposit/withdrawal. Generic POST paths are exact, use
the execution origin and preserve request bytes, `Authorization` and
`Idempotency-Key`. Set the control backend's `Host` header from the matched
route's authenticated public origin, so its origin check sees the intended
execution/control host. Mutation retries are disabled. The RPC relay exposes
only the listed methods and must not
reveal its private upstream credentials. The existing OpenRouter reference
gateway is a separate deployment component and is not this generic frontend.

Publish only the reviewed public files, then independently distribute the exact
profile SHA-256 and compatible SDK/native build. Release `.13` supports schema 2;
`.8` cannot load it. Keep existing funded consumers' original profile and custody
bindings. Read-only preflight verifies public configuration,
catalog and chain bindings; it does not prove provider credit, availability or
successful execution. Funded live acceptance needs its own explicit provider,
wallet, deployment and budget authorization.
