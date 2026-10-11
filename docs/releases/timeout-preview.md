# Timeout improvements — SDK/native 0.2.0-devnet.9

This focused release extends `.8` transport waits for slow control, finalized
indexer and inference responses. It does not change dependencies, protocol,
proof verification, accounting, lease lifetime or recovery rules. Later general
JSON API source work is not included.

| Wait | `.8` | `.9` |
|---|---:|---:|
| Native provider response headers | 60 seconds | 10 minutes |
| Native frontend to SDK response headers | 5 minutes | 15 minutes |
| SDK control, quote, OA verification and withdrawal clearance | 60 seconds | 120 seconds |
| SDK finalized indexer/snapshot and profile RPC reads | 30 seconds | 60 seconds |
| Default full public preflight | 60 seconds | 180 seconds |

The provider response's total limit remains ten minutes. Caller cancellation,
explicit preflight overrides and existing TCP/TLS connection limits still apply.
Other applications, gateways and providers can impose shorter limits. A longer
transport wait does not extend signed quote/key/session validity. Timeouts do
not trigger inference replay; inspect and recover uncertain work first.

## Status and service checks

SDK `client.status()` and native `/admin/status` read local journal state.
They do not run a public preflight or poll the provider. Reading status before
sending is useful for detecting pending work and preventing duplicate inference.

`preflightPublicDeployment()` is an explicit, read-only network diagnosis of
configuration, catalog and finalized chain/indexer state. Applications choose
when to call it; SDK inference does not automatically run that full public check
for each request. Authorization, validity and settlement checks remain necessary.
The separate zkchat integration currently calls full preflight plus readiness
before `chat`, `request` and `prepareDeposit`; its UI policy is not changed by
installing this SDK. Applications can separate full connection diagnostics from
normal local status rendering. Do not treat an old readiness observation as
fresh admission permission or suppress a failed authorization.

A successful inference response alone does not establish verified settlement.
Check both completed response consumption and signed settlement/recovery state.
HTTP 503 is a server/proxy availability response; it is not by itself proof that
the client's timeout fired. A diagnostic endpoint may fail before inference is
sent. Longer timeouts reduce premature client aborts but cannot repair an
unavailable server.

## Download and install

Download SDK/native assets, `release-manifest.json` and `SHA256SUMS` from
[the `.9` release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.9).
Verify the GitHub immutable release/asset attestations and the downloaded
checksums before use. This is GitHub distribution, not an npm registry release.
Native support remains macOS ARM64, macOS 13.5+, without Apple notarization.

```sh
shasum -a 256 -c SHA256SUMS
npm install --save-exact ./zkapi-solana-sdk-0.2.0-devnet.9.tgz @solana/kit@8.4.0
```

Extract the native archive into a separate directory. Keep the original runtime,
profile, journal, keys and receipts. Use the [offline upgrade plan](usability-preview.md#existing-installations)
and complete pending work with the original installation. Do not replace a funded
profile binding. `.9` is not an in-place custody migration.

For a new consumer only, use these independently pinned inputs:

```json
{
  "schema": 2,
  "chain": "solana:devnet",
  "label": "Public Devnet — SDK .9 timeout improvements",
  "profileUrl": "https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.9-r7.json",
  "profileSha256": "382cc3c5359a9a2fdcf67a7ae0524f26397e705055ff9105c95ca32ec3186fd3"
}
```

Revision 7 changes only revision and SDK compatibility from revision 6. All 21
models, tariffs, deployment and artifact pins remain identical; existing profile
objects remain unchanged. Run the new installation's public consumer helper with
these profile flags for read-only preflight. No wallet or inference is needed.
See [support](../support.md) for verification boundaries.
