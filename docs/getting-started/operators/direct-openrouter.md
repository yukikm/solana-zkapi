# Set up the direct OpenRouter operator

For both operating modes, start with [operator setup](../proxy-operator.md).
This guide takes a new direct OpenRouter Devnet operator from server requirements
to a public payment API and a verified client connection. Run repository commands from a
pinned source checkout. Instructions for an existing funded installation are in
[same-state maintenance](same-state-restart.md).

## 1. Choose the operating mode and prepare the inputs

| Mode | Who sends prompts upstream? | Setup covered here |
|---|---|---|
| `direct_openrouter` | The client, using the session's short-lived provider key | Existing public Devnet gateway and Linux bootstrap |
| `proxy` | The operator, through a configured provider adapter | Control/dispatcher configuration is implemented; public inference ingress and its acceptance require separate configuration |

The public payment gateway in this guide deliberately refuses provider inference
routes. It is not an arbitrary API reverse proxy. For an inference proxy, first
prepare [API provider configuration](../api-provider.md), then use the
[control provider reference](../../../services/control/PROVIDERS.md) and
[isolation/financial recovery requirements](operations.md). The public
OpenRouter bootstrap does not configure that mode or establish its readiness.

For the implemented public direct mode, prepare:

- A new Linux server with systemd, nginx, PostgreSQL 16 (`postgres`, `initdb`, `psql`,
  `pg_isready` on `PATH`), Python 3 and persistent state mounted at `/srv/zka`.
  The bootstrap requires an empty dedicated mount and unused `zka-*` service
  identities. It refuses an existing or partially initialized operator.
- Rust 1.90.0, Node 24.19.0 and npm 11.9.0 on a Linux build machine matching the
  server architecture. The macOS clientd package is not a server distribution.
- Two independent HTTPS Devnet RPC origins, including archive access covering
  the Pool's initialization slot; a public HTTPS origin; private backups with
  independently retained decryption capability; disk/capacity monitoring.
- A compatible finalized Devnet program and new Pool, its exact build/setup,
  signed public profile and proving assets, and the original role keys. The
  operator must control the relevant authorities; never borrow an existing
  funded Pool or its journals for a new deployment. Create these inputs with
  [fresh chain deployment](chain-deployment.md), preserving the staging order
  in step 3 below.
- OpenRouter management rights and real provider credit, verified model/tariff
  pins, plus a challenger fee payer with Devnet SOL. Follow
  [API provider setup](../api-provider.md) before proceeding.

For AWS, follow [hosting](hosting.md) to prepare the private instance,
HTTPS NAT, CloudFront VPC origin and private S3 assets. The bootstrap accepts
CloudFront's generated `https://<name>.cloudfront.net` origin. Other hosting
requires adapting the service/configuration installation explicitly; it is not
supported by that helper unchanged. Record the generated hostname before signing
the final profile. The documented small host is a preview, not a production
capacity or high-availability guarantee.

## 2. Build and install the server

Initialize the pinned upstream source, install dependencies and build on the
Linux build machine:

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run typecheck
npm run build:sdk
cargo build --release --locked --manifest-path services/control/Cargo.toml --bins
cargo build --release --locked --manifest-path services/indexer/Cargo.toml --bin indexerd
cargo build --release --locked --manifest-path services/challenger/Cargo.toml --bin challengerd
```

Install the same pinned source tree and its installed Node dependencies at
`/opt/zkapi`. Copy only reviewed source/runtime files; exclude `.env`, `target/`,
private input directories and local financial state. The server installation
must contain these additional files:

| Destination | Built or verified source |
|---|---|
| `/opt/zkapi/bin/controld`, `signerd`, `dispatcherd`, `opsd` | `services/control/target/release/` |
| `/opt/zkapi/bin/indexerd` | `services/indexer/target/release/indexerd` |
| `/opt/zkapi/bin/challengerd` | `services/challenger/target/release/challengerd` |
| `/opt/zkapi/node/bin/node` | Verified Linux Node 24.19.0 binary |
| `/opt/zkapi/scripts/`, `packages/sdk/`, `node_modules/` | Matching checkout, built SDK and pinned installed dependencies |
| `/opt/zkapi/deploy/public-devnet/systemd/` | Reviewed unit files from that checkout |

Record executable hashes, make the installation root-owned and non-writable by
service users, and confirm `/opt/zkapi/node/bin/node --version` prints
`v24.19.0`. Review the [service-unit paths](service-units.md), including
`/usr/bin/postgres`, against the host. A build pass does not initialize chain or
financial state.

## 3. Prepare the signed deployment and private inventory

Follow [fresh chain deployment](chain-deployment.md) from source checkout through
random setup and matching IDL/SBF/WASM builds. **Stage the canonical profile
before deploying the program and initializing its Pool.** Use
[deployment inputs](deployment.md#pin-and-bootstrap-a-canonical-public-deployment)
for the emitter's exact configuration fields:

```sh
node scripts/prepare_public_devnet_deployment.ts \
  --stage /private/initial-public-config.json /private/new-staging-root
