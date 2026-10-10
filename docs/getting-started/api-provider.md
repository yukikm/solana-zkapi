# Connect an inference API provider

Use this guide when you supply an inference API account or a service that issues
short-lived inference keys to a Solana zkAPI deployment. You prepare provider
access, model capabilities and billing inputs; the **zkAPI operator** runs the
USDC pool, ledger, signer, dispatcher and public gateway. One organization can
perform both roles. For that deployment, also follow
[operator setup](proxy-operator.md).

If you only want to use an existing deployment, install [clientd](clientd.md) or
follow the [application SDK setup](sdk.md). Consumers do not need
the operator's provider API keys.

The implemented adapters cover the combinations below. An arbitrary
OpenAI-compatible API URL is **not configurable** as a production proxy
destination. See [adding your own API](#adding-your-own-api) for that case.

## 1. Choose a supported route and obtain access

| Route / preparation role | API account requirements | Supported inference |
|---|---|---|
| OpenAI proxy / `openai` | Inference key, credit and access to the exact chosen model | Chat Completions, Responses |
| Anthropic proxy / `anthropic` | Inference key, credit, Messages version `2023-06-01`, compatible usage/cache fields | Messages; optional operator-funded count_tokens |
| OpenRouter proxy / `openrouter` | Ordinary inference key, credit and reviewed model routing/prices | Chat Completions |
| OpenRouter direct / `direct_openrouter` | **Management** key with restricted-key creation, listing, disable, usage and deletion rights, including BYOK usage | Chat Completions using the issued key |
| OA-org direct / `direct_oa` | Organization issuance/retirement access, exact usage receipts, independently trusted issuer/verifier/inference bases and station ID | Client-supported OA Chat/Responses; acceptance coordinator covers Chat |

Obtain keys from the provider's account console or your organization's secret
manager. Confirm the required permissions there. An ordinary OpenRouter
inference key cannot replace a management key. A public model listing establishes
neither account access nor available credit.

Text, client-executed tools and streaming require the adapter's supported request
and usage shapes. Hosted tools, media, persisted Responses and unsupported
metering fields are rejected before provider dispatch. Responses uses
`store=false`. See the [provider contracts](../../services/control/PROVIDERS.md)
for the complete subset and recovery behavior.

## 2. Create a private preparation directory and credential

Run the following from a repository checkout with Python 3, using the pinned
toolchains in [Contributing](../../CONTRIBUTING.md) for subsequent builds.
This example selects OpenRouter direct. Change `ZKAPI_PROVIDER_ROLE` to one role
from the table. Use a fresh directory only for a new setup; retain the same
directory for retries and recovery.

```sh
umask 077
export ZKAPI_PROVIDER_ROLE=direct_openrouter
export ZKAPI_PROVIDER_WORK="$PWD/target/provider-onboarding"
mkdir -p "$ZKAPI_PROVIDER_WORK"
chmod 700 "$ZKAPI_PROVIDER_WORK"
python3 - <<'PY'
import getpass, os
from pathlib import Path
names = {
    'openai': 'ZKAPI_OPENAI_API_KEY_FILE',
    'anthropic': 'ZKAPI_ANTHROPIC_API_KEY_FILE',
    'openrouter': 'ZKAPI_OPENROUTER_API_KEY_FILE',
    'direct_openrouter': 'ZKAPI_OPENROUTER_MANAGEMENT_KEY_FILE',
    'direct_oa': 'ZKAPI_OA_ORGANIZATION_KEY_FILE',
}
root = Path(os.environ['ZKAPI_PROVIDER_WORK']).resolve()
role = os.environ['ZKAPI_PROVIDER_ROLE']
variable = names[role]
path = root / (role + '.credential')
key = getpass.getpass('Provider credential (hidden): ')
if not 0 < len(key) <= 4096 or not all(33 <= ord(c) <= 126 for c in key):
    raise SystemExit('Use the raw printable credential without whitespace.')
with path.open('x') as output:
    output.write(key)
path.chmod(0o600)
with (root / 'provider.env').open('x') as output:
    output.write(f'{variable}={path}\n')
    output.write('ZKAPI_PROVIDER_BUDGET_MICRO_USDC=1000000\n')
PY
```

This keeps the key out of shell history, JSON configuration and command output.
The credential file has no trailing newline. The environment file contains an
absolute file reference and a **one-USDC preparation budget**, not a payment or
provider-credit purchase. Match that value to your reviewed plan before live
acceptance. Configure exactly one raw or `_FILE` source per credential; process
environment values override the environment file.

For OA, append the four public inputs supplied by your issuer to `provider.env`:
`ZKAPI_OA_ISSUER_BASE`, `ZKAPI_OA_VERIFIER_BASE`, `ZKAPI_OA_INFERENCE_BASE` and
`ZKAPI_OA_STATION_ID`. Bases must be HTTPS without embedded credentials, query or
fragment. Their values come from your reviewed provider agreement/configuration,
not from a key response. OA leases are 60, 120, 180, 240 or 300 seconds. Distribute
the verifier/station pins to clients through an independently trusted profile.

## 3. Prepare the model, tariff and acceptance plan

The preparation tool takes a complete plan and produces native provider and
tariff JSON. The following makes a **draft for one route** from the checked-in
examples. Those examples contain dated models, prices and validity windows;
review and update them before use. The command does not carry over an old
campaign's identity or reservation journal.

```sh
python3 - <<'PY'
import json, os, shutil, uuid
from pathlib import Path
root = Path(os.environ['ZKAPI_PROVIDER_WORK'])
role = os.environ['ZKAPI_PROVIDER_ROLE']
seed = json.loads(Path('config/provider-acceptance.i10.json').read_text())
cases = [c for c in seed['cases']
         if (c['provider'] if c['mode'] == 'proxy' else c['mode']) == role]
if not cases:
    raise SystemExit('No OA seed exists. Create the OA plan described below.')
case = dict(next(c for c in cases if not c['stream'] and not c['tools']))
case.update(id='first-request', max_output_tokens=32,
            max_cost_micro_usdc='1000000', session_ttl_seconds=60)
model = case['model'] if case['mode'] == 'proxy' else '*'
entry = next(m for m in seed['models']
             if (m['tariff']['provider'], m['tariff']['model']) == (case['provider'], model))
(root / 'sources').mkdir(exist_ok=True)
for source in entry['sources']:
    original = Path('config') / source['file']
    destination = root / 'sources' / original.name
    shutil.copyfile(original, destination)
    source['file'] = destination.relative_to(root).as_posix()
plan = dict(schema=1, campaign_id='provider-' + uuid.uuid4().hex,
            budget_micro_usdc='1000000', usd_usdc_ratio='1:1',
            max_requests=1, max_output_tokens=32, models=[entry], cases=[case])
with (root / 'plan.json').open('x') as output:
    json.dump(plan, output, indent=2)
    output.write('\n')
PY
```

Review `plan.json` and the files under `sources/` with the operator. Obtain the
following values from the provider's current model, pricing and API documentation
and your account's routing configuration:

| Plan field | Required value |
|---|---|
| `models[].profile` | Proxy: provider, exact model ID, supported endpoint names, **full** context/output limits and cache mode. Direct: `null`. |
| `models[].tariff` | Provider/model, version, explicit Unix-second validity window, pricing basis, complete integer rates and zero operator fee. |
| `models[].sources` | Current primary-source URL, UTC retrieval time, saved local file and its SHA-256. Files resolve relative to the plan. |
| `cases[]` | Actual inference model, mode, endpoint, streaming/tools flags, output bound, lease duration and maximum reservation. |
| `budget_micro_usdc`, `max_requests` | Explicit aggregate limits for all cases, matching the private environment budget. The coordinator supports at most 10 USDC. |

Proxy endpoint names are `chat_completions`, `responses`, `messages` and
`count_tokens`, with the provider combinations from step 1. `count_tokens` is
operator-funded and is not an inference case in this coordinator.

Proxy tariffs use `pricing_basis: "fixed_usage_rates"`. Set one rate per unit,
in the order shown, using integer decimal strings for
`nano_usdc_numerator` and `unit_denominator`:

| Cache mode | Required rate units, in order |
|---|---|
| `inclusive_read` | `cache_read_tokens`, `input_tokens`, `output_tokens` |
| `inclusive_read_write` | `cache_read_tokens`, `cache_write_tokens`, `input_tokens`, `output_tokens` |
| `anthropic_split` | `cache_read_tokens`, `cache_write_1h_tokens`, `cache_write_5m_tokens`, `input_tokens`, `output_tokens` |

For example, a reviewed rate of USD 0.15 per million tokens is 150 nano-USDC
per token at the selected 1 USD = 1 USDC policy. This illustrates the conversion;
it is not a current provider price. Use exact decimal/rational arithmetic.
Anthropic requires `anthropic_split`; the other adapters use an inclusive mode.

Direct tariffs use `model: "*"`, `pricing_basis: "provider_reported_usd"`,
`rates: []` and `operator_fee_micro_usdc: "0"`. The case and application catalog
still name real selectable models. To create an OA plan, use the same top-level
shape from [the empty template](../../config/provider-acceptance.example.json),
one model entry with `profile: null` and an OA direct tariff, and one case with
`mode: "direct_oa"`, `provider: "oa"`, `endpoint: "chat_completions"` and the
actual issuer-supported model. Fill all fields listed above; there is no
fabricated OA model or endpoint supplied by this repository.

The maximum case reservation must cover the full-context input bound plus
requested output for proxy, or at least the signed Pool cap for direct. The
note must also cover the Pool cap. A small prompt does not reduce the proxy's
conservative context reservation. Increase the reviewed limit or choose a
compatible model when necessary; do not falsify model limits or omit charges.

After updating source files, retrieval metadata, validity windows and rates,
recompute source and tariff hashes. This does not verify their accuracy:

```sh
python3 - <<'PY'
import hashlib, json, os
from pathlib import Path
root = Path(os.environ['ZKAPI_PROVIDER_WORK'])
path = root / 'plan.json'
plan = json.loads(path.read_text())
for model in plan['models']:
    for source in model['sources']:
        source['sha256'] = hashlib.sha256((root / source['file']).read_bytes()).hexdigest()
    tariff = model['tariff']
    body = {k: v for k, v in tariff.items() if k != 'tariff_hash'}
    # The tariff schema contains ASCII strings and integer values; this is JCS.
    encoded = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    tariff['tariff_hash'] = hashlib.sha256(encoded).hexdigest()
path.write_text(json.dumps(plan, indent=2) + '\n')
PY
```

## 4. Validate and generate the private configuration

```sh
python3 scripts/provider_acceptance.py preflight \
  --plan "$ZKAPI_PROVIDER_WORK/plan.json" \
  --env-file "$ZKAPI_PROVIDER_WORK/provider.env" \
  --state-dir "$ZKAPI_PROVIDER_WORK/prepared"

python3 scripts/provider_acceptance.py prepare \
  --plan "$ZKAPI_PROVIDER_WORK/plan.json" \
  --env-file "$ZKAPI_PROVIDER_WORK/provider.env" \
  --state-dir "$ZKAPI_PROVIDER_WORK/prepared"
```

Both commands report `network_requests: 0`. Require
`ready_for_native_config_validation: true` and no missing environment fields.
Preflight checks plan structure, bounds, validity and local source hashes, not
provider permissions or credit. Preparation copies credentials into mode-0600
files and writes immutable `prepared/providers.json` and `prepared/tariffs.json`.
Changed input refuses overwrite; retain the original prepared state.

The generated JSON is a provider configuration fragment, **not a full dispatcher
configuration**. OpenRouter direct bases are fixed at
`https://openrouter.ai/api/v1`; preparation sets a 60-second retirement grace.
The operator must explicitly review its deployed grace policy. Proxy entries
have `local_test_base: null`, credential paths and complete model profiles.
Do not substitute an external URL into the loopback-only fixture field.

## 5. Connect the operator deployment and verify a usable route

Hand the operator the reviewed plan, source evidence, generated provider/tariff
files and credentials through its private secret-delivery mechanism. Credential
paths must point to owner-only files on the actual service host. Never put these
files in a public artifact bundle. The operator follows
[operator setup](proxy-operator.md) to bind them to the actual pool, trusted
manifest, ledger and isolated dispatcher.

Before enabling admission, verify these joins:

1. The control catalog, dispatcher model profiles and client model catalog use
   the same provider/model/API combinations. Every configured model has its
   complete tariff; every tariff hash appears in the trusted manifest.
2. The operator's full dispatcher configuration includes its verified Devnet
   scope, manifest hash, pool, private claim directory and dedicated read-only
   Unix PostgreSQL role. Run its installed binary as the configured service user:
   `dispatcherd /absolute/path/to/runtime/dispatcher.json --check-config`.
   The file is generated by operator setup; passing `providers.json` alone is
   invalid. This check validates scope without making provider HTTP calls.
3. Run fresh public-profile preflight and inspect `/zkapi/v1/catalog` and
   `/v1/models` where the selected public gateway exposes them. Readiness and
   model listing still do not prove live inference access.
4. For live acceptance, initialize the new campaign budget once, then use the
   [provider acceptance procedure](../development/provider-acceptance.md#live-execution-and-recovery)
   with the existing SDK, funded test note and the same plan/state. Verify the
   requested inference, exact metered receipt, signed successor, bounded charge
   and key retirement/session recovery. The preparation commands never send
   that inference for you.

The public operator bootstrap currently supplies the selected OpenRouter direct
deployment. Enabling another adapter also requires the operator's corresponding
backend configuration and public route acceptance; adding a provider fragment
does not automatically publish a new gateway route or release profile.

Publish only after that route's checks pass. Client handoff consists of the
authenticated deployment/profile URL and independently distributed digest,
explicit mode, supported model/API list, tariffs, funding instructions and
recorded compatibility limits. Direct OA clients also need independently
trusted verifier/station pins. Send users to [clientd setup](clientd.md) or the
[SDK guide](sdk.md), never to your management-key file.

OpenRouter retirement disables the key, waits the configured grace, captures
exact management `usage + byok_usage`, persists it and confirms deletion before
signing the capped charge. Grace does not establish provider invoice finality;
late costs remain the operator's risk. Unknown inference or issuance is
recovered through the same journal and session without creating a replacement
request. Keep existing reservations and completed charges unchanged.

## Adding your own API

For a new inference service, configuration alone is insufficient. The existing
proxy provider enum and public egress destinations are fixed, and direct
OpenRouter accepts only its pinned API bases. An OA URL is usable only with the
complete compatible issuance, verification, receipt and retirement contract;
it is not a generic OpenAI-compatible endpoint switch.

A new adapter needs explicit provider/endpoint types, credential and egress
policy, request validation, streaming/usage normalization, conservative
reservations, tariff/receipt support, catalog and client compatibility, plus
interruption and recovery tests. Start from the
[provider adapter contracts](../../services/control/PROVIDERS.md),
[API/accounting specification](../specs/api-proxy.md) and
[local acceptance runner](../../scripts/run_i06_i07.sh). Keep the shared ledger,
signer and no-replay state machine. After implementation and offline regression,
follow steps 3–5 for scoped live acceptance and publication.
