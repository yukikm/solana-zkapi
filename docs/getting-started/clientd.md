# Install and run clientd

clientd runs a local API for AI applications and manages ZKAPI funding and
settlement. The ready-built package supports **Apple Silicon, macOS 13.5+**.
It includes Node and the proof binaries. You need Terminal and Python 3; no
repository checkout, npm, Go or Rust is required. The package is not Apple
signed or notarized.

These instructions create a new public Devnet installation. Keep an existing
funded installation, profile and journal unchanged; see
[upgrades](../releases/usability-preview.md). Check [support](../support.md)
before use.

## 1. Download

Open Terminal and run this block. It verifies the published `.8` archive and
installation manifest, then installs under `~/Applications/ZKAPI` without sudo.
Obtain these checksums through this repository's trusted release channel.

```sh
(
  set -eu
  ZKAPI_BASE="$HOME/Applications/ZKAPI"
  ZKAPI_INSTALL="$ZKAPI_BASE/zkapi-clientd-0.2.0-devnet.8-darwin-arm64"
  [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || {
    echo 'This package requires an Apple Silicon Mac.' >&2; exit 1;
  }
  [ ! -e "$ZKAPI_INSTALL" ] || {
    echo 'Installation exists. Preserve it; do not overwrite.' >&2; exit 1;
  }
  mkdir -p "$ZKAPI_BASE/target"
  ZKAPI_DOWNLOAD=$(mktemp -d "$ZKAPI_BASE/target/download.XXXXXX")
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --output "$ZKAPI_DOWNLOAD/clientd.tar.gz" \
    'https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.8/zkapi-clientd-0.2.0-devnet.8-darwin-arm64.tar.gz'
  printf '%s  %s\n' \
    '14154d038bc0e79347076b9983754eeca2fbde78159be21e5ca7b0cddca632ac' \
    "$ZKAPI_DOWNLOAD/clientd.tar.gz" | shasum -a 256 -c -
  tar -xzf "$ZKAPI_DOWNLOAD/clientd.tar.gz" -C "$ZKAPI_BASE"
  printf '%s  %s\n' \
    '20c194668cbb9b13fecf8170c709fb03dd055bbd1b67b93b6e652dcfe7d118be' \
    "$ZKAPI_INSTALL/release.json" | shasum -a 256 -c -
  "$ZKAPI_INSTALL/bin/clientd" --help
)
```

Continue only after both checksums print `OK` and clientd prints its usage.
If macOS blocks execution, inspect the error; do not disable Gatekeeper.

## 2. Create a profile

Set these paths in **each Terminal window** used below:

```sh
ZKAPI_BASE="$HOME/Applications/ZKAPI"
ZKAPI_INSTALL="$ZKAPI_BASE/zkapi-clientd-0.2.0-devnet.8-darwin-arm64"
ZKAPI_INPUTS="$ZKAPI_BASE/deployment-devnet8"
ZKAPI_PROFILE="$ZKAPI_BASE/profile-devnet8"
```

Download the pinned deployment assets, run read-only preflight and create local
credentials:

```sh
(
  set -eu
  [ ! -e "$ZKAPI_INPUTS" ] && [ ! -e "$ZKAPI_PROFILE" ] || {
    echo 'Setup files exist. Preserve them; do not repeat setup.' >&2; exit 1;
  }
  "$ZKAPI_INSTALL/bin/node" \
    "$ZKAPI_INSTALL/tools/public-devnet-consumer/cli.mjs" install-native \
    --profile-url 'https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.8-r6.json' \
    --profile-sha256 'ec10c1ab41bb5105222d3e25c7e1eba6b96b1b397abd0f854657030269992a77' \
    --output "$ZKAPI_INPUTS" --runtime-network direct
  ZKAPI_RUNTIME_SHA=$("$ZKAPI_INSTALL/bin/node" -e \
    'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).runtimeSha256)' \
    "$ZKAPI_INPUTS/installation.json")
  "$ZKAPI_INSTALL/bin/clientd" setup \
    --profile "$ZKAPI_PROFILE" \
    --distribution "$ZKAPI_INSTALL/release.json" \
    --sha256 '20c194668cbb9b13fecf8170c709fb03dd055bbd1b67b93b6e652dcfe7d118be' \
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
| API | OpenAI Chat Completions |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | Contents of `profile-devnet8/inference-token` |
| Model | An exact ID from the `models` command |
| Maximum output | 128 tokens |

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
