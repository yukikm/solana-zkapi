# Install and run clientd

clientd connects an existing AI application to Solana zkAPI through
`http://127.0.0.1:8787/v1`. Install the native package, prepare a deployment
profile, start the daemon, fund a Devnet note, then connect your application.
The application uses a **local inference token** as its API key.

This guide uses the published **`0.2.0-devnet.8` macOS ARM64 package** and
revision-6 public Devnet profile. It requires **Apple Silicon, macOS 13.5+**,
`curl`, `tar`, `shasum` and Python 3 for the private passphrase prompt. Node,
the SDK and native proof tools are included; a source checkout and npm install
are unnecessary. Linux, Windows and Intel macOS packages are not verified.
The macOS package is not Apple signed or notarized.

Use an existing private Solana **64-byte keypair JSON** when funding through
clientd. This is the Solana CLI keypair format, not a seed phrase or a browser
wallet connection. If needed, follow the official
[Solana CLI wallet guide](https://solana.com/docs/intro/installation/solana-cli-basics)
to create a separate Devnet wallet. Never share its JSON or passphrase.

Already have a funded profile? Keep its original installation, inputs, custody
and journal. Follow the [upgrade procedure](upgrading.md)
instead of replacing it with the new profile below.

## 1. Download and verify

Check the [current support status](../status.md) and
[public deployment inputs](public-devnet-preview.md). Obtain this guide and its
hashes from the trusted repository or authenticate the
[immutable GitHub release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.8).
A checksum supplied only inside an untrusted download does not authenticate it.

Run these commands in one terminal. All paths below become absolute; the
versioned directories must be new. Keep later profiles outside the installation.

```sh
umask 077
ZKAPI_ROOT="$HOME/.local/share/zkapi"
mkdir -p "$ZKAPI_ROOT"
ZKAPI_ROOT="$(cd "$ZKAPI_ROOT" && pwd -P)"
ZKAPI_RELEASE="$ZKAPI_ROOT/release-0.2.0-devnet.8"
mkdir "$ZKAPI_RELEASE"
ZKAPI_ARCHIVE="$ZKAPI_RELEASE/zkapi-clientd-0.2.0-devnet.8-darwin-arm64.tar.gz"

curl --fail --location --proto '=https' --proto-redir '=https' \
  'https://github.com/yukikm/solana-zkapi/releases/download/v0.2.0-devnet.8/zkapi-clientd-0.2.0-devnet.8-darwin-arm64.tar.gz' \
  --output "$ZKAPI_ARCHIVE"
printf '%s  %s\n' \
  '14154d038bc0e79347076b9983754eeca2fbde78159be21e5ca7b0cddca632ac' \
  "$ZKAPI_ARCHIVE" | shasum -a 256 -c -
```

Continue only if the checksum reports `OK`. Extract and check the installation
manifest before executing the package:

```sh
tar -xzf "$ZKAPI_ARCHIVE" -C "$ZKAPI_RELEASE"
ZKAPI_INSTALL="$ZKAPI_RELEASE/zkapi-clientd-0.2.0-devnet.8-darwin-arm64"
ZKAPI_RELEASE_SHA256='20c194668cbb9b13fecf8170c709fb03dd055bbd1b67b93b6e652dcfe7d118be'
printf '%s  %s\n' "$ZKAPI_RELEASE_SHA256" "$ZKAPI_INSTALL/release.json" | shasum -a 256 -c -
```

After the second `OK`, make `clientd` available in this terminal:

```sh
export PATH="$ZKAPI_INSTALL/bin:$PATH"
clientd --help
```

This PATH change applies to the current shell. In later terminals, set
`ZKAPI_INSTALL` to the same absolute directory and repeat the `export`, or use
`"$ZKAPI_INSTALL/bin/clientd"` explicitly. The directory also contains the bundled
Node. Keep installed files unchanged; startup rejects changed/unlisted files
and symlinks. Do not run `npm install` inside it.

## 2. Check the deployment and generate its inputs

The bundled helper downloads the pinned profile and proof assets, verifies the
deployment and checks finalized chain/indexer state. It uses **direct HTTPS**
for installation and preflight and performs no wallet transaction or inference.

```sh
ZKAPI_PROFILE_URL='https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile-sdk-0.2.0-devnet.8-r6.json'
ZKAPI_PROFILE_SHA256='ec10c1ab41bb5105222d3e25c7e1eba6b96b1b397abd0f854657030269992a77'
ZKAPI_INPUTS="$ZKAPI_ROOT/public-devnet-sdk8-r6"

"$ZKAPI_INSTALL/bin/node" "$ZKAPI_INSTALL/tools/public-devnet-consumer/cli.mjs" \
  preflight --profile-url "$ZKAPI_PROFILE_URL" \
  --profile-sha256 "$ZKAPI_PROFILE_SHA256"

curl --fail --silent --show-error 'https://d366buuvadnp3.cloudfront.net/relay-status'
curl --fail --silent --show-error 'https://d366buuvadnp3.cloudfront.net/provider-budget'
```

Preflight must succeed and new admission must be enabled before you fund new
usage. The public gateway currently requires no invitation and reports
`operator_funded`, `trial_limits: false`. That policy does not guarantee provider
credit or uptime; see [funding and access](devnet-funding.md).

Generate the files into the new input directory:

```sh
"$ZKAPI_INSTALL/bin/node" "$ZKAPI_INSTALL/tools/public-devnet-consumer/cli.mjs" \
  install-native --profile-url "$ZKAPI_PROFILE_URL" \
  --profile-sha256 "$ZKAPI_PROFILE_SHA256" \
  --output "$ZKAPI_INPUTS" --runtime-network direct
```

The command repeats preflight and writes `runtime.json`, `network.json`, verified
artifacts and an `installation.json` receipt. Preserve this directory at the same
path. For Tor runtime transport or an invitation-gated deployment, see the
[optional network setup](clientd-network.md).
The `--runtime-network` flag does not change the helper's download transport.

## 3. Create your private profile

Read the runtime digest from the receipt produced by the verified helper, then
create a new profile. This does not initialize custody or deposit funds.

```sh
ZKAPI_PROFILE="$ZKAPI_ROOT/profile-sdk8"
ZKAPI_RUNTIME_SHA256="$("$ZKAPI_INSTALL/bin/node" --input-type=module -e \
  'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).runtimeSha256)' \
  "$ZKAPI_INPUTS/installation.json")"

clientd setup --profile "$ZKAPI_PROFILE" \
  --distribution "$ZKAPI_INSTALL/release.json" --sha256 "$ZKAPI_RELEASE_SHA256" \
  --runtime-config "$ZKAPI_INPUTS/runtime.json" --runtime-sha256 "$ZKAPI_RUNTIME_SHA256" \
  --network-config "$ZKAPI_INPUTS/network.json"
```

Setup prints the local base URL and `custody_initialized: false`. It creates a
private profile with separate `inference-token` and `management-token` files.
The former lets applications spend through clientd; the latter is for local
management. `clientd request` selects the appropriate token automatically.
Setup refuses existing profiles and retains partial failures for inspection.

## 4. Start clientd

Replace the wallet path with your own existing keypair. Keep it owner-only.
Choose a journal passphrase of at least 16 UTF-8 bytes and retain it securely.
The prompt helper sends secrets directly through a pipe; never redirect its
output to a file or put wallet/passphrase secrets in environment variables.

```sh
ZKAPI_WALLET='/absolute/path/to/your-devnet-keypair.json'
chmod 600 "$ZKAPI_WALLET"
python3 "$ZKAPI_INSTALL/scripts/clientd_secrets.py" \
  --initialize --wallet "$ZKAPI_WALLET" | clientd run "$ZKAPI_PROFILE"
```

Leave this terminal open. Successful startup prints:

```text
clientd listening on 127.0.0.1:8787; mode is fixed by configuration
```

Use `--initialize` only until custody is first created. If startup creates
`PROFILE/custody.json` and then fails a later check, restart without that flag.
Keep the same passphrase and files. Missing/corrupt custody requires recovery,
not a replacement profile.

Open a second terminal and set the same paths (the defaults below match this
guide):

```sh
ZKAPI_ROOT="$(cd "$HOME/.local/share/zkapi" && pwd -P)"
ZKAPI_INSTALL="$ZKAPI_ROOT/release-0.2.0-devnet.8/zkapi-clientd-0.2.0-devnet.8-darwin-arm64"
ZKAPI_PROFILE="$ZKAPI_ROOT/profile-sdk8"
export PATH="$ZKAPI_INSTALL/bin:$PATH"

clientd request "$ZKAPI_PROFILE" models
clientd request "$ZKAPI_PROFILE" status
```

A new profile reports `wallet_status: "unfunded"`; this is expected. Model
listing confirms local configuration, not successful inference. The optional
`clientd request "$ZKAPI_PROFILE" model-availability` checks public ZDR metadata
without sending a prompt; a listed model still needs credit and capacity.

## 5. Fund the Devnet note

Follow [Devnet funding](devnet-funding.md) to obtain the exact Devnet USDC mint
and Devnet SOL for fees/rent. Faucet USDC and the operator's real provider bill
are separate. Recheck preflight and admission before depositing.

Save the following as `deposit.json` outside the installation, replacing every
`WALLET_PUBLIC_KEY` with your wallet's public address. It prepares a two-USDC
deposit (`2000000` micro-USDC), giving headroom above this profile's one-USDC
authorization cap. It contains public transaction inputs, not wallet secrets.

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

```sh
clientd request "$ZKAPI_PROFILE" wallet < /absolute/path/to/deposit.json
clientd request "$ZKAPI_PROFILE" status
printf '%s\n' '{"action":"advance"}' | clientd request "$ZKAPI_PROFILE" wallet
clientd request "$ZKAPI_PROFILE" status
```

Each `advance` continues one saved transaction step. Inspect its result and
repeat that action only as the saved operation requires, until finalized
`wallet_status` is `active`. If the saved operation reports `proof_required`,
resume its proof, inspect status, then continue with `advance` once the proof
completes:

```sh
printf '%s\n' '{"action":"prove"}' | clientd request "$ZKAPI_PROFILE" wallet
clientd request "$ZKAPI_PROFILE" status
printf '%s\n' '{"action":"advance"}' | clientd request "$ZKAPI_PROFILE" wallet
clientd request "$ZKAPI_PROFILE" status
```

See [recovery](recovery.md) for other saved states. A timeout does not
justify a new deposit or replacement transaction: inspect the same saved
operation. A wallet signature or HTTP success alone does not mean the note is
funded.

## 6. Connect an AI application

| Setting | Value |
|---|---|
| OpenAI-compatible base URL | `http://127.0.0.1:8787/v1` |
| API key | Contents of `PROFILE/inference-token`, preferably through a file secret reference |
| Model | Exact ID from `clientd request PROFILE models` |
| Automatic retries / model fallbacks | Disabled |
| Output limit | Within the deployment's advertised bound (this profile: 128 tokens) |

Start with the [OpenClaw setup](openclaw.md), including its
configuration generator and retry settings. The
[compatibility table](../integrations/README.md) records the tested scopes and
Claude Code/Codex request-format blockers. An OpenAI-style URL alone does not
establish compatibility with every client.

Give the application only the inference token. Consume or cancel every response.
When supported, use one UUID `Idempotency-Key` per intentional request and zero
client retries. Allow time for proof preparation and up to two minutes of
settlement waiting between sessions. Inspect status after an interrupted request
before deliberately starting another; inference is never automatically replayed.

## Stop, restart and withdraw

Stop your application's new requests and finish or cancel active responses.
If you have not deposited yet and status remains `unfunded`, stop with **Ctrl+C**
in the daemon terminal; no session close is needed. Otherwise, in the management
terminal, inspect status and close the API session:

```sh
clientd request "$ZKAPI_PROFILE" status
clientd request "$ZKAPI_PROFILE" close
clientd request "$ZKAPI_PROFILE" status
```

If settlement is pending or `recovery_required` is true, follow the
[recovery guide](recovery.md) with the same profile. Press **Ctrl+C** in
the daemon terminal and allow shutdown to finish. Stopping clientd or closing
the API session does **not** withdraw the deposited note.

For later starts, restore your path variables and use the same wallet/passphrase
without `--initialize`:

```sh
ZKAPI_WALLET='/absolute/path/to/your-devnet-keypair.json'
python3 "$ZKAPI_INSTALL/scripts/clientd_secrets.py" \
  --wallet "$ZKAPI_WALLET" | clientd run "$ZKAPI_PROFILE"
```

To withdraw after settlement, keep clientd running and save this as
`withdraw.json` outside the installation. Replace every `WALLET_PUBLIC_KEY`
with your own wallet's public address:

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
clientd request "$ZKAPI_PROFILE" wallet < /absolute/path/to/withdraw.json
clientd request "$ZKAPI_PROFILE" status
printf '%s\n' '{"action":"advance"}' | clientd request "$ZKAPI_PROFILE" wallet
clientd request "$ZKAPI_PROFILE" status
```

Continue the saved withdrawal with `advance` (and `prove` if required), inspecting
each result until finalized `wallet_status: "closed"`. Keep the installation,
deployment inputs, encrypted profile/journal and a trusted journal head available
for recovery. A backup's encryption cannot detect rollback.

## Troubleshooting

| Symptom | Next step |
|---|---|
| `clientd: command not found` | Restore PATH or use the absolute `bin/clientd` path |
| Unsupported executable / macOS security prompt | Check Apple Silicon and macOS 13.5+; verify the archive and follow your Mac's security policy for this unnotarized preview |
| Checksum or installation integrity failure | Stop; obtain the verified release again in a separate directory and retain the original profile |
| Existing/partial input or profile directory | Inspect it; use a new directory only for a genuinely new installation |
| Preflight `snapshot` or `catalog` failure | Check [service status](../status.md) and retry only the read-only check; this is not a wallet-balance diagnosis |
| Private wallet/profile file error | Use canonical absolute paths, owner-only directories (`0700`) and wallet files (`0600`); avoid symlinks |
| Cannot connect to `127.0.0.1:8787` | Check the foreground daemon output and that another process has not occupied the port |
| `recovery_required`, HTTP 409 or uncertain wallet send | Inspect `status` and follow [recovery](recovery.md); preserve the operation and custody |
| Provider/model/privacy error | Check model availability and status; settle/recover pending work before a deliberate new request |

For a private deployment or source build, use the
[clientd component reference](../../apps/clientd/README.md).