```

The detailed guide defines every input field. This command creates new staged
files; it does not deploy a program, initialize a Pool or verify current chain
state. Continue the chain guide's explicit deploy/initialize steps, retaining
the staged profile unchanged. Before host bootstrap, verify the finalized
program/Pool, authorities, initialization receipt and start slot. The emitter
cannot stage an already initialized Pool as if it had no chain state. Do not
use known-entropy local fixtures as public deployment inputs.

Assemble the exact [bootstrap input directory](bootstrap-inputs.md):
public profile/assets, build/setup files, four private role seeds, management
credential, challenger key, `operator.json` and a hash inventory. The bootstrap
uses direct OpenRouter with a **five-second settlement grace**; the provider
preparation helper's default is 60 seconds. Select and review that policy
explicitly with your provider accounting assumptions before startup. Provider
charges reported later remain the operator's risk.

Publish only the reviewed consumer profile and complete assets to their signed
immutable URLs. Check anonymous downloads and exact hashes. Preserve all
authenticated license/provenance notices; never upload the whole private input
directory.

## 4. Initialize the new database, signer and service configuration

Transfer the private inventory through a protected channel. On the new host,
substitute its actual path and independently retained inventory SHA-256:

```sh
sudo python3 /opt/zkapi/scripts/bootstrap_public_devnet_operator.py \
  --initialize-new-operator \
  --input-directory /private/operator-inputs \
  --inventory-sha256 REVIEWED_INVENTORY_SHA256
```

Success prints `initialized: true`, `provider_budget_initialized: false` and
`public_admission_enabled: false`. It creates distinct database logins, migrates
the financial schema, provisions the exact Pool, initializes one signer journal
and challenger journal, installs systemd units and starts only PostgreSQL.
Configuration locations are listed in [bootstrap inputs](bootstrap-inputs.md#generated-files).

If the command fails, inspect its redacted `failed_stage` and protected state.
Never delete `operator-initialization.json`, a journal, a lock or the database
to rerun it. Partial state requires reconciliation.

Check the installed units and provider configuration without issuing a key:

```sh
sudo systemd-analyze verify /etc/systemd/system/zka-*.service
sudo runuser -u zka-runtime -- /opt/zkapi/bin/dispatcherd \
  /srv/zka/runtime/dispatcher.json --check-config
