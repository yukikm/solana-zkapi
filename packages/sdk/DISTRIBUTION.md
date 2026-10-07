# Installing the SDK outside this repository

The SDK is distributed as an npm tarball. It contains compiled ES modules and
TypeScript declarations, so your application does not need TypeScript source
loading or access to the zkAPI repository. Registry publication is disabled with
`private: true`; no package under this name on npm is endorsed by this project.

Obtain `zkapi-solana-sdk-0.2.0-devnet.1.tgz` and its SHA-256 through a trusted release
channel, check the checksum, then install the exact tarball. The release target is
[`v0.2.0-devnet.1`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.1).
Check that the assets and manifest have actually been published; a source version
or a locally built archive alone does not establish publication:

```sh
shasum -a 256 zkapi-solana-sdk-0.2.0-devnet.1.tgz
npm install --save-exact ./zkapi-solana-sdk-0.2.0-devnet.1.tgz @solana/kit@8.4.0
```

Read the [Kit API migration guide](../../docs/sdk/kit-migration.md) when upgrading
from the first preview. Keep the tarball and your application's lockfile. Node integrations use Node
24.19.0 (the validated Node 24 release); browser applications bundle the browser
entry points for a modern browser with Web Crypto, Workers, IndexedDB and Web
Locks. Node's native SQLite journal is available through the separate
`@zkapi/solana-sdk/journal-node` entry point. Browser imports do not include Node
filesystem, process, SQLite or child-process APIs.

```ts
import { createZkApiClient } from '@zkapi/solana-sdk';
import { createBrowserClient } from '@zkapi/solana-sdk/browser';
import { readChatText, readChatDeltas } from '@zkapi/solana-sdk/chat';
```

For a browser prover worker, create an application-owned entry file:

```js
// prover.worker.js — bundle as a separate ES module worker.
import '@zkapi/solana-sdk/prover-worker';
```

Point `createWorker` at your application's bundled worker. Do not serve the
package's unbundled entry file directly; its imports must be resolved by your
application build. Native clients use `NativeProver` from
`@zkapi/solana-sdk/prover-node` with the independently pinned executable path and
SHA-256. Explicit `./control`, `./wallet`, `./transport`, `./trust`,
`./session-snapshot` and other documented exports remain available for advanced
integrations. Internal file paths are not public imports.

## Deployment and prover assets are separate

Installing this library does not select an operator or authorize spending. It
ships no deployment, provider key, wallet key, journal, WASM binary or proving
key. Application maintainers install a reviewed deployment bundle separately:

- Independent `ManifestTrustPolicy` with expected deployment, chain, program,
  Pool, mint, service origins and build/role pins; its trust anchor must not be
  derived from a freshly downloaded manifest.
- Signed manifest bytes and the complete `ArtifactBundle`: compiler-backed Vault
  IDL, request/withdrawal/tree proving and verifying keys, pinned tree source and
  verifier constants, and all additional manifest artifact entries.
- Locally installed WASM plus its independent SHA-256, or a native prover binary
  plus its independent SHA-256. The browser worker comes from your trusted build.
- A browser-safe RPC endpoint, authenticated indexer/control configuration and
  tariff/model configuration supported by that deployment. Never place private
  RPC URLs or provider-management credentials in browser assets.

`createZkApiClient` authenticates the manifest, all artifacts, RPC genesis and
finalized PoolConfig before use. `createBrowserClient` also checks WASM bytes
before opening custody. Missing or mismatched inputs fail closed. Tarball and
checksum integrity alone is not authenticated distribution if both arrive from
an untrusted source. Setup assumptions, operator availability, program upgrade
powers and provider metering remain deployment trust boundaries.

Keep the same deployment pins and journal for funded or unresolved notes. A
library update must not rewrite deployment identity or replace uncertain signed
operations. All amounts use integer micro-USDC; inference is never silently
replayed, and direct mode never falls back to proxy. The encrypted journal can
retain exact request bodies, including conversation context.

## Building a tarball from a reviewed checkout

From the repository root, install the pinned build dependencies and run:

```sh
npm ci
mkdir -p target/sdk-distribution
npm pack --workspace @zkapi/solana-sdk --pack-destination target/sdk-distribution
shasum -a 256 target/sdk-distribution/zkapi-solana-sdk-0.2.0-devnet.1.tgz
python3 scripts/run_external_sdk_acceptance.py
```

`prepack` clears stale output and builds JavaScript/declarations. The package
allowlist excludes source tests, runtime state, environment files and deployment
assets. The isolated acceptance installs the actual tarball outside the checkout,
checks Node imports and declaration resolution, bundles browser and worker entry
points, verifies the browser graph has no Node builtins, and runs existing
lifecycle/response tests against the installed package. These are local fixture
checks; they do not establish live provider, devnet funding, Phantom or release
acceptance. Newly authored SDK code is covered by the included MIT LICENSE;
dependencies retain their own notices. Public preview distribution does not
establish production release acceptance.

## Loading a distributable public artifact bundle

An operator can package the authenticated public assets once with the offline
`package_sdk_distribution_assets.mjs` tool in the source checkout. Its input has
only these fields: `schema: 1`, `trust` (the independently reviewed
`ManifestTrustPolicy`), `manifest` (a path), `artifacts` (the `ArtifactBundle`
field names with file paths, including `additional`), and
`wasm: {path, sha256}`. Paths are relative to the input JSON. The output directory
must be new. No wallet, provider, RPC credential or journal configuration belongs
in this input.

```sh
node scripts/package_sdk_distribution_assets.mjs reviewed-public-input.json public-assets
```

The packager verifies the existing SDK trust contract, all manifest artifacts,
and the WASM digest before writing the bundle. Its output includes `bundle.json`
and flat public files. Preserve the reported `bundleSha256` through an independent
trusted channel, then distribute the files through static hosting. The descriptor
is bounded to 1 MiB and its combined public assets to 512 MiB. Nothing is uploaded
by the packager. Program deployment, service endpoints and model tariffs remain
operator configuration.

Independent browser applications can now load this bundle without importing any
reference UI code:

```ts
import { loadDeploymentAssets } from '@zkapi/solana-sdk/deployment';

const assets = await loadDeploymentAssets('https://your-app.example/zkapi/bundle.json', {
  bundleSha256: independentlyInstalledBundleSha256,
});
// Supply assets.manifest, assets.trust and assets.artifacts in ClientDeployment.
// For createBrowserClient also supply assets.wasm and assets.wasmSha256.
// The app still owns its Kit RPC client, indexer origin, models, wallet and storage.
```

The loader uses only flat files in the descriptor's directory. It authenticates
the descriptor before following its paths, verifies sizes and hashes, and invokes
the existing manifest/artifact checks. Fetches omit credentials and reject
redirects. The default overall deadline is 120 seconds, configurable up to 300
seconds with `timeoutMs`; `signal` permits caller cancellation. Failures expose a
redacted `DeploymentAssetsError`. Its download checks do not establish finalized
chain state; the application factory performs that check before use.
