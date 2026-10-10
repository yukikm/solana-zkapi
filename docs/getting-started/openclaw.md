# Use OpenClaw

OpenClaw uses clientd as a custom OpenAI Chat Completions provider. First
[install, start and fund clientd](clientd.md). The steps below use the public
Devnet `.8` installation and **OpenClaw 2026.9.8**.

Selected public text and read-tool requests passed with an earlier client and
a bounded settlement adapter. The `.8` client adds native session reuse and
settlement waiting; its local tests do not establish a new funded OpenClaw
lifecycle. See [support](../support.md).

## 1. Install OpenClaw

If you already have version `2026.9.8`, use it. Otherwise, with
[Node 24.19.0](https://nodejs.org/en/download/archive/v24.19.0) and npm 11.9.0
installed, install it into a separate directory:

```sh
ZKAPI_BASE="$HOME/Applications/ZKAPI"
npm install --prefix "$ZKAPI_BASE/openclaw" --ignore-scripts \
  --no-audit --no-fund openclaw@2026.9.8
"$ZKAPI_BASE/openclaw/node_modules/.bin/openclaw" --version
```

The commands below use that local binary. If using an existing installation,
set `ZKAPI_OPENCLAW` to its absolute executable path. Recheck compatibility
before upgrading OpenClaw.

## 2. Generate the configuration

Keep clientd running. In a second Terminal:

```sh
ZKAPI_BASE="$HOME/Applications/ZKAPI"
ZKAPI_INSTALL="$ZKAPI_BASE/zkapi-clientd-0.2.0-devnet.8-darwin-arm64"
ZKAPI_PROFILE="$ZKAPI_BASE/profile-devnet8"
# Replace this path if using an existing OpenClaw installation.
ZKAPI_OPENCLAW="$ZKAPI_BASE/openclaw/node_modules/.bin/openclaw"
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" models
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" status
```

Choose a listed Chat model with text support and, for tool use, client-tool
support. The example uses the revision-6 catalog ID `openai/gpt-5.6-luna`, a
32,000-token context limit and the profile's 128-token output limit. Catalog
membership does not establish funded acceptance for that model.

```sh
(
  set -eu
  umask 077
  set -C
  "$ZKAPI_INSTALL/bin/clientd" openclaw-config "$ZKAPI_PROFILE" \
    --model openai/gpt-5.6-luna --context-window 32000 --max-tokens 128 \
    > "$ZKAPI_BASE/openclaw-zkapi.json"
)
```

This creates a separate `zkapi` agent with a file reference to the inference
token, one concurrent request and no fallback models. Keep
`$ZKAPI_PROFILE/openclaw-agent/settings.json`: it disables provider retries.
Neither command changes your normal OpenClaw configuration.

The generator requires an explicit model entry with `chat` in its API list.
If it rejects a model, choose a listed Chat model or ask the operator for a
compatible deployment configuration.

## 3. Send a request

Confirm the note is active and status has no recovery requirement. This command
sends a real inference request and can spend provider credit:

```sh
OPENCLAW_CONFIG_PATH="$ZKAPI_BASE/openclaw-zkapi.json" \
OPENCLAW_STATE_DIR="$ZKAPI_BASE/openclaw-state" \
  "$ZKAPI_OPENCLAW" agent --local --agent zkapi \
  --session-id zkapi-first --message 'Reply with a short greeting.' \
  --thinking off --timeout 300 --json
```

Use a distinct session ID for a new conversation. Tool continuations are
additional inference requests and can incur charges. OpenClaw executes tools
under its own permissions and stores its own conversation history. This setup
supports text and client-executed tools; it does not enable image, audio or
provider-hosted tools.

## 4. Settle or recover

When finished:

```sh
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" close
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" status
```

On HTTP 409, cancellation or connection loss, inspect status before another
turn. If recovery is required, use the [recovery guide](../sdk/recovery.md).
Do not rerun an uncertain prompt or reset the profile. To return funds, follow
[clientd withdrawal](clientd.md#stop-restart-and-withdraw).

OpenClaw documents [custom providers](https://docs.openclaw.ai/gateway/config-tools/custom-providers)
and [file credential references](https://docs.openclaw.ai/gateway/secrets/secretref-contract).
