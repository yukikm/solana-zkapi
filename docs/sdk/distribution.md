# Independent SDK and artifact distribution

Install Solana zkAPI in an application repository with a reviewed SDK tarball.
The package contains compiled JavaScript and TypeScript declarations; the demo
UI and the zkAPI source checkout are not runtime dependencies. Start with the
[self-contained distribution guide](../../packages/sdk/DISTRIBUTION.md) for
installation, worker bundling and the public deployment artifact format.

There are two separate deliverables:

| Deliverable | Contents | Application integration |
|---|---|---|
| `zkapi-solana-sdk-0.2.0-devnet.1.tgz` | SDK ES modules and declarations with explicit exports | Install with npm; use `createZkApiClient` or `createBrowserClient` |
| Public deployment bundle | Independently reviewed trust policy, signed manifest, complete proof/IDL artifacts and pinned WASM | Host as static files and call `loadDeploymentAssets` with an independently installed descriptor SHA-256 |

A native application additionally installs the pinned native prover for its
platform. Existing OpenAI-compatible applications can use the
[local clientd setup](clientd-quickstart.md). The agent application receives only
clientd's local inference token. Provider-management credentials belong to the
operator's separate service configuration.

Build and verify a SDK release from the repository root:

```sh
npm ci
npm pack --workspace @zkapi/solana-sdk --pack-destination /absolute/existing/output
python3 scripts/run_external_sdk_acceptance.py --output target/sdk-distribution-check
```

This checker copies the actual tarball to a temporary independent project,
installs it without source links, resolves every exported declaration, builds
browser and worker bundles, and runs the lifecycle, trust, response and asset
loader tests through package imports. Public deployment assets are never silently
added to the npm package. `private: true` deliberately prevents accidental
registry publication; registry publication is not needed for tarball installs.

For the optional real local artifact checks, first build the native/WASM provers
and prepare a public bundle with the offline packager, then run:

```sh
python3 scripts/run_external_sdk_acceptance.py \
  --output target/sdk-distribution-artifact-check \
  --real-provers \
  --asset-bundle /absolute/path/to/public-assets \
  --asset-bundle-sha256 <independently-retained-bundle-json-sha256>
```

The test copies the native binary, WASM and public artifacts into the independent
project, verifies exact artifact hashes, compares native/WASM snapshot
reconstruction, and rejects tampering. It makes no RPC, AUTH, funding or provider
request. Actual provider/devnet evidence remains separately scoped. See the
[distribution evidence](../evidence/I10-sdk-distribution.md).

Keep the exact tarball and an application lockfile for reproducible installs.
Review dependency changes when updating either. A checksum supplied by the same
untrusted download is not an independent trust anchor. The
[Devnet Preview release](../releases/devnet-preview.md) is publicly downloadable
and has a verified GitHub immutable-release attestation. Other-platform native
installers, Apple signing/notarization and full production gates remain separate.
