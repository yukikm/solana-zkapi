# Claude Code integration status

**Claude Code 2.1.220 cannot currently use clientd by changing configuration
alone.** Its gateway settings reach the local server, but its actual request
format is rejected before the SDK or any financial authorization runs. Keep
this integration experimental. The [OpenClaw integration](openclaw.md) records
the existing tested agent path and its deployment limitations.

The [recorded compatibility probe](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/I10-claude-code-configuration-results.json)
uses the installed Claude Code CLI, synthetic Anthropic responses, and the
production Go HTTP handler. It does not use Anthropic credentials, an existing
Claude login, public RPC, funded notes, or a provider. It does not modify user
settings or defaults.

## Configuration contract

Claude Code supports an Anthropic Messages gateway through
`ANTHROPIC_BASE_URL`. Its `ANTHROPIC_AUTH_TOKEN` variable sends a Bearer token;
`ANTHROPIC_API_KEY` sends `x-api-key`. clientd accepts its own local inference
token in the Bearer header. A Claude subscription or an Anthropic provider key
is not the local credential. See the official
[gateway connection guide](https://code.claude.com/docs/en/llm-gateway-connect).

The intended configuration, once the blockers below are addressed, is:

| Setting | Required value or meaning |
|---|---|
| Gateway base URL | `http://127.0.0.1:8787`, with no `/v1` suffix |
| Local authentication | The private clientd `inference-token`, delivered as Bearer authentication |
| clientd mode | Explicit `proxy` with an Anthropic model and its authenticated tariff |
| Model | An exact model ID in the deployment and clientd allowlists |
| API | Anthropic `/v1/messages`, optionally `/v1/messages/count_tokens` |
| Tool execution | Claude Code executes approved local tools; clientd transports model requests |

The current `direct_openrouter` Chat endpoint is a different API dialect. It
does not make Claude Code's native Messages requests work by itself. Switching
to proxy changes which party can see prompts and responses, and must remain an
explicit choice. Preparation of clientd itself is documented in the
[native quickstart](../sdk/clientd-quickstart.md).

## Observed blockers

The tested CLI still sent the following with experimental features, thinking,
prompt caching and retries disabled:

| Observed request | Current clientd/control behavior |
|---|---|
| `POST /v1/messages?beta=true` | Go rejects query strings with HTTP 400 `unsupported_route`; the SDK receives no request |
| Top-level `metadata.user_id` | Outside the strict Anthropic proxy request allowlist |
| `anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14` | The SDK/control path does not preserve or authenticate beta headers for provider dispatch |

The first row is an actual production-handler rejection. The remaining rows
combine actual captured request structure with inspection of current control
validation and transport; they are not additional provider failures. The
[official gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol)
documents the query and beta-header behavior. No query, metadata or beta field
is silently removed by this integration.

Supporting this client requires an explicit, reviewed request contract across
the local handler, durable operation identity, proxy validation and provider
transport. It also needs real Anthropic usage/settlement acceptance. Accepting
arbitrary extra fields or making the route ignore all query strings would not
establish compatibility or safe metering.

## Reproduce the isolated probe

On macOS, with Python 3, the repository's pinned Go toolchain and Claude Code
installed, run:

```sh
python3 scripts/run_claude_code_clientd_acceptance.py \
  --claude /absolute/path/to/claude \
  --go /absolute/path/to/go \
  --output target/claude-code-acceptance/new-run
```

The probe creates a temporary home, empty working directory, private fixture
token and isolated settings. It uses `--bare`, `--setting-sources ''`,
`--no-session-persistence`, a fixed system prompt and a temporary `apiKeyHelper`.
The helper supplies only a synthetic local token. macOS `sandbox-exec` limits
the CLI's network access to loopback; the script fails if that sandbox is
unavailable. No existing configuration is merged or rewritten.

The tested environment includes:

```text
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1
CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1
CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
CLAUDE_CODE_DISABLE_THINKING=1
CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1
CLAUDE_CODE_MAX_RETRIES=0
CLAUDE_CODE_MAX_OUTPUT_TOKENS=512
MAX_THINKING_TOKENS=0
DISABLE_PROMPT_CACHING=1
ENABLE_TOOL_SEARCH=false
```

These are bounded diagnostic settings, not a working funded-client recipe.
The [official environment reference](https://code.claude.com/docs/en/env-vars)
describes their scope. In this installed version, disabling experimental betas
did not remove every beta value.

The actual CLI consumed a text SSE response in one fixture request, executed
the real `Read` tool on a temporary file and sent its result in a second request,
and sent only one request when the fixture returned HTTP 503. The production Go
route then rejected its request with HTTP 400 and zero backend dispatches.
`probeChecksPassed: true` means those observations were reproduced;
`compatibilityPassed: false` remains the integration result.

The HTTP 503 observation does not prove every retry, timeout or interrupted
stream path. No inference replay is authorized by this guide. Before any future
funded acceptance, verify cancellation, partial-stream failures, explicit
same-journal recovery and normal settlement with the exact released client.
In a future funded integration, clientd's encrypted journal would retain exact
request bodies, including conversation history, for durable operation identity
and recovery. Claude Code's own files and approved tools are a separate privacy
boundary. Disabling Claude Code session persistence does not remove clientd
journal content or alter the provider's retention policy.
