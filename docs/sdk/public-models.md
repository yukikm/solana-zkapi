# Public Devnet model selection

New SDK/native **`0.2.0-devnet.8`** consumers: see the [release guide](../releases/usability-preview.md)
for exact downloads and the compatible immutable revision-6 profile. Existing
`.3` installations retain their original profile and recovery inputs.

The revision-3 consumer profile lists all 21 regular text Chat models in the
2026-10-09 OpenRouter catalog matching **OpenAI GPT 5.6 or later** or
**Anthropic Claude 5 or later**. Both families use `direct_openrouter` and the
OpenRouter Chat Completions API. The `provider` field remains `openrouter`,
including for Claude models. No separate Anthropic key is required.

| Family | Included versions |
|---|---|
| GPT 5.6 | Luna, Terra, Sol, and each Pro variant |
| GPT 6 | Luna, Sol, Astra, and each Pro variant |
| GPT 6.1 | Sol and Sol Pro |
| Claude 5 | Fable, Opus, Sonnet |
| Claude 5.1 | Fable |
| Claude 5.5 | Haiku, Opus, Sonnet |

The catalog also contains 21 corresponding `:batch` entries. Those are served
by the separate asynchronous [OpenRouter Batch API](https://openrouter.ai/docs/guides/routing/model-variants/overview),
which this Chat integration does not implement. They are excluded from the Chat
picker. Routing suffixes are not additional model versions.

## Consumer configuration

The gateway's preserved discovery input for SDK/native **0.2.0-devnet.3** is
shown below. New `.8` consumers use the revision-6 input linked above:

```json
{
  "schema": 2,
  "chain": "solana:devnet",
  "label": "Public Devnet — GPT 5.6+ and Claude 5+",
  "profileUrl": "https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-models-gpt56-claude5-r3.json",
  "profileSha256": "210bda7eb98fe902bf00194096355f5e3ac2ae79421477d4a9d2678b9faa1f6a"
}
```

The public gateway exposes two read-only discovery endpoints:

- [`GET /zkapi/v1/models`](https://d366buuvadnp3.cloudfront.net/zkapi/v1/models): configured IDs in an OpenAI-style `object: "list"` / `data` envelope.
- [`GET /zkapi/v1/client-profile`](https://d366buuvadnp3.cloudfront.net/zkapi/v1/client-profile): the profile URL and digest in the configuration shape above.

Both support public CORS and omit credentials. Discovery does not submit AUTH,
reserve capacity, initialize custody, or contact OpenRouter. Verify the profile
digest against this independently obtained pin before installing it. Applications
using a hardcoded older profile keep its old model list until their configuration
is updated. No independent chat application was changed in this deployment.

Existing custody must retain its original profile, note, journal, and recovery
inputs. Do not overwrite a saved profile digest to reopen an existing funded
namespace. Use the normal new-consumer configuration flow for the new profile;
the original immutable profiles remain available for recovery.

## Admission and accounting

The new model profile is separately pinned by the gateway's optional
`modelProfile` configuration. The grant-era `profileUrl`, `profilePath`, and
`profileSha256` remain unchanged and continue to authenticate the original
budget history. Expansion validates the same deployment, bundle, provider
origin, wildcard tariff, and one-USDC session cap. It does not initialize a grant,
reset reservations, or increase provider spending limits.

In this direct mode the actual request goes from the consumer to OpenRouter.
The configured list controls SDK model selection; it is not an OpenRouter
per-model key ACL. Quotes and AUTH use the existing `models: ["*"]` tariff and
provider-reported cost accounting.

At the original model-deployment observation, all seven authorized request
reservations were consumed and all seven sessions were settled. Those records
remain unchanged. On 2026-10-10, the operator separately selected usage without
a fixed trial allowance. Check `/provider-budget` and [funding and access](devnet-funding.md)
for schema 2 operator-funded status, then run fresh preflight. Model publication
does not change provider credit or establish inference success for each model.

The profile is an immutable catalog snapshot, not automatic future model
discovery. Later eligible releases require a new catalog snapshot/profile and
gateway pin. `scripts/public_model_profile.ts` selects numeric version ranges
and preserves the deployment and tariff bindings. SDK `.3` profiles have a
32-model bound; the generator rejects overflow instead of silently truncating.
