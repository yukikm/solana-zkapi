# Support

ZKAPI is a **Devnet preview**. The current SDK is
[`.20`](releases/non-expiring-deposits-preview.md); native installers remain
[`.15`](releases/direct-recovery-preview.md). SDK `.18` adds explicit encrypted
backup enrollment and browser/Node.js restoration after device-data loss, with
local fixture validation and hosted synthetic-record recovery acceptance on **2026-10-25 JST**. It requires a separately saved
recovery kit and an available, trusted-for-freshness recovery service. Existing
custody is unchanged until explicit enrollment. Provider and client lifecycle
compatibility below retains the earlier evidence through **2026-10-12 JST**.
The new non-expiring Pool is `public-devnet-20261025-nonexpiry-v1`; matching
operator services were activated and passed backend readiness checks on October 25.
Use its [independent profile pins](getting-started/non-expiring-deposits.md#public-devnet-identity)
and fresh preflight before funding.

SDK/native `.15` retains Node 24.22.1 LTS from `.14`. Source SDK and isolated installed-package
checks pass locally; these results do not establish hosted CI or fresh paid
provider acceptance. Use the
[recovery upgrade procedure](getting-started/direct-recovery-upgrade.md); retain
the immutable `.13`/`.14` artifacts and existing funded custody.

Recovery now distinguishes completion, pending work and failed observation.
Historical `ISSUANCE_UNKNOWN` sessions remain unresolved until existing recovery
obtains sufficient evidence; a missing key or repaired host setting does not
prove settlement. No fresh paid chat acceptance is claimed by this release.

The October 21 deployment introduced [current-state PoC synchronization](getting-started/poc-state-sync.md).
Its funded deposit/restart/withdrawal observations remain historical evidence for
that Pool. The October 25 deployment uses a fresh program and zero-TTL Pool with
matching operator artifacts and a separate client namespace. Finalized Pool
verification confirms zero TTL and a 1,800-second withdrawal challenge period.
Earlier profiles, journals and immutable releases remain separate; no test
balance or unresolved operation is migrated automatically.

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
| SDK | Immutable GitHub tarball distribution; no npm registry release. `.20` release and seven asset attestations verified. Local proof/custody checks and hosted synthetic recovery passed; funded new-Pool browser/Phantom acceptance remains unverified. |
| Public profile | Fresh `public-devnet-20261025-nonexpiry-v1` zero-TTL Pool, configured for direct OpenRouter Chat Completions. Finalized identity verified; matching operator services activated and backend readiness passed on October 25. Funded new-Pool lifecycle remains unverified. Model names do not enable other API dialects. |
| Current-state synchronization | October 21 Pool: deposit, restart without the cache or old history access, and signed-clearance withdrawal verified. The new Pool retains batched current-account/header reads with no historical enumeration; those historical funded results are not new-Pool acceptance. |
| Public output limit | Up to 4,096 output tokens per response under the current [application usage policy](getting-started/devnet.md#5-use-and-recover), subject to a lower model limit. This is not a token bound in the authenticated profile or direct backend. |
| OpenClaw | Selected text and read-tool continuation cases succeeded using a bounded settlement adapter. No new OpenClaw lifecycle was run for the current Pool. |
| Claude Desktop | A simple local fixture connection test passed. Real Chat is rejected by query/body validation. |
| Claude Code | 2.1.220 passed selected streamed-text, Read-tool and subsequent-turn tests through the finite HTTP gateway using synthetic providers and local proof/SBF settlement; a capability-error retry is fenced before another provider dispatch. Selected live Haiku 4.5 streamed-text, Read-tool round-trip and same-conversation continuation cases also completed with signed metered SDK settlement through a local proxy and dedicated public Devnet Pools, using a bounded settlement adapter between requests. Full tool and coding-agent coverage remain unverified. Each new session requires a balance at least equal to the manifest cap. The legacy Messages adapter still rejects query, metadata and beta headers. See [the Claude Code guide](getting-started/claude-code.md). |
| Codex | Responses requests hit unsupported fields and custom tool formats. |
| Recovery | Selected historical native recovery cases succeeded. On October 25, isolated Chromium contexts, Chromium-to-Firefox and Chromium-to-WebKit runs each restored three synthetic new-Pool MAX-u64 notes through the hosted encrypted service, including changes after file export, selected deposit and unresolved operations; wrong files were rejected and the old owner was fenced. No funded lifecycle, Safari app or Phantom compatibility is claimed. |

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
