# Model selection

The public Devnet profile uses **direct OpenRouter Chat Completions**. Its
`provider` is `openrouter`, including for Claude model IDs. It does not provide
Anthropic Messages or OpenAI Responses merely because those model families appear.

For a new installation, use the profile pinned in [Devnet setup](../getting-started/devnet.md).
List its exact model IDs with:

```sh
/absolute/install/bin/clientd request /absolute/profile models
```

SDK applications use `client.listModels()`. Choose a model with the required API
and capabilities; a listing alone does not establish provider credit, current
availability or successful inference.

## Discovery and profile updates

The public gateway exposes two read-only endpoints:

- `GET /zkapi/v1/models`: configured model IDs in an OpenAI-style list.
- `GET /zkapi/v1/client-profile`: a profile URL and digest.

Discovery performs no authorization, inference or custody initialization.
Authenticate the profile digest independently and check its `sdkVersions` before
installation; gateway discovery may retain an older compatible profile.

Profiles are immutable catalog snapshots. They do not automatically discover
future models. A new catalog requires a new profile and an explicit gateway
`modelProfile` pin, validated against the same deployment, bundle, provider
origin, tariff and cap. `scripts/public_model_profile.ts` rejects model-count
overflow instead of truncating it. Batch API variants are not Chat models.

Keep existing funded custody's original runtime, profile and journal. Do not
replace its saved digest to obtain a different model list.

## Pricing and access

Direct OpenRouter tariffs use `model: "*"` and provider-reported USD accounting.
The client model list limits application selection; it is not an OpenRouter
per-model key ACL. Requests travel from the client to OpenRouter.

Check `/provider-budget`, [admission policy](../getting-started/devnet.md) and
fresh preflight before funding. Changing a model list does not add provider
credit, reset reservations or increase session caps.
