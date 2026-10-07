# Codex configuration and current compatibility limit

**Codex 0.145.0 cannot currently use clientd with configuration alone.** The
actual CLI reaches the local Responses endpoint, but clientd rejects its request
before AUTH or provider dispatch. Keep this integration experimental; the
configuration below is a connection template, not a supported inference setup.
Do not fund a note just to reproduce this configuration check.

The [recorded probe](../evidence/I10-codex-configuration-results.json) ran the
installed CLI in temporary home, Codex state and working directories. It changed
no user settings and used no real provider credentials or funds. The production
Go frontend and shared SDK rejected one unchanged request. Separately, a
synthetic Responses server confirmed streamed text, real local file reading and
tool-result continuation, plus exactly one HTTP request on 503 and on stream
loss. Those protocol checks bypass ZKAPI admission and billing.

## Choose the correct endpoint and mode

Codex custom providers use `POST /v1/responses`, not Chat Completions. The
OpenRouter Chat deployment used by the OpenClaw example cannot serve this route.
A reviewed deployment would need either `direct_oa` with provider `oa`, or an
explicit `proxy` model with provider `openai`, and `responses` in its configured
API list. Proxy mode changes who can read the request; do not switch modes to
work around an error. An available model name does not establish protocol or
metering compatibility.

These endpoint requirements follow the official [gateway connection guide](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway)
and [gateway compatibility requirements](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility).
Use the deployment's exact reviewed model name. A custom alias also needs
matching model metadata supplied for the installed Codex version.

## Isolated connection template

Use a separate directory for `CODEX_HOME`; do not replace your normal
`~/.codex/config.toml`. Save this as the separate directory's `config.toml`.
Replace the model placeholder with the reviewed Responses model. If an operator
supplies a model catalog, add its absolute `model_catalog_json` path before the
first TOML table.

```toml
model = "YOUR_CONFIGURED_RESPONSES_MODEL"
model_provider = "zkapi"
web_search = "disabled"

[features]
apps = false
plugins = false
browser_use = false
computer_use = false
image_generation = false
multi_agent = false
skill_search = false
tool_suggest = false
enable_request_compression = false

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

`ZKAPI_CODEX_TOKEN` must contain the profile's **local inference token**. It is not
the management token, a wallet secret, or a provider key. Supply it to the Codex
process using your secret mechanism; do not put its bytes in TOML or a command
argument. This example reads the existing private token file without printing
it and scopes the variable to the child process:

```sh
ZKAPI_CODEX_TOKEN="$(cat /absolute/private/zkapi-profile/inference-token)" \
CODEX_HOME=/absolute/private/codex-zkapi \
  codex exec --strict-config --ephemeral --skip-git-repo-check --ignore-rules \
  --sandbox read-only -C /absolute/empty-test-directory \
  --json "Reply with a short greeting."
```

The settings disable HTTP and stream retries, WebSockets and optional hosted
features for this bounded check. The official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes these provider controls. Other client versions, profiles and features
need new request-shape and failure tests. Local sandbox permissions govern
Codex's tools separately from provider authentication.

## What currently blocks the request

The actual request had `store: false` and `stream: true`. It still included
`prompt_cache_key`, `client_metadata` with session/thread/turn identifiers,
`include: ["reasoning.encrypted_content"]`, and a `custom` `apply_patch` tool.
Disabling optional features did not remove them. The direct request guard
rejects `prompt_cache_key` and the custom tool form. Its current metadata guard
does not specifically reject `client_metadata`; this is not a claim that every
identifier is filtered. The proxy's strict Responses parser also rejects the
extra top-level fields and custom tools. Merely changing the base URL or choosing proxy mode does not resolve this.

No fields are silently removed, no tool schemas are rewritten, and no financial
or retention guard is relaxed by this guide. Successful integration needs a
reviewed supported request contract and acceptance of continuation, tools,
metering, settlement and recovery. `store: false` concerns provider response
storage; it does not promise that Codex, the operator, or a provider retains no
logs. The SDK also retains admitted exact request bodies in its encrypted
journal for recovery. `--ephemeral` does not make every local artifact disappear.

After a failure, inspect clientd status. Never automatically retry an uncertain
inference or reset the note/journal. The local probe proves the configured CLI
made one request on its tested failures; it does not establish public-provider
recovery or compatibility.

## Reproduce the credential-free probe

```sh
ZKAPI_CODEX=/absolute/path/to/codex \
  target/i08-toolchain/bin/node scripts/run_codex_clientd_acceptance.ts \
  target/codex-clientd-acceptance
```

This version-pinned runner uses the production Go HTTP handler and shared SDK
with a synthetic journal, then a separate localhost Responses fixture.
Its model `gpt-5.4` is selected only to exercise bundled CLI request metadata; it
is not a recommendation or evidence of that model's provider availability.
`probeChecksPassed: true` means the documented probes behaved as expected;
`productionCompatible: false` remains the integration result. The actual Codex
Desktop application, public funding, provider billing and end-to-end ZKAPI
inference remain unverified for this client.
