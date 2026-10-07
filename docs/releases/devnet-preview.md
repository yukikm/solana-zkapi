# Devnet Preview 0.1.0-devnet.1

This preview distributes the application SDK and local clientd. It is intended
for developers integrating with a reviewed Solana zkAPI devnet operator.
It does not provide a default public operator, a mainnet deployment, a security
audit or full production acceptance.

Download the release assets from
[GitHub Releases](https://github.com/yukikm/solana-zkapi/releases/tag/v0.1.0-devnet.1).

| Asset | Use |
|---|---|
| `zkapi-solana-sdk-0.1.0-devnet.1.tgz` | Compiled ESM and TypeScript declarations for independent applications |
| `zkapi-clientd-0.1.0-devnet.1-darwin-arm64.tar.gz` | Local daemon, Node runtime, native prover/verifier and dependencies; Apple Silicon, macOS 13.5+ |
| `SHA256SUMS` | Exact archive hashes; authenticate the release before trusting these values |
| `release-manifest.json` | Package hashes, source revisions, platform requirements and validation scope |

No npm registry package is endorsed. npm publishing remains disabled in the SDK
package; installing the release tarball is supported. Newly authored code is
MIT licensed, with third-party notices preserved in the source and distribution.

## Install the SDK

Download the SDK tarball and `SHA256SUMS`. Verify the release and archive using
the available GitHub release attestation, or an independently trusted archive
hash. Install the exact checked file:

```sh
npm install ./zkapi-solana-sdk-0.1.0-devnet.1.tgz
```

Use Node 24.19.0 for the validated native SDK environment. Browser consumers
bundle the browser and worker entry points. Follow the
[SDK quickstart](../sdk/quickstart.md) and
[artifact installation guide](../../packages/sdk/DISTRIBUTION.md).

## Install clientd

The native archive requires Apple Silicon and macOS 13.5 or later. This build
was tested on macOS 26.6.2; other operating systems and architectures have not
been verified. Extract the checked archive into a new installation directory:

```sh
tar -xzf zkapi-clientd-0.1.0-devnet.1-darwin-arm64.tar.gz
./zkapi-clientd-0.1.0-devnet.1-darwin-arm64/bin/clientd --help
```

Follow [private setup, funding and recovery](../sdk/clientd-quickstart.md).
The release manifest records the installed `release.json` digest required by
`clientd setup`. Keep the installation immutable and the private profile outside
it. Give an AI application only the local inference token.

The [OpenClaw guide](../integrations/openclaw.md) uses a dedicated configuration,
disabled retries and explicit Chat-capable model policies. Legacy string-only
model entries are rejected by the generator. Claude Code and Codex remain
blocked by their current production request formats; their diagnostic guides
are not a compatibility claim.

## Required operator inputs

An operator must supply an independently reviewed trust policy, signed manifest,
proof/IDL/WASM assets, network routes, model tariffs, and available control,
indexer and RPC services. The public package does not choose or discover an
operator. Installing it does not deposit funds or authorize inference.

The prepared complete proof bundle is omitted from this release because the
redistribution terms of four upstream setup files have not been established.
See [third-party notices](../../THIRD_PARTY_NOTICES.md). Existing local and funded
deployment artifacts remain unchanged. Do not substitute new keys or manifests
for an existing note.

## Verification boundary

Credential-free tests exercise SDK lifecycle fixtures, browser custody,
independent package installation, Go race checks and installed local clientd
behavior. Historical public devnet SDK and OpenClaw lifecycles remain separately
recorded in [integration evidence](../evidence/I10-external-integration.md).
The OpenClaw live run used a bounded custom devnet relay; it did not establish
public transport acceptance for the stock supervisor. Historical provider
failures, reservations and recovery records remain preserved.

The focused client preview CI does not replace the historical full implementation
matrix. Its old evidence snapshot checker is known to disagree with later
source revisions. No full I10, G1–G4, mainnet or audit pass is claimed.