```

Continue only when both succeed. This validates configuration, not provider
credit or live inference.

## 5. Start the internal services

```sh
sudo systemctl start zka-signer.service zka-indexer.service
sudo systemctl is-active zka-postgresql.service zka-signer.service zka-indexer.service
curl --fail --silent --show-error http://127.0.0.1:18883/zkapi/v1/tree/root
```

The signer unit's readiness hook must verify reconciliation and its exact
configuration digest. Wait for a fresh finalized indexer root for the intended
Pool. An HTTP503 during catch-up is a stop point; retain the configured start
slot and investigate RPC/history availability.

```sh
sudo systemctl start zka-control.service zka-challenger.service
sudo systemctl is-active zka-control.service zka-challenger.service
```

Check challenger health under `/srv/zka/challenger/journal/health.json`: matching
Pool, ready status, recent observations and no unresolved deadline/unknown
transaction. A running process alone is insufficient. Configure the private
[operations collector](operations.md#live-collector) for ongoing
ledger, signer, fee-payer, chain and challenger observations.

## 6. Configure HTTPS and start the public gateway

Create `/srv/zka/config/gateway.json`, owner `zka-gateway`, mode `0600`, using
your exact origin, immutable profile URL and private RPCs. This example starts
with new admission suspended:

```json
{
  "port": 4175,
  "publicOrigin": "https://YOUR_DISTRIBUTION.cloudfront.net",
  "allowedBrowserOrigins": ["*"],
  "allowNativeRequests": true,
  "allowTransactions": true,
  "allowNewAdmissions": false,
  "requireInvitation": false,
  "profileUrl": "https://YOUR_DISTRIBUTION.cloudfront.net/releases/YOUR_REVISION/profile.json",
  "profilePath": "/srv/zka/public/profile.json",
  "profileSha256": "EXACT_PROFILE_SHA256",
  "bundleDescriptorPath": "/srv/zka/public/assets/bundle.json",
  "rpcUrl": "https://YOUR_PRIVATE_DEVNET_RPC",
  "indexerUrl": "http://127.0.0.1:18883",
  "controlUrl": "http://127.0.0.1:18887",
  "budget": {"kind": "operator-funded"}
}
```

Replace all placeholders; this is not a valid configuration as written.
`operator-funded` makes the operator responsible for provider charges without
a lifetime trial counter. For an existing finite authority, preserve its exact
[budget configuration](budget.md). Invitations, restricted browser
origins, history RPC and additional models are covered by the
[gateway manual](gateway.md).

Install [nginx.cloudfront.conf.example](../../../deploy/public-devnet/nginx.cloudfront.conf.example)
in nginx's included HTTP configuration directory, replacing the fixed upstream
Host with the exact viewer hostname. Start the gateway, validate the full nginx
configuration, then start nginx:

```sh
sudo systemctl start zka-gateway.service
sudo systemctl is-active zka-gateway.service
sudo nginx -t
sudo systemctl start nginx.service
sudo systemctl is-active nginx.service
curl --fail --silent --show-error http://127.0.0.1:8080/relay-status
```

If nginx was already running before the configuration change, run
`sudo systemctl reload nginx.service` after a successful `nginx -t`, then repeat
the port-8080 check. A successful syntax check alone does not load the new
listener. Its response must show your intended gateway configuration.

CloudFront must forward Authorization and the reviewed browser headers, disable
API/error caching, use one origin attempt and restrict private port8080 ingress
to its VPC-origin security group. Follow [hosting](hosting.md); do not
expose the database, signer, admin, control or indexer ports publicly.

## 7. Verify a usable deployment before admitting clients

From an independent machine, set your public origin and check:

```sh
ZKAPI_ORIGIN='https://YOUR_DISTRIBUTION.cloudfront.net'
curl --fail --silent --show-error "$ZKAPI_ORIGIN/relay-status"
curl --fail --silent --show-error "$ZKAPI_ORIGIN/provider-budget"
curl --fail --silent --show-error "$ZKAPI_ORIGIN/zkapi/v1/readiness"
curl --fail --silent --show-error "$ZKAPI_ORIGIN/zkapi/v1/catalog"
```

Require the intended admission policy, spending mode, ready service checks and
expected catalog. `/relay-status` is configuration only; `/provider-budget`
does not check provider credit. Check real account credit/permissions and
private challenger health separately.

Install the released consumer helper through the [clientd guide](../clientd.md),
substituting **your** profile URL/hash, and run its read-only `preflight`.
Every asset, manifest, chain, indexer and model check must pass. Test browser
CORS and expected route/method refusals separately. Configure encrypted backups
and verify [same-state restart](same-state-restart.md) before public use.

Once these checks pass, deliberately set `allowNewAdmissions: true` in the same
gateway configuration and restart only that gateway under your maintenance
procedure. For a newly approved funded acceptance, follow the clientd guide
through funding, one bounded inference, signed settlement, same-journal recovery
and withdrawal. An uncertain result must be recovered, never replayed. Earlier
consumed grants and completed acceptance cases do not authorize another run.

Publish the immutable profile URL/hash, supported model/API features, funding
instructions and incident contact alongside actual verification results. Review
[status](../../status.md) before claiming broader compatibility or availability.

## When a check fails

| Symptom | Next step |
|---|---|
| Bootstrap refuses occupied or partial state | Inspect retained marker/identities; do not reinitialize |
| Signer reconciliation or Pool pin mismatch | Suspend admission and reconcile original ledger, journal and deployment inputs |
| Indexer/challenger cannot catch up | Check archive-capable RPC, original start slot, disk and fee payer; retain history |
| Empty catalog or public readiness HTTP503 | Check PostgreSQL, signer, archive disk headroom and RPC before changing provider settings |
| Preflight hash mismatch | Check exact immutable publication inputs; preserve funded clients' original pins |
| Provider credit exhausted | Suspend new admission while keeping recovery available; do not reset old grants |
| Inference/transaction result unknown | Follow original-operation recovery and [incident handling](incidents.md) |
