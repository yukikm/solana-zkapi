# GPT 5.6+ / Claude 5+ public model deployment — 2026-10-09

The requested model expansion is deployed at **06:52:31 UTC / 15:52:31 JST**.
The new immutable revision-3 profile contains **21 OpenRouter Chat models**:
14 OpenAI GPT 5.6+ models and seven Anthropic Claude 5+ models. Its exact ID list,
hashes, rollout, and checks are in the [machine-readable evidence](PD-model-expansion-20261009.json).
Consumer setup and family grouping are in [Public model selection](../sdk/public-models.md).

The profile is published at
[`profile-models-gpt56-claude5-r3.json`](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-models-gpt56-claude5-r3.json),
SHA256 `210bda7eb98fe902bf00194096355f5e3ac2ae79421477d4a9d2678b9faa1f6a`.
Its conditional S3 upload returned a matching full-object checksum and exact
version `Gx5jde8qmVIB2uZLIp1P3sdDdW0I4nRe`. Anonymous download matched all 9,786
bytes. The original `.2` and `.3` profiles remain immutable.

The optional gateway `modelProfile` setting pins this separate consumer
profile. The original grant-era profile and all grant identity/authorization
files remain unchanged. Runtime validation binds the expansion to the original
deployment, bundle, provider origin, wildcard tariff and one-USDC session cap.
No additional model-specific OpenRouter dashboard setting was needed.

The public gateway now serves:

- `GET /zkapi/v1/models`, containing the exact 21 configured IDs.
- `GET /zkapi/v1/client-profile`, containing the new profile locator and digest.

Both endpoints are read-only and do not contact OpenRouter. The existing
CloudFront `/zkapi/v1/*` behavior forwards them; no infrastructure change was
made. `/v1/models` at the public origin is not the discovery route. The original
control `/zkapi/v1/catalog` retains its authenticated wildcard tariff semantics.
Direct AUTH already uses `models: ["*"]`; the model list is SDK configuration,
not an OpenRouter per-model key ACL.

## Deployment and preservation

SSM `a931bd58-8a21-4562-8c35-c92826426c8d` completed one gateway stop/start,
yielding PID **128763**. The **51,078-byte** full receipt was independently
downloaded and matched SHA256
`d4a5136ebe3d2cefa6d09e0664feb98286e84499da6947b722a2e4a90006ac30`.

Of 106 protected files, only the two gateway sources and gateway configuration
changed. A new model-profile validator module and the new consumer profile were
added. All five other process identities and all unit policies remained equal.
The current complete database hash remained
`404b72ac11f81c76c1c4d21d436fafaec73a6f35f4704534be3171e60a370cab`;
reservations remained
`246526f2c6f0095498a07f729280ca28f3b67bcc6970f42b866f31de444ba2e5`.
This cut contains seven settled sessions, seven reservations and 40 recovery
checkpoint rows. No AUTH, inference, wallet transaction, grant initialization,
new reservation, reservation reset, client rebuild or independent chat edit was
performed by this work.

The initial read-only inspection rejected the historical four-session database
hash before any deployment mutation. Fresh inspection established that the
operator state had already advanced to seven sessions/reservations. The later
guarded rollout preserved that current state rather than restoring or relabeling
the older checkpoint. Keep the original failure and all prior evidence.

## Validation and limits

All **71 local tests passed**, zero skips, under Node **24.19.0**. Coverage includes
numeric version matching, batch/other-author rejection, exact deployment/tariff
lineage, independently pinned expansion, original budget binding, CORS, and
read-only discovery rejecting POST, credentials and extra query parameters.
The full local SDK loader verified the profile and 27 profile/bundle/asset reads.
Existing custody digest mismatch still rejects before opening that namespace.

The original installed SDK/native `.3` passed all **ten public preflight checks**
using the published 21-model profile; all **7,257** installed files remained
unchanged. Production Node syntax checks, installed legacy gateway SDK profile
loading, expanded profile validation and the unchanged exhausted budget status
also passed before the gateway start.

At **06:53:52–06:53:53 UTC**, public models, client-profile, provider-budget and
readiness all returned **HTTP200** with wildcard CORS. The 21 IDs and profile
URL/digest exactly matched preparation. Both new routes also passed public
OPTIONS with HTTP204. These checks establish bounded configuration/readiness,
not actual inference success for all models or continuous availability.

The observed budget reports **seven of seven reservations consumed**, zero
remaining micro-USDC and zero available requests. This was already true before
deployment. New inference needs a separately authorized capacity extension;
model publication does not replenish it.

The corresponding 21 `:batch` aliases belong to the separate asynchronous
[OpenRouter Batch API](https://openrouter.ai/docs/guides/routing/model-variants/overview)
and are not advertised as Chat models. This is an immutable catalog snapshot;
future eligible versions need another profile publication. Applications pinned
to older profiles retain their old model lists until their new-consumer
configuration is updated. Preserve existing custody bindings. No new source
release, Git push or hosted CI pass is claimed by this deployment.
