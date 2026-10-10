# Provider acceptance

Use this guide to prepare and validate provider adapters with the existing
`ControlClient`, `WalletClient`, control services and shared accounting ledger.
For installing the client, start with [clientd](../getting-started/clientd.md).
For supported providers and observed coverage, see [status](../status.md).

The commands below prepare configuration or run local tests. A live acceptance
run needs its own reviewed deployment, provider access and spending limit.
Previously completed or uncertain operations must not be replayed.

## Credentials and capabilities

Keep credentials in an ignored, owner-only `.env` or owner-only files referenced
by absolute `_FILE` paths. Set exactly one nonempty source per credential pair;
blank placeholders are treated as absent. The preparation tool reads only its
provider variables and budget, never wallet keys or unrelated `.env` values.

| Mode | Environment variable; file alternative | Required capability |
| --- | --- | --- |
| OpenAI proxy | `ZKAPI_OPENAI_API_KEY`; `ZKAPI_OPENAI_API_KEY_FILE` | Chosen Chat Completions or Responses model and complete billable usage. |
| Anthropic proxy | `ZKAPI_ANTHROPIC_API_KEY`; `ZKAPI_ANTHROPIC_API_KEY_FILE` | Messages API version `2023-06-01` and supported cache usage fields. |
| OpenRouter proxy | `ZKAPI_OPENROUTER_API_KEY`; `ZKAPI_OPENROUTER_API_KEY_FILE` | Chosen Chat model and complete usage. |
| OpenRouter direct | `ZKAPI_OPENROUTER_MANAGEMENT_KEY`; `ZKAPI_OPENROUTER_MANAGEMENT_KEY_FILE` | Restricted key creation, listing, retirement and exact usage, including BYOK. |
| OA-org direct | `ZKAPI_OA_ORGANIZATION_KEY`; `ZKAPI_OA_ORGANIZATION_KEY_FILE` | Compatible issuance, reconciliation, final usage and retirement contract, verifier and station. |

An ordinary inference key does not imply management or organization permissions.
OA also requires `ZKAPI_OA_ISSUER_BASE`, `ZKAPI_OA_VERIFIER_BASE`,
`ZKAPI_OA_INFERENCE_BASE` and `ZKAPI_OA_STATION_ID`. Each base must be HTTPS
without credentials, query or fragment. Supported lease TTLs are 60, 120, 180,
240 and 300 seconds. The adapter retains the upstream OA verifier contract.

OpenRouter management and inference use `https://openrouter.ai/api/v1`.
Direct retirement confirms disable, waits the configured grace interval, captures
one exact `usage + byok_usage` observation durably, then confirms deletion before
signing the capped settlement. Missing usage remains pending. This capture is
not provider invoice finality; delayed costs remain the operator's risk.

Proxy destinations are fixed by the adapters. Public-provider configurations
reject fixture URL overrides, redirects, environment proxies and automatic
upstream retries. See the [provider contract](../../services/control/PROVIDERS.md).

## Prepare a reviewed plan

Start from [the empty plan template](../../config/provider-acceptance.example.json)
and save the completed plan under an ignored local directory. Its placeholders
and empty case list are not runnable. For each model, supply the actual native
endpoints, full context/output limits, cache mode, tariff and hashes of reviewed
primary source material. Recheck prices and availability before execution.

Use the `Tariff` structure in the [API specification](../specs/api-proxy.md).
`tariff_hash` is SHA-256 over JCS of the tariff body without that field. Rate
numerators are integer nano-USDC; denominators are unit counts. Include all
applicable cache rates in canonical order. Direct tariffs use `profile: null`,
`model: "*"`, `pricing_basis: "provider_reported_usd"` and empty rates; each
direct case still names the actual inference model.

Each case has these fields:

```json
{
  "id": "openai-chat-plain",
  "mode": "proxy",
  "provider": "openai",
  "model": "REPLACE_WITH_VERIFIED_MODEL",
  "endpoint": "chat_completions",
  "stream": false,
  "tools": false,
  "max_output_tokens": 32,
  "max_cost_micro_usdc": "1000000",
  "session_ttl_seconds": 60
}
```

The coordinator supports OpenAI Chat/Responses, Anthropic Messages, OpenRouter
Chat and Chat through either direct mode. Streaming and client tools are explicit
case flags. `count_tokens` is not a spending-coordinator case.

Proxy reservations cover the full context at the highest applicable input/cache
rate plus maximum requested output, with integer rounding. Direct reservations
cover at least the entire signed lease cap. Do not shrink model context limits
to fit a budget or use tariffs that omit applicable charges. The current
coordinator caps `ZKAPI_PROVIDER_BUDGET_MICRO_USDC` at `10000000` (10 USDC), assumes
`1 USD = 1 USDC`, and enforces plan request/output limits. These limits do not
grant permission to spend or constrain unrelated use of the same provider key.

