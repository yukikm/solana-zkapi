# SDK and artifact distribution

Install the published **`0.2.0-devnet.8` SDK tarball** in your application.
It contains compiled JavaScript and TypeScript declarations; it does not require
the demo UI or source checkout. Downloads and verification hashes are in the
[public deployment guide](../getting-started/devnet.md).

| Input | Purpose |
|---|---|
| SDK tarball | Application API, response readers and browser worker entry point |
| Deployment bundle | Trust policy, signed manifest, proof/IDL artifacts and pinned WASM |
| Native prover or clientd package | Native proof generation or a local endpoint for an existing AI client |

Follow the [distribution reference](../../packages/sdk/DISTRIBUTION.md) for
installation, worker bundling, artifact loading and tarball builds. For an
existing AI application, use the [clientd quickstart](../getting-started/clientd.md).
Public proof assets are separate from the SDK package. Provider-management
credentials remain with the operator.

Maintainers can check an independently installed tarball with:

```sh
python3 scripts/run_external_sdk_acceptance.py --output target/sdk-distribution-check
```

The checker tests package exports, types, browser/worker builds and lifecycle
fixtures outside the source tree. Optional native/WASM artifact checks are
described in the [distribution reference](../../packages/sdk/DISTRIBUTION.md).
These local checks do not verify live providers or public-chain lifecycles.

Keep the tarball, independent trust pins and application lockfile. Registry
publication is disabled with `private: true`; tarball installation does not
require an npm release. Published native packages cover macOS ARM64; other
platforms, Apple notarization and production qualification remain outside the
verified release scope.
