# Install or upgrade to SDK/native 0.2.0-devnet.13

Release `.13` includes the finite HTTP gateway and registered JSON APIs. The
[release notes](../releases/universal-api-gateway-preview.md) state its scope.
An existing public OpenRouter profile remains an inference selection.

## Verify the release assets

Download into a new directory. Use an authenticated GitHub CLI that supports
immutable release verification:

```sh
set -eu
mkdir zkapi-devnet13-download
cd zkapi-devnet13-download
gh release download v0.2.0-devnet.13 --repo yukikm/solana-zkapi
gh release verify v0.2.0-devnet.13 --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.13 SHA256SUMS --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.13 release-manifest.json --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.13 zkapi-solana-sdk-0.2.0-devnet.13.tgz --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.13 zkapi-clientd-0.2.0-devnet.13-darwin-arm64.tar.gz --repo yukikm/solana-zkapi
shasum -a 256 -c SHA256SUMS
```

Keep previous archives, manifests, profiles and recovery builds. A filename or
a checksum downloaded from the same untrusted source is insufficient authentication.

## Update an SDK application

Use Node 24.19.0 and npm 11.9.0. Copy the verified SDK archive into the
application's vendor directory without overwriting earlier artifacts, then:

```sh
npm install --save-exact ./vendor/zkapi-solana-sdk-0.2.0-devnet.13.tgz
```

Keep `@solana/kit` at 8.4.0. Rebuild the app and its prover worker from the same
SDK. Update runtime version assertions and archive checksums while retaining
the existing origin, wallet, storage name, profile URL/hash, note/catalog IDs,
journals and receipts. `.13` accepts legacy schema 1 profiles listing `.8` through
`.12`; do not rewrite their SDK-version list. Schema 2/3 profiles must explicitly
list `.13` and remain separately authenticated.

Preserve the [stream consumption and recovery behavior](sdk-streaming-upgrade.md#rebuild-and-verify-the-application).
Do not run concurrent clients against the same custody. Recover an uncertain
operation through its original journal instead of repeating inference or a transaction.

## Install the native package

On Apple Silicon macOS 13.5+, extract the verified archive into a new location:

```sh
set -eu
test ! -e zkapi-clientd-0.2.0-devnet.13-darwin-arm64
tar -xzf zkapi-clientd-0.2.0-devnet.13-darwin-arm64.tar.gz
python3 - <<'PY'
import hashlib, json
from pathlib import Path
release = json.loads(Path('release-manifest.json').read_text())
root = Path('zkapi-clientd-0.2.0-devnet.13-darwin-arm64')
assert hashlib.sha256((root / 'release.json').read_bytes()).hexdigest() == release['native']['installation_manifest_sha256']
manifest = json.loads((root / 'release.json').read_text())
for name, digest in manifest['files'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
print('Native installation verified')
PY
./zkapi-clientd-0.2.0-devnet.13-darwin-arm64/bin/clientd --help
```

For a new profile, follow [native setup](clientd.md#2-create-a-profile), selecting
the verified `.13` installation and its `release.json` pin from the authenticated
release manifest. Use independently reviewed deployment assets and read-only
preflight before funding. The [finite HTTP guide](finite-http-api.md) covers
schema 3 registration and invocation; the existing public profile does not supply it.

An existing native profile pins its runtime installation. Keep that funded
installation and its original custody intact; extracting `.13` does not migrate
it. Never rerun setup over a funded profile or replace its journal to select a
new runtime. The native archive has no Apple signature or notarization.

## Update an existing control service

This procedure is for authorized maintenance of an existing deployment. It
preserves its program, Pool, manifest, provider settings, tariffs and profiles.

1. Build matching `controld`, `signerd` and any installed `opsd` from the reviewed
   release commit with pinned Rust and locked dependencies. Compare dispatcher
   and frontend inputs separately; preserve their configured hashes when unchanged.
2. Suspend new admission while leaving status and recovery available. Wait for
   settled sessions and finished dispatch attempts. Do not resolve uncertainty by
   clearing claims or replaying work.
3. Back up the database, original binaries/configuration and signer journal to
   private storage. Record all financial rows and hashes of custody/configuration
   inputs at the same maintenance cut. Stop control before signer and verify exit.
4. Apply the checksummed additive `0004_finite_http.sql` migration with the
   migration role; earlier migrations must already match. Install matching binaries.
   Existing operation rows receive `envelope_version = 1`, `binding_hash = NULL`
   and `meter_hash = NULL`. Compare all original columns before/after and validate
   these defaults separately; do not mistake new columns for financial changes.
5. Start signer with its original journal/keys, then control. Verify reconciliation,
   all four migration checksums, readiness and unchanged financial/custody inputs.
   Resume admission only after those checks and public read-only routes pass.

Old binaries reject the new migration set. Prefer a forward fix with admission
suspended if startup fails; never delete migration records or restore a snapshot
that loses acknowledged fences or settlements. This maintenance does not publish
a finite HTTP selection: new provider routes, credentials, tariffs and profiles
need a separately reviewed integration. See [operations](operations.md).
