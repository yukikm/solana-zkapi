# Minimal public Devnet preview launch plan

**Historical proposal, superseded for the current deployment (2026-10-08 JST).**
The 16 GiB operator and managed NAT gateway sizing below is retained as the
original design. The user selected the roughly USD50/month
[US East budget configuration](aws-budget-host.md): a 4 GiB `t3a.medium` operator,
separate `t3a.nano` HTTPS NAT instance, and 48 GiB total encrypted gp3 storage.
The [actual infrastructure record](../../docs/evidence/PD-aws-live-infrastructure.md)
and [current public-input guide](../../docs/sdk/public-devnet-preview.md) describe
the deployed resources and publication checkpoint. Operator catch-up and funded
acceptance remain in progress. Long-term capacity qualification is excluded
from the current scope; the smaller allocation is not a sustained-capacity claim.

Recorded: 2026-10-07 JST. This is a deployment design from a read-only source
inspection, not a deployed service, a purchase, a new budget, or live acceptance.
It does not change the frozen candidate, prior profiles, running local services,
signer journals, reservations or evidence.

## Recommended first deployment

Run an invitation-only, single-model **direct OpenRouter Chat** preview on one
persistent Linux VM in one availability zone. Use the new public API gateway and
independent client application. Keep the API, control, indexer and signer on the
same host so the implemented loopback/Unix-socket boundaries remain valid. Users'
prompts go directly to OpenRouter. There is no hosted inference proxy to build
for this initial path.

The user selected an **AWS-generated CloudFront HTTPS hostname**. No owned
domain, Route 53 zone or custom ACM certificate is required for the viewer URL.
Use one distribution for API, profile and immutable public assets. Its existing gateway API routes are `/zkapi/v1/*`, `/rpc`, `/relay-status`
and `/provider-budget`. Route `/releases/<revision>/profile.json` and `/releases/<revision>/assets/*` to a private S3
bucket through CloudFront origin access control; the gateway does not serve
these paths. Route API requests through a CloudFront VPC origin to nginx on the
private EC2 host. Keep the host without a public IP. A single-AZ NAT gateway
provides outbound RPC/provider/package access; the VPC also needs the CloudFront
VPC-origin prerequisites described in the infrastructure template. The profile's control/indexer origin must equal that HTTPS
origin, and its RPC URL must be that origin plus `/rpc`. The independently hosted
chat app's exact HTTPS origin goes in the gateway's browser allowlist. Public
asset responses use public GET/HEAD CORS without credentials; the gateway API
retains its explicit browser-origin allowlist. The generated
CloudFront hostname must be known before signing final canonical profile bytes.
Keep its API behavior uncached (including errors), pass the reviewed Origin,
Authorization, content-type, browser fetch-metadata and invitation headers, and
set origin connection attempts to one. The gateway still validates methods,
headers and exact signed operations. Do not log invitation or bearer headers.
The private nginx origin sets the exact generated viewer hostname on its gateway
upstream; it does not trust an arbitrary forwarded host header. Publish the
exact profile digest through the authenticated release channel.

Suggested initial VM size is **4 vCPU, 16 GiB RAM, 100 GiB encrypted persistent
storage**, with at least 20 GiB free before enabling new admission. These are
conservative starting allocations, not measured capacity or a promise of
supported concurrency. Cap the invitation pool and run one deliberate inference
at a time during launch acceptance. Measure indexer catch-up, challenger queue,
proof memory, disk growth and TLS response sizes on the chosen machine before
raising traffic. A fresh Pool limits the history replay cost.

Single-host operation is a Devnet limitation: no automatic failover, production
availability, zero-RPO or independent fault-domain claim. A normal process/VM
restart with the same intact durable volumes must be tested. If acknowledged
ledger/signer state is lost or rolled back, suspend new admission and follow
reconciliation; never initialize replacement state. An off-host backup is
necessary, but a periodic backup alone cannot prove that every acknowledged
reservation is present. Guaranteed preservation across storage loss requires the
existing reviewed synchronous-standby/last-ACK witness design and another
independent durable store; it is a larger deployment than this minimal preview.

