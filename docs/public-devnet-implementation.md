# Public Devnet integration implementation

Recorded 2026-10-07 JST. This implements the independent-consumer backlog, starting
from source `eb9a5d1e384cee97a545e7482c0f3c223da0b2ac`. The existing immutable
`v0.2.0-devnet.1` release remains historical and unchanged. New APIs described
here are unreleased until a separately verified release publishes them.

## Ownership and selected scope

The repository maintainer owns integration code and release review. On
2026-10-08 JST the user approved the [lower-cost US East configuration](../deploy/public-devnet/aws-budget-host.md),
targeting roughly USD50/month, with an AWS-generated CloudFront HTTPS hostname.
The earlier seven-day/USD100 proposal is superseded. The user explicitly
excluded long-term operation qualification from this preview's current scope;
archive growth remains a documented limitation rather than a month-long launch
gate. Provisioning, current resource headroom and live acceptance must still be
verified. The user also approved seven additional USDC of maximum provider
exposure for one selected authority. No running private profile becomes a
public default by implication.

The first intended public acceptance is one explicitly configured Devnet Chat
path, consumed by an independent browser app. Direct OpenRouter Chat is a
candidate because separate historical JSON/SSE lifecycles exist; selecting a
model in a new profile is still an operator decision. The exact program, Pool,
setup, manifest, bundle, profile digest and released SDK digest must be frozen
together before that acceptance. No placeholder URL is a deployed service.

## Implementation contract

1. A versioned public profile authenticates the existing bundle by digest and
   supplies public RPC/indexer routes, explicit mode, exact models/tariffs and
   capability declarations. The bundle's existing manifest trust contract is
   authoritative for financial and cryptographic identities.
2. An independently installed profile digest is the initial trust anchor.
   Profile loading never trusts a digest obtained only from the profile server.
   Reopening a wallet retains its original profile digest, origin and custody
   namespace; a new default profile never migrates an unresolved note.
3. Read-only preflight validates assets, manifest, finalized genesis/Pool and
   shared snapshots without opening custody, asking for a signature, submitting
   AUTH or calling paid inference. Component errors are redacted. Passing
   preflight does not prove provider credit, successful inference or withdrawal.
4. A standalone consumer utility imports only compiled public package exports.
   It can run preflight and derive native runtime/allowlist files in a new local
   directory. Native `clientd setup` remains responsible for local tokens and
   custody setup. It does not copy provider/operator secrets.
5. Admission suspension preserves settlement and withdrawal routes. Public
   transport remains bounded to reviewed destinations, methods and transaction
   instructions; it is never an arbitrary destination proxy.
6. Artifact release review records an explicit decision for every file. Local
   packaging, public upload and downloadable proof acceptance are separate.

## Acceptance and external dependencies

Local verification covers authenticated-profile rejection, no-mutation
preflight, installed-export consumer tooling, native configuration generation
and transport admission/recovery policy. Existing SDK financial and journal
tests remain regression gates. Tests use local service/chain fixtures unless
their report explicitly says otherwise.

Public readiness still requires PD-01 hosted deployment and PD-02 complete
anonymous asset download/proof acceptance,
PD-05/06 actual provider and access/subsidy policy, then the PD-08 browser
lifecycle and PD-10 operator recovery exercise. PD-09 is required before
advertising native public-service readiness. PD-11 remains a separate expansion.

The existing campaign retains 17 reservations and 9,154,216 micro-USDC reserved
out of 10,000,000. Its 845,784 remaining capacity cannot admit another full
1,000,000-micro-USDC AUTH. The separately approved seven-USDC grant is implemented
as one [detached AWS authority](../deploy/public-devnet/detached-budget.md), with
no transferred old capacity. The [2026-10-08 initialization checkpoint](evidence/PD-detached-budget-initialization.md)
records the one selected grant initialized, zero new reservations, and all seven
slots remaining. New public admission was disabled and available admissions were
zero at that checkpoint; full consumer readiness remains incomplete. No unlimited
public subsidy is authorized. Historical reservations must never be reset or reused
for a new operation. This initialization and read-only API verification made no
paid requests or funding transactions.

