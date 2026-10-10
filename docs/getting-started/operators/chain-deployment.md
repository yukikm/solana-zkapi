# Create a fresh Devnet program and Pool

Use this before [operator setup](../proxy-operator.md) when you do not yet have
a matching setup, Vault program and initialized Pool. The commands prepare a
fresh experimental setup, build its exact program/IDL, and deploy and initialize
on **Solana Devnet**. They do not install a server or perform inference.

Run preparation/build commands on a trusted build machine. The explicitly
labelled deployment/initialization steps spend Devnet SOL and sign transactions;
they belong to a reviewed new deployment. Existing funded installations must
keep their original setup, program, Pool, keys and journals.

## 1. Get the pinned source and tools

Choose the full commit hash reviewed for your deployment; do not substitute an
unreviewed moving branch or assume an old release tag matches your intended build.

```sh
git clone https://github.com/yukikm/solana-zkapi.git
cd solana-zkapi
git checkout --detach REVIEWED_FULL_COMMIT_SHA
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run build:sdk
bash scripts/install_sbf_tools.sh
```

Use Rust 1.90.0 from `rust-toolchain.toml`, Node 24.19.0 and npm 11.9.0. The SBF
installer supports Linux x86-64 and macOS ARM64 and pins `cargo-build-sbf 4.1.0`
with platform-tools `v1.54`. Check its reported versions. Install a reviewed
[Solana CLI](https://solana.com/docs/intro/installation) providing `solana program deploy`;
record its version in your deployment inputs. The repository does not pin or
install that CLI for you.

The local proxy branch also needs `openssl` on `PATH`; its `--configure` step
uses it to create the retained loopback TLS certificate and key.

Use an owner-only Solana CLI JSON keypair for your Devnet initializer and upgrade
authority. If you need a new wallet, create and back it up using the
[Solana wallet instructions](https://solana.com/docs/intro/installation/solana-cli-basics).
Acquire Devnet SOL through [funding](../devnet-funding.md). The initializer must
cover program rent, its temporary deployment buffer and Pool/account rent;
client deposit amounts are not a server deployment budget.

Create an owner-only `/private/operator-chain.env` with these values:

```dotenv
SOLANA_DEVNET_RPC=https://YOUR_REVIEWED_DEVNET_RPC
WALLET_PRIVATE_KEY_PATH=/absolute/path/to/initializer-keypair.json
```

This file contains a wallet **path**, not the private key bytes. Keep the RPC
URL private. The runner checks the Devnet genesis before reading the wallet.
`--prepare` needs read-only RPC and wallet access; setup generation and builds
do not need either.

## 2. Generate a new random setup

Use a new directory under this checkout's ignored `target/`. The generator
refuses an existing output and does not read a wallet or call RPC/provider APIs:

```sh
umask 077
ZKAPI_SETUP="$PWD/target/operator-setup"
python3 scripts/prepare_public_devnet_profile.py --output "$ZKAPI_SETUP"
```

Retain the reported `public_profile_sha256` independently and set it below:

```sh
ZKAPI_SETUP_SHA256='PUBLIC_PROFILE_SHA256_PRINTED_BY_THE_GENERATOR'
python3 scripts/check_public_devnet_profile.py \
  --profile "$ZKAPI_SETUP" --sha256 "$ZKAPI_SETUP_SHA256"
node scripts/run_i10_devnet_vault.ts --validate-public-profile \
  --public-devnet-profile "$ZKAPI_SETUP" \
  --public-devnet-profile-sha256 "$ZKAPI_SETUP_SHA256"
```

Both checks must pass. Preserve the entire setup directory, especially
`private/{state,clearance,quote,receipt}.seed`, the tree proving/verifying keys,
source bundle and profile. The tree setup and role keys use fresh OS randomness;
the request/withdrawal keys retain their pinned upstream provenance. This is
an experimental single-party setup, not a reviewed ceremony. Do not select
`--allow-legacy-devnet-fixtures` or `ZKAPI_ALLOW_LEGACY_DEVNET_FIXTURES`.

## 3. Prepare program identity and Pool parameters

In the same Bash shell, define the shared arguments and prepare the base program
identity. This writes private local files and makes read-only RPC calls, but
sends no transaction:

```sh
zkapi_vault_args=(
  --public-devnet-profile "$ZKAPI_SETUP"
  --public-devnet-profile-sha256 "$ZKAPI_SETUP_SHA256"
)
node --env-file=/private/operator-chain.env scripts/run_i10_devnet_vault.ts \
  "${zkapi_vault_args[@]}" --prepare
ZKAPI_DEPLOYMENT="$ZKAPI_SETUP/deployment"
```

The output contains the new program address, initializer and base Pool PDA.
`deployment/program-keypair.json` identifies the program;
`deployment/deployment.json` binds the genesis, mint, Pool seed, initializer,
cap, durations and cost limits. Preserve both. Review parameters before any
signature/publication: the helper starts with a 3,600-second note TTL,
60-second challenge window, 1,000,000-micro-USDC cap, maximum program rent of
4,000,000,000 lamports and per-Pool-transaction fee limit of 10,000 lamports.
These are helper defaults, not a measured public operating policy. Review any
different TTL/challenge choice in this new record before staging or initialization;
do not change a record after chain state, manifests or journals depend on it.

Read the public build pins from that new record, without printing private keys:

```sh
export ZKAPI_DEVNET_PROGRAM_ID="$(node --input-type=module -e \
  'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).program_id)' \
  "$ZKAPI_DEPLOYMENT/deployment.json")"
export ZKAPI_DEVNET_INITIALIZER="$(node --input-type=module -e \
  'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).initializer)' \
  "$ZKAPI_DEPLOYMENT/deployment.json")"
export ZKAPI_PUBLIC_DEVNET_PROFILE="$ZKAPI_SETUP"
export ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256="$ZKAPI_SETUP_SHA256"
```

## 4. Build the matching IDL, SBF program and prover

Keep the same four public environment pins for both Vault commands. Disabling
default features is essential: the default build is the local fixture profile.

```sh
cargo run --locked --manifest-path tools/vault-idl/Cargo.toml \
  --no-default-features --features devnet -- "$ZKAPI_DEPLOYMENT/vault-idl.json"
cargo build-sbf --manifest-path programs/zkapi-vault/Cargo.toml \
  --tools-version v1.54 --arch v0 --no-default-features \
  --features devnet,sbf-entrypoint --sbf-out-dir "$ZKAPI_DEPLOYMENT" -- --locked
cargo build --locked --release --manifest-path apps/clientd/prover/Cargo.toml \
  --target wasm32-unknown-unknown --lib
```

Require a successful compiler-generated IDL whose `address` equals the prepared
program and a matching `zkapi_vault.so`. Inspect the SBF build output: oversized
stack-frame diagnostics can appear without a failing process exit and must
block deployment. The WASM output is
`apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm`.

Create the public build record before any public-profile staging. This offline
snippet writes the exact schema and serialization expected by the existing
Vault runner and refuses to overwrite a record:

```sh
node --input-type=module - "$ZKAPI_SETUP" "$ZKAPI_SETUP_SHA256" <<'JS'
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const [setup, pin] = process.argv.slice(2);
const sha = value => createHash('sha256').update(value).digest('hex');
const raw = await readFile(join(setup, 'public-profile.json'));
assert.equal(sha(raw), pin);
const profile = JSON.parse(raw), dir = join(setup, 'deployment');
const deployment = JSON.parse(await readFile(join(dir, 'deployment.json')));
const idl = await readFile(join(dir, 'vault-idl.json'));
const program = await readFile(join(dir, 'zkapi_vault.so'));
assert.equal(JSON.parse(idl).address, deployment.program_id);
assert.equal(deployment.public_profile_sha256, pin);
const build = {
  schema: 2, public_profile_sha256: pin, tree_setup: 'single_party_os_random',
  deployment_environment: 'devnet', setup_profile: 'test_only',
  program_id: deployment.program_id, deployment_authority: deployment.initializer,
  genesis_hash: deployment.genesis, mint: deployment.mint,
  token_program: deployment.token_program, idl_sha256: sha(idl),
  program_sha256: sha(program), state_key: profile.state_key,
  clearance_key: profile.clearance_key, circuit_profile_hash: profile.circuit_profile_hash
};
const bytes = JSON.stringify(build, null, 2) + '\n';
await writeFile(join(dir, 'build-manifest.json'), bytes, {flag: 'wx', mode: 0o600});
console.log(JSON.stringify({build_manifest_sha256: sha(bytes), ...build}));
JS
```

Retain the ELF, IDL, WASM and build-record hashes with the source commit and
tool versions. A build record identifies bytes; it does not prove a chain
deployment or successful proof/lifecycle acceptance.

## 5. Select the public-direct or local-proxy configuration path

### Public direct OpenRouter

**Stage the canonical public origin before program deployment and Pool
initialization.** Follow [public staging](deployment.md#pin-and-bootstrap-a-canonical-public-deployment)
using the setup, deployment, build, IDL and WASM just produced. Supply the actual
CloudFront origin, reviewed model/tariff, manifest-authority key and exact notices.
`manifestAuthorityKeyPath` must be the same initializer JSON keypair used by
the Vault runner; the emitter checks its public key against
`deployment.initializer`. An unrelated distribution signer is refused.
Use `noDeploymentOrFundingOrServiceState: true` only while it is true.

Record a finalized replay starting slot with a read-only RPC request:

```sh
node --env-file=/private/operator-chain.env --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import {createSolanaRpc} from '@solana/kit';
const rpc = createSolanaRpc(process.env.SOLANA_DEVNET_RPC);
assert.equal(await rpc.getGenesisHash().send(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
console.log((await rpc.getSlot({commitment: 'finalized'}).send()).toString());
JS
```

Put that slot into the staging configuration's numeric `startSlot`, then run:

```sh
node scripts/prepare_public_devnet_deployment.ts \
  --stage /private/initial-public-config.json /private/new-staging-root
```

The stage config's replay slot can be a reviewed finalized slot observed before
initialization; it must never be later than the actual initialize receipt.
Keep the generated profile and assets unchanged. This produces signed staging
inputs with `chainCompatible: false`; verify chain state after the next steps.
Do not run the Vault runner's `--configure` for this branch: it creates local
origins, not the public profile just signed.

If the program is already deployed but its Pool is absent, the emitter has an
explicit `program_deployed_pool_uninitialized` mode requiring independently
retained finalized program/account evidence; see the detailed staging guide.
It cannot authorize a profile rewrite for an initialized or funded Pool. There
is no automatic initialized-Pool migration/publisher in this command.

### Local/Devnet inference proxy

The existing runner can sign a **loopback** provider manifest. After the base
IDL exists, prepare its dedicated provider Pool (same program, new Pool):

```sh
node --env-file=/private/operator-chain.env scripts/run_i10_devnet_vault.ts \
  "${zkapi_vault_args[@]}" --pool=provider --prepare
ZKAPI_POOL_DIRECTORY="$ZKAPI_DEPLOYMENT/pools/provider"
```

Review that Pool's separate `deployment.json` parameters before initialization.
The provider-manifest command uses the fixed preparation directory
`target/i10-provider-acceptance`. In a new checkout where it does not exist,
run the [provider preparation](../api-provider.md) commands with that exact
`--state-dir`, your reviewed proxy plan and private provider environment file.
Do not overwrite, copy/reset or reuse an existing campaign to fit this recipe.
The backend later uses this same prepared directory as `--provider-state`.

This path does not author arbitrary public proxy origins. The public staging
emitter accepts only direct OpenRouter. A public proxy requires a separately
reviewed manifest/profile authoring and publication integration using the
[manifest and SDK contracts](../deployment-inputs.md); that publishing step has
no general proxy CLI in this repository. Use the local path for supported
Devnet integration, or complete that integration before advertising public
proxy onboarding.

## 6. Deploy the exact program — signs transactions

For either branch, deploy the base program only once:

```sh
node --env-file=/private/operator-chain.env scripts/run_i10_devnet_vault.ts \
  "${zkapi_vault_args[@]}" --deploy
```

The helper authenticates setup/build pins and Devnet genesis, estimates rent,
requires balance above twice the ProgramData rent plus 10,000,000 lamports,
and invokes `solana program deploy` with the retained program/buffer keypairs,
zero priority fee and `--max-sign-attempts 1`. Its CLI batch cost bound is
separate from the 10,000-lamport Pool-transaction fee limit.

Success writes `deployment/deployed.json` after checking finalized executable
program/ProgramData ownership, PDA, exact ELF bytes and upgrade authority.
Retain its observed cost and hashes. If deployment fails or its result is
uncertain, inspect the saved buffer/program and on-chain state before another
attempt; do not generate replacement program/buffer identities. If the program
already exists, this command verifies its bytes/authority and does not upgrade it.

## 7. Initialize the selected Pool — signs one transaction

Choose only the branch prepared above. For the staged public direct Pool:

```sh
ZKAPI_POOL_DIRECTORY="$ZKAPI_DEPLOYMENT"
node --env-file=/private/operator-chain.env scripts/run_i10_devnet_vault.ts \
  "${zkapi_vault_args[@]}" --initialize
```

For the separately prepared local proxy Pool:

```sh
ZKAPI_POOL_DIRECTORY="$ZKAPI_DEPLOYMENT/pools/provider"
node --env-file=/private/operator-chain.env scripts/run_i10_devnet_vault.ts \
  "${zkapi_vault_args[@]}" --pool=provider --initialize
```

Initialization verifies the deployed program first, derives the Pool/tree/vault
accounts, and saves `initialize-transaction.json` with exact signed bytes before
one send (`maxRetries: 0`). It waits for a finalized, successful receipt and
checks the saved message, signature and bounded fee before writing
`initialize-receipt.json`. Success prints `initialized: true`, the Pool and slot.

If a saved initialization is unresolved, keep its original record. Only after
confirming that `initialize-transaction.json` already exists may the exact same
`--initialize` command be used to check that saved attempt again; the existing
record path verifies its wire and polls finality without resending it. Missing
or expired unresolved state requires explicit recovery, not deleting the record
or selecting another Pool to hide uncertainty.

For the local proxy branch only, author its local manifest after initialization:

```sh
node --env-file=/private/operator-chain.env scripts/run_i10_devnet_vault.ts \
  "${zkapi_vault_args[@]}" --pool=provider \
  --provider-plan=/private/reviewed-proxy-plan.json --configure
```

This reads prepared tariff hashes from `target/i10-provider-acceptance`, signs
`public-manifest.json`, and writes `private-indexer.json` plus local TLS material.
It makes read-only chain calls and signs the manifest, but performs no inference,
deposit or AUTH. For the provider Pool, the defaults are indexer **19283**,
control HTTPS **19285** and inference
HTTPS **19286**. The generated indexer public origin is `https://127.0.0.1:19284`.
Use these exact signed origins with a trusted local TLS transport. The backend
and [proxy setup](../proxy-operator.md) can choose distinct private listener ports,
but ingress must still match the manifest.

## 8. Verify finalized identities and hand off to server setup

Retain, and independently compare against the reviewed inputs:

| Record/check | Required result |
|---|---|
| `deployed.json` | Matching ProgramData PDA, upgrade authority and exact program SHA-256 |
| `initialize-transaction.json` and `initialize-receipt.json` | Same saved signature/wire digest, successful finalized receipt, expected Pool instruction and bounded fee; initializer is also payer, admin and treasury owner in this helper |
| Setup/build/IDL | Matching program, initializer, role keys, circuit profile, mint and all artifact hashes |
| Replay slot | At or before the recorded finalized initialization slot |
| Fresh SDK preflight before admitting users | Actual finalized PoolConfig, tree/indexer, manifest, catalog and assets all validate |

The helper's receipts prove their stated chain operations; they do not establish
server readiness, provider credit, usable inference, or an audit. Neither
`--admin-check` nor `--lifecycle` is needed for this handoff: those are additional
financial acceptance actions, not read-only deployment verification.

For public direct mode, use the unchanged `new-staging-root/prepared` public
manifest/profile/assets, original setup/roles and finalized initialization receipt
in [bootstrap inputs](bootstrap-inputs.md), then continue
[direct OpenRouter setup](direct-openrouter.md). Supply the actual receipt slot
in `operator.json`; the stage's earlier replay slot may remain valid.

For the local proxy, use `deployment/pools/provider` as the backend's
`--deployment`, the **base** `deployment/zkapi_vault.so` as `--program`, the
original setup and `target/i10-provider-acceptance` as `--provider-state`.
Keep that explicit ELF path; the nested provider Pool does not copy the ELF.
Continue [proxy setup](../proxy-operator.md) with its actual signed local origins
and retained private TLS certificate, or with a separately reviewed public
proxy publication. Back up every private identity and chain receipt before
accepting a funded note.