## Processes, routes and durable storage

Use a dedicated non-root service account and a read-only pinned application
checkout, for example `/opt/zkapi`. Keep private state under a short path such as
`/srv/zka` because Unix socket paths have a length bound. Public assets belong in
an entirely separate nginx-readable directory. No directory containing a seed,
management key, DSN, budget state, journal or private RPC URL is a web root.

| Component | Start target | Listener / network | State to preserve |
|---|---|---|---|
| CloudFront + S3 | Reviewed infrastructure template; default generated TLS domain | Public HTTPS 443; static OAC origin plus private VPC API origin | Distribution/bucket policy, immutable published files and version IDs |
| nginx | Private ingress adapted from `nginx.same-origin.conf.example` | Private HTTP 8080, only from the CloudFront VPC-origin security group | Exact site config and fixed gateway Host |
| API gateway | `node scripts/public_devnet_gateway.ts --config /srv/zka/config/gateway.json` | `127.0.0.1:4175`; outbound fixed private RPC/control/indexer only | Exact profile/bundle copies, private config, admission digest, new seven-cap authority and read-only historical snapshot |
| PostgreSQL | PostgreSQL 16 service | Private Unix socket; no public TCP listener | Data, WAL, system identifier and backup history |
| signer | `signerd --local-test ...` | Private Unix socket only | Original independent sign-once journal, role seed/envelopes and exact signer config |
| control | `controld serve /srv/zka/config/control.json` | `127.0.0.1:18887` | Existing single-writer financial ledger and quote/receipt identity |
| provider dispatcher | Spawned through `providers.dispatcher` by control | No inbound listener; fixed OpenRouter management HTTPS egress | Hash-pinned binary/config, SELECT-only DB login, fsynced one-shot claims and management credential |
| indexer | `indexerd /srv/zka/config/indexer.json` | `127.0.0.1:18883`; archive-capable Devnet RPC HTTPS | Exact Pool initialization slot, public snapshot directory and deployment pins |
| challenger | `challengerd run /srv/zka/challenger/config.json` | No public listener; Unix read-only DB plus Devnet RPC HTTPS | Durable full archive, jobs, exact signed attempts, fee payer, health and alert spool |
| observer | Existing read-only status/collector integration | Operator-private only | Original counter baselines, recovery witnesses and retained redacted reports |

Use separate filesystem trees or volumes for PostgreSQL, the signer journal and
challenger/budget state. Separate volumes on one host improve recovery handling
but do not establish independent failure domains. Suggested paths are
`/srv/zka/db`, `/srv/zka/signer`, `/srv/zka/challenger`, `/srv/zka/budget`,
`/srv/zka/config` and `/srv/zka/public`. Owner-only private directories/files use
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

## Reuse the existing executable components

Build server binaries on the chosen Linux architecture from the exact reviewed
source, with Rust 1.90.0 and Node 24.19.0. PostgreSQL 16 is the existing CI target.
The macOS ARM64 consumer archive is not a Linux server distribution. Build and
record Linux binary hashes; do not relabel macOS verification as Linux evidence.
The native client candidate additionally uses the repository-pinned Go toolchain.

From the pinned source checkout, the existing build/start commands are:

```sh
cargo build --release --locked --manifest-path services/control/Cargo.toml --bins
cargo build --release --locked --manifest-path services/indexer/Cargo.toml --bin indexerd
cargo build --release --locked --manifest-path services/challenger/Cargo.toml --bin challengerd
npm ci
npm run build:sdk
```

The existing control runbook provides concrete migration-owner, runtime-writer,
signer-reader and provider-reader roles. For a public host, configure those
separate logins and run the daemons directly. The control implementation accepts
the explicit Devnet overlay with public HTTPS manifest pins while retaining a
loopback HTTP listener and Unix PostgreSQL transport.

