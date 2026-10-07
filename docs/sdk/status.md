# Support and verification status

Updated 2026-10-07 JST. “Implemented,” “locally tested” and “publicly verified”
describe different boundaries. Evidence is tied to the source/configuration
tested at the time; adding a wrapper does not reverify an older deployment.

| Capability | Current evidence / limit |
|---|---|
| Application SDK and response helpers | 315 local SDK tests with zero skips and actual Chrome custody; independent SDK Chat text/tools/SSE consumption, settlement and devnet withdrawal verified in selected cases. OpenRouter terminal-usage parsing corrected; [integration evidence](../evidence/I10-external-integration.md), [parser correction](../evidence/I10-sdk-sse-parser.md) |
| Standalone browser chat | Arbitrary text/history, configured model/API selection, SSE/cancel and recovery UI; actual Chrome with synthetic services plus a pinned local build wired to the fresh public devnet profile; existing user Chrome blocks localhost, so actual standalone Phantom remains unverified; [evidence](../evidence/I10-parity-review-browser.md) |
| Private authorization reads | Common snapshot and shared-account reads with local native/WASM path reconstruction; selected-note financial recovery remains separate |
| Fresh public devnet setup | Fresh OS-random profile deployed with finalized artifact pins; two actual native direct-provider lifecycles passed. Single-party tree setup and upgrade authority remain; [evidence](../evidence/I10-parity-review-live-components/results.json) |
| Encrypted browser storage | Actual headless Chrome/IndexedDB/Web Locks tests; not portable backup or OS-keychain acceptance |
| OpenRouter proxy Chat tools | One real case, `openai/gpt-4o-mini`, HTTP 200, 18 micro-USDC, verified successor; [report](../evidence/I10-openrouter-tools-case-results.json) |
| Browser OpenAI demo | Actual Chrome/Phantom funding, fixed text response and SDK-verified 4-micro-USDC settlement; [observation](../evidence/I10-phantom-openai-success-observation.json), [runtime](../evidence/I10-phantom-openai-success-runtime.json) |
| That demo's withdrawal | Independent finalized transaction collection; [report](../evidence/I10-repeat-demo-withdrawal-finalized.json) |
| Second funded demo | One new actual response on a separate 2-USDC note; [observation](../evidence/I10-repeat-demo-api-observation.json). Not repeated live conversation on that note |
| Streaming | One actual OpenRouter direct Chat SSE case passed, HTTP 200, 4 micro-USDC and signed successor; [report](../evidence/I10-parity-review-live-components/direct-sse-case.json). This does not supersede the earlier proxy SSE quote failure or establish standalone Phantom streaming |
| Multiple models/direct modes | OpenRouter direct Chat JSON and SSE passed on `openai/gpt-4o-mini`, including runtime management-checkpoint corroboration and withdrawal; [aggregate](../evidence/I10-parity-review-live-components/results.json). Other direct providers/APIs, live model switching and the full matrix remain unverified |
| Compact one-signature deposit | Two actual public devnet native SDK compact deposits and mutual closes passed, six finalized transactions per lifecycle; [runtime](../evidence/I10-parity-review-live-components/direct-plain-runtime.json). The 995-byte public wire and 1,007-byte local priority-fee relay test are separate; actual compact Phantom UX remains unverified |
| SDK distribution | Compiled ES modules/types, real independent npm installation, 59 installed fixture tests and real native/WASM/artifact checks; see [distribution](distribution.md). Registry publication, deployment availability and production release are separate |
| Native installation and existing agents | Private setup/run/request commands, generated OpenClaw configuration, 43 Go race tests, installed native Vault SBF and ten actual OpenClaw CLI fixture checks. Separate actual OpenClaw text/tool continuation, signed settlement, settled restart and devnet withdrawal passed through the bounded acceptance relay; [integration evidence](../evidence/I10-external-integration.md), [native local evidence](../evidence/I10-clientd-external.md) |
| Claude Code and Codex configuration | Isolated CLI probes and configuration guides; current request validation still blocks these clients. No live-provider or funded acceptance. See [application compatibility](../integrations/README.md) |
| Production | Full I10/G3 and G1–G4 gates incomplete |

The historical funded browser demo sends a fixed prompt. The standalone
[browser chat application](https://github.com/yukikm/solana-zkapi-client) is separate;
its services, manifest pins, reservations and journals were not migrated.

Initial APIs cover text and client-executed tools. Images/documents, audio,
Realtime, hosted tools, arbitrary HTTP proxying, persisted provider conversation
storage, Ollama and native SOL billing are outside the initial release scope.

For source-specific local results of this addition, see the
[application SDK evidence](../evidence/I10-app-sdk.md) and the newer
[parity review and actual direct cases](../evidence/I10-parity-review.md). Historical failures,
waivers and reservations remain authoritative; no failed case is upgraded to a
pass by a later example or documentation change.
