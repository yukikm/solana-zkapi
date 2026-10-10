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

## Verify the complete lifecycle locally

Use a Unix environment: this runner requires Unix sockets and Python `fcntl`.
Use the pinned Node, Rust and SBF tools in [Contributing](../../CONTRIBUTING.md)
and [Testing](../testing.md), plus a local PostgreSQL installation. Initialize
the pinned submodules and npm dependencies. The runner builds the current
control, dispatcher, signer, native verifier/prover and Vault SBF binaries;
it uses offline Cargo dependencies already installed on the machine.

The proof prerequisites are reproducible test artifacts. If they are missing,
the runner reports which prerequisite command is needed. From a fresh test
workspace, generate them in this dependency order. The prerequisite suites
also need GNU tar, the Rust `wasm32-unknown-unknown` target and Chromium:

```sh
bash scripts/run_i04.sh
bash scripts/run_i05.sh
python3 scripts/run_i09_challenger.py
python3 scripts/run_i08_wallet.py
python3 scripts/run_general_api.py
```

Run from the repository root. `ZKAPI_NODE` and `ZKAPI_SBF` can select installed
pinned executables. The prerequisite runners use their documented test output
directories; never use a funded installation as a test output directory.

The last command creates a fresh local database and encrypted journal. It
deposits 5,000,000 synthetic micro-USDC through the actual Vault SBF program,
retains a settled inference operation in the same journal, executes a JSON
lookup, verifies receipts and the signed successor, then withdraws the remainder.
It also checks an HTTP failure, invalid JSON, duplicate operation IDs and restart
recovery. The expected charges are 1 micro-USDC for the retained inference
fixture and 250 for the JSON success: withdrawal 4,999,749 micro-USDC.

Proofs, signatures, ledger accounting and Vault execution are real local tests.
Provider responses, RPC transport and finalized-chain observations are fixtures;
this does not test a public provider, public Devnet or a released package.
Each run preserves its logs and result in a new ignored directory under
`target/general-api-local/`; the commands do not need a previous run's report.

## Register an operation

The operator installs an operation descriptor and a private credential file in
`runtime.providers.api`. For example:

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
  "credential_file": "/absolute/private/weather-api-key"
}
```

The descriptor is copied into the tariff and signed quote. Clients cannot
choose another upstream URL, method, path or headers. The adapter sends the
operator credential as Bearer authorization. Production destinations require
HTTPS and public network addresses; isolated local fixtures use numeric
loopback HTTP. Redirects and automatic retries are disabled.

The tariff has `version: "2"`, `provider: "generic"`, the same `api` descriptor,
`pricing_basis: "fixed_request"`, and one rate:

```json
{"unit":"requests","nano_usdc_numerator":"250000","unit_denominator":"1"}
```

Include `valid_from`, `valid_until` and `operator_fee_micro_usdc: "0"`; omit
`model`. Compute `tariff_hash` as SHA-256 of JCS tariff bytes without that hash
field. Pin it in a **new local deployment manifest**, then authenticate that
manifest independently. Do not edit a funded installation's manifest to add a
tariff. See [the protocol contract](../specs/api-proxy.md#registered-json-api-operations)
for all fields and compatibility rules.

## Call it through the SDK

Build the SDK from source. Add `services: [{tariff}]` to the ordinary
`createZkApiClient` options, where `tariff` is the complete authenticated API
tariff. Use `mode: "proxy"` and `models: []` for an API-only installation.
The factory verifies the tariff pin and deployment exactly as it does for
inference integrations. Continue using the existing deposit and withdrawal
methods; do not create another wallet or journal for API calls.

```ts
const response = await client.requestApi({
  operationId: crypto.randomUUID(),
  service: 'weather',
  operation: 'lookup',
  body: { city: 'Tokyo' },
});
const result = await response.json(); // Consume or cancel every response.
if (!response.ok) throw new Error('API failed; inspect saved operation status.');
const status = await client.status();
// Inspect pending work and the verified lastSettlement before another action.
```

The native source runtime accepts `services: [{"tariff":"/absolute/tariff.json"}]`
with `models: []`. Use its existing API credential for
`POST /zkapi/v1/api/weather/lookup`, with `Content-Type: application/json` and a
UUIDv4 `Idempotency-Key`. `GET /zkapi/v1/apis` lists locally configured
descriptors. Wallet and recovery actions stay on the existing management routes.

The daemon closes each generic request's session after the response is consumed
or canceled. A successful response does not bypass receipt verification; failed
settlement remains pending. Recovery uses the saved operation and exact
authorization, and never executes an uncertain request again.

An HTTP 2xx response with valid, bounded JSON costs one request unit. An observed
HTTP rejection costs zero and returns a sanitized error. A timeout, malformed
JSON or interrupted response leaves usage unknown and follows the existing
operator-loss waiver path. ZK proofs verify payment conditions, not the truth
of the API response or the operator's observation.