In an operator-controlled shell whose environment contains only the reviewed
private DSN files/values, the initial daemon order is:

```sh
# One-time bootstrap on a genuinely new deployment only:
ZKAPI_DATABASE_URL="$ZKAPI_MIGRATION_DATABASE_URL" services/control/target/release/controld migrate
services/control/target/release/controld signer-config /srv/zka/config/control.json
ZKAPI_DATABASE_URL="$ZKAPI_WRITER_DATABASE_URL" services/control/target/release/controld provision /srv/zka/config/control.json

# Save the validated signer-config output in its owner-only signer config file.
# Initialize a journal exactly once; this command refuses an existing path.
services/control/target/release/signerd --local-test --config /srv/zka/config/signer.json --journal /srv/zka/signer/signer.journal --initialize-journal

# Long-running services are supervised with these same commands/identities.
services/indexer/target/release/indexerd /srv/zka/config/indexer.json
ZKAPI_SIGNER_DATABASE_URL="$ZKAPI_SIGNER_DATABASE_URL" services/control/target/release/signerd --local-test --config /srv/zka/config/signer.json --journal /srv/zka/signer/signer.journal --socket /srv/zka/signer/signer.sock --state-seed-file /srv/zka/signer/state.seed --clearance-seed-file /srv/zka/signer/clearance.seed
ZKAPI_DATABASE_URL="$ZKAPI_WRITER_DATABASE_URL" services/control/target/release/controld serve /srv/zka/config/control.json
services/challenger/target/release/challengerd run /srv/zka/challenger/config.json
node scripts/public_devnet_gateway.ts --config /srv/zka/config/gateway.json
```

These are separate supervised processes, not a shell script to paste and run
sequentially. The long-running commands block. The DSN variable names describe
private deployment inputs; this plan supplies none. Use protected environment
files or equivalent service-manager credentials rather than secrets in command
arguments. The signer seed flags can be replaced with the existing pinned KMS
envelope helper only after that helper is configured and verified. Neither route
permits replacing the original journal.

Before direct daemon startup, validate `providers.dispatcher` and its pinned
`dispatcherd` configuration, with `local_test_only: false` plus the explicit
Devnet deployment/manifest object. Its owner-only OpenRouter management credential
must have actual issuance permissions and credit. The control-side provider
entries must not point at usable credentials. Keep direct provider tariff
`provider_reported_usd`, model `*`, integer cap 1,000,000 micro-USDC, and the exact
hash pinned in the manifest. The public model list selects the supported Chat
model and advertised streaming/tools subset separately.

`run_i10_devnet_backend.py` already has runnable `prepare`, `check-local` and
`serve` modes, persistent identity checks, signer reconciliation, Unix-only
PostgreSQL and dispatcher preparation. It is useful to validate a new isolated
setup. It is not the final public service unit: it uses one local test DB role
for control/signer and starts/manages its own cluster. Do not deploy that default
role arrangement as a least-privilege claim.

`run_i10_devnet_challenger.py prepare` can create and validate the separate
read-only DB role/config and initial journal after the backend exists. Its
`scan` mode prewarms the archive without signing/sending. Its `serve` wrapper is
bounded to at most 3,600 seconds; a persistent operator runs the underlying
`challengerd run` under the supervisor, retaining the same configuration/journal.
Do not schedule fresh wrapper state once an hour. Alert if the live health file
is missing/stale, the scan has not caught up or an unresolved challenge approaches
its deadline.

## Pin and bootstrap a canonical public deployment

Prefer a **new empty Pool using a verified compatible existing Devnet program
and setup**, if the existing build permits the chosen initializer and the exact
role keys/proving material are available to the operator. This avoids changing
a funded Pool or paying program deployment rent again. If a new setup is needed
or no matching private role custody is available, a new program/build and Pool
are required instead. This is a technical compatibility
check, not permission to reuse or publish somebody else's signing material.

