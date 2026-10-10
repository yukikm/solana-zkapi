# Deploying a public Devnet operator

Use this guide to prepare a new Solana zkAPI operator. For an existing operator,
use [same-state maintenance](same-state-restart.md) and preserve its profile,
Pool, custody, financial ledger and journals. Client installation is documented
in [getting started](../clientd.md).

The public preview uses direct OpenRouter Chat, a private Linux host and a
bounded public API gateway. Read the [hosting guide](hosting.md) for AWS network,
cost and storage constraints, and [current status](../../status.md) for
verified deployment scope. A single-host preview has no automatic failover or
zero-loss storage guarantee. Off-host backups alone do not prove preservation
of every acknowledged reservation; the stronger synchronous-standby/last-ACK
witness design is documented in [operations](operations.md).

## Processes, routes and durable storage

Use a dedicated non-root service account and a read-only pinned application
checkout, for example `/opt/zkapi`. Keep private state under a short path such as
`/srv/zka` because Unix socket paths have a length bound. Public assets belong in
an entirely separate nginx-readable directory. No directory containing a seed,
management key, DSN, budget state, journal or private RPC URL is a web root.

| Component | Start target | Listener / network | State to preserve |
|---|---|---|---|
| CloudFront + S3 | Reviewed infrastructure template; default generated TLS domain | Public HTTPS 443; static OAC origin plus private VPC API origin | Distribution/bucket policy, immutable published files and version IDs |
| nginx | Private ingress adapted from `nginx.cloudfront.conf.example` | Private HTTP 8080, only from the CloudFront VPC-origin security group | Exact site config and fixed gateway Host |
| API gateway | `node scripts/public_devnet_gateway.ts --config /srv/zka/config/gateway.json` | `127.0.0.1:4175`; outbound fixed private RPC/control/indexer only | Exact profile/bundle copies, private config, admission digest, selected budget policy and any retained finite authority/snapshot |
| PostgreSQL | PostgreSQL 16 service | Private Unix socket; no public TCP listener | Data, WAL, system identifier and backup history |
| signer | `signerd --local-test --config /srv/zka/runtime/signer.json ...` | `/run/zkapi-signer/signer.sock` | Original independent sign-once journal, role seed/envelopes and exact signer config |
| control | `controld serve /srv/zka/runtime/control.json` | `127.0.0.1:18887` | Existing single-writer financial ledger and quote/receipt identity |
| provider dispatcher | Spawned through `providers.dispatcher` by control | No inbound listener; fixed OpenRouter management HTTPS egress | Hash-pinned binary/config, SELECT-only DB login, fsynced one-shot claims and management credential |
| indexer | `indexerd /srv/zka/indexer/config.json` | `127.0.0.1:18883`; archive-capable Devnet RPC HTTPS | Exact Pool initialization slot, public snapshot directory and deployment pins |
| challenger | `challengerd run /srv/zka/challenger/config.json` | No public listener; Unix read-only DB plus Devnet RPC HTTPS | Durable full archive, jobs, exact signed attempts, fee payer, health and alert spool |
| observer | Existing read-only status/collector integration | Operator-private only | Original counter baselines, recovery witnesses and retained redacted reports |

Use separate filesystem trees or volumes for PostgreSQL, the signer journal and
challenger/budget state. Separate volumes on one host improve recovery handling
but do not establish independent failure domains. The bootstrap paths are
`/srv/zka/postgres`, `/srv/zka/signer`, `/srv/zka/challenger`,
`/srv/zka/budget-seven`, `/srv/zka/runtime`, `/srv/zka/config` and `/srv/zka/public`. Owner-only private directories/files use
0700/0600. The public tree contains only reviewed descriptor/profile/artifacts.
Keep a recoverable off-host copy of the signer journal and acknowledged ledger
checkpoint/WAL, protected independently from the primary service account.

The EC2 security group accepts private nginx port 8080 only from the CloudFront
VPC-origin security group. Use the approved authenticated management path such
as SSM for administration; do not add a public SSH listener. Ports
4175/18883/18887, PostgreSQL and signer/admin sockets must not be exposed. Outbound HTTPS is needed
for two independently configured Devnet RPC origins, archive reads, OpenRouter
management and release downloads. The generated CloudFront certificate is
managed at the edge; the private HTTP origin has no user-managed public TLS key. Do not expose provider
management egress as a generic proxy. A process dispatcher on the same OS user is
not production credential isolation; separately enforced identities/namespaces
and fencing remain stronger deployment work.

