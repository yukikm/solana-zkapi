# Ethereum parity review: browser and application SDK

Reviewed 2026-10-07 JST, after pulling Solana commit
`664db46e00f77659203b81482f2859ca04d25fc8`. The Ethereum source reference remains
`045b444ea1b52538d1b40273c7cb6ed09468a052`.

This review covers the standalone browser conversation, public application SDK,
response consumers, custody disclosure and recovery controls. It reuses the
existing wallet/control lifecycle and encrypted journal. It does not migrate a
funded note, change public deployment pins, spend a provider reservation or add a
second financial state machine.

## Corrected findings

1. **P2: Chat text readers accepted unsupported tool calls as complete text.**
   A JSON message containing both text and `tool_calls`, or an SSE delta with
   tool fields, could be treated as a complete ordinary answer. The standalone
   conversation would then retain text while discarding the tool-call context.
   Both readers now reject actual tool calls, legacy function calls, unsupported
   roles and unknown finish reasons. Applications handling client tools must
   consume the native response explicitly. Empty tool lists remain compatible
   with ordinary text responses.
2. **P2: Chat SSE completion did not require a terminal choice.** A bare
   `[DONE]`, or partial content followed directly by `[DONE]`, was accepted as
   successful completion. The parser now requires a recognized text finish
   reason before `[DONE]` and rejects further choices after termination. A
   regression verifies that partial output remains visible as interrupted and
   cannot enter the next request's conversation context. No inference is replayed.
3. **P2: Conversation retention wording understated local storage.** The UI's
   transcript is memory-only, but `Operation.bodyBase64` contains request bodies,
   including prompts and complete prior turns. Settlement copies those operations
   into encrypted journal history. The app, clear-conversation result and README
   now explain that these bodies remain after settlement and clearing the visible
   conversation. The journal is preserved, including all financial recovery data.
   This is a disclosed content-retention difference from the Ethereum native
   helper's documented separation from prompts and responses; encryption does not
   remove the trusted-application/origin boundary.

The [baseline reproduction](I10-parity-review-ux-components/baseline-reproduction.log)
loads `chat.ts` directly from the pulled Git commit in an isolated temporary
directory. It records the old acceptance of mixed tool text and an empty bare-DONE
stream. The current negative tests reject both.

## Verification

All six [recorded command stages](I10-parity-review-ux-components/results.json)
passed with Node 24.19.0:

| Check | Result |
| --- | --- |
| SDK chat/client and browser conversation/native-response suites | 47 passed, zero failures/skips |
| SDK TypeScript check | Passed |
| Browser example TypeScript check | Passed |
| Browser example and prover-worker build | Passed |
| Actual Chrome 154.0.8037.98 standalone UI scenario | 1 passed, zero failures/skips |
| `git diff --check` | Passed |

The Chrome scenario uses an isolated profile and explicit synthetic wallet,
SDK and provider ports. It checks the current UI's explicit account/mode choice,
history across models/APIs, cancellation through delayed cleanup, recovery,
clearance, emergency escape/challenge/finalization and unchanged financial state
after clearing the transcript. Its six synthetic inference calls remain six;
the added retention assertion adds no inference or network traffic. The separate
SDK tests use the real encrypted journal and shared lifecycle with synthetic
provider/proof/chain ports. These are focused local tests, not a new immutable
full-I10 aggregate or live-provider acceptance.

## Final combined-source UI verification

After the parallel SDK lifecycle, authorization immutability, emergency escape
and host-routing corrections were present, a fresh seven-stage UI run passed.
The [final command and source inventory](I10-parity-review-ux-final-components/results.json)
records **115 inputs unchanged** during this run, Node 24.19.0 and each log hash.
The earlier 47-test checkpoint above remains evidence for its original snapshot.

| Final check | Result |
| --- | --- |
| All wallet UI suites, including host, provider, storage-note presentation and two actual Chrome fixture scenarios | 72 passed, zero failures/skips |
| Strict wallet UI TypeScript check | Passed |
| Standalone conversation and native JSON/SSE readers | 17 passed, zero failures/skips |
| Standalone TypeScript check and fresh browser/worker build | Passed |
| Standalone actual Chrome 154.0.8037.98 scenario | 1 passed, zero failures/skips |
| `git diff --check` | Passed |

These tests use isolated browser profiles and synthetic provider/wallet/chain
ports. They do not interact with the existing funded browser profile, campaign
reservations or the separate live acceptance campaign. The historical actual
Chrome/Phantom fixed-prompt success remains recorded in
[SDK support status](../sdk/status.md). This new standalone fixture result does
not upgrade that historical result into current multi-model, streaming, direct
browser or fresh-profile Phantom acceptance.

## Compact relay follow-up

A later SDK-wire reproduction identified that the live wallet host still rejected
`deposit_compact_v1`, despite the wallet selecting it for independently pinned
compact-capable manifests. The [compact relay review](I10-parity-review-compact-relay.md)
records the HTTP 400 red case and guarded fix. A fresh combined-source run passed
73 wallet UI tests, 63 compact/trust/transport tests, UI typechecking, standalone
build and the actual Chrome standalone scenario with zero skips. This supersedes
the earlier 72-test UI snapshot for the relay fix while preserving that history.

## Remaining demonstration boundaries

- The default standalone app has an empty reviewed-profile list. The later
  [browser provisioning follow-up](I10-parity-review-browser-provisioning.md)
  adds independently pinned build-time installation and bounded local routing.
  It intentionally makes no deployment request before such a profile is installed.
  The previously successful fixed-prompt Chrome/Phantom demonstration remains
  valid for its recorded snapshot, but it does not establish the standalone
  app's repeated conversation, model switching, native APIs or streaming.
- Broad public parity still needs that configured application exercised with
  actual Chrome/Phantom, compact funding, repeated sends on the same note,
  configured models/APIs, direct and proxy routes, cancellation, reload and
  settlement/withdrawal/operator-outage recovery. Existing authorized global
  provider reservations must remain intact. Local fixtures cannot fill missing
  direct-provider credentials or prove CORS and provider compatibility.
- The public SDK is a source workspace, not a published npm package. Browser
  custody depends on the same origin/profile/account, and portable backup is
  unavailable. The text UI delegates client-tool execution to advanced SDK
  consumers. These limits remain explicit; the app does not claim tool execution
  or transcript restoration.
- Mainnet deployment and third-party audit are later milestones and are not
  counted as failures of this devnet review. USDC billing and exclusion of Ollama
  remain intentional project scope.

See [current SDK support status](../sdk/status.md), the earlier
[browser evidence](I10-parity-browser.md), and the separate privacy/protocol
review for the complete trust comparison. Historical funded journals, profiles,
budgets, receipt reports and the user's untracked review directory are unchanged.
