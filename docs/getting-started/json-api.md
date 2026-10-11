# Fixed-price JSON API getting started

This source-level tutorial uses a registered JSON lookup API and the same
`WalletClient`, `ControlClient`, `ClientDaemon`, encrypted journal, accounting
ledger and independent signer as the inference integrations. No model or token
count is required. The initial adapter supports `POST`, bounded JSON responses
and one fixed charge for each successful response.

This capability is not included in the published `0.2.0-devnet.8` packages or
enabled on the existing public deployment. Keep funded installations, profile
pins and recovery files intact. Use a separate local test directory and a fresh
synthetic note for this tutorial.

## Verify onboarding in a fresh local environment

Use a Unix environment with the pinned Node 24.19.0, npm 11.9.0, Rust 1.90.0,
Go 1.25.0, cargo-build-sbf 4.1.0/platform-tools v1.54, the Rust WASM target,
PostgreSQL tools, Python and GNU tar. Chromium is not required. The tool check
reports all missing/mismatched dependencies without installing tools, changing
shell profiles or starting a system database:

```sh
python3 scripts/run_general_api.py --check-tools
```

Prepare dependency caches explicitly, then run offline acceptance:

```sh
git submodule update --init --recursive
python3 scripts/prepare_general_api_dependencies.py
python3 scripts/run_general_api.py --onboarding
```

The dependency preparation command is a separate online fetch step for pinned
npm, Cargo and Go dependencies. It installs no toolchains. The execution command
uses locked/offline caches and fails with preparation guidance when they are
missing; it does not silently resolve a new graph or fall back to online fetching.
`ZKAPI_NODE`, `ZKAPI_NPM`, `ZKAPI_GO`, `ZKAPI_SBF` and `ZKAPI_GNU_TAR` select
already-installed executables. See [Testing](../testing.md) for the complete
artifact and dependency requirements.

Every run gets a new `target/general-api-local/run-*/` directory, isolated
PostgreSQL socket/database, synthetic provider and fresh custody. It generates
its deterministic TEST ONLY proof prerequisites from pinned source, builds the
current services, proof/native/WASM artifacts, SDK/native distributions and Vault
SBF, and retains interrupted journals and claims. It needs no historical
I04/I05/I08/I09 report or funded installation.

The onboarding path runs the same compiler/private renderer as the operator
procedure, installs the SDK outside the checkout and creates a separate native
installation. Configuration validation and API discovery precede custody funding.
The API-only lifecycle deposits 5,000,000 synthetic micro-USDC, makes a successful
lookup, an observed HTTP failure and an invalid-JSON call with stable distinct
operation IDs, verifies settlement and withdraws 4,999,750 micro-USDC. Duplicate
IDs and recovery do not execute the provider again. Separate response-loss and
timeout variants retain their original journals and verify their own terminal
balances. The no-argument regression remains available and preserves its mixed
inference charge of 1 plus API charge of 250, withdrawing 4,999,749 micro-USDC:

```sh
python3 scripts/run_general_api.py
```

Public-format profile/preflight/installer contracts use injected HTTPS/Devnet
fixture reads. Local execution uses real proofs, signatures, ledger and Vault
SBF with synthetic provider HTTP/RPC/finality. These are two separate evidence
scopes. Neither establishes public provider availability, public Devnet execution,
released client coverage or production readiness. Reports remain under ignored
`target/`; do not publish custody, database, seed or journal directories.

## Register the same operation for a new Devnet installation

Follow [Register a JSON API](api-registration.md) to create one private project
with a descriptor, integer micro-USDC price, explicit validity interval and
credential-file reference. The tool computes the exact nano-USDC tariff/hash,
new manifest bindings, schema 2 profile and complete control/dispatcher/indexer/
challenger/signer configuration. Generated files require no tariff or descriptor
edits. An API-only selection has `mode: "proxy"`, `models: []`,
`modelCapabilities: {}` and the generated `services`.

The provider supplies its ordinary POST JSON endpoint and Bearer credential.
The operator supplies the proxy, new deployment inputs, private roles, budget,
frontend and independent trust pins. Unsupported methods, authentication,
streaming and billing rules require an explicit adapter contract. Registration
never alters a funded Pool or calls the provider.

## Call it through the SDK

Install the matching unpublished source SDK tarball in your application. Load
the generated schema 2 public profile with its independently installed SHA-256,
then pass `publicProfileClientOptions(loaded)` to `createZkApiClient` together
with your existing prover, selected wallet and encrypted storage. The loaded
selection contains `mode: "proxy"`, `models: []` and authenticated `services`.
The factory verifies the tariff pin and deployment exactly as it does for
inference integrations. Continue using the existing deposit and withdrawal
methods; do not create another wallet or journal for API calls.

```ts
// Separate explicit funding action, using your already selected wallet.
await client.prepareDeposit('5000000');
const progress = await client.advanceWallet();
// Continue the saved operation until complete; handle proof_required with
// resumeWalletProof(). Pending or unknown does not mean funded.
if (!(await client.status()).canRequest) throw new Error('Funding is not ready.');
const operationId = crypto.randomUUID(); // Save this ID before dispatch.
const response = await client.requestApi({
  operationId,
  service: 'weather',
  operation: 'lookup',
  body: { city: 'Tokyo' },
});
const result = await response.json(); // Consume or cancel every response.
if (!response.ok) throw new Error('API failed; inspect saved operation status.');
const status = await client.status();
// Inspect pending work and verified settlement before withdrawal.
// If this result is uncertain, reopen this same note and call client.recover().
// Never create a new operation ID to replay it.
```

## Use the installed native client

The matching unpublished native installer materializes every authenticated
service tariff and the exact execution egress routes. It includes no upstream
provider route or provider credential. Follow the native setup procedure with
the generated API-only inputs; no model or OpenClaw configuration is needed.
`clientd setup` runs the pinned Node configuration validator before creating a
profile or custody.

Before funding, discover locally configured operations with the API token:

```sh
clientd request /absolute/profile apis
```

After explicitly funding through the existing wallet commands, send exactly one
request using a saved UUIDv4:

```sh
clientd api /absolute/profile --service weather --operation lookup \
  --operation-id 123e4567-e89b-42d3-a456-426614174000 < request.json
```

The body must be bounded JSON. The command writes the API response to stdout and
bounded operation/status/recovery guidance to stderr. Discovery has a 30-second
deadline; an API command has a 900-second overall deadline including preparation
and response consumption. It does not retry, follow redirects or replace the
operation ID. Non-2xx or transport failure exits nonzero. Inspect `status` and
use existing recovery after an uncertain result; HTTP 2xx alone does not prove
signed settlement completed. Wallet, close, recovery and withdrawal remain the
same note-management commands.

The daemon closes each generic request's session after the response is consumed
or canceled. A successful response does not bypass receipt verification; failed
settlement remains pending. Recovery uses the saved operation and exact
authorization, and never executes an uncertain request again.

An HTTP 2xx response with valid, bounded JSON costs one request unit. An observed
HTTP rejection costs zero and returns a sanitized error. A timeout, malformed
JSON or interrupted response leaves usage unknown and follows the existing
operator-loss waiver path. ZK proofs verify payment conditions, not the truth
of the API response or the operator's observation.