## Build and start the services

Use the ordered [direct OpenRouter setup](direct-openrouter.md#2-build-and-install-the-server)
for the Linux build, installation, private bootstrap inventory and service
startup. It creates the actual paths listed above and installs the reviewed
[service units](service-units.md). The macOS client archive is not a Linux
server distribution. Record exact source, Node/Rust versions and executable
hashes for the selected Linux architecture.

For inference proxy mode, use [proxy operator setup](../proxy-operator.md).
Its local Devnet launcher retains its own private directory layout and is
separate from the public OpenRouter bootstrap. It supports prepared proxy
provider/tariff inputs; it is not a second startup recipe for an existing
`/srv/zka` operator.

Both paths preserve one financial ledger, original role keys and independent
signer journal, retained provider dispatch claims, finalized indexer state and
challenger work. The public bootstrap installs distinct database roles; the
local launcher has explicitly narrower isolation. Keep provider credentials
inside the dispatcher boundary, retain the exact tariff/model/cap bindings,
and verify signer reconciliation, chain catch-up and challenger readiness
before admitting funded clients. See [operations](operations.md) for stronger
process isolation, monitoring and restoration requirements.

## Pin and bootstrap a canonical public deployment

For a new installation, start with [fresh chain deployment](chain-deployment.md):
it gives source checkout, random setup, IDL/SBF/WASM build, program deployment,
Pool initialization and finalized verification commands. The public-origin
staging described below occurs before Pool initialization; finalized chain
verification is then required before server bootstrap.

Prefer a **new empty Pool using a verified compatible existing Devnet program
and setup**, if the existing build permits the chosen initializer and the exact
role keys/proving material are available to the operator. This avoids changing
a funded Pool or paying program deployment rent again. If a new setup is needed
or no matching private role custody is available, a new program/build and Pool
are required instead. This is a technical compatibility
check, not permission to reuse or publish somebody else's signing material.

Before server bootstrap, required inputs include finalized deployed ELF/ProgramData
bytes and upgrade authority, compiler IDL, matching OS-random setup/profile,
program and initializer pins, Circle Devnet USDC mint/token program, Pool
initialization receipt, cap, note TTL, challenge duration and treasury owner.
Offline staging uses the planned deployment and build before initialization.
Use the existing finalized
program/Pool validators and exact signed-transaction journal. Do not select the
historical 60-second challenge period merely because a local demo used it; choose
a window supported by measured catch-up/restart/challenge behavior, and keep the
service/recovery path available for the resulting withdrawal window.

`scripts/prepare_public_devnet_deployment.ts` provides an offline,
new-output-only canonical-origin emitter. Its input must be a declared
**pre-deployment staging profile**, not a released/funded Pool or a copied active
backend. It authenticates the source bundle, setup, deployment record and staging
declaration by independent SHA-256 pins; checks the source manifest signature
against the existing owner-only authority key; preserves every financial,
program, Pool, role, tariff and build field; and changes only control/inference
origins and proving-key base URL. Both the new signature and complete consumer
profile pass the existing SDK validators. It does not generate any key.

For initial staging, `--stage` creates the signed source manifest/bundle and
staging declaration from the independently pinned fresh setup, deployment record,
compiled build, IDL/ELF and WASM. It uses `publicDevnetManifestBase`, `vaultBinding`,
`manifestDigest`, the existing Ed25519 signer and SDK verification; it does not
invoke the historical transaction launcher. Run with an owner-private config:

```sh
node scripts/prepare_public_devnet_deployment.ts --stage /private/initial-public-config.json /private/new-staging-root
```

The initial config uses `schema: 1`,
`noDeploymentOrFundingOrServiceState: true`, `distributionDecisionPath`,
`distributionDecisionSha256`, `noticesDirectory`, `publicSetupDirectory`,
`publicSetupSha256`, `deploymentPath`, `deploymentSha256`, `buildManifestPath`,
`buildManifestSha256`, `idlPath`, `programPath`, `wasmPath`, `wasmSha256`,
`expected: {deploymentId, programId, pool}`, `manifestAuthorityKeyPath`, and the
same public URL, private indexer and `consumer` fields in the table below. Paths
are explicit; use absolute paths in deployment inputs. IDL/ELF hashes must match
the independently pinned build, and the build's role keys/profile, initializer,
program, mint and token program must match the separately pinned setup/deployment.
The Pool address must derive from the exact staging seed and program. The
manifest-authority input is read only; no transaction wallet is discovered/read.

If the fresh program has already been deployed but its Pool has not been
initialized, omit `noDeploymentOrFundingOrServiceState` and explicitly select
`initialState: "program_deployed_pool_uninitialized"`,
`noPoolFundingOrServiceState: true`, and
`finalizedProgramVerification: {path, sha256}`. The independently retained
read-only observation must join finalized genesis, program/ProgramData address,
ELF bytes, upgrade authority and absent Pool at a recorded slot. The emitter
checks those joins and rejects mixed provenance modes, existing Pool evidence
and budget/service-state inputs. The pinned observation is operator evidence,
not a cryptographic proof of RPC finality or current absence. The output remains
`chainCompatible: false`; verify the actual initialization receipt and finalized
Pool before bootstrap. Both modes refuse existing output directories and never
initialize financial state or transfer old budget capacity.

The pinned distribution decision is
[`upstream-setup-distribution.json`](../../../deploy/public-devnet/upstream-setup-distribution.json); keep its
reviewed hash separate from the config. The supplied notices directory must
contain the exact five files bound by that record. The emitter checks each
approved request/withdrawal setup hash and size against the actual setup, and
every notice byte hash and size. All five notices are mandatory in the schema-2
source and final bundle; mutation or a core filename collision fails closed.

Supply source-specific project/dependency notices through optional
`additionalNotices: {"public-name.txt": {"path": "/reviewed/source-notice.txt",
"sha256": "<reviewed-exact-file-digest>", "bytes": 123}}`. Each input needs an
exact independently reviewed size/hash; an older binary's notices do not
implicitly cover a new binary. All verified extra bytes are retained in both
source and final bundles. Mandatory notices cannot be replaced, and case-fold
filename collisions, core names, symlinks, more than 32 total notices, more than
1 MiB per notice or 4 MiB total fail before creating output. The staging report
records all emitted notice hashes.

For the selected AWS OAC path, use
`https://<generated-name>.cloudfront.net/releases/<revision>/profile.json` and
`https://<generated-name>.cloudfront.net/releases/<revision>/assets/`. Replace the
angle-bracket values with actual distribution/revision inputs before signing.

The complete canonical result is in `<new-staging-root>/prepared`. The parent
retains source public inputs, the signed source bundle and staging provenance,
plus an owner-private preparation config. Preserve all of them. This mode was
verified with synthetic offline staging fixtures; it does not deploy or initialize
the new Pool.

For an already authored, independently pinned **fresh staging** bundle, the
origin-only mode remains available with a new destination:

```sh
node scripts/prepare_public_devnet_deployment.ts /private/staging-public-config.json /private/new-public-output
```

The exact `schema: 1` configuration fields are:

| Field | Required input |
|---|---|
| `sourceBundlePath`, `sourceBundleSha256` | Complete offline source bundle descriptor and authenticated digest |
| `sourceDeploymentPath`, `sourceDeploymentSha256` | New staging `deployment.json` and authenticated digest |
| `publicSetupDirectory`, `publicSetupSha256` | Existing reviewed OS-random setup directory and exact `public-profile.json` hash |
| `stagingDeclarationPath`, `stagingDeclarationSha256` | Exact declaration below and independently retained digest |
| `expected` | Exact `deploymentId`, `programId`, `pool`, `manifestHash` from the new signed staging manifest |
| `manifestAuthorityKeyPath` | Existing 0600 owner-only Ed25519 byte-array file matching the source manifest authority; read only |
| `publicOrigin` | The actual generated CloudFront HTTPS origin, without a trailing slash |
| `assetsBaseUrl`, `profileUrl` | Immutable HTTPS asset directory ending in `/` and versioned profile URL outside that directory |
| `privateRpcUrl` | Private HTTPS archive RPC URL; written only to the private indexer config |
| `indexerListen`, `snapshotsDirectory`, `startSlot` | Explicit loopback listener, absolute snapshot path and reviewed replay slot; verify the finalized initialization slot before bootstrap |
| `consumer` | `id`, `revision`, one exact existing OpenRouter Chat `model` with authenticated tariff, and boolean `streaming` / `tools` |

The staging declaration has exactly `schema: 1`,
`kind: "public_devnet_predeployment"`, `expected` matching the configuration,
`sourceBundleSha256`, `sourceDeploymentSha256`, `publicSetupSha256`, and
`noDeploymentOrFundingOrServiceState: true`. That operator assertion is provenance,
not cryptographic proof that no funds or financial state exist. The emitter is
never a funded migration or a way to create a second writer for an existing Pool.
Its report deliberately retains `chainCompatible: false`: independently compare
finalized program/Pool/build, initialization slot and existing-state absence
before starting the new financial services.

The output includes `public-manifest.json`, `trust.json`, `deployment.json`,
`build-manifest.json`, compiler IDL/ELF, complete `assets/`, `consumer-profile.json`,
`public-assets-config.json`, `private-indexer.json` and a redacted provenance
report. The root directory is 0700. Publish only the reviewed assets directory
and consumer profile; never publish the entire output. Retain the original
private role custody separately and pass the new manifest/build/deployment
objects to the existing backend/challenger preparation; this emitter does not
create database roles, daemon state, provider credentials or a budget.

The historical `run_i10_devnet_vault.ts --configure` is not an offline staging
author: it calls RPC, checks deployed ProgramData and reads an initialization
receipt before writing its local origins. Use the new `--stage` path for initial
offline authorship, not a funded historical bundle. Final chain compatibility
still requires the actual deployed/finalized program and Pool checks.

The complete asset packager already runs as:

```sh
node scripts/package_sdk_distribution_assets.mjs /private/public-assets-config.json /srv/zka/public/releases/REVISION
```

It authenticates the existing manifest/trust/artifact format and refuses an
existing output directory. All request/withdrawal/tree keys, IDL, source bundle,
verifier constants, extra build artifacts and exact WASM must be present. A
compiled SDK or native archive alone does not satisfy this dependency. The four unchanged upstream setup-file decisions are recorded in
[`upstream-setup-distribution.json`](../../../deploy/public-devnet/upstream-setup-distribution.json), with the
source evidence in [PD-02-redistribution-followup.md](https://github.com/yukikm/solana-zkapi/blob/ea4cb0ac005832abae6e703eb177914c0c9aa193/docs/evidence/PD-02-redistribution-followup.md).
Include their five exact authenticated notices and review the remaining bundle
components before exposing the complete public asset tree. Publish all exact file sizes/digests and setup limitations, then
verify anonymous downloads through real TLS and the independent installed SDK.

## Start services and verify the deployment

1. Install a pinned Linux server build, private configuration and reviewed
   [systemd units](service-units.md). Prepare storage and separate database
   roles without replacing any existing financial state.
2. Verify the finalized program, Pool, setup, authorities and initialization
   receipt against the signed deployment inputs. Start PostgreSQL, signer and
   indexer; require signer reconciliation and complete finalized catch-up.
3. Start control and challenger. Start the gateway with
   `allowTransactions: true` and `allowNewAdmissions: false`. Configure the
   explicit [budget policy](budget.md) and browser/native access in
   [the gateway guide](gateway.md).
4. Verify immutable profile/asset downloads, installed SDK preflight, CORS,
   route/method refusal, authorization forwarding and service readiness. Check
   provider permissions/credit and private challenger health independently.
   `/relay-status` alone is a configuration report.
5. Verify encrypted off-host backups and [same-state restart](same-state-restart.md).
   Measure memory, free disk, archive growth, CPU credits and chain lag before
   enabling admission. Keep recovery available during admission suspension.
6. Record separately authorized funded lifecycle results with exact signed
   settlement, same-journal recovery and withdrawal. Publish only supported
   combinations in [status](../../status.md); local fixtures do not establish
   public browser or provider acceptance.

Publish immutable profile/bundle/release hashes and an availability, incident
and retirement policy. Keep the original recovery route for funded notes.
On an outage, retain unknown operations and provider management references for
the existing disable/final-usage/settlement path. A restart or HTTP health check
never authorizes inference replay or replacement financial state.
