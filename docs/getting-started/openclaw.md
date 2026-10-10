# Get started with OpenClaw inference on macOS

OpenClaw can use clientd as a custom inference endpoint through the Chat
Completions API. First [install, start and fund clientd on macOS](clientd.md).
The commands below continue that **Apple Silicon macOS** installation, using
the public Devnet `.8` OpenRouter profile and **OpenClaw 2026.9.8**.
The `~/Applications/ZKAPI` paths belong to this macOS example; use your existing
installation and profile paths if they differ, without moving funded state.

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

Choose an exact model ID from the `models` response with Chat text support and,
for tool use, client-tool support. Replace `YOUR_LISTED_CHAT_MODEL` below and
set `ZKAPI_CONTEXT_WINDOW` to a reviewed context size supported by that model.
The example advertises 32,000 tokens and uses the public profile's 128-token
output limit. Neither listing a model nor generating configuration establishes
funded acceptance for it. There is no required model vendor.

```sh
ZKAPI_MODEL='YOUR_LISTED_CHAT_MODEL'
ZKAPI_CONTEXT_WINDOW=32000
(
  set -eu
  umask 077
  set -C
  "$ZKAPI_INSTALL/bin/clientd" openclaw-config "$ZKAPI_PROFILE" \
    --model "$ZKAPI_MODEL" --context-window "$ZKAPI_CONTEXT_WINDOW" --max-tokens 128 \
    > "$ZKAPI_BASE/openclaw-zkapi.json"
)
```

This creates a separate `zkapi` agent with a file reference to the inference
token, one concurrent request and no fallback models. Keep
`$ZKAPI_PROFILE/openclaw-agent/settings.json`: it disables provider retries.
Neither command changes your normal OpenClaw configuration.

The generated OpenClaw field `api: "openai-completions"` names its Chat
Completions wire format. It does not select OpenAI as the provider. The model
and route come from your authenticated ZKAPI deployment; this example uses
OpenRouter.

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