The [backlog](public-devnet-readiness-backlog.md) remains the acceptance checklist;
its boxes close only with the actual evidence required there. Implementation of
a helper alone does not close public-service acceptance.

## Backlog disposition

| Backlog | Source implementation in this candidate | Required external completion |
|---|---|---|
| PD-01 | Standalone canonical API gateway, private upstream configuration, explicit admission/recovery controls and TLS template | Provision the approved AWS services; verify finalized program bytes and authorities; connect authenticated operational observations |
| PD-02 | Original-author MIT OR Apache-2.0 declaration verified; Apache-2.0 branch selected for the four exact files, with authenticated schema-2 notices and a per-file release gate | Publish and verify complete anonymous downloads and matching real proofs |
| PD-03 | Authenticated profile loader plus offline initial staging/public-origin authoring, preserved notices and strict deployment/setup/build joins | Publish a reviewed immutable profile for the actual chosen service and complete assets through an independent trust channel |
| PD-04 | Read-only bounded preflight; explicit CORS and canonical RPC/control/tree routes; recovery-aware browser adapter | Verify the deployed HTTPS origins, browser worker/WASM, direct-provider CORS and real wallet lifecycle |
| PD-05 | Streaming/tool restrictions enforced before financial admission, explicit direct mode/model/tariff profile | Select current supported combination; supply issuer access/credit; capture fresh issuance, inference, settlement and cleanup evidence |
| PD-06 | Funding instructions, integer denomination/cap explanation, approved seven-USDC detached authority initialized against exact public pins with zero reservations at the recorded checkpoint, durable reservation preservation and admission suspension | Enable admission only after readiness checks; verify invitations and abuse/rate policy for the actual service |
| PD-07 | Independent-package CLI, browser adapter and native file generator; bundled helper in a new native candidate | Publish the newly verified client artifacts and actual profile; complete clean-machine onboarding with public inputs |
| PD-08 | Fixture coverage for profile, preflight, custody continuity, admission restrictions and response lifecycle | Run the independent app against the selected public deployment with real browser/wallet/provider, recovery and withdrawal |
| PD-09 | Canonical native transport, scoped private invitation and bounded same-process completed-response settlement wait, preserving no-replay recovery | Complete the stock supervisor/public transport lifecycle against the chosen service |
| PD-10 | Local evidence record, publication gate and runbook references for persistent signer/database/challenger state | Operate live readiness sources; rehearse service recovery and publish scoped release/lifecycle receipts |
| PD-11 | No expanded platform/client or production compatibility claim | Separate implementation and acceptance after the initial public preview |

The operator template does not manufacture a healthy signer/provider result.
Public preflight reports which read-only checks were actually performed and
leaves operator admission unverified. A successful HTTP listener or local fixture
cannot substitute for the outstanding service observations above.

Local results and preserved failed attempts are recorded in
[the initial implementation evidence](evidence/PD-public-devnet-readiness.md) and
the [completed local follow-up](evidence/PD-public-devnet-followup.md). The latter
records actual independent-app changes, 377 SDK tests, six newly generated
native/WASM proofs, the complete local bundle and detached budget verification.

The original redistribution omission was an incomplete source investigation: the
original author’s pinned root README contains the license grant. See the
[redistribution correction](evidence/PD-02-redistribution-followup.md) and
[notice implementation](evidence/PD-02-notice-packaging.md). The old release’s
omitted assets remain historical; its immutable contents are not replaced.

Terminology correction: the initial evidence’s one installed native/WASM check
runs the real `snapshot_path` command and rejects path tampering. It does not
generate a Groth16 proof. [Matching complete-bundle proof generation](evidence/PD-complete-bundle-proofs.md)
has now passed separately; the earlier test/log bytes remain unchanged.
