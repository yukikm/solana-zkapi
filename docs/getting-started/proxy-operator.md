# Run a ZKAPI operator

The operator runs control, provider dispatch, settlement signing, the tree indexer
and challenger. Proxy mode also relays inference; direct mode sends inference
from the client to the provider. Both use the same ledger and settlement service.

This is a Devnet/test deployment. Start with [Create a new Devnet deployment](deployment.md)
to build and initialize your program, Pool, signing keys, proof artifacts and
manifest. Downloading a consumer profile does not provide private operator
inputs. See [support](../support.md) for supported scope.

## 1. Prepare the host and build

Use the pinned [toolchains](../../CONTRIBUTING.md), PostgreSQL 16, a persistent
private state volume, two independent Solana RPC origins, an archive RPC covering
Pool initialization, and an operator-owned HTTPS origin. Keep provider credit and
SOL for the challenger fee payer available.

From the repository root:

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run build:sdk
cargo build --release --locked --manifest-path services/control/Cargo.toml --bins
cargo build --release --locked --manifest-path services/indexer/Cargo.toml --bin indexerd
cargo build --release --locked --manifest-path services/challenger/Cargo.toml --bin challengerd
```

Build outputs are under each service's `target/release/`. Keep the matching SDK
source, Node runtime and challenger bridge installed with the binaries.

Before configuring real providers, run the local suite with PostgreSQL and the
pinned SBF tools available:

```sh
bash scripts/run_i06_i07.sh
```

This uses provider fixtures, real proofs and the local Vault SBF. It makes no
paid provider calls and does not deploy a public service.

## 2. Prepare a new deployment

Have these inputs ready before starting services:

| Input | Required binding |
|---|---|
| Deployed Vault and initialized Pool | Program bytes, authority, Devnet genesis, Circle Devnet USDC mint |
| Request, withdrawal and tree proof artifacts | Circuit/setup hashes and matching native/WASM provers |
| Signed manifest, IDL and build manifest | Program, Pool, service origins, role keys, caps and tariff hashes |
| Public SDK profile and artifact bundle | Independently published SHA-256 pins; include license notices |
| Private state and clearance keys | Match the Pool/build; retain the signer journal independently |
| Private quote and receipt keys | Match the manifest |
| Provider credentials and model configuration | Follow [API provider setup](api-provider.md) |
| Challenger fee key | Its public key and available Devnet SOL |

Follow the [deployment procedure](deployment.md) for the exact setup, build,
staging, program deployment and Pool initialization commands. Use its finalized
initialization slot and original private role files below. The procedure also
identifies the manual configuration needed for non-reference provider modes.

## 3. Configure the database and daemons

As the PostgreSQL administrator, create a new database and separate roles once:

```sql
CREATE ROLE zkapi_control_writer NOLOGIN;
CREATE ROLE zkapi_control_reader NOLOGIN;
CREATE ROLE zkapi_migration LOGIN;
CREATE ROLE zkapi_writer LOGIN;
CREATE ROLE zkapi_signer LOGIN;
CREATE ROLE zkapi_provider LOGIN;
CREATE ROLE zkapi_challenger LOGIN;
CREATE DATABASE zkapi OWNER zkapi_migration;
GRANT zkapi_control_writer TO zkapi_writer;
GRANT zkapi_control_reader TO zkapi_signer, zkapi_provider, zkapi_challenger;
GRANT CONNECT ON DATABASE zkapi TO zkapi_writer, zkapi_signer, zkapi_provider, zkapi_challenger;
```

Reuse existing group roles if already present. Provision local authentication
separately and keep database connection credentials private. Runtime roles must
not own the database or tables. Migrations grant writer and reader permissions;
runtime DELETE, TRUNCATE and DDL are forbidden. Use Unix-socket connections for
Devnet. Keep runtime directories mode `0700` and private configs, seeds and
journals mode `0600`.

Prepare these files using the linked field definitions:

| File | Contents |
|---|---|
| `control.json` | [`RuntimeConfig`](../../services/control/src/config.rs): manifest and independent hash, RPC origins, indexer origin, signer socket, quote/receipt key paths, tariffs and providers |
| `dispatcher.json` | [Provider isolation config](operations.md#provider-isolation): read-only DB role, Pool, persistent claims directory and provider credentials |
| `indexer.json` | [Indexer config](../../services/indexer/README.md): program/Pool/genesis/circuit pins, archive RPC, initialization slot, public origin and snapshot directory |
| `challenger.json` | [Challenger config](../../services/challenger/README.md): same manifest/build pins, read-only DB role, archive start slot, journal, tree proving key, fee key and pinned SDK bridge |

Control keeps `local_test_only: true`. Public Devnet requires its explicit
`devnet` configuration with IDL, program, build manifest and independent hashes;
schema-2 builds also require the public setup profile and its hash.
Configure the dispatcher's corresponding Devnet pins too. Merely changing the
RPC URL does not enable Devnet.

Set `enable_local_adapter: false` for real providers. Control's
`providers.dispatcher` selects the exact dispatcher binary, its SHA-256 and
private config path. Keep provider credentials with that dispatcher. Give it
read-only ledger access and retain its one-use dispatch claims across restarts.

## 4. Initialize once, then start

Set `ZKAPI_MIGRATION_DATABASE_URL`, `ZKAPI_WRITER_DATABASE_URL` and
`ZKAPI_READER_DATABASE_URL` to the separately provisioned connections. With
`zkapi_state` pointing to your prepared private directory:

```sh
umask 077
zkapi_bin="$PWD/services/control/target/release"
zkapi_state=/absolute/private/zkapi

