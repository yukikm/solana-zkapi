# Update Node.js and install SDK/native 0.2.0-devnet.14

This procedure updates the Node runtime while preserving the existing
payment lifecycle and authenticated deployment inputs. Read the
[release notes](../releases/node-security-preview.md) for security changes and
validation scope. `.14` has separate SDK and native artifacts; authenticate the
release and exact assets before installation.

## Preserve existing state

Retain the original SDK/native archives, installation manifests, profile bytes
and hashes, wallet selection, storage names, note/catalog IDs, journals,
receipts and recovery material. Stop concurrent clients before using the same
custody. Do not rerun setup over an existing funded native profile or derive a
new browser storage name from the SDK version.

SDK `.14` accepts profiles listing `.13` in schemas 1, 2 and 3, plus the existing
legacy schema 1 versions `.8` through `.12`. Keep their `sdkVersions` and exact
profile bytes unchanged. An uncertain operation continues through its existing
recovery path; an upgrade never authorizes replaying inference or a transaction.

## Select the pinned Node toolchain

Use Node 24.22.1 LTS and its bundled npm 11.19.1. Download the correct platform
archive from the [official Node release](https://nodejs.org/en/blog/release/v24.22.1)
and verify it against the official signed checksums before execution. Install
it in a separate versioned directory and select its `bin` directory for this
checkout or application. Preserve earlier pinned runtimes for explicit recovery.

Verify the selected executables:

```sh
node --version
npm --version
test "$(node --version)" = v24.22.1
test "$(npm --version)" = 11.19.1
```

For a reviewed source checkout, follow [contributor checks](../../CONTRIBUTING.md).
Use `npm ci --ignore-scripts` with the tracked lockfile. Source builds and native
packaging select `ZKAPI_NODE` and `ZKAPI_NPM` as absolute executable paths when
needed. The native archive supplies its own Node executable, so changing the
shell's Node does not patch an already installed native archive.

## Authenticate the published release

Download `.14` into a new directory using an authenticated
GitHub CLI with immutable release verification support:

```sh
set -eu
mkdir zkapi-devnet14-download
cd zkapi-devnet14-download
gh release download v0.2.0-devnet.14 --repo yukikm/solana-zkapi
gh release verify v0.2.0-devnet.14 --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.14 SHA256SUMS --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.14 release-manifest.json --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.14 zkapi-solana-sdk-0.2.0-devnet.14.tgz --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.14 zkapi-clientd-0.2.0-devnet.14-darwin-arm64.tar.gz --repo yukikm/solana-zkapi
shasum -a 256 -c SHA256SUMS
```

Do not proceed if release authentication, asset verification or a checksum
fails. A filename or a digest downloaded beside an untrusted file does not
establish authenticity. `.13` remains available under its original release tag;
never overwrite its saved artifacts with `.14` bytes.

## Update an SDK application

Copy the verified `.14` tarball into a new path in the application's vendor
directory. Keep earlier archives and the original lockfile in recovery storage.
Then update the dependency:

```sh
npm install --save-exact ./vendor/zkapi-solana-sdk-0.2.0-devnet.14.tgz
```

Keep `@solana/kit` at 8.4.0 if the application imports it directly. Rebuild the
application and its prover worker with the same SDK; update version assertions
and archive integrity checks. Keep its origin, wallet, storage namespace,
profile URL/hash and deployment pins unchanged. Run the application's fixture
and build checks, then the existing public-profile read-only preflight.
Preflight does not open custody, fund a note, send inference or submit a transaction.

Preserve [stream consumption and recovery behavior](sdk-streaming-upgrade.md#rebuild-and-verify-the-application).
A successful build or preflight does not establish a funded lifecycle or provider
credit. Paid requests and wallet transactions remain deliberate separate actions.

## Install the native archive separately

The native package targets Apple Silicon macOS 13.5 or newer. After authenticating
the release, extract into a new directory and verify every installed file:

```sh
set -eu
test ! -e zkapi-clientd-0.2.0-devnet.14-darwin-arm64
tar -xzf zkapi-clientd-0.2.0-devnet.14-darwin-arm64.tar.gz
python3 - <<'PY'
import hashlib, json
from pathlib import Path
release = json.loads(Path('release-manifest.json').read_text())
root = Path('zkapi-clientd-0.2.0-devnet.14-darwin-arm64')
assert hashlib.sha256((root / 'release.json').read_bytes()).hexdigest() == release['native']['installation_manifest_sha256']
manifest = json.loads((root / 'release.json').read_text())
for name, digest in manifest['files'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
print('Native installation verified')
PY
./zkapi-clientd-0.2.0-devnet.14-darwin-arm64/bin/node --version
./zkapi-clientd-0.2.0-devnet.14-darwin-arm64/bin/clientd --help
```

Expect `v24.22.1`. The archive has no Apple signature or notarization; do not
disable Gatekeeper to work around an unexplained verification failure.
For an explicitly new, unfunded profile, follow [native setup](clientd.md#2-create-a-profile)
using the verified `.14` installation and its authenticated `release.json`
digest. Keep the deployment profile's exact bytes and hash.

An existing funded native profile pins its installation. This procedure does
not rebind it or replace any installed file in place. Retain that original
installation and custody for explicit recovery. A runtime migration for a funded
native profile needs its own reviewed procedure; merely extracting `.14` does
not perform one.

## Update an existing operator's Node runtime

For authorized maintenance of an existing deployment, inventory each Node
consumer, including the gateway and challenger bridge. Compare runtime source,
locked dependencies, service configuration and executable hashes before changing
anything. The macOS native client archive is not a Linux server bundle.

Stage the verified Node 24.22.1 binary for the server's architecture in a new
versioned location. Follow [backup and restart](backup-and-restart.md) to preserve
the database, signer/challenger journals, original binaries and configuration.
Quiesce new work and inspect unresolved operations before restarting an affected
service. Keep its configured manifest, Pool, provider settings, credentials,
financial ledger and custody paths unchanged. Do not run initialization tools,
clear reservations or reset capacity as part of a runtime update.

After switching the service's executable path, verify the actual running Node
version, process health, reconciliation and the public read-only routes in the
[Devnet guide](devnet.md#3-check-service-access). Readiness and successful restart
are separate from paid inference, wallet transactions and long-term availability.
Retain the previous executable and configuration for diagnosis without rolling
back acknowledged financial state or replaying uncertain work.
