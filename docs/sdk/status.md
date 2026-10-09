# Support and verification status

Updated 2026-10-09 JST. The current public client release is
**`0.2.0-devnet.3`**. [Public API restoration](../evidence/PD-public-restoration-20261009.md)
completed, and installed preflight passed ten checks at 00:55:26 UTC.
[E01 emergency withdrawal](../evidence/PD-E01-emergency-withdrawal-20261009.md)
also completed, followed by fresh public HTTP 200 at 01:43:23 UTC in the
[core completion record](../evidence/PD-core-completion-20261009.md). Final
evidence is linked and versioned in this documentation update.
Evidence below applies to its recorded source and deployment, not automatically
to later working-tree changes or continuous availability.

| Capability | Current evidence / limit |
|---|---|
| Public profile and distribution | [SDK .3 publication](../evidence/PD-sdk3-publication.md) verifies release/asset attestations, anonymous downloads and all 7,257 native installed-file hashes. The authenticated profile supplies the deployment, proof assets, capabilities and public transports. Distribution is SDK tarball and macOS ARM64 clientd; npm publication and other platforms remain separate. |
| Public service readiness | [Restoration and installed preflight](../evidence/PD-public-restoration-20261009.md) verified public control/indexer/signer availability and ten `.3` preflight checks with all 7,257 installed files unchanged. Admission/recovery were separately observed enabled. No AUTH, inference or wallet action ran; provider credit and continuous availability are outside these observations. Run fresh preflight before use. |
| Independent onboarding | Public-input installation and released `clientd setup` succeeded outside the checkout with isolated consumer directories. This is a same-host installation, not a pristine-OS test. [Scope and receipts](../evidence/PD-core-scope-reconciliation.md) |
| SDK lifecycle and response handling | The `.3` SDK validation passed **385/385 local tests**, with 75 guarded inputs unchanged, covering request rejection before AUTH, tariff/cap binding, terminal usage, cancellation and durable recovery without inference replay. These overlap earlier focused tests and are not new provider calls. [Core scope](../evidence/PD-core-scope-reconciliation.md) |
| Native public lifecycle | [N-01](../evidence/PD-native-public-N01.md) completed compact deposit, Chat and verified settlement. The subsequent `.3` [OpenClaw N-02/N-03](../evidence/PD-native-public-N02-N03.md) completed text/read-tool continuation using the explicit settlement scheduling adapter. [N-04](../evidence/PD-native-public-N04.md) completed interrupted-stream recovery and mutual withdrawal: four signed charges total **20 micro-USDC**, with **4,999,980 micro-USDC** returned and the note closed. These dated results do not establish current service readiness. |
| OpenRouter accounting | The installed [Ethereum-parity policy](../evidence/PD-openrouter-ethereum-parity.md) disables the key, waits five seconds, durably captures one valid management `usage + byok_usage` observation, confirms deletion and signs the capped charge. Delayed accounting is the operator's risk; signed charges are immutable. The historical N-02/N-03 response-cost discrepancy remains preserved, without retroactive repricing or an invoice-finality claim. |
| History and service restart | Complete private checkpoints preserve replay state and financial journal authority. [Actual warm restart](../evidence/PD-warm-restart-20261009.md) verified cache population and bounded process reads for binary `0037eca8…`. The [writer-only throughput successor](../evidence/PD-replay-writer-deployment-20261009.md) is installed. The later [public restoration](../evidence/PD-public-restoration-20261009.md) passed fresh finalized reconciliation and gateway readiness while preserving the complete database and four reservations. |
| Preview capacity | [Read-only capacity evidence](../evidence/PD-capacity-retained-20261009.md) confirms `t3a.medium` Standard, 80 GiB data/20 GiB root, and 30,190,022,656 available bytes at 00:25:35 UTC. Retained archive data exceeds 40 GiB; no migration, rollback or new storage approval is claimed. Continued chain growth leaves long-term qualification deferred. |
| Funding and withdrawals | Compact deposits and ordinary mutual closure have public native evidence above. [E01 emergency withdrawal](../evidence/PD-E01-emergency-withdrawal-20261009.md) continued the original deposit/journal and independently verified seven exact-wire finalized transactions, one micro-USDC returned, Note closed and `Pending.exists=false`. Its journal has zero AUTH; the complete operator database and four reservations remain unchanged. [Funding guide](devnet-funding.md) |
| Browser SDK and custody | Browser factory, local proof worker, encrypted IndexedDB journal and shared snapshot/path validation are implemented. Headless Chrome custody and separate-origin preflight have scoped evidence; current funded browser/Phantom cases are deferred. Application conversation history and presentation remain the consuming app's responsibility. [Readiness backlog](../public-devnet-readiness-backlog.md) |
| Kit and hosted CI | The SDK/native client uses Solana Kit 8.4.0 directly; see the [breaking API migration](kit-migration.md). All nine implementation jobs passed at exact `.3` source `e2ee9320…` ([historical CI](../evidence/PD-hosted-ci-e2ee932.md)). Latest test-only source `6f796c1…` is published; its hosted workflow remains in progress at this checkpoint. The corrected local E2E passed 19 real SBF transactions. These are separate scopes, not a new all-nine-job pass or runtime-artifact authentication. [Completion record](../evidence/PD-core-completion-20261009.md) |
| Other AI clients and production | Claude Code/Codex configuration probes remain blocked by request validation; no funded compatibility is claimed. [Compatibility guide](../integrations/README.md). Full I10/G3, G1–G4, production qualification, audit and mainnet remain incomplete. |

Earlier I10 results remain historical evidence:

- The **2026-10-05** Chrome/Phantom fixed-prompt demo recorded a verified
  four-micro-USDC settlement and a separately collected finalized withdrawal.
  The later response on a separate two-USDC note is also retained.
  [Response observation](../evidence/I10-phantom-openai-success-observation.json),
  [runtime](../evidence/I10-phantom-openai-success-runtime.json),
  [withdrawal](../evidence/I10-repeat-demo-withdrawal-finalized.json),
  [second response](../evidence/I10-repeat-demo-api-observation.json).
- The **2026-10-07** standalone browser build and synthetic-service checks did
  not establish actual Phantom use; the recorded Chrome localhost blocker
  remains preserved. [Browser evidence](../evidence/I10-parity-review-browser.md).
- Earlier direct OpenRouter JSON/SSE lifecycles and compact deposits/withdrawals,
  plus one proxy Chat-tools case charging 18 micro-USDC, retain their original
  model and deployment limits. They do not establish other providers, a full
  model matrix or current browser acceptance.
  [Direct cases](../evidence/I10-parity-review-live-components/results.json),
  [SSE case](../evidence/I10-parity-review-live-components/direct-sse-case.json),
  [compact native case](../evidence/I10-parity-review-live-components/direct-plain-runtime.json),
  [proxy tools](../evidence/I10-openrouter-tools-case-results.json).
- The **2026-10-07** independent SDK/native integration records preserve their
  package-installation, proof, synthetic OpenClaw and selected provider scopes.
  Their older test counts are not added to the `.3` SDK count.
  [Integration](../evidence/I10-external-integration.md),
  [native installation](../evidence/I10-clientd-external.md),
  [SSE parser correction](../evidence/I10-sdk-sse-parser.md).

Initial APIs cover text and client-executed tools. Images/documents, audio,
Realtime, hosted tools, arbitrary HTTP proxying, persisted provider conversation
storage, Ollama and native SOL billing are outside the initial release scope.
The [standalone application](https://github.com/yukikm/solana-zkapi-client) is
maintained separately. Historical failures, signed receipts, journals and
reservations remain authoritative; later work does not relabel failed cases.