ZKAPI_DATABASE_URL="$ZKAPI_MIGRATION_DATABASE_URL" "$zkapi_bin/controld" migrate
ZKAPI_DATABASE_URL="$ZKAPI_WRITER_DATABASE_URL" "$zkapi_bin/controld" \
  signer-config "$zkapi_state/control.json" > "$zkapi_state/signer.json"
ZKAPI_DATABASE_URL="$ZKAPI_WRITER_DATABASE_URL" "$zkapi_bin/controld" \
  provision "$zkapi_state/control.json"
"$zkapi_bin/signerd" --local-test --config "$zkapi_state/signer.json" \
  --journal "$zkapi_state/signer.journal" --initialize-journal
services/challenger/target/release/challengerd init "$zkapi_state/challenger.json"
```

Run initialization only for new state. A missing or damaged existing journal
requires recovery, not initialization. Keep each long-running command below
under your supervisor or in its own terminal:

```sh
ZKAPI_SIGNER_DATABASE_URL="$ZKAPI_READER_DATABASE_URL" "$zkapi_bin/signerd" \
  --local-test --config "$zkapi_state/signer.json" \
  --journal "$zkapi_state/signer.journal" --socket "$zkapi_state/signer.sock" \
  --state-seed-file "$zkapi_state/state.seed" \
  --clearance-seed-file "$zkapi_state/clearance.seed"

services/indexer/target/release/indexerd "$zkapi_state/indexer.json"
```

Wait for signer reconciliation and finalized indexer catch-up before starting:

```sh
ZKAPI_DATABASE_URL="$ZKAPI_WRITER_DATABASE_URL" "$zkapi_bin/controld" \
  serve "$zkapi_state/control.json"
services/challenger/target/release/challengerd run "$zkapi_state/challenger.json"
```

Control acquires the sole financial writer lock and verifies chain and signer
state before admitting work. It invokes the dispatcher; do not run a second
financial writer. The [systemd templates](../../deploy/public-devnet/systemd/README.md)
show persistent paths and shutdown order for the reference Linux installation.

## 5. Publish and check the service

Serve the reviewed profile, proof bundle, WASM and notices from immutable HTTPS
paths. Publish independent profile/download pins for consumers. Configure TLS,
CORS and fixed upstream routes without forwarding cookies or private RPC keys.

The [public gateway](../../deploy/public-devnet/README.md) supports the reference
direct OpenRouter deployment. It is not a generic proxy-inference gateway.
For proxy mode, expose the control service's supported `/v1/*` inference routes
and `/zkapi/v1/*` control routes through your reviewed HTTPS frontend, plus
indexer routes and a restricted RPC relay. Preserve exact bodies and
`Idempotency-Key`; disable automatic retries for AUTH, inference and transactions.

Before admitting users:

1. Verify live program bytes, Pool and authority against your published pins.
2. Check finalized tree root and snapshot delivery, signer reconciliation,
   challenger status, fee balance and provider credit.
3. Run [SDK preflight](sdk.md#2-check-the-deployment) from a separate client.
4. Verify deposit, your advertised inference modes, signed settlement,
   same-journal recovery and withdrawal with your own authorized test budget.
5. Publish only the verified scope, model limits and access policy.

## 6. Maintain and recover

Back up PostgreSQL plus WAL, the independent signer journal, dispatcher claims,
challenger journal and original deployment files. Test restoration together.
Monitor archive growth, database headroom, fees and challenge deadlines using
the [operations reference](operations.md).

For maintenance, suspend new admission while keeping recovery and withdrawal
routes available. Stop control and its provider children before signer and
PostgreSQL. Resume with the original state and pins. Unknown work must reconcile
through the existing ledger; a timeout or restart is never permission to resend
inference, replace transactions or initialize a new journal.
