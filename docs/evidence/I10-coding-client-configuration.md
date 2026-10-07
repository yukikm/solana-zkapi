# Claude Code and Codex configuration checks

Recorded 2026-10-07 JST. The user asked whether Claude Code and Codex can be
configured like the documented OpenClaw integration. Both applications support
custom API endpoints, but their tested request formats are **not yet compatible
with the current Solana clientd path**. The new guides document configuration
and exact blockers; they are not instructions to start funded acceptance.

## Artifacts and reproduction

| Client | Configuration | Credential-free probe and result |
|---|---|---|
| Claude Code | [Guide](../integrations/claude-code.md) | [Runner](../../scripts/run_claude_code_clientd_acceptance.py), [report](I10-claude-code-configuration-results.json) |
| Codex CLI | [Guide](../integrations/codex.md) | [Runner](../../scripts/run_codex_clientd_acceptance.ts), [report](I10-codex-configuration-results.json) |

Use each guide's exact reproduction command and toolchain requirements. The
reports identify the installed CLI version and source hashes. The probes use
isolated configuration/state and synthetic credentials and prompts. Existing
user logins, default model configuration, funded profiles, journals and immutable
provider-budget reservations are not changed. There are no new public-chain,
provider-inference or financial AUTH operations in this work.

Claude Code **2.1.220** consumed one synthetic text stream, executed a real local
`Read` tool followed by a second request, and sent one request on HTTP 503. Its
actual production-handler attempt returned HTTP 400 with zero backend
dispatches; a separate local replay corroborated `unsupported_route`.
Codex CLI **0.145.0** made one production Go/shared-SDK request, rejected with
zero AUTH and provider calls. Its separate fixture checked text (one request),
local file reading and continuation (two requests), HTTP 503 (one request) and
interrupted SSE (one request). Both reports explicitly retain compatibility
failure despite successful diagnostic assertions.

The report source hashes were checked against the final files. `python3
scripts/check_design.py` passed document/schema/link checks; Python probe syntax
and `git diff --check` also passed. These static checks do not establish provider
or financial acceptance.

## Findings

Claude Code uses Anthropic Messages, including `/v1/messages?beta=true` and
`metadata.user_id` even in the restricted text configuration. The production Go
frontend rejects queries; the real Anthropic proxy body allowlist also excludes
metadata. Disabling experimental capabilities does not remove every beta
header. A future implementation needs a reviewed policy for those headers and
identity fields, rather than silently forwarding or discarding them. The
synthetic SSE, local read-tool and HTTP-error checks are client wire evidence,
not Anthropic provider or ZKAPI settlement acceptance.

Codex uses Responses, including `prompt_cache_key` and a custom `apply_patch`
tool in the tested restricted configuration. The direct-mode validator rejects
those request shapes before preparing financial authorization. Responses route
existence and a successful synthetic Responses stream do not establish native
Codex compatibility. The report retains the distinction between configuration
parsing, fixture behavior and the production validation boundary.

OpenClaw's existing reviewed OpenRouter Chat profile cannot supply these API
formats by changing the base URL. Claude Code requires a separately reviewed
Anthropic proxy model and tariff. Codex requires a reviewed OpenAI Responses
model in an appropriate direct or proxy deployment. No automatic provider/mode
fallback was added.

## Next acceptance boundary

Supporting these clients requires explicit, versioned compatibility work:

- Handle only reviewed query/header/identity fields with documented privacy
  behavior; keep the effective financial request durably bound to one operation.
- Support the required request and continuation/tool formats without weakening
  model pins, metering, output limits or provider-state restrictions.
- Verify actual-client retry, interrupted-stream and recovery behavior. A new
  request without a stable operation UUID is a new operation, even when the
  prompt is unchanged.
- Repeat funding, real inference, signed settlement and withdrawal separately
  for each client/provider path before claiming funded compatibility.

The SDK financial state machine, Go route guards and Rust proxy validators were
not relaxed for these documentation/probe additions. Prior OpenClaw and external
SDK live evidence remains historical, source-specific evidence. Full I10/G3 and
production release gates remain incomplete.
