# Support

ZKAPI is a **Devnet preview**. The current SDK/native release is
[`0.2.0-devnet.14`](releases/node-security-preview.md). Its Node security update
has local validation on **2026-10-23 JST**; provider and client lifecycle
compatibility below retains the earlier evidence through **2026-10-12 JST**.
Run [fresh preflight](getting-started/devnet.md) to check a deployment now.

SDK/native `.14` uses Node 24.22.1 LTS. Source SDK and isolated installed-package
checks pass locally; these results do not establish hosted CI or fresh paid
provider acceptance. Use the
[security upgrade procedure](getting-started/node-security-upgrade.md); retain
the immutable `.13` artifacts and existing funded custody.

The public backend switched to [current-state PoC synchronization](getting-started/poc-state-sync.md)
on 2026-10-21 JST, using config v2, a fresh Pool and new signer/challenger journals.
Use the [new profile pins](getting-started/devnet.md) with a new client journal.
The verified Vault program and proving assets are reused. Existing SDK/native
`.13` release assets remain unchanged; this rollout installs server binaries and
the matching server-side challenger bridge. Earlier profiles and journals bind
the retired Pool and are retained separately.

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
| Finite HTTP gateway | `.13` includes version 2 bindings, version 3 tariffs/receipts/profiles and `finite_http_v1` through the same payment lifecycle. Fixed HTTP, Responses and Messages meters; bounded raw requests and finite responses. See the [gateway guide](getting-started/finite-http-api.md). Local installed-runtime checks use real proofs/SBF with synthetic provider/finality inputs. Selected real Anthropic text, Read-tool and conversation-continuation cases completed through a local proxy and dedicated public Devnet Pools with signed metered SDK settlement; the one-shot lifecycle also completed withdrawal. Broader provider, production and full browser coverage remain unverified. |
| Native package | Apple Silicon, macOS 13.5+. No Apple notarization or verified packages for other platforms. |
| SDK | Tarball distribution; no npm registry release. Browser custody/proof tests are local; funded browser/Phantom acceptance is unverified. |
| Public profile | Fresh `public-devnet-20261021-state-v1` Pool, using direct OpenRouter Chat Completions. Model names do not enable other API dialects. |
| Current-state synchronization | Fresh Devnet deposit, restart without the cache or old history access, and signed-clearance withdrawal verified. Batched current-account/header reads; no historical enumeration. Live challenge sends and new paid inference were not exercised by this rollout. |
| Public output limit | Up to 4,096 output tokens per response under the current [application usage policy](getting-started/devnet.md#5-use-and-recover), subject to a lower model limit. This is not a token bound in the authenticated profile or direct backend. |
| OpenClaw | Selected text and read-tool continuation cases succeeded using a bounded settlement adapter. No new OpenClaw lifecycle was run for the current Pool. |
| Claude Desktop | A simple local fixture connection test passed. Real Chat is rejected by query/body validation. |
| Claude Code | 2.1.220 passed selected streamed-text, Read-tool and subsequent-turn tests through the finite HTTP gateway using synthetic providers and local proof/SBF settlement; a capability-error retry is fenced before another provider dispatch. Selected live Haiku 4.5 streamed-text, Read-tool round-trip and same-conversation continuation cases also completed with signed metered SDK settlement through a local proxy and dedicated public Devnet Pools, using a bounded settlement adapter between requests. Full tool and coding-agent coverage remain unverified. Each new session requires a balance at least equal to the manifest cap. The legacy Messages adapter still rejects query, metadata and beta headers. See [the Claude Code guide](getting-started/claude-code.md). |
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
