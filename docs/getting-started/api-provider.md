# Connect an API provider

An API provider supplies inference and usage accounting. A ZKAPI operator runs
authorization and settlement. If you are using ZKAPI as a customer, follow
[clientd](clientd.md) or [SDK setup](sdk.md); you do not need a provider key.

## 1. Choose a supported adapter

| Mode | Provider | Supported API |
|---|---|---|
| Proxy | OpenAI | Chat Completions, Responses |
| Proxy | OpenRouter | Chat Completions |
| Proxy | Anthropic | Messages, optional count_tokens |
| Direct | OpenRouter | Chat Completions with a short-lived provider key |
| Direct | OA | Chat Completions and Responses with verified issued keys |

These are implemented adapters, not a claim that every model has live acceptance.
See [support](../support.md). Text and client-executed tools are the supported
scope. Media, hosted tools, background execution and provider-stored conversation
history are not supported.

An arbitrary OpenAI-compatible base URL cannot be registered through configuration.
Proxy targets are fixed in the adapters; `local_test_base` is only for loopback
test fixtures. Supporting a new provider requires an adapter and its usage,
settlement and recovery tests. Reuse the existing ledger and dispatcher.

## 2. Prepare credentials

Provision real provider credit separately from Devnet USDC. Give credentials only
to the operator's private dispatcher configuration:

- OpenAI/Anthropic/OpenRouter proxy: an inference API key.
- Direct OpenRouter: a management key permitted to create, disable, inspect and
  delete session keys. Keep it separate from an inference key.
- Direct OA: issuer credentials and independently reviewed issuer, verifier,
  inference base and station ID.

Store each raw credential in an owner-only regular file, mode `0600`, without a
newline. Keep containing private directories mode `0700`. Do not put provider
keys in the browser, public manifest, SDK profile, command arguments or logs.

## 3. Configure models and prices

Add the adapter to the private `providers` object used by
[operator setup](proxy-operator.md). For a proxy adapter, supply:

| Field | Value |
|---|---|
| `provider` | `openai`, `openrouter` or `anthropic` |
| `credential_file` | Absolute private credential path |
| `local_test_base` | `null` for the real provider |
| `models[].provider`, `models[].model` | Matching provider and exact model ID |
| `models[].endpoints` | `chat_completions`, `responses`, `messages` or `count_tokens`, as supported above |
| `models[].context_tokens`, `max_output_tokens` | Verified positive integer limits |
| `models[].cache_mode` | The adapter's verified usage schema: `inclusive_read`, `inclusive_read_write` or `anthropic_split` |

Create one matching `fixed_usage_rates` tariff per proxy model. Include every
applicable input, output and cache rate as integer rational nano-USDC per usage
unit (`nano_usdc_numerator` / `unit_denominator`). Do not use floating-point
prices. Settlement rounds the session total to micro-USDC under the
[accounting rules](../specs/api-proxy.md). The conservative reservation uses the model's
context limit and maximum input rate, so the configured cap must accommodate it.

Direct tariffs use `provider_reported_usd`, model `"*"`, and an empty rates list.
The consumer profile still lists the allowed model IDs and their capabilities.
Direct OpenRouter configuration is:

```json
{
  "provider": "openrouter",
  "api_base": "https://openrouter.ai/api/v1",
  "inference_base": "https://openrouter.ai/api/v1",
  "credential_file": "/absolute/private/openrouter-management-key",
  "settlement_grace_seconds": 5
}
```

Publish tariff hashes in the signed manifest and use the exact tariffs in control
and consumer configuration. Keep previously accepted tariffs for settlement.
Adding a model only to the UI does not enable the backend. See the exact
[provider configuration](../../services/control/PROVIDERS.md) and
[tariff contract](../contracts/openapi.json).

## 4. Validate and publish

1. Review provider documentation for the selected model's limits, price and
   usage fields. Freeze those values in the adapter profile and tariff.
2. Run the local provider tests from [operator setup](proxy-operator.md).
3. Start the configured dispatcher and control service. Check
   `/zkapi/v1/catalog` and SDK preflight against the intended model/profile.
4. Test each advertised mode/API/streaming/tool combination with a separately
   authorized provider budget and test wallet. Verify its signed charge, recovery
   and withdrawal before advertising that combination as tested.
5. Publish an authenticated consumer profile and send users to
   [clientd](clientd.md) or [SDK setup](sdk.md).

Do not resend an uncertain provider request or reissue an uncertain direct key.
For direct OpenRouter, settlement disables the key, waits the configured grace,
captures management usage, confirms deletion and signs a capped charge. Delayed
provider accounting is the operator's risk; it cannot increase a settled charge.
OA uses its issuer's own retirement and receipt lifecycle.
