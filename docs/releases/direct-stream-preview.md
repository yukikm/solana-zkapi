# Direct streaming and Response branches — SDK 0.2.0-devnet.12

[SDK `0.2.0-devnet.12`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.12)
fixes direct Chat Completions completion and preserves native `Response.clone()`
and `ReadableStream.tee()` behavior. It builds on the immutable `.10` client
source. General JSON API onboarding work, native package updates and server
deployments are outside this SDK release.

The main source checkout also contains unpublished general API onboarding work
under `0.2.0-devnet.9-onboarding.0`. Its package version and locally built tarball
are distinct from this immutable `.12` release.

Download the
[SDK archive](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.12/zkapi-solana-sdk-0.2.0-devnet.12.tgz),
[release manifest](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.12/release-manifest.json)
and [SHA256SUMS](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.12/SHA256SUMS).
Verify the immutable release and asset attestations and compare the archive's
SHA-256 with `SHA256SUMS` before installation. The
[application update procedure](../getting-started/sdk-streaming-upgrade.md)
provides commands and custody requirements.

## Completion and settlement

The earlier streaming reader stopped after a valid `finish_reason` and `[DONE]`,
then canceled the HTTP body before EOF. If EOF had not already reached the
SDK bridge, that cancellation invalidated the direct session and could leave
the application requiring a manual `recover()` after every successful reply.
The local `.11` candidate corrected that path but tied validation to the
particular `Response` consumed by the helper, which did not preserve ordinary
cloning, teeing and independent consumers.

`.12` validates Chat SSE completion in the upstream response path. Validation
does not depend on which consumer, helper, clone or tee branch reads the bytes.
Successful transport completion requires valid terminal SSE and HTTP EOF.
It retains the existing direct lease reuse behavior: an explicitly requested
next message can use the same unexpired session and conversation.
When the lease expires during a successfully completed response, existing
settlement recovery waits for and verifies the saved session's signed result.
Temporary settlement HTTP failures (408, 429 and 5xx) and request timeouts can be
retried within the bounded wait; inference and wallet transactions are never
resent.

An abort or failure before upstream EOF, malformed SSE, missing terminal
markers, or an expired transport deadline prevents successful transport
completion. A settlement wait that expires remains unresolved under the
existing recovery flow. The encrypted journal, exclusion locks, signature
checks and accounting lifecycle remain authoritative. Provider usage metadata
is not a billing receipt.

## Clones, tee branches and text readers

`client.chat()` and `client.request()` return native `Response` objects.
Before locking or consuming a body, applications can use `response.clone()` or
`response.body.tee()` with the platform's normal locking and `bodyUsed` rules.
Canceling one branch leaves another active branch able to consume the response.
Canceling all branches before upstream EOF cancels the request and retires the
lease. A caller's request `AbortSignal` still aborts the shared transport while
it is active.

A branch's cancellation promise follows native tee behavior: it can remain
pending until the other branch finishes or is also canceled. Start the other
branch's consumption or cancellation without first awaiting that promise.
This also applies to leaving a `readChatDeltas()` loop early, because the
helper cancels its branch during cleanup.

Native tee has no separate bound on its slow branch's queue. A fast reader can
cause the slow branch to buffer the whole response, subject to the SDK's
16 MiB Chat SSE response limit. Drain or cancel branches that are no longer
needed; cloning is not a way to obtain bounded per-branch backpressure.

`readChatDeltas(response)` remains a one-argument, text-only helper. The upstream
validator accepts valid Chat streams with tool calls, function calls or multiple
choices; use a provider-native SSE consumer for those responses. The helper
requires terminal text SSE and EOF before iteration completes; applications
can display yielded text immediately. A fast branch may already have completed upstream transport
while a slow branch is still displaying queued text. Keep consumer progress
separate from `client.status()`: successful transport, UI completion and verified
financial settlement are distinct events. Use `canRequest` to enable Send and
verified settlement status to display charges. A later helper rejection of
valid but unsupported content, or cancellation of already buffered bytes, does
not reverse a successfully completed upstream transport.

The shared Chat SSE transport has a 600,000 ms total deadline from creation of
the response wrapper through validated upstream EOF. The deadline ends before
existing bounded settlement waiting. Separately, the text helper gives each
pending `reader.read()` up to 600,000 ms; time spent by the consumer processing
yielded text does not count toward that read's timeout. The SDK retains the
16 MiB response and 1 MiB event bounds. Advanced daemon callers may opt into
bounded settlement waiting with the optional
`ClientDaemon.maintenance(true)` argument introduced by the earlier local
streaming candidate; omitting the argument keeps the non-waiting mode. The browser
client's existing 45,000 ms settlement wait also bounds automatic idle
settlement and transient retries; the advanced native daemon's existing
default remains 120,000 ms. See the
[application update procedure](../getting-started/sdk-streaming-upgrade.md).

## Compatibility and scope

The SDK accepts authenticated `.8`, `.9`, `.10` and `.11` profiles while
preserving their original bytes, hashes and custody bindings. No journal
schema, deployment pin, public protocol, proving artifact or transaction format
changes are needed. The `.10` authorization retirement recovery and its journal
compatibility requirements remain in effect. Keep the original installation
and backups; older clients may reject journals containing retirement records.

Verification uses synthetic provider, chain and settlement fixtures together
with the real SDK request path and streaming parser. Installed-tarball checks
exercise the packaged runtime separately. These checks do not establish fresh
funded inference, public RPC/indexer availability, browser-wallet acceptance,
mainnet support or production readiness. Normal completion avoids the spurious
manual payment check; unresolved or uncertain operations still require the
existing recovery flow.

Distribution uses GitHub release assets; npm registry publication remains
disabled. Native packages remain at immutable
[`.10`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.10).
Preserve earlier local `.11` and `.12` candidate archives and handoffs without
overwriting them; only the exact archive authenticated by this GitHub release
is its distribution artifact. This release alone does not update an already
deployed zkchat application or its worker bundle.