Required inputs are the finalized deployed ELF/ProgramData bytes and upgrade
authority, compiler IDL, matching OS-random setup/profile, program and initializer
pins, Circle Devnet USDC mint/token program, Pool initialization receipt, cap,
note TTL, challenge duration and treasury owner. Use the existing finalized
program/Pool validators and exact signed-transaction journal. Do not select the
historical 60-second challenge period merely because a local demo used it; choose
a window supported by measured catch-up/restart/challenge behavior, and keep the
service/recovery path available for the resulting withdrawal window.

`scripts/prepare_public_devnet_deployment.ts` now provides a separate offline,
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
[`upstream-setup-distribution.json`](upstream-setup-distribution.json); keep its
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
compiled SDK or native archive alone does not satisfy this dependency. The four unchanged upstream setup-file decisions are now recorded in
[`upstream-setup-distribution.json`](upstream-setup-distribution.json), with the
source evidence in [PD-02-redistribution-followup.md](../../docs/evidence/PD-02-redistribution-followup.md).
Include their five exact authenticated notices and review the remaining bundle
components before exposing the complete public asset tree. Publish all exact file sizes/digests and setup limitations, then
verify anonymous downloads through real TLS and the independent installed SDK.

The gateway, installer, invited browser adapter and native admission integration
are implemented in the new candidate. The native token integration is
`admission: {origin, token_file}` and injects the canonical token only on exact
control AUTH POSTs; the immutable older release does not have it. Neither the
candidate nor a local TLS fixture establishes the public PD-08/09 lifecycle.

## Budget, invitation and launch sequence

The user approved seven additional USDC for the seven-case acceptance matrix.
Use [detached-budget.md](detached-budget.md) for one new AWS seven-cap authority,
linked to a root-owned, read-only historical snapshot exported under the original
lock immediately before final deployment review. This transfers zero original
capacity and leaves the local services/ledger/recovery paths intact. Public
status reports only the active seven-cap grant and labels history as a snapshot.
No actual export or grant was created by implementation or fixture tests.
The earlier [V1 local-lock option](supplemental-budget.md) remains implemented,
but the same approval must initialize only one selected authority, never both.

The old campaign remains at 17 immutable reservations totaling 9,154,216
micro-USDC, leaving 845,784. The current full-cap direct path cannot admit a new
1,000,000-micro-USDC authorization from it. Never clone/reset this ledger to make
capacity appear available. The new seven-USDC authorization is received;
hosting expenditure remains separate. Final deployment pins, a unique grant UUID,
snapshot anchors and the new host/volume authority are recorded before explicit
initialization. The gateway never initializes a budget during startup. Only the
new seven slots count as AWS admission capacity; historical AUTH recovery cannot
route through that grant. This is a bounded acceptance grant, not unlimited
preview funding or automatic additional capacity after exhaustion. Local lock
and inode checks do not prove distributed uniqueness or safe stale-backup
promotion; retain one selected writer and reconcile restores explicitly.

Start the gateway with `allowTransactions: true`, `allowNewAdmissions: false`.
This keeps settlement/recovery paths available while refusing fresh provider
reservations and deposit initiation. Once profile/assets/chain/indexer/control
checks pass, configure the owner-private SHA-256 of a newly generated canonical
43-character invitation token. Distribute the token only to selected testers;
neither it nor the digest belongs in public profile/assets or logs. A missing or
invalid token permits only an exactly matching previously reserved AUTH through
the locked immutable budget; it cannot reserve a new full cap or send a new AUTH
to control. The invitation is stripped before upstream forwarding.

Launch in this order:

1. Prepare the reviewed CloudFront/S3/private-EC2/NAT infrastructure and retain its
   generated HTTPS hostname. Prepare a new staging deployment/config directory
   and candidate server installation; verify hashes and versions offline, then
   emit the canonical origin/profile for that exact generated hostname.
