# Set up OpenClaw with Solana zkAPI

Connect OpenClaw to a running local clientd, generate a dedicated configuration,
then send an intentional agent turn. OpenClaw uses the local inference token;
you do not give it the wallet, custody passphrase or provider management key.

This guide uses **OpenClaw 2026.9.8** and a new **clientd `0.2.0-devnet.8`**
installation. Selected earlier public OpenRouter runs used a separate
[settlement adapter](openclaw-settlement-adapter.md). Those results do not
establish a funded `.8` OpenClaw lifecycle; see
[verification scope](#verification-scope). Installation and configuration below
are local; running an agent turn consumes provider capacity and note balance.

## 1. Prepare clientd and restore your paths

Complete [Install and run clientd](clientd.md), including deployment preflight
and funding. Leave clientd running in its own terminal. In a second terminal,
set the paths from that guide; adjust them if you chose different directories:

```sh
umask 077
ZKAPI_ROOT="$(cd "$HOME/.local/share/zkapi" && pwd -P)"
ZKAPI_INSTALL="$ZKAPI_ROOT/release-0.2.0-devnet.8/zkapi-clientd-0.2.0-devnet.8-darwin-arm64"
ZKAPI_PROFILE="$ZKAPI_ROOT/profile-sdk8"
export PATH="$ZKAPI_INSTALL/bin:$PATH"

clientd request "$ZKAPI_PROFILE" status
clientd request "$ZKAPI_PROFILE" models
```

Before a new turn, status must show an active funded wallet, no wallet operation
or emergency escape, and no recovery requirement. For a fresh session, also
confirm `phase: "ready"` and an empty `unresolved_operations` array. The balance
must cover the deployment's authorization cap plus usage headroom. If state is
unresolved, follow [clientd recovery](clientd.md#stop-restart-and-withdraw) first.

Choose an exact advertised **Chat** model with text/streaming support; read-tool
continuation additionally requires client-tool support. The public revision-6
profile permits at most 128 output tokens. Model availability and service
readiness can change; run the current [preflight and access checks](clientd.md#2-check-the-deployment-and-generate-its-inputs)
before new usage.

## 2. Install the tested OpenClaw version

clientd includes Node 24.19.0, but its immutable installation does not include npm
for installing other applications. Use a separate host installation of
[Node 24.19.0 and npm 11.9.0](https://nodejs.org/en/download/archive/v24.19.0)
for this step. Check `node --version` and `npm --version` before installation.

Install OpenClaw into a new directory outside clientd:

```sh
ZKAPI_OPENCLAW_HOME="$ZKAPI_ROOT/openclaw-2026.9.8"
mkdir "$ZKAPI_OPENCLAW_HOME" &&
npm install --prefix "$ZKAPI_OPENCLAW_HOME" --save-exact \
  --ignore-scripts --no-audit --no-fund openclaw@2026.9.8
ZKAPI_OPENCLAW_ENTRY="$ZKAPI_OPENCLAW_HOME/node_modules/openclaw/openclaw.mjs"

"$ZKAPI_INSTALL/bin/node" "$ZKAPI_OPENCLAW_ENTRY" --version
```

The output must identify `OpenClaw 2026.9.8`. The commands below call that exact
entry point, so a different globally installed `openclaw` cannot take its place.
Keep the generated npm lockfile. Recheck configuration and failure behavior
before upgrading OpenClaw.

## 3. Generate an isolated configuration

Set `ZKAPI_MODEL` to your selected model ID. Set `ZKAPI_CONTEXT_WINDOW` to a
reviewed context limit for that model; `32000` is an example, not a discovered
capability. Do not increase the deployment's output cap.

```sh
ZKAPI_MODEL='YOUR_ADVERTISED_CHAT_MODEL_ID'
ZKAPI_CONTEXT_WINDOW=32000
ZKAPI_OPENCLAW_DIR="$ZKAPI_ROOT/openclaw-sdk8"
(
  set -e
  mkdir "$ZKAPI_OPENCLAW_DIR"
  mkdir "$ZKAPI_OPENCLAW_DIR/workspace"
  clientd openclaw-config "$ZKAPI_PROFILE" \
    --model "$ZKAPI_MODEL" --context-window "$ZKAPI_CONTEXT_WINDOW" --max-tokens 128 \
    > "$ZKAPI_OPENCLAW_DIR/openclaw.json"
)
```

Generation must succeed before proceeding. It requires an object-form model
entry whose `apis` includes `chat`; a legacy string-only entry or Messages-only
model is refused. Obtain a reviewed compatible deployment policy instead of
adding an API flag to bypass that check.

The generated configuration contains the loopback `/v1` URL, an
`openai-completions` provider, a file `SecretRef` to `PROFILE/inference-token`,
a dedicated `zkapi` agent, one concurrent request and no model fallbacks. Token
bytes are not printed. Setup already created
`PROFILE/openclaw-agent/settings.json` containing
`{"retry":{"provider":{"maxRetries":0}}}`. Preserve this embedded-agent file;
that retry setting is not an `openclaw.json` key.

Use the same restricted application settings exercised by the fixture harness:
a dedicated workspace, the `read` tool only, no plugins and no automatic
bootstrap. This edits only the newly generated application configuration:

```sh
"$ZKAPI_INSTALL/bin/node" --input-type=module - \
  "$ZKAPI_OPENCLAW_DIR/openclaw.json" "$ZKAPI_OPENCLAW_DIR/workspace" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [file, workspace] = process.argv.slice(2);
const config = JSON.parse(readFileSync(file, 'utf8'));
config.agents.defaults.workspace = workspace;
config.agents.defaults.skipBootstrap = true;
config.agents.defaults.thinkingDefault = 'off';
config.tools = { allow: ['read'], toolSearch: false };
config.plugins = { enabled: false };
writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
JS

export OPENCLAW_CONFIG_PATH="$ZKAPI_OPENCLAW_DIR/openclaw.json"
export OPENCLAW_STATE_DIR="$ZKAPI_OPENCLAW_DIR/state"
"$ZKAPI_INSTALL/bin/node" "$ZKAPI_OPENCLAW_ENTRY" config validate --json
```

Validation must exit successfully before a turn. It does not perform inference.
The two environment variables contain paths, not credentials. They select this
configuration and conversation state without replacing your usual OpenClaw
settings. Preserve them in later terminals, together with the `ZKAPI_*` paths.
OpenClaw stores its own conversation history independently of the SDK journal.

## 4. Send one text turn

After fresh preflight and funded-state checks, run one deliberate turn:

```sh
"$ZKAPI_INSTALL/bin/node" "$ZKAPI_OPENCLAW_ENTRY" agent --local --agent zkapi \
  --session-id zkapi-first-text --message "Reply with a short hello. Do not use tools." \
  --thinking off --timeout 600 --json

clientd request "$ZKAPI_PROFILE" status
```

`--local` runs the OpenClaw agent on your computer; its model request still goes
through clientd to the configured provider. The timeout allows proof preparation
and settlement waiting. It does not authorize retries or guarantee that an
unavailable provider will respond. A session ID selects OpenClaw conversation
history; it is not an inference idempotency key. Re-running the command can
create a new charged request.

A successful CLI run returns assistant text. Check clientd status as a separate
financial result: text appearing does not mean settlement has finished. With
`.8` inputs, successful responses can reuse their direct session for 60 seconds;
settlement occurs on expiry, close, failure or renewal. When finished:

```sh
clientd request "$ZKAPI_PROFILE" close
clientd request "$ZKAPI_PROFILE" status
```

Wait for terminal settlement and an empty unresolved-operation list before
considering the session complete. `close` does not withdraw your note. Use the
[clientd withdrawal steps](clientd.md#stop-restart-and-withdraw) when finished
with funded usage.

## 5. Use a local read tool

Tool execution happens in OpenClaw under its own permissions. A tool result is
sent back in a separate inference and can incur another charge. The read-only
configuration above is the supported starting point; additional tools, plugins,
media and hosted provider tools need separate validation.

Create a public test file in the dedicated workspace:

```sh
printf '%s\n' 'ZKAPI_READ_OK' > "$ZKAPI_OPENCLAW_DIR/workspace/probe.txt"
```

For a new `.8` profile, the configured native 60-second reuse and 120-second
settlement wait handle successful same-process responses. A provider delay,
cancellation or restart can still require explicit recovery. **The legacy
settlement adapter requires zero key reuse and rejects the default `.8`
configuration.** Do not change an existing profile to make it pass that check.

Once prior work is settled and you deliberately choose a two-inference tool
turn, use:

```sh
"$ZKAPI_INSTALL/bin/node" "$ZKAPI_OPENCLAW_ENTRY" agent --local --agent zkapi \
  --session-id zkapi-first-read \
  --message "Read probe.txt exactly once and report its contents. Do not call another tool." \
  --thinking off --timeout 600 --json

clientd request "$ZKAPI_PROFILE" status
```

The intended result is one `read` execution followed by assistant text containing
`ZKAPI_READ_OK`, then verified settlement of the resulting usage. Do not count
that intended result as published `.8` acceptance: the recorded public
read-tool run used an earlier installation **with the
[settlement scheduling adapter](openclaw-settlement-adapter.md)**. Maintaining
that legacy zero-reuse workflow requires its original adapter, runtime and
profile; it is not evidence for a direct `.8` run or arbitrary tool loops.

## Errors and recovery

| Symptom | Action |
|---|---|
| Version differs from 2026.9.8 | Use the exact installed entry point; revalidate any newer version separately |
| Configuration/model rejection | Check the Chat model ID, reviewed context/output limits and file SecretRef path |
| Token or local connection error | Keep clientd running; verify the profile path and generated loopback URL |
| HTTP 409 / `recovery_required` / canceled turn | Stop new turns; inspect clientd status and complete explicit recovery |
| HTTP 503, provider or privacy-policy error | Inspect status and settle/recover the original operation before deliberately choosing new work |
| Adapter rejects key reuse or a third request | Respect its legacy zero-reuse, two-request scope; do not bypass or clear saved markers |

For unresolved sessions, the native management commands are:

```sh
clientd request "$ZKAPI_PROFILE" status
clientd request "$ZKAPI_PROFILE" recover
clientd request "$ZKAPI_PROFILE" status
```

Use [recovery semantics](recovery.md) for wallet operations or a session
that remains unresolved. Keep the original profile, custody and journal.
Disabling fallbacks alone does not disable retries; retain the embedded-agent
retry file and do not merge unreviewed retry/transport/plugin overrides.

## Verification scope

- The local harness exercises OpenClaw 2026.9.8 text streaming, read-tool
  continuation, HTTP 503 without replay, cancellation and explicit recovery,
  using the production Go frontend and shared SDK with synthetic services/proofs.
- [Earlier public N-02/N-03 runs](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-native-public-N02-N03.md)
  established selected text/read-tool cases with the scheduling adapter. They
  retain their original client versions, profiles and verification boundaries.
- `.8` distribution and read-only preflight are recorded in
  [support status](../status.md); a funded `.8` OpenClaw lifecycle is not established
  by those checks. Availability and broader model/client coverage remain separate.

Maintainers can reproduce the credential-free local harness from the repository
root with the pinned toolchains and a new native distribution:

```sh
npm install --prefix target/openclaw-acceptance --ignore-scripts --no-audit --no-fund openclaw@2026.9.8
node scripts/run_openclaw_clientd_acceptance.ts \
  target/openclaw-acceptance /absolute/native-distribution
```

The harness isolates its state and writes results under `target/`; it performs
no public-chain or paid provider call. See OpenClaw's
[custom-provider configuration](https://docs.openclaw.ai/gateway/config-tools/custom-providers),
[file SecretRef contract](https://docs.openclaw.ai/gateway/secrets/secretref-contract)
and [retry policy](https://docs.openclaw.ai/concepts/retry) for upstream settings.
