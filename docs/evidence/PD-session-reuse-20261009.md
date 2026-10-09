# Ethereum session reuse parity — source follow-up

Recorded 2026-10-09 JST. The user requested comparing settlement frequency with
Ethereum zkAPI and aligning the implementation when different. This change is
**locally verified, unpublished source work**. Public SDK/native `.3` artifacts,
profiles, custody, running services and the exhausted seven-request grant remain
unchanged.

## Upstream comparison

`git ls-remote https://github.com/ethereum/zkapi.git HEAD` returned
`045b444ea1b52538d1b40273c7cb6ed09468a052`, the existing vendored baseline. Four
anonymous HTTPS downloads matched the vendored bytes exactly; their SHA-256
values are in the [machine-readable record](PD-session-reuse-20261009.json).

| Surface | Ethereum behavior | Solana source follow-up |
|---|---|---|
| Browser SDK | Reuse a live in-memory lease for the same conversation and spending policy; renew with 90 seconds or less remaining | Direct application API requests a 300-second lease, scopes reuse with `sessionId` and rotates at that margin |
| Native clientd | Default fixed 60-second reuse window, configurable 0–300; shorter provider expiry wins; requests do not extend the window | Preserve the 60-second default, bind the window to acquisition/expiry, and wait for a group of completed responses to settle before fresh authorization |
| Successful response | Release the response's use of the key without settling every call | Keep the lease available after body consumption, with one saved operation UUID per explicit send |
| Retirement | Expiry, explicit close or policy renewal triggers settlement; clientd also invalidates reuse on cancellation/errors | Close on those boundaries, wait for active response bodies, retain signed successor verification and explicit recovery after uncertainty |

References: [browser reuse and rotation](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/sdk/services/browserWalletRuntime.js#L1963-L2067),
[browser response release](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/sdk/services/browserWalletRuntime.js#L2332-L2372),
[server default 300-second TTL](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/crates/zkapi-cli/src/main.rs#L56-L57),
[native default and bounds](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/zkapi-clientd/internal/config/config.go#L20-L23),
and [native acquisition and completion](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/zkapi-clientd/internal/zkapi/client.go#L248-L472).

The previously installed five-second OpenRouter accounting grace remains the
[separate accounting policy](PD-openrouter-ethereum-parity.md). Reuse changes when
retirement starts; it does not remove usage capture, deletion, capped charges or
signed settlement verification.

## Source changes

- The application facade uses the existing `ClientDaemon` and encrypted
  `NoteJournal`; no second financial state machine or journal migration is added.
- Direct defaults request a 300-second lease. `keyReuseSeconds: 0` retains the
  previous per-request behavior; explicit 1–300 selects a fixed window. Proxy's
  default remains per-request because upstream browser direct reuse does not
  define a third-party proxy policy.
- Optional `sessionId` binds direct reuse to one local conversation; omitted
  values use `default`. Another conversation must explicitly settle first. The
  identifier is copied before asynchronous work and is not sent to the provider.
- `canRequest` now recognizes an owned active session. A non-null session is no
  longer sufficient to classify the client as needing recovery. Initialization
  and status remain read-only; idle checks cause no control traffic before
  retirement and do not emit periodic busy states.
- The facade waits up to 45 seconds for renewal settlement; reusable direct
  clientd defaults to a bounded 120-second wait. Every previous operation must
  have a fully consumed successful response in the same process before that
  automatic wait is allowed. Failure consumes that permission. Inference is
  never retried, and a new operation is not authorized before the prior signed
  successor is accepted.
- Reopening a journal cannot revive a key or borrow another facade's lease.
  Provider keys remain memory-only. Disposal stops local timers without erasing
  custody or implying remote retirement. Ordinary direct withdrawal first asks
  the existing lifecycle to close; pending settlement still blocks withdrawal.

The source retains serial application actions and existing cap/receipt checks.
This does not establish complete equivalence of every browser/native API,
spending-tier feature, concurrent-request policy or deployment configuration.

## Verification and retained failures

Pinned Node **24.19.0**:

- Final complete SDK suite: **397 passed, zero failures or skips**.
- Independent npm tarball consumption: **84 installed lifecycle/trust tests
  passed, zero failures or skips**. Export/declaration checks, public consumer
  adapter/network/installer tests, consumer typecheck, and browser/worker builds
  passed. Its recorded source inputs remained unchanged during the run.
- SDK typecheck and build passed. Design/link checks and `git diff --check`
  passed before this final evidence addition and were rechecked afterward.

New coverage includes grouped settlement across models, the exact 90-second
renewal boundary, fixed expiry, idle close, an in-flight stream at expiry,
retirement pending across multiple completed operations, signature rejection,
cancellation/errors/non-2xx responses, reload ownership, immutable conversation
arguments and explicit zero-reuse compatibility.

The first focused run had three failures: fixtures expected unknown operations
to remain pending after the new direct retirement behavior, and retirement had
initially also changed the proxy uncertainty path. The proxy path was restored;
the direct assertion now verifies retained settled history and no replay.
Subsequent focused 61/61 and 69/69 runs, the earlier full 396/396 run and both
independent-package reports remain in the task's ignored output directory. An
initial Python HTTPS attempt failed certificate validation; a subsequent curl
download used its normal TLS verification and matched all four vendored files.
No TLS verification bypass was used.

## Distribution boundary

The local test tarball has SHA-256
`09cbbe5b4800594f72ccd0abf7a83db6bbe379e1a8510b406066f3b9ab5480cf`.
It retains the development package version for testing and is **not a replacement
for the immutable published `.3` release**. A successor release and matching
consumer installation are still needed. The current public `.3` native-input
helper stays at zero reuse plus its compatible 120-second wait; changing it to
reusable grouped waiting would be incompatible with the published `.3` binary.
No independent chat repository or existing installed runtime was modified.

All lifecycle/provider data here is local fixture data. No live AUTH, provider
inference, reservation, wallet action, grant reset, host mutation, Git push,
release publication or hosted CI occurred. Historical sessions, financial cuts,
receipts, releases and earlier failures remain preserved.