2. Initialize the new Pool only after reviewing its exact signed transaction,
   authority, setup, rent/fee bounds and retention window. Save finalized receipts.
3. Provision private persistence and roles. Start indexer, signer/control and
   challenger. Complete read-only archive catch-up and signer reconciliation.
4. Enable the generated CloudFront TLS endpoint and exact API/static origin
   rules with admission suspended.
   Exercise the installed independent SDK preflight from an allowed app origin;
   test invalid origins, missing/altered assets, unavailable indexer/control and
   token refusal. Confirm no private URL/key/journal enters static files/logs.
5. Verify the operator's actual management permissions and account credit in a
   separately bounded manner; configure the matching tariff/model/cap and new
   explicitly approved supplemental grant. Resolve the local-authority deployment
   boundary before enabling admission for the invited acceptance scope.
6. Deliberately run the independent browser note lifecycle: correct funding,
   deposit, two conversation turns, advertised streaming, signed settlement,
   interruption/reload recovery and withdrawal. Retain exact failures and count
   intentional inference sends separately from control/recovery attempts.
7. Rehearse same-state service restart, indexer catch-up and emergency
   escape/challenge/finalize before claiming recoverable public service. Run the
   separate native candidate lifecycle before advertising native readiness.
8. Publish immutable profile/bundle/release pins, anonymous-download evidence,
   supported feature matrix and an operator contact/availability/retirement
   notice. Keep the old deployment's recovery route for existing notes.

On restart, start the same database and signer journal before admitting new
work; a stale socket is not proof that an old process is dead. Do not add an
`ExecStartPre` that deletes journals, claims or a signer socket unconditionally.
On outages, retain `allowTransactions: true` where applicable and suspend new
admission. Preserve unknown attempts and provider management references for the
existing disable/final-usage/settlement path. Never resend inference or infer
success from HTTP health alone.

## Remaining implementation versus operator choices

| Item | Existing implementation | Remaining launch work |
|---|---|---|
| API/CORS/invitation/native routing | Candidate bounded gateway and consumers | Actual public TLS/browser/native acceptance |
| Public manifest generation | New-only offline canonical-origin emitter with authenticated source and signed output, plus initial staging authorship and 11 passing fixture tests | Finalized chain comparison of the new deployment; no existing Pool migration |
| Services and durable recovery | Executable control, signer, dispatch, indexer, challenger and operations tools | Linux build, reviewed unit/config files, roles/permissions, state-preserving restart drill |
| Supervision | Signals and same-state restart guards exist | Concrete service-manager units and failure alert wiring; no automatic reset/takeover |
| Public readiness | SDK preflight and configuration-only `/relay-status` | Private live signer/challenger/provider observations plus a truthful published readiness/status policy |
| Proof assets | Offline authenticated packager/loader, exact four-file redistribution decision and mandatory five-notice propagation | Complete-bundle publication review, public files and anonymous download/proof acceptance |
| Provider usage | Direct OpenRouter lifecycle adapters and older live results | Current operator permission/credit, explicit new budget and fresh candidate lifecycle |
| Recovery capacity | Same-state journals, witnesses and restore validation | Tested single-host boundaries; independent synchronous storage if zero-loss recovery is required |

Only these choices require the operator/user's input if they cannot be resolved
from already authorized resources: **the reviewed AWS spending limit; the new
provider-spend cap and invitation recipients; and who owns service availability/incident
handling.** The four unchanged upstream setup-file redistribution decisions have
been recorded; complete-bundle publication checks are implementation work. The user already selected an AWS-generated HTTPS hostname,
so an owned domain or domain purchase is not a pending requirement. Program/Pool/profile
selection, exact ports, directory layout, route generation and validation are
implementation decisions to resolve from evidence. Do not send the user a list
of cryptographic constants to invent.
