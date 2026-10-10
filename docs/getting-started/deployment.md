# Create a new Devnet deployment

This procedure creates a new Vault program, Pool and public artifact bundle for
an operator. It supports the reference **direct OpenRouter** deployment with a
one-USDC session cap. It creates keys and later sends Devnet transactions.
Run it only for your own new deployment; never point it at an existing funded
Pool or reuse another operator's private setup.

The scripts are individual build, staging and transaction tools. The steps below
join them explicitly. They do not configure production or mainnet.

## 1. Prepare tools, wallet and service addresses

Use the [pinned toolchains](../../CONTRIBUTING.md), the Solana CLI, Python 3 and
an initializer wallet funded with Devnet SOL. See [wallet creation](devnet.md#4-fund-your-wallet).
The initializer also acts as this preview's admin, treasury, upgrade and manifest
authority. Keep its keypair in an owner-only file outside published assets.

From the repository root:

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run build:sdk
bash scripts/install_sbf_tools.sh
rustup target add wasm32-unknown-unknown
```

Select a new directory under `target/` and your wallet path:

```sh
umask 077
export ZKAPI_PUBLIC_DEVNET_PROFILE="$PWD/target/my-devnet"
export WALLET_PRIVATE_KEY_PATH=/absolute/private/operator-wallet.json
```

Set `SOLANA_DEVNET_RPC` privately to your HTTPS Devnet RPC endpoint. Do not put
private RPC URLs in documentation, public files or shell history. Obtain a second
independent RPC origin for control and an archive endpoint covering Pool creation.

Choose the real HTTPS service origin before signing public profiles. The gateway
uses that origin for control/indexer and `<origin>/rpc` for client RPC. Reserve
immutable URLs for the profile and assets, for example:

```text
https://YOUR_HOST/releases/YOUR_RELEASE/profile.json
https://YOUR_HOST/releases/YOUR_RELEASE/assets/
```

`YOUR_HOST` must be an actual public hostname. Publication does not require
putting private RPC, database or provider credentials at that origin.

## 2. Generate and pin the experimental setup

```sh
python3 scripts/prepare_public_devnet_profile.py \
  --output "$ZKAPI_PUBLIC_DEVNET_PROFILE"
```

Record its printed `public_profile_sha256` through your trusted review channel,
then set that exact value:

```sh
export ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256=REVIEWED_SHA256
node scripts/run_i10_devnet_vault.ts \
  --public-devnet-profile "$ZKAPI_PUBLIC_DEVNET_PROFILE" \
  --public-devnet-profile-sha256 "$ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256" \
  --validate-public-profile
```

The directory contains public proof artifacts and a separate `private/` directory
with `state.seed`, `clearance.seed`, `quote.seed` and `receipt.seed`. Preserve
these private files for the operator services; never publish the whole directory.
The setup uses a fresh single-party tree setup and the pinned upstream request
and withdrawal setup. It is experimental, without a reviewed ceremony.

## 3. Prepare program and Pool identities

```sh
node scripts/run_i10_devnet_vault.ts \
  --public-devnet-profile "$ZKAPI_PUBLIC_DEVNET_PROFILE" \
  --public-devnet-profile-sha256 "$ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256" \
  --prepare
```

This checks the Devnet genesis, reads the selected initializer wallet, and writes
`deployment/program-keypair.json` and `deployment/deployment.json`. It sends no
transaction. Keep the program keypair private. Set `ZKAPI_DEVNET_PROGRAM_ID` and
`ZKAPI_DEVNET_INITIALIZER` to the public values printed in `public_build_env`.

Review `deployment.json` before continuing. It contains the program and Pool PDA,
initializer, genesis, mint, token program, setup hash, note TTL, challenge period,
cap and rent/fee limits. The runner defaults to a 3,600-second note TTL and a
60-second challenge period. Choose a challenge period that covers your measured
indexer catch-up, restart and challenge time; edit it now if necessary.
Keep `cap_micro_usdc: "1000000"` for the reference gateway. Its
`deposit_micro_usdc` field is acceptance-runner metadata; these setup commands
do not deposit customer funds.

Freeze these choices before signing the manifest or initializing the Pool.

## 4. Build the Vault, IDL and prover

Use the same four exported public build inputs from steps 2–3:

```sh
cargo run --locked --manifest-path tools/vault-idl/Cargo.toml \
  --no-default-features --features devnet -- \
  "$ZKAPI_PUBLIC_DEVNET_PROFILE/deployment/vault-idl.json"
cargo build-sbf --manifest-path programs/zkapi-vault/Cargo.toml \
  --tools-version v1.54 --arch v0 --no-default-features \
  --features devnet,sbf-entrypoint \
  --sbf-out-dir "$ZKAPI_PUBLIC_DEVNET_PROFILE/deployment" -- --locked
cargo build --locked --release --manifest-path apps/clientd/prover/Cargo.toml \
  --target wasm32-unknown-unknown --lib
```

Reject SBF output containing oversized-stack diagnostics even if the command
exits successfully. The WASM output is
`apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm`.
Check that the generated IDL address matches the new program ID. Do not replace
the checked-in local-test IDL.

Create the build manifest before staging. This offline snippet reads only public
metadata/artifacts and writes a new file; it matches the transaction runner's
build-manifest encoding:

```sh
node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const root = process.env.ZKAPI_PUBLIC_DEVNET_PROFILE;
assert.ok(root);
const read = path => readFile(path);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const profileBytes = await read(join(root, 'public-profile.json'));
assert.equal(digest(profileBytes), process.env.ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256);
const profile = JSON.parse(profileBytes);
const out = join(root, 'deployment');
const deployment = JSON.parse(await read(join(out, 'deployment.json')));
const build = {
  schema: 2, public_profile_sha256: digest(profileBytes), tree_setup: 'single_party_os_random',
  deployment_environment: 'devnet', setup_profile: 'test_only',
  program_id: deployment.program_id, deployment_authority: deployment.initializer,
  genesis_hash: deployment.genesis, mint: deployment.mint, token_program: deployment.token_program,
  idl_sha256: digest(await read(join(out, 'vault-idl.json'))),
  program_sha256: digest(await read(join(out, 'zkapi_vault.so'))),
  state_key: profile.state_key, clearance_key: profile.clearance_key,
  circuit_profile_hash: profile.circuit_profile_hash,
};
await writeFile(join(out, 'build-manifest.json'), JSON.stringify(build, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
JS
```

Record exact SHA-256 hashes of the build manifest, IDL, ELF and WASM. Retain the
reviewed source revision with those artifacts.

## 5. Author the public profile before deploying

Create a private `initial-public-config.json` with the following exact fields.
All paths should be absolute; hash fields are lowercase SHA-256 of exact file
bytes. The [TypeScript interface](../../scripts/prepare_public_devnet_deployment.ts)
defines the strict contract.

| Field | Value |
|---|---|
| `schema` | `1` |
| `noDeploymentOrFundingOrServiceState` | `true`, only while no program, Pool or service state exists |
| `distributionDecisionPath`, `distributionDecisionSha256` | Reviewed `deploy/public-devnet/upstream-setup-distribution.json` and its hash |
| `noticesDirectory` | `deploy/public-devnet/upstream-notices/` |
| `publicSetupDirectory`, `publicSetupSha256` | New setup directory and the step-2 profile hash |
| `deploymentPath`, `deploymentSha256` | `deployment/deployment.json` and its hash |
| `buildManifestPath`, `buildManifestSha256` | `deployment/build-manifest.json` and its hash |
| `idlPath`, `programPath` | New `vault-idl.json` and `zkapi_vault.so` |
| `wasmPath`, `wasmSha256` | Built prover WASM and its hash |
| `expected` | `{ "deploymentId": "YOUR_NEW_ID", "programId": "PROGRAM", "pool": "POOL" }` from your reviewed identities |
| `manifestAuthorityKeyPath` | Original initializer wallet file; the signer address must match |
| `publicOrigin` | Real HTTPS API origin, without trailing `/` |
| `assetsBaseUrl`, `profileUrl` | Immutable URLs selected in step 1; asset directory ends with `/` |
| `privateRpcUrl` | Private HTTPS archive RPC; kept out of public output |
| `indexerListen` | For example `127.0.0.1:18883` |
| `snapshotsDirectory` | Absolute persistent snapshot directory |
| `startSlot` | An integer at or before Pool initialization; replace the private indexer config's value with the finalized initialization slot in step 7 |
| `consumer` | Model configuration below |

`consumer` has this shape; replace the placeholders with your reviewed model
and complete tariff:

```json
{
  "id": "my-devnet",
  "revision": 1,
  "model": {
    "id": "REVIEWED_OPENROUTER_MODEL_ID",
    "provider": "openrouter",
    "apis": ["chat"],
    "tariff": {
      "version": "1",
      "provider": "openrouter",
      "model": "*",
      "pricing_basis": "provider_reported_usd",
      "valid_from": "REVIEWED_UNIX_SECONDS",
      "valid_until": "REVIEWED_UNIX_SECONDS",
      "rates": [],
      "operator_fee_micro_usdc": "0",
      "tariff_hash": "SHA256_OF_JCS_TARIFF_WITHOUT_TARIFF_HASH"
    }
  },
  "streaming": false,
  "tools": false
}
```

Use canonical integer strings for tariff times and enable only capabilities you
will validate. Compute `tariff_hash` with the existing SDK's
`sha256Hex(jcsBytes(tariffWithoutHash))` from `@zkapi/solana-sdk/trust`.
The same tariff must be installed in the operator's control service.

Set configuration mode `0600`, then run:

```sh
node scripts/prepare_public_devnet_deployment.ts --stage \
  /absolute/private/initial-public-config.json \
  "$ZKAPI_PUBLIC_DEVNET_PROFILE/staging"
```

This signs and verifies the manifest, packages the proof assets/notices, and
writes `staging/prepared/consumer-profile.json` plus `staging/prepared/assets/`.
It makes no chain or provider call. Keep the printed profile/bundle hashes for
independent publication. Do not rewrite these bytes after the Pool exists.

The emitter currently supports one OpenRouter Chat model and the one-USDC cap.
It does not generate a proxy/OA consumer profile. Those modes require manual
manifest/profile authorship under the [deployment contract](../sdk/deployment.md)
and independent validation; changing this script's output mode is insufficient.

## 6. Deploy the program

Review the program ID, initializer, ELF hash and maximum rent/fee settings first.
The next command spends Devnet SOL:

```sh
node scripts/run_i10_devnet_vault.ts \
  --public-devnet-profile "$ZKAPI_PUBLIC_DEVNET_PROFILE" \
  --public-devnet-profile-sha256 "$ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256" \
  --deploy
```

It checks genesis, rent and balance, retains the deployment buffer keypair,
invokes the Solana CLI with one maximum signing attempt, and verifies finalized
ProgramData bytes and upgrade authority against the built ELF and initializer.
Keep `deployment/deployed.json` and the program/buffer keypairs privately.

If deployment is interrupted, inspect the retained buffer and chain state
before continuing. The deployment CLI is a multi-transaction upload; it does not
use the SDK wallet-operation journal. Do not blindly rerun it after uncertainty.

## 7. Initialize and verify the Pool

```sh
node scripts/run_i10_devnet_vault.ts \
  --public-devnet-profile "$ZKAPI_PUBLIC_DEVNET_PROFILE" \
  --public-devnet-profile-sha256 "$ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256" \
  --initialize
```

This creates PoolConfig, TreeState and the USDC vault using the reviewed
`deployment.json`. It saves `initialize-transaction.json` before its single send
and writes `initialize-receipt.json` only after finalized success. If the result
is unknown, rerunning **this same command with the same directory** reads the
saved transaction and checks its receipt; it does not resend or replace it.
An expired or failed initialization needs operator review; do not delete its
saved attempt to make the command send again.

Use the receipt's slot as the indexer/challenger start slot. Independently verify
the finalized program, Pool and upgrade authority against the manifest/build.
The staging report's `chainCompatible: false` means offline packaging made no
such chain observation; do not treat it as deployment acceptance.

## 8. Start services and publish

Follow [Run a ZKAPI operator](proxy-operator.md#3-configure-the-database-and-daemons),
using the new manifest, build, original role seeds and exact tariff. Build and
install Linux service binaries on the chosen Linux architecture; the macOS
client archive is not a server bundle.

For the reference systemd layout only, the existing
[`bootstrap_public_devnet_operator.py`](../../scripts/bootstrap_public_devnet_operator.py)
can initialize a new empty mounted `/srv/zka` with binaries/source under
`/opt/zkapi`. It requires root, PostgreSQL tools, a CloudFront origin, a privately
assembled input inventory and exact binary hashes:

```sh
python3 scripts/bootstrap_public_devnet_operator.py --initialize-new-operator \
  --input-directory /absolute/private/operator-inputs \
  --inventory-sha256 REVIEWED_INVENTORY_SHA256
```

This optional bootstrap is specific to that host layout. Its input directory
contains `operator.json`, `public/`, `deployment/`, `roles/`,
`openrouter-management.credential`, `challenger-fee-key.json` and `inventory.json`.
`operator.json` supplies schema `1`, `new_operator: true`, `start_slot`,
`public_origin`, `manifest_sha256`, `profile_sha256`, `primary_rpc`,
`secondary_rpc`, `challenger_payer`, `tariffs` and `binary_sha256` for all five
service binaries. Use `public/profile.json` for the consumer profile and
`public/assets/` for its bundle. Include **only** `vault-idl.json`,
`zkapi_vault.so`, `build-manifest.json` and the setup's `public-profile.json`
inside this inventory's `deployment/`; bootstrap makes that directory readable.
Keep all wallet/program keypairs outside it. `roles/` contains the four original
32-byte role seed files.

`inventory.json` is `{ "schema": 1, "files": { "relative/file": "SHA256" } }`
and must cover every other input file. There is no general
operator-distribution builder or inventory-generator
command; assemble and review these inputs manually, or use the explicit daemon
setup in the operator guide. Never bootstrap an occupied or interrupted state
volume again.

Publish only `staging/prepared/assets/` at `assetsBaseUrl` and
`staging/prepared/consumer-profile.json` at `profileUrl`. Do not publish the setup,
staging parent, build wallet files, private indexer config or operator inventory.
Configure [gateway and HTTPS](gateway.md), run independent [SDK preflight](sdk.md#2-check-the-deployment),
then verify a funded lifecycle and recovery before enabling public admission.
