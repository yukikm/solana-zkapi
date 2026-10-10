# Public Devnet model selection

The revision-6 profile for SDK/native **`0.2.0-devnet.8`** contains 21 regular
text Chat models from the 2026-10-09 OpenRouter catalog. Use the
[current profile and download pins](public-devnet-preview.md) for a new
installation. Existing custody retains its original profile.

Both model families use `direct_openrouter` and OpenRouter Chat Completions.
The `provider` field is `openrouter`, including for Claude models. Consumers do
not supply an OpenRouter or Anthropic management key.

| Family | Included versions |
|---|---|
| GPT 5.6 | Luna, Terra, Sol, and each Pro variant |
| GPT 6 | Luna, Sol, Astra, and each Pro variant |
| GPT 6.1 | Sol and Sol Pro |
| Claude 5 | Fable, Opus, Sonnet |
| Claude 5.1 | Fable |
| Claude 5.5 | Haiku, Opus, Sonnet |

The asynchronous OpenRouter Batch API is outside this Chat integration, so
`:batch` entries are excluded. A listed model is not a claim of tested inference,
provider credit or capacity. See [support status](../status.md).

## Find the exact model IDs

For a running clientd, use the profile directory from the
[installation guide](clientd.md):

```sh
clientd request "$ZKAPI_PROFILE" models
```

Applications use `client.listModels()`. The public gateway also exposes:

- [`GET /zkapi/v1/models`](https://d366buuvadnp3.cloudfront.net/zkapi/v1/models): OpenAI-style model list.
- [`GET /zkapi/v1/client-profile`](https://d366buuvadnp3.cloudfront.net/zkapi/v1/client-profile): profile URL and digest.

These are read-only discovery endpoints with public CORS. Use
`credentials: "omit"` in browser requests. Gateway profile discovery still
points to the preserved `.3` profile; **new `.8` installations must explicitly
select revision 6** from the [public deployment guide](public-devnet-preview.md).
Verify its hash through your trusted distribution channel.

For an explicit check of the provider's public ZDR catalog, run:

```sh
clientd request "$ZKAPI_PROFILE" model-availability
```

This sends no prompt and does not reserve capacity. Catalog presence does not
establish account access, credit or inference success. See the
[availability result meanings](../releases/usability-preview.md#zdr-model-availability-and-errors).

## Model policy and spending

Requests go directly from the consumer to OpenRouter. The configured model list
controls SDK selection; it is not an OpenRouter per-model key ACL. Quotes and
AUTH use the pinned wildcard tariff and provider-reported cost accounting. The
profile sets a one-USDC session cap and at most 128 output tokens.

Check fresh preflight, `/relay-status` and `/provider-budget` before new usage.
The public service reports operator-funded usage without a fixed trial allowance;
provider charges and note-balance checks still apply. Read
[funding and access](devnet-funding.md).

The profile is an immutable catalog snapshot. New models require a new reviewed
profile; do not replace a funded note's saved profile to update its model picker.
Operators use `scripts/public_model_profile.ts` to generate a compatible catalog
while preserving deployment and tariff bindings.
