# Support and verification status

Updated 2026-10-06 JST. “Implemented,” “locally tested” and “publicly verified”
describe different boundaries. Evidence is tied to the source/configuration
tested at the time; adding a wrapper does not reverify an older deployment.

| Capability | Current evidence / limit |
|---|---|
| Application SDK and response helpers | New local fixture tests; no new provider/public-chain acceptance from this change |
| Encrypted browser storage | Actual headless Chrome/IndexedDB/Web Locks tests; not portable backup or OS-keychain acceptance |
| OpenRouter proxy Chat tools | One real case, `openai/gpt-4o-mini`, HTTP 200, 18 micro-USDC, verified successor; [report](../evidence/I10-openrouter-tools-case-results.json) |
| Browser OpenAI demo | Actual Chrome/Phantom funding, fixed text response and SDK-verified 4-micro-USDC settlement; [observation](../evidence/I10-phantom-openai-success-observation.json), [runtime](../evidence/I10-phantom-openai-success-runtime.json) |
| That demo's withdrawal | Independent finalized transaction collection; [report](../evidence/I10-repeat-demo-withdrawal-finalized.json) |
| Second funded demo | One new actual response on a separate 2-USDC note; [observation](../evidence/I10-repeat-demo-api-observation.json). Not repeated live conversation on that note |
| Streaming | Implemented and locally tested. The recorded OpenRouter SSE run stopped before inference; [report](../evidence/I10-openrouter-sse-quote-failure-results.json) |
| Multiple models/direct modes | Implemented configuration/adapters; full live compatibility and management-key rights remain unverified |
| Compact one-signature deposit | Local actual SBF and SDK wire verified; public compact deployment/Phantom not established by those tests; [review](../evidence/I10-single-deposit-review.md) |
| npm/package release | Source workspace only (`private: true`); public distribution and production bundle pending |
| Production | Full I10/G3 and G1–G4 gates incomplete |

The current browser demo sends a fixed prompt. It is not a general chat app.
The new application facade and example are separate from that funded demo;
its services, manifest pins, reservations and journals were not migrated.

Initial APIs cover text and client-executed tools. Images/documents, audio,
Realtime, hosted tools, arbitrary HTTP proxying, persisted provider conversation
storage, Ollama and native SOL billing are outside the initial release scope.

For source-specific local results of this addition, see the
[application SDK evidence](../evidence/I10-app-sdk.md). Historical failures,
waivers and reservations remain authoritative; no failed case is upgraded to a
pass by a later example or documentation change.
