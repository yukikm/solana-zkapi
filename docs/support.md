# Support

ZKAPI is a **Devnet preview**. The published SDK is
[`0.2.0-devnet.13`](releases/universal-api-gateway-preview.md), including the matching
native package. This compatibility summary is based on records through **2026-10-12 JST**.
Run [fresh preflight](getting-started/devnet.md) to check a deployment now.

The payment and proof primitives are shared across API use cases. The source
tree adds registered, fixed-price JSON operations through the same SDK, clientd
and ledger, with offline registration, API-only schema 2 profiles and native
discovery/invocation. The JSON adapter supports proxy POST with bounded JSON requests and
responses; a signed descriptor binds the operation, destination and billing rule.
The `.13` SDK/native packages also include finite HTTP gateway support. These
capabilities require matching operator configuration and authenticated selection;
the existing public deployment remains direct OpenRouter Chat Completions.
See the [local JSON API tutorial](getting-started/json-api.md),
[general API integration](getting-started/api-integration.md) and the separate
[inference tutorials](getting-started/inference.md).

| Area | Supported or observed scope |
|---|---|
| General JSON API | Offline registration and local fixed-price POST JSON onboarding in `.13`. This legacy adapter remains bounded POST JSON; no public provider acceptance is established. |
| Finite HTTP gateway | `.13` includes version 2 bindings, version 3 tariffs/receipts/profiles and `finite_http_v1` through the same payment lifecycle. Fixed HTTP, Responses and Messages meters; bounded raw requests and finite responses. See the [gateway guide](getting-started/finite-http-api.md). Local installed-runtime checks use real proofs/SBF with synthetic provider/finality inputs; public provider, production and full browser coverage are unverified. |
| Native package | Apple Silicon, macOS 13.5+. No Apple notarization or verified packages for other platforms. |
| SDK | Tarball distribution; no npm registry release. Browser custody/proof tests are local; funded browser/Phantom acceptance is unverified. |
| Public profile | Direct OpenRouter Chat Completions. Model names do not enable other API dialects. |
| Public output limit | Up to 4,096 output tokens per response under the current [application usage policy](getting-started/devnet.md#5-use-and-recover), subject to a lower model limit. This is not a token bound in the authenticated profile or direct backend. |
| OpenClaw | Selected text and read-tool continuation cases succeeded using a bounded settlement adapter. The current `.8` configuration has not had a new funded lifecycle test. |
| Claude Desktop | A simple local fixture connection test passed. Real Chat is rejected by query/body validation. |
| Claude Code | Requests hit query, metadata and beta-header compatibility limits. |
| Codex | Responses requests hit unsupported fields and custom tool formats. |
| Recovery | Selected native interrupted-stream recovery, withdrawal and emergency escape cases succeeded. |

Within inference, text and client-executed tools are in scope. Media, Realtime,
hosted tools, persisted provider conversations, Ollama and native SOL billing are not.
Production, mainnet, security audits, complete provider coverage and long-term
availability are not established by this preview.

The public service uses operator-funded provider usage without a fixed trial
allowance. Devnet USDC does not buy provider credit. A model listing or a passing
readiness check does not guarantee credit, inference success or uptime.

Direct providers receive prompts. Proxy operators also receive prompts and
responses. OpenRouter ZDR routing is a provider policy, not proof of deletion.
Delayed provider accounting can leave costs with the operator; signed charges
are never retroactively changed.

Keep existing funded profiles, runtimes, journals and recovery material.
Use the [recovery reference](sdk/recovery.md) after an uncertain operation;
do not send it again as a new request.