After completing the plan and setting the reviewed budget in the private
environment file, run from the repository root:

```sh
python3 scripts/provider_acceptance.py preflight --plan target/provider-acceptance/plan.json --state-dir target/provider-acceptance/state --env-file .env
python3 scripts/provider_acceptance.py prepare --plan target/provider-acceptance/plan.json --state-dir target/provider-acceptance/state --env-file .env
```

`preflight` makes no network calls. It checks raw values in memory and file
metadata for `_FILE` references. `prepare` copies whitelisted credentials into
mode-0600 files and writes immutable `providers.json` and `tariffs.json`; it does
not modify input files or verify provider permissions. Changed configuration
refuses overwrite. Validate the resulting dispatcher configuration with
`dispatcherd CONFIG --check-config` before using it.

Initialize a new campaign's budget once with the tool's `budget-init` command
only for that campaign's approved limit. Keep the same plan and state directory
across restarts. Inspect existing state with:

```sh
python3 scripts/provider_acceptance.py budget-status --plan target/provider-acceptance/plan.json --state-dir target/provider-acceptance/state
```

Never initialize another directory to recover missing or uncertain state. Each
maximum is reserved durably before possible issuance or inference and remains
consumed after success, failure or uncertainty. Repeating a reserved case is
rejected. This external test budget is separate from the financial ledger.

Optional `--role`, `--profile` and repeated `--case` selectors prepare an
immutable subset under `configurations/<profile>`. They share the parent plan
and budget. Pass that profile directory to the backend's `--provider-state`;
keep the SDK helper's `stateDir` at the parent campaign root.

## Live execution and recovery

Pin reviewed tariffs in the deployment manifest before backend identity
initialization. Keep the manifest, Pool, signer state, ledger and custody bound
to the same identity. The note must cover the Pool's solvency cap even after a
charge; testnet collateral and the external provider budget are separate.

The [devnet helper](../../scripts/i10_devnet_provider.ts) exports
`runDevnetProviderAcceptance`. Its caller supplies verified artifacts, a real
prover, encrypted journal, finalized chain connection and native verifier. The
helper requires an initialized budget, reserves each case before AUTH and sends
one native inference request. It never sends Solana transactions itself.

A pass requires an actual `PROXY_USAGE`, `OPENROUTER_USAGE` or `OA_SIGNED_RECEIPT`
receipt, metered reason, evidence digest, verified successor, exact operation
and body identity, and bounded charge. A waived or unknown receipt does not pass
acceptance. The caller closes through `WalletClient` and verifies receipts and
balances independently. Completed-case resume verifies saved evidence and skips
the inference; a reserved but unreported case requires explicit recovery.

Failure reports contain bounded stage/status/timing fields, send/settlement
status and the plan hash. They omit credentials, URLs, response bodies and raw
exception text. Keep private backend logs and the original journal intact.
The [recovery verifier](../../scripts/i10_devnet_provider_recovery.ts) checks
the saved case, tariff, operation, receipt, state and budget before withdrawal.

The [native runner](../../scripts/run_i10_devnet.ts) provides distinct recovery
flags using the existing plan, profile, campaign and lifecycle journal:

| Flag | Required state and behavior |
| --- | --- |
| `--withdraw-settled-provider-case` | Verifies the recorded settlement or allowed signed zero-charge waiver, then uses ordinary mutual close. |
| `--recover-unaccepted-provider-auth` | Reconciles an uncertain, unaccepted AUTH using permanent signed clearance in the same journal. |
| `--withdraw-unstarted-provider-case` | Requires the immutable quote-503 checkpoint, no AUTH/session history and no case reservation; ordinary clearance and finalized Note/proof checks still authorize withdrawal. |

None of these paths creates another deposit or inference, erases a consumed
reservation, or turns a failed case into a pass. HTTP absence or an empty
database alone is insufficient recovery evidence.

## Local regression checks

Use the pinned Node and Rust toolchains from [Contributing](../../CONTRIBUTING.md):

```sh
python3 scripts/test_provider_acceptance.py
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --resolveJsonModule --lib ES2023,DOM --types node scripts/provider_acceptance_client.test.ts scripts/i10_devnet_provider.ts scripts/i10_devnet_provider_recovery.test.ts
node --test scripts/provider_acceptance_client.test.ts scripts/i10_provider_report.test.ts scripts/i10_devnet_provider_config.test.ts scripts/i10_devnet_provider_recovery.test.ts
python3 scripts/test_i10_provider_diagnostics.py
cargo test --manifest-path services/control/Cargo.toml --locked --test proxy_adapters --test proxy_diagnostics
```

These cover conservative reservations, redaction, persistence, one-shot inference,
settlement validation and recovery with local HTTP/proof/chain fixtures. They do
not establish live provider coverage. See [verification](verification.md) for
result storage and [public consumer preparation](../../scripts/public_consumer_acceptance.md)
for browser/native acceptance tooling.
