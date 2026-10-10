# Support

ZKAPI is a **Devnet preview**. Published SDK and native clients are
`0.2.0-devnet.8`; see the [release notes](releases/usability-preview.md).
This compatibility summary is based on records through **2026-10-10 JST**.
Run [fresh preflight](getting-started/devnet.md) to check a deployment now.

The payment and proof primitives are shared across API use cases. The source
tree adds registered, fixed-price JSON operations through the same SDK, clientd
and ledger. Initial support is proxy POST with bounded JSON requests and
responses; a signed descriptor binds the operation, destination and billing rule.
This source capability is separate from the published `.8` clients and the
existing public deployment. See the [local JSON API tutorial](getting-started/json-api.md),
[general API integration](getting-started/api-integration.md) and the separate
[inference tutorials](getting-started/inference.md).

| Area | Supported or observed scope |
|---|---|
| General JSON API (source) | Local fixed-price POST JSON integration. No public provider or released client coverage is implied. Other methods, binary bodies, asynchronous jobs and generic streaming need explicit adapters and billing contracts. |
| Native package | Apple Silicon, macOS 13.5+. No Apple notarization or verified packages for other platforms. |
| SDK | Tarball distribution; no npm registry release. Browser custody/proof tests are local; funded browser/Phantom acceptance is unverified. |
| Public profile | Direct OpenRouter Chat Completions. Model names do not enable other API dialects. |
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
