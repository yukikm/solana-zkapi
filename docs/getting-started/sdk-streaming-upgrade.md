# Update a chat application to SDK 0.2.0-devnet.12

[SDK `.12`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.12)
fixes completion of direct OpenRouter Chat Completions streams and preserves
native response cloning and teeing. The
[release notes](../releases/direct-stream-preview.md) describe behavior and
remaining limits. This SDK-only release retains the existing `.10` native
packages and does not authorize paid inference or transactions.

## Install the reviewed archive

Use Node 24.19.0 and npm 11.9.0. Download the exact
[SDK archive](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.12/zkapi-solana-sdk-0.2.0-devnet.12.tgz)
and [SHA256SUMS](https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.12/SHA256SUMS)
into a new directory. Follow the
[distribution verification commands](https://github.com/yukikm/solana-zkapi/blob/v0.2.0-devnet.12/packages/sdk/DISTRIBUTION.md)
to verify the release and both asset attestations, then compare the SDK's
SHA-256 with its entry in the authenticated `SHA256SUMS`.

In the consuming application, preserve previous tarballs and the lockfile.
Earlier local `.11` and `.12` candidates retain their original archives and
handoffs; a local `.12` filename alone does not identify the published bytes.
If the vendor directory already contains that filename, retain it under its
original checksum in a separate archive directory before copying the verified
release asset into the vendor directory. Then install it:

```sh
shasum -a 256 vendor/zkapi-solana-sdk-0.2.0-devnet.12.tgz
npm install --save-exact ./vendor/zkapi-solana-sdk-0.2.0-devnet.12.tgz
```

Keep `@solana/kit` at 8.4.0 when the application imports it. Add the new archive
and checksum to the application's integrity checks; retain earlier archives
needed for recovery. This release has no npm registry package or new native
archive. A locally computed checksum alone does not authenticate an artifact.

## Preserve existing custody

Keep the same browser origin, wallet account, profile URL and authenticated
profile hash, deployment pins, storage name, note IDs, deposit catalog, journals,
receipts and recovery material. `.12` accepts the existing authenticated `.8`,
`.9`, `.10` and `.11` profiles without replacing their contents. Retain the
original installation and a backup. Do not run two clients against the same custody
concurrently. Preserve separate legacy recovery builds and their original SDKs.

When updating zkchat, the runtime version becomes `.12`, while its existing
storage generation remains `.8`: `zkchat-sdk-0.2.0-devnet.8` and the original
note/catalog identities. Keep `public/zkapi-config.json` unchanged. The `.3`
recovery build keeps its original SDK, worker and profile. Preserve unresolved
work and use the existing explicit recovery action when its result is uncertain.

## Rebuild and verify the application

Update the dependency and lockfile, runtime version labels, expected SDK version
assertions and archive checksums. In zkchat these are maintained in
`vite.config.ts`, `src/lib/sdkVersion.ts`, `scripts/verify-sdk.mjs`, build checks
and SDK compatibility tests. Do not derive storage names from the newly installed
SDK version.

Rebuild the application and its prover worker from the same SDK. Continue to
create a fresh operation UUID only for each explicit Send, retain the conversation
`sessionId`, and keep `keyReuseSeconds: 60` for the existing public OpenRouter
profile. Consume the full `readChatDeltas()` iterator. A valid final SSE event
does not finish the call until HTTP EOF is confirmed; interruption and failure
must continue to use existing status and recovery controls.
Pass the application's stop signal to `client.chat({ ..., signal })` as before.
The reader keeps its one-argument, text-only contract and existing response/frame
size limits. The shared Chat SSE transport has a 600,000 ms deadline through
validated upstream EOF, ending before settlement waiting. Each pending helper
read separately has a 600,000 ms timeout; consumer processing pauses between
reads do not count toward it. The browser client's automatic settlement wait
remains bounded to 45,000 ms.

Native `Response.clone()` and `response.body.tee()` are supported before the
body is locked or consumed. Keep their consumers independent: a fast branch
can finish upstream transport while another still displays buffered text.
Cancel an unused branch without awaiting its cancellation promise before
starting or canceling the other branch. Native tee cancellation can wait for
both branches to finish; canceling one branch does not stop the other.
Canceling all branches before EOF makes the request incomplete. An abort on
the original request signal still affects the whole active transport.

A slow tee branch can buffer the entire response, up to the 16 MiB Chat SSE
response limit; there is no additional per-branch queue bound. Prefer a single
consumer when a second copy is unnecessary. Read `client.status()` for request
availability and verified financial state, separately from each branch's UI
progress. `readChatDeltas()` remains text-only; use a native SSE consumer for
tool calls, function calls or multiple choices. Rejecting unsupported content
or canceling buffered data after successful upstream EOF does not undo that
transport's completion.

For zkchat's local fixture checks:

```sh
npm run verify:sdk
npm test
npm run build
node scripts/check-build.mjs
npm run test:e2e
```

These commands do not establish live provider or wallet acceptance. Application
deployment is a separate action: serve both rebuilt app and worker bundles at
the existing origin, with its existing recovery build and custody configuration.
Updating the library source or server alone does not update browser clients.

Normal replies should allow the next explicit Send without a manual payment
check. Expired sessions may remain unavailable while their verified settlement
is pending. If the bounded wait expires, the service remains unavailable, or a
request was interrupted, keep the pending operation and use explicit recovery;
do not resend inference or force `canRequest` to `true`.
