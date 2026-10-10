# Configure Codex

**Codex CLI 0.145.0 cannot currently use ZKAPI through configuration alone.**
Its Responses request is rejected before financial authorization. Desktop
acceptance is also unverified. Use [OpenClaw](openclaw.md) for the documented
agent path.

## Connection template

An isolated evaluation needs a deployment with **OpenAI Responses**: either
`direct_oa` or an explicitly selected OpenAI proxy model. The public OpenRouter
Chat profile cannot serve this API.

Save this template in a separate evaluation configuration. Replace the model
placeholder with the deployment's exact model ID; do not replace your normal
`~/.codex/config.toml`.

```toml
model = "YOUR_CONFIGURED_RESPONSES_MODEL"
model_provider = "zkapi"
web_search = "disabled"

[model_providers.zkapi]
name = "Local ZKAPI clientd"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
env_key = "ZKAPI_CODEX_TOKEN"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
```

`ZKAPI_CODEX_TOKEN` must contain only the profile's private `inference-token`,
supplied to the Codex process through your credential mechanism. Keep the
management token, wallet and data password outside Codex. If the model is an
alias, obtain compatible model catalog metadata from the operator.

The official [gateway guide](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway)
and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describe custom providers and retry settings. These settings choose a provider;
they do not establish ZKAPI compatibility.

## Current limit

The tested CLI sends `prompt_cache_key` and a custom `apply_patch` tool that
direct Responses validation rejects. The proxy parser also rejects the request's
extra fields and tool forms. Changing the URL, disabling optional features or
selecting proxy mode does not resolve this.

Do not fund a note for this configuration check or strip fields to force it
through admission. Contributors can use the repository's synthetic probe:

```sh
ZKAPI_CODEX=/absolute/path/to/codex \
  target/i08-toolchain/bin/node scripts/run_codex_clientd_acceptance.ts \
  target/codex-clientd-acceptance
```

It uses isolated configuration and synthetic responses. A passing probe means
the expected compatibility limit was reproduced, not that funded inference
works. See [support](../support.md).
