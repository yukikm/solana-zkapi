# OpenClaw through local clientd

Use OpenClaw's custom `openai-completions` provider with the local clientd URL.
The application API key is a local inference token, never an OpenRouter
management key. First install, configure, initialize and fund clientd using the
[native quickstart](../sdk/clientd-quickstart.md).

This integration is pinned and locally exercised with **OpenClaw 2026.9.8**.
The actual CLI runs streamed text, executes a read tool and sends its result in
a new inference, handles an HTTP 503 without replay, cancels on process
termination, and resumes new work after explicit SDK recovery. Those checks use
synthetic control/provider/proof fixtures through the production Go frontend
and compiled SDK. The separate native Vault test covers the complete installed
clientd supervisor, process restart and real local SBF.

A separate [actual devnet run](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-openclaw-devnet.md) completed
funding, OpenClaw streamed text, one real read tool and its continuation, signed
settlement, clean settled restart and ordinary withdrawal. It used the installed
native runtime and production Go HTTP handler with a bounded operator devnet
Unix egress adapter. Public acceptance of the complete installed supervisor and
its normal egress policy remains unverified. The live profile retained its
immutable earlier SDK archive; the final portable package includes the later
optional SDK SSE-reader fix and passed fresh local native/SBF and OpenClaw tests.
Exact package digests and the independent finalized receipts are in the report.

## Generate configuration

Choose an ID from `clientd request PROFILE models`. Use context/output limits
reviewed for that model and its tariff; the example values are placeholders for
an appropriately configured text model, not a funding limit.

The generator requires a reviewed object-form model entry whose `apis` includes
`chat`. Legacy string-only model entries are rejected because their identifier
alone does not establish Chat support. Have the deployment maintainer supply the
explicit model policy; do not add `chat` to a Messages-only tariff to bypass this
check. The runtime's existing legacy configuration support is unchanged.

```sh
/absolute/install/bin/clientd openclaw-config /absolute/private/zkapi-profile \
  --model YOUR_CONFIGURED_MODEL --context-window 32000 --max-tokens 512 \
  > /absolute/private/openclaw-zkapi.json
```

The command prints a configuration with:

- `models.providers.zkapi.baseUrl` set to the numeric loopback clientd `/v1` URL.
- `api: "openai-completions"`, a file `SecretRef` to `inference-token`, and
  text-only capability declarations. No token bytes are printed.
- A dedicated `zkapi` agent directory in the profile and `fallbacks: []`.
- One concurrent agent request and ignored project-level embedded settings.

Setup also creates `PROFILE/openclaw-agent/settings.json` with
`{"retry":{"provider":{"maxRetries":0}}}`. This is an embedded-agent setting,
**not an `openclaw.json` key**. Preserve it. Disabling model fallbacks alone does
not disable retries. Do not merge this snippet into an agent that has different
retry, transport or plugin overrides without repeating the failure tests.

For an isolated configuration, start a turn with the nonsecret configuration
path in `OPENCLAW_CONFIG_PATH`:

```sh
OPENCLAW_CONFIG_PATH=/absolute/private/openclaw-zkapi.json \
  openclaw agent --local --agent zkapi --session-id zkapi-first \
  --message "Hello" --thinking off --json
```

Use a separate `OPENCLAW_STATE_DIR` if you want to keep this integration's
OpenClaw state separate. The generator does not edit your existing OpenClaw
configuration, sessions, provider credentials or defaults. Review any merge
into an existing configuration, including agent overrides. OpenClaw may store
conversation history independently of the SDK's encrypted journal.

## Errors and tools

Keep clientd in the foreground or under a supervisor that preserves its private
profile. On a canceled turn, connection loss, HTTP failure or `recovery_required`,
inspect `clientd request PROFILE status` before asking OpenClaw to perform a new
turn. Use explicit `recover`/`close` and inspect the resulting note state. Never
reset tokens, custody or the journal as an inference retry mechanism.

A tool response and its follow-up inference are distinct intentional requests.
Each can consume provider budget. The live tool roundtrip used a 60-second
reusable session; a zero-reuse session can still be closing when OpenClaw sends
the tool result. Fund the reviewed authorization cap plus charge headroom and
inspect settlement before starting a new session. Tool execution happens in
OpenClaw, under its own permissions; clientd does not execute the tool. Direct inference remains
between the user's clientd and configured provider. Proxy mode exposes content
to the proxy as documented by that mode. No image/audio or hosted provider tools
are enabled by this text integration.

## Reproduce the local compatibility check

Use the repository's pinned Node and Go toolchains. Install OpenClaw into a
separate ignored directory, then run the fixture harness against a new native
package. The install uses exact OpenClaw version 2026.9.8; the saved package lock
records dependency integrities.

```sh
npm install --prefix target/openclaw-acceptance --ignore-scripts --no-audit --no-fund openclaw@2026.9.8
node scripts/run_openclaw_clientd_acceptance.ts \
  target/openclaw-acceptance /absolute/native-distribution
```

The harness checks the actual CLI version, isolates its home/config/state,
uses no user/provider credentials, and writes `results.json` with explicit
fixture/live flags. It does not send chat messages to another person or channel.
The `--local` agent runs only against the localhost fixture. Each new tool turn
has a distinct SDK operation; unknown inference is not replayed during recovery.

The upstream contracts used here are documented in OpenClaw's
[custom-provider configuration](https://docs.openclaw.ai/gateway/config-tools/custom-providers),
[file SecretRef contract](https://docs.openclaw.ai/gateway/secrets/secretref-contract)
and [retry policy](https://docs.openclaw.ai/concepts/retry). Revalidate generated
configuration and failure behavior before upgrading OpenClaw.
