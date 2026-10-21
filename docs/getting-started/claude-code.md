# Evaluate Claude Code inference compatibility

Claude Code 2.1.220 has passed selected local tests through the
[finite HTTP gateway](finite-http-api.md): streamed text, a Read-tool round trip
and a subsequent user turn. These tests use the actual CLI and installed clientd,
shared SDK/accounting, real proofs and Vault SBF, with synthetic provider
responses and chain finality. They do not establish live Anthropic or public
Devnet acceptance by themselves.

Separate bounded live tests used Claude Code 2.1.220 and Claude Haiku 4.5 with
real Anthropic responses, a local proxy/clientd and dedicated Pools on public
Solana Devnet. Selected streamed-text, Read-tool round-trip and subsequent-turn
cases succeeded, including resuming the same CLI conversation. These cases
produced verified signed metered receipts and SDK settlement. The one-shot
lifecycle also completed withdrawal. The multi-request test used a bounded
settlement adapter that waited for SDK settlement before the next request and
did not replay earlier turns.

The legacy Messages adapter still rejects Claude Code's query, metadata and beta
headers. Select an authenticated finite HTTP gateway profile for a new evaluation;
changing a base URL does not add that capability to an existing funded profile.

## Connection settings

Use a matching SDK/native `.13` installation and schema 3 proxy profile with a
finite HTTP mount, an `anthropic_messages` meter and an authenticated model/tariff.
The public OpenRouter Chat profile does not provide this route. Keep its custody,
journal and configuration unchanged.

| Setting | Value |
|---|---|
| `ANTHROPIC_BASE_URL` | The local gateway mount, such as `http://127.0.0.1:8787`, without `/v1` |
| `ANTHROPIC_AUTH_TOKEN` | The private clientd `inference-token` |
| `ANTHROPIC_MODEL` | The exact configured Anthropic model ID |
| `ANTHROPIC_CUSTOM_HEADERS` | `Accept-Encoding: identity` |
| `CLAUDE_CODE_MAX_RETRIES` | `0` |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` for an isolated evaluation |

Claude Code's [gateway guide](https://code.claude.com/docs/en/llm-gateway-connect)
documents Bearer authentication through `ANTHROPIC_AUTH_TOKEN`. Supply only the
local inference token through per-process configuration; keep the provider key,
management token, wallet and data password outside Claude Code. Do not also set
`ANTHROPIC_API_KEY` or use an `apiKeyHelper` that sends `x-api-key`: the gateway
rejects caller-supplied provider credentials. The identity encoding pin avoids
the tested CLI's default offer of `zstd`, which this gateway contract does not
enable. Leave normal user settings unchanged while evaluating this connection.

## Verified scope and limits

The gateway carries the original raw query, headers and body through the existing
encrypted journal and accounting ledger. Its registration must explicitly match
the selected provider route and model. Provider usage and signed receipts remain
the authority for settlement; a successful CLI response alone is insufficient.

Claude Code 2.1.220 can retry a thinking-capability error despite retries being
disabled. The local test verifies that the durable recovery hold rejects the
second attempt with `recovery_required` before authorization or provider egress.
Inspect and recover the original operation before requesting more work; do not
clear custody or treat a new operation ID as permission to replay.

A tool round trip normally makes at least two inference requests. A one-request
test can check a short text response with tools disabled, but cannot establish
general coding-agent compatibility. Other CLI versions, optional features and
broader live-provider workflows need separate verification.

Each gateway request starts a new authorization session, which requires the
settled private balance to be at least the manifest's fixed authorization cap.
Depositing exactly that cap permits only one session if its charge is positive;
settlement then leaves too little balance to authorize another, even when the
next request's estimated token cost is small. For a test of N sessions, fund at
least the cap plus the sum of the maximum charges for the first N−1 sessions,
rounding each session's charge up to integer micro-USDC. Keep the provider budget
and request limits bounded separately. After `recovery_required`, inspect the
saved operation and balance before attempting more work; closing a settled
authorization does not replenish its balance.

Contributors can run the pinned native-client gateway suite:

```sh
python3 scripts/run_general_api.py --gateway-clients
```

It covers Claude Code and Codex using isolated settings, synthetic providers and
local proof/SBF lifecycles. Follow the pinned prerequisites in
[testing](../testing.md); this command makes no paid provider requests.

## Legacy adapter limit

The tested CLI sends `POST /v1/messages?beta=true`, which the legacy inference
frontend rejects with `unsupported_route`. It also sends `metadata.user_id` and
beta headers that the legacy proxy contract does not support. Disabling
experimental features did not remove these fields.

Do not fund a note to test this configuration or remove request validation to
make it pass. For a credential-free local probe, contributors can run:

```sh
python3 scripts/run_claude_code_clientd_acceptance.py \
  --claude /absolute/path/to/claude \
  --go /absolute/path/to/go \
  --output target/claude-code-acceptance/new-run
```

This older probe records the legacy rejection and synthetic CLI response cases;
it does not exercise the finite HTTP gateway or establish provider billing or
funded acceptance. See [support](../support.md).
