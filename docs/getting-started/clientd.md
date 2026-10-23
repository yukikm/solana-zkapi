# Get started with inference on macOS (clientd)

This guide connects AI applications to ZKAPI through clientd's local inference
API, using the public Devnet OpenRouter deployment. It covers one API integration;
see the [getting-started index](README.md) for ZKAPI's broader API model.

clientd manages local inference, funding and settlement. These installation
commands are for **Apple Silicon, macOS 13.5+** and use the ready-built package.
It includes Node and the proof binaries. You need Terminal, Python 3 and an authenticated GitHub CLI with immutable
release verification support; no
repository checkout, npm, Go or Rust is required. The package is not Apple
signed or notarized.

`~/Applications/ZKAPI` is a directory chosen for this macOS example, not a
required ZKAPI layout. Other platforms require a separately built and verified
distribution; see [building clientd](../../apps/clientd/README.md#build-and-verify)
and the current [platform support](../support.md).

These instructions create a new public Devnet installation. Keep an existing
funded installation, profile and journal unchanged; see
[upgrades](../releases/usability-preview.md). Check [support](../support.md)
before use.

The [`.14` Node security upgrade](node-security-upgrade.md) supplies Node 24.22.1
and retains the existing authenticated deployment profile and custody bindings.

## 1. Download

These commands install the immutable `.14` release and create fresh state for
`public-devnet-20261021-state-v1`. Earlier funded profiles remain separate.

Open Terminal and run this block. It authenticates the `.14` release and its
assets, verifies archive and installation digests from the release manifest,
then installs under `~/Applications/ZKAPI` without sudo.

```sh
(
  set -eu
  ZKAPI_BASE="$HOME/Applications/ZKAPI"
  ZKAPI_RELEASE="$ZKAPI_BASE/releases/v0.2.0-devnet.14"
  ZKAPI_INSTALL="$ZKAPI_BASE/zkapi-clientd-0.2.0-devnet.14-darwin-arm64"
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
    echo 'This package requires an Apple Silicon Mac.' >&2; exit 1;
  }
  [ ! -e "$ZKAPI_INSTALL" ] && [ ! -e "$ZKAPI_RELEASE" ] || {
    echo 'Installation or download exists. Preserve it; do not overwrite.' >&2; exit 1;
  }
  mkdir -p "$ZKAPI_RELEASE"
  cd "$ZKAPI_RELEASE"
  gh release download v0.2.0-devnet.14 --repo yukikm/solana-zkapi \
    --pattern release-manifest.json --pattern zkapi-clientd-0.2.0-devnet.14-darwin-arm64.tar.gz
  gh release verify v0.2.0-devnet.14 --repo yukikm/solana-zkapi
  gh release verify-asset v0.2.0-devnet.14 release-manifest.json --repo yukikm/solana-zkapi
  gh release verify-asset v0.2.0-devnet.14 zkapi-clientd-0.2.0-devnet.14-darwin-arm64.tar.gz --repo yukikm/solana-zkapi
  python3 - <<'VERIFY_ARCHIVE'
import hashlib, json
from pathlib import Path
release = json.loads(Path('release-manifest.json').read_text())
archive = Path('zkapi-clientd-0.2.0-devnet.14-darwin-arm64.tar.gz')
assert release['version'] == '0.2.0-devnet.14'
assert hashlib.sha256(archive.read_bytes()).hexdigest() == release['assets'][archive.name]['sha256']
print('Native archive verified')
VERIFY_ARCHIVE
  tar -xzf zkapi-clientd-0.2.0-devnet.14-darwin-arm64.tar.gz -C "$ZKAPI_BASE"
  python3 - "$ZKAPI_INSTALL" <<'VERIFY_INSTALLATION'
import hashlib, json, sys
from pathlib import Path
release = json.loads(Path('release-manifest.json').read_text())
root = Path(sys.argv[1])
assert hashlib.sha256((root / 'release.json').read_bytes()).hexdigest() == release['native']['installation_manifest_sha256']
manifest = json.loads((root / 'release.json').read_text())
for name, digest in manifest['files'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
print('Native installation verified')
VERIFY_INSTALLATION
  test "$("$ZKAPI_INSTALL/bin/node" --version)" = v24.22.1
  "$ZKAPI_INSTALL/bin/clientd" --help
)
```

Continue only after release/asset authentication and both verification messages
succeed and clientd prints its usage. Keep the authenticated release manifest in
its download directory. If macOS blocks execution, inspect the error; do not
disable Gatekeeper.

## 2. Create a profile

Set these paths in **each Terminal window** used below:

```sh
ZKAPI_BASE="$HOME/Applications/ZKAPI"
ZKAPI_RELEASE="$ZKAPI_BASE/releases/v0.2.0-devnet.14"
ZKAPI_INSTALL="$ZKAPI_BASE/zkapi-clientd-0.2.0-devnet.14-darwin-arm64"
ZKAPI_INPUTS="$ZKAPI_BASE/deployment-state-20261021"
ZKAPI_PROFILE="$ZKAPI_BASE/profile-state-20261021"
```

Download the pinned deployment assets, run read-only preflight and create local
credentials:

```sh
(
  set -eu
  [ ! -e "$ZKAPI_INPUTS" ] && [ ! -e "$ZKAPI_PROFILE" ] || {
    echo 'Setup files exist. Preserve them; do not repeat setup.' >&2; exit 1;
  }
  gh release verify-asset v0.2.0-devnet.14 "$ZKAPI_RELEASE/release-manifest.json" --repo yukikm/solana-zkapi
  ZKAPI_INSTALL_SHA=$(python3 - "$ZKAPI_RELEASE/release-manifest.json" <<'INSTALL_PIN'
import json, sys
from pathlib import Path
release = json.loads(Path(sys.argv[1]).read_text())
assert release['version'] == '0.2.0-devnet.14'
print(release['native']['installation_manifest_sha256'])
INSTALL_PIN
  )
  "$ZKAPI_INSTALL/bin/node" \
    "$ZKAPI_INSTALL/tools/public-devnet-consumer/cli.mjs" install-native \
    --profile-url 'https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261021-state-v1/profile.json' \
    --profile-sha256 '5e15d66c6f45265951cf1f8dd6cc0dae6574c4b8dd6756f828f7543ecaa97b9a' \
    --output "$ZKAPI_INPUTS" --runtime-network direct
  ZKAPI_RUNTIME_SHA=$("$ZKAPI_INSTALL/bin/node" -e \
    'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtimeSha256)' \
    "$ZKAPI_INPUTS/installation.json")
  "$ZKAPI_INSTALL/bin/clientd" setup \
    --profile "$ZKAPI_PROFILE" \
    --distribution "$ZKAPI_INSTALL/release.json" \
    --sha256 "$ZKAPI_INSTALL_SHA" \
    --runtime-config "$ZKAPI_INPUTS/runtime.json" \
    --runtime-sha256 "$ZKAPI_RUNTIME_SHA" \
    --network-config "$ZKAPI_INPUTS/network.json"
)
```

Success reports `base_url: http://127.0.0.1:8787/v1`,
`custody_initialized: false` and `funded: false`. Keep the installation, inputs
and profile at these paths. A `snapshot` or `catalog` error means verification
failed: stop and check [service status](../support.md). Depositing or supplying
a provider key will not fix it.

## 3. Start

Choose a private data password of at least 16 ASCII characters. Save it: every
restart needs the same password. The first start initializes encrypted local
custody but does not deposit or send a prompt.

```sh
(
  set -eu
  set -o pipefail
  [ ! -e "$ZKAPI_PROFILE/custody.json" ] || {
    echo 'Custody exists. Use the restart command.' >&2; exit 1;
  }
  python3 "$ZKAPI_INSTALL/scripts/clientd_secrets.py" --initialize | \
    "$ZKAPI_INSTALL/bin/clientd" run "$ZKAPI_PROFILE"
)
```

Leave this window open after `clientd listening on 127.0.0.1:8787` appears.
In a second Terminal, set the paths from step 2, then check:

```sh
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" models
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" status
```

## 4. Fund your note

Follow [Devnet wallet setup](devnet.md#4-fund-your-wallet) to create or select
a wallet and obtain Devnet SOL and USDC. Check the guide's service-access step
before depositing. Native signing needs your own Solana keypair JSON file
(64 bytes, owned by you, mode `0600`). Keep it outside the installation and
profile. A provider API key is not required.

Stop clientd with Control-C. Restart it with the same password and the wallet
created in the Devnet guide. Change the path only if using a different wallet:

```sh
(
  set -eu
  set -o pipefail
  python3 "$ZKAPI_INSTALL/scripts/clientd_secrets.py" \
    --wallet "$HOME/.config/zkapi-wallets/devnet.json" | \
    "$ZKAPI_INSTALL/bin/clientd" run "$ZKAPI_PROFILE"
)
```

In the second Terminal, save this as `$ZKAPI_BASE/deposit.json`. Replace every
`WALLET_PUBLIC_KEY` with that wallet's public address:

```json
{
  "action": "deposit",
  "amount": "2000000",
  "roles": {
    "payer": "WALLET_PUBLIC_KEY",
    "feePayer": "WALLET_PUBLIC_KEY",
    "uploader": "WALLET_PUBLIC_KEY",
    "rentPayer": "WALLET_PUBLIC_KEY",
    "tokenOwner": "WALLET_PUBLIC_KEY"
  }
}
```

Amounts are integer micro-USDC: `2000000` is two test USDC. The public profile
reserves a one-USDC session cap, so a deposit of exactly one USDC can prevent
the next session after a nonzero charge.

Prepare the deposit once:

```sh
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" wallet < "$ZKAPI_BASE/deposit.json"
```

Advance the saved operation, checking status after each step. Repeat only this
`advance` step as needed until `wallet_status` is `active`:

```sh
printf '%s\n' '{"action":"advance"}' | \
  "$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" wallet
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" status
```

After a timeout or uncertain transaction, inspect the same saved operation.
Do not submit another deposit. See [recovery](../sdk/recovery.md) if it cannot
advance or needs proof resumption.

## 5. Connect an application

For the public Devnet profile:

| Setting | Value |
|---|---|
| API format | Chat Completions (`POST /v1/chat/completions`) |
| Provider route | OpenRouter, through the authenticated public profile |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | Contents of `profile-state-20261021/inference-token` |
| Model | An exact ID from the `models` command |
| Maximum output | 4,096 tokens, or the selected model's lower limit |

Set this output limit in the connected application. It is the
[current public Devnet application policy](devnet.md#5-use-and-recover), not a
token limit encoded in the authenticated profile or enforced by the direct
backend. The monetary session cap still applies. Existing installations can
change this application setting without replacing their profile or custody.

Copy the inference token on macOS:

```sh
tr -d '\n' < "$ZKAPI_PROFILE/inference-token" | pbcopy
```

The inference token permits spending from your note. Keep the management token,
wallet and data password out of application settings. Disable automatic retries
and model fallbacks; preserve one operation UUID per intentional request when
the client supports `Idempotency-Key`.

Use [OpenClaw](openclaw.md) for the documented agent path. Claude Desktop,
Claude Code and Codex currently have [compatibility limits](../support.md).
Direct requests expose prompts to the provider; proxy requests also expose them
to the proxy operator.

## Stop, restart and withdraw

Stop with Control-C and wait for clientd to exit. Restart with the same profile,
password and wallet command from step 4. If you have never supplied a wallet,
omit `--wallet`. **Never repeat `--initialize` after `custody.json` exists**,
including after a failed start.

After using an application, close its API session and inspect settlement:

```sh
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" close
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" status
```

`close` settles the session; it does not withdraw the note. Once the session is
settled, save this as `$ZKAPI_BASE/withdraw.json`, replacing the public keys:

```json
{
  "action": "withdraw",
  "mode": "mutual_close",
  "destination_owner": "WALLET_PUBLIC_KEY",
  "roles": {
    "payer": "WALLET_PUBLIC_KEY",
    "feePayer": "WALLET_PUBLIC_KEY",
    "uploader": "WALLET_PUBLIC_KEY",
    "rentPayer": "WALLET_PUBLIC_KEY",
    "tokenOwner": "WALLET_PUBLIC_KEY"
  }
}
```

```sh
"$ZKAPI_INSTALL/bin/clientd" request "$ZKAPI_PROFILE" wallet < "$ZKAPI_BASE/withdraw.json"
```

Use the same `advance` and `status` commands until finalized `wallet_status` is
`closed`. Keep your profile, encrypted custody, journal and deployment inputs
for recovery. If status reports `recovery_required`, stop new inference and
follow [recovery](../sdk/recovery.md); never clear files to retry.

## Use another deployment

Obtain its authenticated profile and checksum, compatible native release, API
mode, models and any required admission credential from its operator. Use those
inputs in step 2 only for a **new** profile. The
[native configuration reference](../../apps/clientd/README.md#distribution-and-configuration)
covers custom runtime files, Tor and independently trusted provider/verifier
endpoints.
