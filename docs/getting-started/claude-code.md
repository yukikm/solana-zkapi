# Configure Claude Code

**Claude Code 2.1.220 cannot currently use ZKAPI through configuration alone.**
Its actual request reaches clientd but is rejected before financial
authorization. Use [OpenClaw](openclaw.md) for the documented agent path.

## Connection settings

For an isolated compatibility evaluation, use a clientd deployment with
**Anthropic Messages in explicit proxy mode** and an authenticated model/tariff.
The public OpenRouter Chat profile does not support this API.

| Setting | Value |
|---|---|
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787`, without `/v1` |
| `ANTHROPIC_AUTH_TOKEN` | The private clientd `inference-token` |
| `ANTHROPIC_MODEL` | The exact configured Anthropic model ID |
| `CLAUDE_CODE_MAX_RETRIES` | `0` |

Claude Code's [gateway guide](https://code.claude.com/docs/en/llm-gateway-connect)
documents Bearer authentication through `ANTHROPIC_AUTH_TOKEN`. Supply only the
local inference token through your credential mechanism; keep the management
token, wallet and data password outside Claude Code. Leave normal user settings
unchanged while evaluating this connection.

## Current limit

The tested CLI sends `POST /v1/messages?beta=true`, which clientd rejects with
`unsupported_route`. It also sends `metadata.user_id` and beta headers that the
proxy contract does not support. Disabling experimental features did not remove
these fields.

Do not fund a note to test this configuration or remove request validation to
make it pass. For a credential-free local probe, contributors can run:

```sh
python3 scripts/run_claude_code_clientd_acceptance.py \
  --claude /absolute/path/to/claude \
  --go /absolute/path/to/go \
  --output target/claude-code-acceptance/new-run
```

The probe uses synthetic responses and isolated settings; it does not establish
provider billing or funded acceptance. See [support](../support.md).
