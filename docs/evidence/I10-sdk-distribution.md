# Independent SDK distribution — 2026-10-07 JST

The SDK can now be installed by an application outside the zkAPI checkout.
The compiled package has explicit ES-module and TypeScript-declaration exports,
including browser, worker, native journal/prover and the existing advanced
interfaces. `private: true` remains enabled to prevent accidental npm registry
publication; ordinary npm tarball installation works without registry publication.

This initial distribution checkpoint produced `zkapi-solana-sdk-0.1.0.tgz`, **107,706 bytes**, with SHA-256
`3e601fae1d41a804a3c59b10c0eb88052bbedd0ba9317ad88e7cdb9fad06ebbd`.
The controlled package contains 58 regular files: compiled modules/declarations,
package metadata and the three SDK documents. It contains no source tests,
environment files, keys, deployment state, proving assets, WASM or journals.
The separate client repository retains the exact tarball for its file dependency.
The later [SSE parser correction](I10-sdk-sse-parser.md) has a separately verified
replacement package and preserved reports; it does not overwrite this checkpoint.

## Implementation

- [Package configuration](../../packages/sdk/package.json) points to compiled
  `dist` modules and declaration files. [The build](../../packages/sdk/build.mjs)
  clears stale outputs, uses pinned TypeScript, rewrites runtime extensions and
  normalizes declaration imports to `.js`. Internal/source paths are not exported.
- [Public asset packaging](../../scripts/package_sdk_distribution_assets.mjs)
  authenticates the independently supplied manifest/build policy, the complete
  existing artifact contract and WASM hash before writing a new directory.
  Outputs have flat filenames, no input filesystem paths and no private host
  configuration. The output descriptor is limited to 1 MiB and public files to
  512 MiB combined. An existing output is refused.
- [The SDK asset loader](../../packages/sdk/src/deployment.ts) authenticates an
  independently installed descriptor digest before requesting same-directory
  files. It verifies byte bounds/digests and uses the existing manifest/artifact
  checks. Credentials are omitted and redirects refused. An overall deadline and
  caller cancellation also bound custom fetch/read implementations that ignore
  aborts; stalled cleanup cannot hold initialization open or expose private errors.
- `ClientDaemon.status()` now returns an explicit unfunded/zero/null-head state
  for a new native profile. This local read creates no note and makes no control
  request. Corrupt journals still fail. No financial state machine was duplicated.
- The explicit [independent-app devnet harness](../../scripts/external_sdk_live.mjs)
  imports only installed package exports. It persists one attempted command per
  inference scenario, refuses inference replay and exact-signature transaction
  resends, and retains encrypted state for explicit recovery. Its presence and
  routing unit tests do not constitute a devnet or provider pass.

## Isolated acceptance

The final command was:

```sh
PATH="$PWD/target/i08-toolchain/bin:$PATH" \
  python3 scripts/run_external_sdk_acceptance.py \
  --output target/sdk-distribution-evidence \
  --real-provers \
  --asset-bundle target/external-integration/public-assets \
  --asset-bundle-sha256 af5a2eb9e11cf93174d9e1391e523a017f028a1518cd768de102f9e326bde591
```

The [saved report](I10-sdk-distribution-components/results.json) passed nine
stages in **8.613 seconds** on **Node 24.19.0**, with **42 guarded SDK/build/test
inputs unchanged**. Its original bytes are retained in
[original-results.json](I10-sdk-distribution-components/original-results.json).
The archived report changes only log references to their checked-in `.txt`
filenames and records the original report hash; log bytes retain their reported
hashes. The consumer lockfile and browser/worker build graphs are retained beside
it.

The test created a project in a temporary directory outside the checkout,
copied the actual tarball there, and performed a separate npm installation.
The installed SDK is a real directory with no `src` folder, workspace symlink or
repository-relative import. All public Node exports imported; both source and
internal `dist` path imports were rejected. All public declaration imports passed
strict NodeNext checking. Browser and worker bundles resolved solely to files in
the isolated project and installed dependencies, with no Node builtins in the
browser graph.

**57 tests passed with zero failures, skips, cancellations or TODOs**, using the
existing application lifecycle, model, trust and response suites through
installed package imports, plus the asset loader boundaries. HTTP/provider/chain
responses in these tests are fixtures. The separate **one real native/WASM test**
reconstructed the original fixture tree identically, rejected changed roots,
notes and deposits, and retained usable engines after rejection. Both binaries
were copied into the independent project first. Their SHA-256 values were:

| Artifact | SHA-256 |
|---|---|
| Native prover | `e0f6891e4320040db6f54e03eb03b11f5de194a42ddd477ab26dd376c42df8d6` |
| WASM prover | `c06a247e1ff88f1ac415ea127bcf49d486b5b4954715cdf00f133b5ac71c1f30` |

The actual public artifact bundle was also copied and loaded through the
installed SDK. It contains 16 files totaling 25,514,825 bytes. Its descriptor SHA
is the command-line pin above; the verified manifest hash is
`0e003f5d03109870af469e430eb268d160d0098ea114049eb454c039eaca8b7d`, for Pool
`2aeTCsHthoockF8LC8N3UfP312BZ8uJ6sfuMbA2rot1w`. All artifact hashes and actual WASM
initialization passed. Modified tree-key bytes, a wrong manifest anchor and a
wrong WASM anchor were rejected. This verifies portable public artifact loading;
it makes no statement about current chain state or service availability.

Separate, overlapping focused checks passed **37 loader/daemon tests**, **five
offline packager checks**, and **three live-harness routing/admission tests**.
The repeatable command `node scripts/test_sdk_distribution_assets.mjs
target/external-integration/public-assets-input.json` produced the
[packer report](I10-sdk-distribution-components/packer-checks.json). It covers
wrong manifest/WASM pins, a private configuration field, a missing artifact and
refusal to overwrite the existing bundle. The
[relay tests](I10-sdk-distribution-components/live-harness-relay-tests.txt) verify
exact request bodies, local Origin handling, direct provider routing, forbidden
routes and admission-before-transport. These counts are not additive coverage.

During initial checker development, its fixture-path regex also matched
`journal.read('note')` and attempted to copy a nonexistent fixture called `note`.
That runner failure occurred before its installed lifecycle stage. The matcher
was narrowed to standalone fixture reads; the successful report above comes
from the corrected runner. Earlier local reports and all historical funded
journals, deployment pins and provider-budget records remain preserved.

## Scope and remaining limits

This distribution evidence uses real npm installation, compiled JavaScript,
TypeScript declarations, browser bundling, native/WASM execution and public
artifact verification. It does not claim new public transactions, provider
inference, actual Phantom or OpenClaw acceptance, signed release hosting,
multiplatform binaries, a production setup ceremony, an OSS license grant or
full I10/G1–G4. The separately executed live harness and native/client application
acceptance have their own reports. No RPC credentials, wallet keys, provider keys
or private custody contents enter this evidence or either distributable.
