# Public Devnet readiness backlog

Original handoff: 2026-10-07 JST. Status updated: 2026-10-08 JST.
**The public profile, complete proof assets, SDK/native archives and independent
chat app are hosted and verified; public service readiness is blocked by the
configured RPC's monthly quota, and funded lifecycle acceptance remains
unfinished.** The original document below records the
separate-session request after an independent chat application could install
the SDK but could not complete a public-input-only integration. Subsequent
deployment and verification evidence is linked here; historical checkpoints
retain their original scope.

Implementation follow-up: [design and implementation record](public-devnet-implementation.md).
That follow-up adds profile/preflight/onboarding and transport/release guards.
The [current public inputs](sdk/public-devnet-preview.md),
[asset publication and proof checks](evidence/PD-public-assets.md), and
[English app publication](evidence/PD-zkchat-english-publication.md) now establish
their separately recorded scopes. Completed distribution, profile, preflight and
policy checks are marked below with their evidence. Local fixtures do not close
the separately required funded lifecycle acceptance.

Latest follow-up: [independent app, complete proof bundle and deployment preparation](evidence/PD-public-devnet-followup.md).
The four-file redistribution question is resolved. AWS-generated HTTPS is
selected and seven additional USDC of provider exposure are approved. The user
approved proceeding with the roughly USD50/month
[US East configuration](../deploy/public-devnet/aws-budget-host.md) on 2026-10-08 JST.
This supersedes the previous seven-day/USD100 proposal. The user excluded
long-term qualification from the current scope; current deployment headroom and
live lifecycle acceptance still require verification. The actual `zkchat` app
is updated and published. Earlier public preflight and unfunded browser/native
initialization passed in their recorded scopes. The
[current RPC checkpoint](evidence/PD-public-rpc-quota-blocker.md) confirms an
actual monthly-quota response from the configured endpoint; a bounded official
free Devnet fallback also returned HTTP 429 before completing its sample.
The [shared archive follower](evidence/PD-shared-archive-indexer-host.md) preserves
the original history, but current root/snapshot endpoints are unavailable and
control remains stopped. New admission remains suspended; funded browser,
native/provider and recovery acceptance remain unfinished. No history is skipped
and no RPC replacement or paid upgrade is established by these observations.
The [detached authority checkpoint](evidence/PD-detached-budget-initialization.md)
records the approved seven-cap grant initialized with zero reservations, without
transferring or reclaiming the original ledger's capacity.

## Objective and scope

An independent application maintainer should be able to start from public
documentation and immutable release assets, select a supported Devnet deployment,
and complete funding -> real chat -> verified settlement -> recovery -> withdrawal
without access to the operator's checkout, private configuration or signing keys.
Application users should choose a wallet and fund it; they should not assemble
cryptographic deployment pins.

Deliver a usable, explicitly scoped **public Devnet preview** first. This backlog
extends the external-integration work under I10 and the relevant distribution
work under I11; it does not replace the existing
[implementation plan](implementation-plan.md), accept G1-G4, or authorize I12
mainnet deployment. Reuse the existing SDK, services, prover, trust validation
and financial state machine. A new protocol implementation is not the goal.

At the original documentation-only handoff, the user intended design and
implementation to continue in another session. That handoff changed no services,
deployments, funded profiles, manifests, circuits, credentials, budgets or runtime
code. The subsequent implementation and deployment records above are separate.

## Original baseline and evidence

| Item | Baseline / observed boundary |
|---|---|
| Reviewed local source | `eb9a5d1e384cee97a545e7482c0f3c223da0b2ac`; working branch `work` |
| Public SDK | `v0.2.0-devnet.1`, source `088ca40bf5886738f87b4db97205db8bff752356`, Solana Kit 8.4.0 |
| SDK tarball SHA-256 | `e6ff141b1c13c278f1c6d80dbe1397f187290270c583a32545df5fe4fbd45019` |
| Published assets | Compiled SDK, macOS ARM64 clientd, release manifest and checksums; publication/attestation evidence already exists |
| Explicit release exclusions | Default public operator, complete proving bundle and new Kit funded-provider acceptance |
| Independent consumer observation | The separate `zkchat` app installed this SDK and built its integration, but had no configured public deployment bundle/operator; its UI and adapter tests did not perform real proof generation, funding or inference |
| Existing upstream live evidence | Selected Devnet deployments, deposits, direct/proxy OpenRouter use, signed settlements, mutual withdrawal and escape/challenge have already succeeded in separately scoped historical cases |
| Remaining distinction | Historical success with configured operator profiles/custom relays does not provide a currently available, documented default operator or establish live acceptance of the published Kit package |

Sources: [Kit release scope](releases/kit-preview.md),
[publication evidence](evidence/I10-kit-publication.json),
[SDK status](sdk/status.md),
[external integration evidence](evidence/I10-external-integration.md),
[direct-provider parity evidence](evidence/I10-parity-review.md),
[deployment inputs](sdk/deployment.md), and
[distribution contract](../packages/sdk/DISTRIBUTION.md).
The independent app's report is `zkchat/docs/INTEGRATION-REPORT.md` in its separate
workspace; this backlog repeats its relevant observation so that workspace is
not required to understand the tasks.

**Do not describe this gap as "Solana Devnet cannot be used" or "no real provider
test exists."** The missing outcome is an externally consumable deployment and
a reproducible lifecycle through its published client path. Existing code,
packaging helpers and successful historical tests must be reused and credited.

## Ethereum comparison: what the public product supplies

At Ethereum source
[`045b444ea1b52538d1b40273c7cb6ed09468a052`](https://github.com/ethereum/zkapi/tree/045b444ea1b52538d1b40273c7cb6ed09468a052),
the [browser SDK documentation](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/sdk/README.md)
describes packaged Mainnet/Sepolia profiles, Vault and signing-key pins, WASM,
proving keys, and a build helper. The
[local daemon](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/zkapi-clientd/README.md)
provides an OpenAI-compatible API without an end-user OpenRouter management key.

Read-only requests in the preceding comparison obtained both public
configuration files and healthy responses from
[Mainnet](https://zkapi-mainnet.openanonymity.ai/health) and
[Sepolia](https://zkapi-sepolia.openanonymity.ai/health).
Sepolia reported `testnet_password_required: true`; Mainnet reported false.
This was endpoint/configuration verification, not paid Ethereum inference or
withdrawal acceptance. These URLs are comparison evidence, not Solana endpoints.

Ethereum's release-pinned configuration and signing public keys are not the
same thing as a separately signed configuration file. Solana already has its
own signed manifest plus independent `ManifestTrustPolicy`; retain that trust
contract. Native ETH billing, Ethereum oracle configuration, unrestricted
testnet access and an npm registry release are not prerequisites for parity
with the independent-consumer experience.

## Priority and dependency map

P0 tasks are blockers for advertising the proposed public Devnet integration.
P1 work improves the broader product or production release and must not be
quietly claimed by completing P0.

| ID | Priority | Deliverable | Depends on |
|---|---|---|---|
| PD-01 | P0 | Public operator and canonical Devnet deployment | Deployment/ownership decision; aligned with PD-02/03 |
| PD-02 | P0 | Complete distributable proof and WASM assets | Redistribution decision and selected setup |
| PD-03 | P0 | Authenticated, versioned public deployment profile | PD-01/02 identities and artifacts |
| PD-04 | P0 | Browser-safe transport and read-only diagnostics | PD-01/03 |
| PD-05 | P0 | Live provider, model and tariff configuration | PD-01; operator provider access |
| PD-06 | P0 | Devnet funding, access and provider-spend policy | PD-01/05 |
| PD-07 | P0 | Public-input-only SDK and clientd onboarding | PD-02/03/04/05/06 |
| PD-08 | P0 | Independent browser lifecycle on released Kit SDK | PD-01 through PD-07 |
| PD-09 | P1 | Released native client lifecycle through supported transport | PD-01 through PD-07 |
| PD-10 | P0 | Published evidence, service recovery and release handoff | PD-08; PD-09 if native readiness is advertised |
| PD-11 | P1 | Additional clients/platforms and production gates | Scoped follow-up after P0 |

PD-09 is required before claiming the native public-service path is ready, but
it need not delay a clearly browser-scoped preview. Checked items below cite their
completed evidence; unchecked items still require their stated acceptance.
The original requirements called for an owner, chosen deployment, exact release
versions and measurable scope before implementation. Current choices are
recorded in the linked deployment evidence, not inferred from this baseline.

## PD-01 — Publish and operate a canonical Devnet deployment

**Gap:** services and Devnet programs exist, but the release does not select or
offer a default public operator. A historical program address, local relay or
localhost service is not a complete public integration.

Work:

- Select an existing compatible deployment or provision a new one. Record why
  its program/build, Pool and setup can be used together; do not mutate an
  existing funded profile to turn it into the public default.
- Publish deployment ID, cluster/genesis, program ID, Pool, mint/token program,
  decimals, Vault/treasury derivation or addresses, build identity, setup
  assumptions and actual admin/upgrade authorities.
- Provision stable HTTPS routes for control, indexer, artifacts and any enabled
  inference path. Run the required signer, database, provider dispatch and
  challenger components with persistent state and an identified operator.
- Define service ownership, availability window, maintenance/retirement policy
  and public redacted health/readiness output. Health must distinguish a live
  HTTP process from usable chain/indexer/provider state.
- Include deployment receipts and a finalized comparison of actual program
  bytes/upgrade authority/Pool configuration to the selected pins.

Acceptance:

- [ ] A third party can obtain the public addresses and reach all required routes
  from a clean machine without a developer's tunnel, checkout or private CA.
- [ ] Read-only validation binds the selected cluster and finalized Pool to the
  release's reviewed program/build/setup identity.
- [ ] A stale indexer, unavailable signer or disabled provider is reported as a
  specific unavailable capability; no fabricated healthy state is returned.

Reuse: [control service](../services/control/README.md),
[indexer](../services/indexer/README.md),
[challenger](../services/challenger/README.md),
[operations](../deploy/operations/README.md) and existing public-profile scripts.

## PD-02 — Resolve and publish the complete proof asset bundle

**Original gap:** the SDK package intentionally contains no deployment, WASM or proving
keys. The prepared complete bundle was omitted because redistribution terms for
four upstream setup PK/VK files were not established. That was an unresolved
release decision in the original handoff, not a finding that redistribution is
legally prohibited. **Follow-up:** the pinned original-author README establishes
MIT OR Apache-2.0; the Apache-2.0 branch is selected for those exact four files,
with authenticated notices. See the [corrected review](evidence/PD-02-redistribution-followup.md).
The separately completed public-download acceptance is recorded below.

Work:

- Record authoritative provenance/terms and a reviewed distribution decision for
  each omitted file; preserve required notices. Do not silently copy those
  files into a public release while this decision remains unresolved.
- If the resolution requires another setup, plan a compatible new program/Pool
  and versioned client profile. New keys must never replace the pinned verifier
  of an existing note or be treated as an asset-only refresh.
- Package signed manifest, trust policy, compiler-backed IDL, request and
  withdrawal PK/VK, tree PK/VK, tree source bundle, verifier constants, all
  additional artifacts and the exact WASM with its hash.
- Publish immutable versioned files, sizes, SHA-256 values, source/build
  provenance and setup limitations. Keep the native prover distribution pinned
  for native consumers as well.
- Reuse the existing offline packager and `loadDeploymentAssets`; do not
  introduce another artifact format unless a versioned design requires it.

Acceptance:

- [x] Every dependency is retrievable from the documented public release/static
  host and usable without operator-private paths or files.
- [x] An independent installed SDK verifies the descriptor and all artifacts,
  produces real proofs with the matching WASM/native prover, and rejects a
  missing/modified/mixed-deployment artifact.
- [x] A release test checks actual downloadable bytes, not just a local bundle
  or an artifact name listed in documentation.

Completion evidence (2026-10-08 JST): [27 anonymous profile/bundle downloads](evidence/PD-public-assets-download.json)
matched the reviewed bytes, followed by [six fresh installed native/WASM proofs](evidence/PD-public-assets-proofs.json),
six independent supplied-VK verifications and 18 proof-level negative checks.
WASM ran under Node; this is not browser proof or funded acceptance. The same
SDK archive `fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc`
also passed the separate [75 installed-package fixtures](evidence/PD-public-devnet-followup-components/external-results.json).

A further offline check used the actual downloaded descriptor
`10a85725034a18bfa3e07913af9cdf89bd10ca05c4ce50aefe5f766a2431c9c8`
and independently installed SDK tree
`18a6a7579c9c1191aa0f864edb52ad6d323e751d35b68f4cbe786bef79695f08`:
the baseline loaded, while a missing request PK, one-byte-modified request PK,
and tree VK substituted from the older local deployment each failed closed.
The substituted VK was `4e62f971f0467a8cd1733194425904d9433cc59f2badaf2e12cc3fda87285443`
instead of `d087ca522e5dc84b0c23daf2e5ebefcca0b489c5aaaf850bd18373a397cb387c`.
No source bytes changed and no network or financial action occurred. The retained
`downloaded-bundle-loader-rejections.json` report SHA-256 is
`1b210b064c8417c7fed562d82f2185993458efa8674a6cbc7898d9dfd5065d13`.

Both [documented public client archives](sdk/public-devnet-preview.md) also
returned anonymous HTTP 200 with validated TLS and immutable cache headers:
the SDK above was 121,467 bytes; the 71,056,092-byte macOS ARM64 native archive
matched `9a2ab6759d99b3d7031b4c939ab654caeec2244763d1f16538e471bd5675cb56`.
The retained anonymous client-download report SHA-256 is
`7e8471ea3444c2fc1dc5e19b16432949e233ce5d7b029a2b8beee8c26122d2ec`.
These complete PD-02 distribution checks, not PD-08/09 live lifecycle or a new
GitHub release-attestation claim; the immutable `.1` releases remain preserved.

The subsequent [immutable `.2` GitHub publication](evidence/PD-public-client-publication.md)
now establishes release/asset attestations and fresh anonymous downloads of the
same client bytes. It does not change the scope of the earlier static-host checks
or establish funded lifecycle acceptance.

Reuse: [distribution format](../packages/sdk/DISTRIBUTION.md),
[omission explanation](releases/devnet-preview.md),
[third-party notices](../THIRD_PARTY_NOTICES.md),
[packager](../scripts/package_sdk_distribution_assets.mjs).

## PD-03 — Distribute a complete authenticated deployment profile

**Gap:** validation types and loaders exist; the independent maintainer still
has to source and assemble the deployment inputs separately.

Work:

- Define a supported, versioned public profile combining the bundle URL and
  independently distributed descriptor hash, reviewed trust/build pins, RPC and
  indexer origins, model/tariff allowlist, explicit direct/proxy mode, and the
  provider/verifier bases required for the selected direct mode.
- Enumerate the existing manifest's deployment/genesis/program/Pool/mint,
  signing keys, circuit/setup/IDL/artifact identities, capabilities, cap, note
  TTL, challenge period and service origins. Reuse the exact SDK contract rather
  than inventing a second list of financial truths.
- Distribute the initial trust anchor through a reviewed release or equivalent
  independently authenticated channel. A hash or public key fetched solely
  from the same untrusted endpoint must not authenticate that endpoint.
- Define SDK/protocol/profile compatibility, rotation, revocation, rollback and
  retirement behavior. Funded or unresolved journals retain their original
  deployment identity and recovery route.
- Derive browser and native configuration from the same reviewed public inputs;
  document consumer-local file paths and credentials separately.

Acceptance:

- [x] A maintainer installs one reviewed profile without manually copying
  cryptographic constants from historical evidence or an operator's filesystem.
- [x] Wrong genesis/program/Pool/mint, swapped signing keys, tariff mismatch,
  altered WASM and unsupported capabilities fail before financial mutation.
- [x] Updating the SDK/profile cannot silently rebind funded or uncertain state.

Evidence: [public native and browser unfunded initialization](evidence/PD-consumer-unfunded-startup.md)
used one pinned profile and public assets. The
[immutable client release](evidence/PD-public-client-publication.md) publishes the
profile pin independently from the artifact host. Its exact-source
[377 SDK / 75 installed-package hosted checks](evidence/PD-public-client-hosted-ci.md)
cover trust mismatches, retained installation identity, immutable authenticated
configuration and existing custody/recovery guards. Negative and upgrade guards
are fixture evidence; these checks do not establish a funded public lifecycle.

Reuse: [deployment contract](sdk/deployment.md),
[trust types and checks](../packages/sdk/src/trust.ts),
[asset loader](../packages/sdk/src/deployment.ts).

## PD-04 — Make browser transport and preflight usable externally

**Gap:** the bounded relay and browser factory exist, but a public host's
CORS/routes/RPC configuration and actual external-browser acceptance are not
provided by merely publishing the library.

Work:

- Specify supported direct CORS and/or same-origin relay deployment. Publish
  exact allowed origins, methods and routes, CSP/worker requirements and a
  tested host configuration.
- Include both shared tree snapshot routes, RPC, control, settlement/recovery
  and the selected inference/provider paths. Use public-safe RPC or a bounded
  relay; never embed credential-bearing RPC URLs or provider management keys.
- Preserve credential omission, redirect refusal, abort propagation, bounded
  reads, exact request bodies and the no-automatic-inference-retry policy.
  A generic arbitrary-destination proxy is not an acceptable shortcut.
- Add/reuse a documented read-only preflight that checks asset hashes, manifest,
  genesis, finalized Pool, snapshot compatibility/freshness, reachable routes
  and configured model capability, with useful redacted errors.
- Explain browser storage/worker requirements and how to retain the same origin
  and custody namespace. Do not evade browser security blocks.

Acceptance:

- [ ] A separately hosted app on its own origin passes preflight in a supported
  real browser and runs the published worker/WASM.
- [x] Preflight/status performs no deposit, AUTH, paid inference, custody reset or
  silent prompt to sign; any user permission requirement is documented.
- [x] Public assets, diagnostics and network traces contain no operator secrets;
  failure identifies the failing component instead of saying only "disconnected."

Evidence: [actual public unfunded startup](evidence/PD-consumer-unfunded-startup.md),
[public app and redacted diagnostics](evidence/PD-zkchat-english-publication.md),
[anonymous assets](evidence/PD-public-assets.md), and the exact released client's
[preflight/redaction fixture checks](evidence/PD-public-client-hosted-ci.md).
Explicit new-storage creation was a separate action after preflight. These checks
do not establish browser proof generation, provider CORS or a funded lifecycle.

Reuse: [browser relay](../scripts/devnet-browser-relay/README.md),
[hosting requirements](sdk/deployment.md), existing SDK browser/transport modules.

## PD-05 — Offer an actually usable provider/model/tariff combination

**Gap:** adapters and selected historical provider successes exist, but a
third-party app has no published default operator model/tariff configuration and
cannot obtain a usable service from a model name alone.

Work:

- Choose and operate at least one explicitly supported text Chat path for the
  first public preview. Keep the broader required direct/proxy and provider
  scope in I10; do not label a one-path preview as full parity.
- Provision the operator's actual management/issuer/provider access and credit.
  For direct modes, configure the independent provider bases and OA verifier
  where applicable; do not assume ordinary inference keys grant issuance rights.
- Publish model IDs, API, mode, streaming/tool support, restrictions, fixed
  integer tariff data/hash/version, authorization cap and billing semantics.
  Backend quote/receipt configuration must match the published profile.
- Exercise real key issuance or proxy dispatch, response consumption, usage
  collection, signed settlement and cleanup. Unsupported or unavailable models
  must fail clearly without silently changing provider or privacy mode.
- Distinguish "implemented", "locally tested" and "live verified" per combination.

Acceptance:

- [ ] The advertised Chat model returns actual provider output and a
  SDK-verified signed successor/charge through the public deployment.
- [ ] Streaming is live-tested if advertised; terminal usage/empty choices,
  cancellation and settlement state are handled.
- [ ] Pricing/cap changes cannot alter an already accepted operation; no
  provider-management secret is requested from an ordinary hosted-service user.

Reuse: [model contract](sdk/deployment.md),
[provider acceptance](provider-acceptance.md),
[SDK SSE correction](evidence/I10-sdk-sse-parser.md).

## PD-06 — Define funding, access and the cost of public testing

**Gap:** Devnet SOL/test USDC do not pay the operator's real provider bill.
Funding must match the selected mint, and the public preview needs an explicit
access and spending policy.

Work:

- Document the Circle Devnet USDC mint and token program accepted by the current
  release, how a new user obtains that USDC, and how to obtain SOL for fees/rent.
  The current [chain validator](../services/control/src/chain.rs) enforces mint
  `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` and SPL Token program
  `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`. An alternative test mint needs
  a separately scoped design and acceptance; it is not an interchangeable
  funding option for this release.
- Check mint, decimals and recipient before funding; give a complete funding
  example with cap headroom and separate SOL fees. Do not imply arbitrary tokens
  named USDC or a mainnet transfer can fund the Devnet note.
- Decide who subsidizes real inference, the provider budget/caps, availability
  limits, rate limits and any invitation/password process. If access is gated,
  document how a third-party tester obtains it.
- Make exhausted subsidy/provider credit distinguishable from low note balance.
  Reject new work safely while keeping applicable settlement/recovery/withdrawal
  paths available.
- Preserve the historical campaign's immutable reservations. The latest handoff
  records 17 reservations, 9,154,216 micro-USDC reserved and 845,784 remaining;
  this cannot admit another full one-USDC authorization. Re-check the
  authoritative ledger in the implementation session; do not reset history or
  infer a new paid testing budget from this documentation request.

Acceptance:

- [ ] A new tester can fund the right assets and understand all prerequisites
  from public instructions, including any access gate.
- [x] The operator has an explicit accountable provider-spend policy; a test
  token balance is never represented as real provider credit.
- [ ] Funding/access/budget errors do not strand a note or trigger a replay.

The [funding guide](sdk/devnet-funding.md),
[detached authority policy](../deploy/public-devnet/detached-budget.md), and
[actual authority initialization](evidence/PD-detached-budget-initialization.md)
separate test tokens, actual provider charges and seven nonreclaimable exposure
reservations. Admission is still disabled; the other live acceptance checks stay
open.

## PD-07 — Provide public-input-only SDK and native quickstarts

**Gap:** package installation works today; integration still requires
maintainer-supplied deployment/runtime/network inputs.

Work:

- Add a small independent browser example consuming only published package
  exports and the reviewed public profile. Include worker/asset build steps,
  wallet selection, funding, Chat/SSE, settlement status, recovery and withdrawal.
- Offer a reviewed helper/template for profile installation and asset placement
  if needed; retain explicit configuration of spending and wallet actions.
  Avoid coupling the core SDK back to the separate reference UI repository.
- Supply a native profile template or generator for public deployment inputs,
  deriving local paths/pins after installation. Keep local inference and
  management tokens separate from operator secrets and wallet custody.
- Document supported versions, platforms, health/diagnostic commands, common
  failures, upgrade/backup constraints and exact supported client configurations.
- Keep the separation between public-service consumption and self-hosting.
  The latter still requires an operator's credentials/infrastructure.

Acceptance:

- [ ] On a clean machine, the documented steps work with downloaded releases
  and user-owned wallet state; no source-relative import, `target/` artifact,
  unpublished JSON, private backend profile or reference app is required.
- [ ] The browser example and native onboarding use the existing SDK lifecycle,
  preserve durable state, and disable automatic inference retries/fallbacks.
- [ ] An actual user can reach a configured ready state without inventing URLs,
  hashes, tariffs or native absolute paths.
- [x] npm registry publication is not treated as a blocker: authenticated
  immutable tarballs remain a valid distribution channel.

The [verified immutable `.2` tarballs](evidence/PD-public-client-publication.md)
are publicly downloadable without npm-registry publication. Current service-ready
onboarding and funded use remain separate from their distribution checks.

Reuse: [SDK quickstart](sdk/quickstart.md),
[native quickstart](sdk/clientd-quickstart.md),
[clientd runtime](../apps/clientd/README.md).

## PD-08 — Verify the released Kit SDK in an independent browser app

**Gap:** the independent zkchat UI/adapter tests are not live acceptance;
historical browser/native cases do not revalidate the newly published Kit client
or the proposed public deployment.

Work and required evidence:

- Install the exact released SDK and public profile in a fresh external app.
  Use a real Wallet Standard wallet (the existing acceptance choice is Phantom),
  actual WASM proofs and the public Devnet/operator/provider endpoints.
- Complete one note's deposit, at least two intentional conversation turns with
  context, real streaming if advertised, verified settlement and mutual
  withdrawal. Show provider output and charge independently of UI success.
- Exercise browser reload/close and explicit same-journal recovery after an
  interruption; record whether interruption happened before acceptance,
  during inference or after settlement. A clean settled restart is not
  unknown-send recovery.
- Check model switching only when multiple models are advertised. Check
  insufficient balance/access/provider failures before extra financial work.
- Record release/profile/artifact hashes, exact test scope and timing,
  finalized transaction signatures/slots/CU/bytes, verified receipts and the
  number of deliberate inference operations versus observed sends.
  Redact secrets and avoid publishing full private requests/journals.

Acceptance:

- [ ] The same note completes the real lifecycle and returns the expected
  remainder; SDK receipt accounting and finalized chain observations agree.
- [ ] No proof/provider/wallet adapter stub stands in for the claimed path.
- [ ] Recovery does not replay inference, silently create a new note, reset
  custody, or switch direct to proxy.
- [ ] Failure observations and untested cases are retained with the successful
  evidence; prior historical results are not relabeled as this run.

## PD-09 — Verify native integration through the shipped transport

**Gap:** historical OpenClaw live acceptance used a custom bounded Devnet relay;
installed-package/local fixtures do not establish current stock-supervisor
public transport or Kit live acceptance.

Work:

- Use the immutable native release on its advertised platform with only the
  public profile, documented network configuration and local user custody.
- Run its supported supervisor/transport against public HTTPS endpoints without
  a hidden acceptance relay, hand-edited runtime or disabled TLS checks.
- Verify models/status, real text and tool continuation where advertised,
  streaming, signed settlement, restart/recovery and Devnet withdrawal.
- Start with the existing OpenClaw integration; record client version, request
  subset, UUID/retry policy and enabled model capabilities.

Acceptance:

- [ ] The installed released client completes a real funded lifecycle through
  its advertised public transport and produces independently checkable receipts.
- [ ] The external AI client receives only its local inference credential.
- [ ] Recovery/unsupported-request behavior is verified in the production
  handler, not only a synthetic HTTP compatibility fixture.
- [ ] The report names any remaining relay or platform limitation explicitly.

Reuse: [OpenClaw integration](integrations/openclaw.md),
[external native evidence](evidence/I10-clientd-external.md),
[integration status](integrations/README.md).

## PD-10 — Publish the evidence and retain a recoverable service

**Gap:** public release/download verification is already available, but it does
not establish continued service readiness, a complete artifact bundle or a
current public-consumer lifecycle.

Work:

- Publish the new profile/bundle with authenticated hashes and source/build
  versions; verify anonymous downloads and compatibility with the actual
  program/Pool before linking it as a supported default.
- Add focused public-distribution/preflight checks and retain their exact scope.
  Keep funded live tests deliberate and budgeted; do not put unattended paid
  inference into ordinary install, health or CI checks.
- Publish PD-08 evidence and PD-09 evidence if native readiness is advertised,
  with a supported feature matrix and explicit
  unverified combinations. Preserve the known comprehensive-CI/evidence
  limitations until independently resolved; a focused pass is not "all CI".
- Exercise the existing operator recovery path on the chosen public deployment:
  indexer catch-up, same-ledger/signer-journal restart, service outage handling,
  challenger readiness and the supported escape/finalize path. A successful
  mutual withdrawal alone does not establish emergency withdrawal readiness.
- Define admission suspension, recovery/withdrawal availability, profile/key
  retirement and user-visible incident guidance. Never replace unresolved
  state with a fresh database, signer journal or manifest to restore green health.
- Make retained archive/replay memory and disk sustainable within the selected
  hosting allowance. The [capacity review](evidence/PD-runtime-capacity-review.md)
  found full-block journal growth and a growing replay digest map. Preserve
  required evidence and existing journals; segmentation alone does not bound
  total disk use. Measure restart, catch-up, recovery and throttled CPU behavior
  on the selected Linux size before claiming continuous operation.
- Link the public operator, funding instructions, immutable profile, known
  limitations and evidence from README/SDK docs; remove placeholder-only
  onboarding from the advertised default path.

Acceptance:

- [ ] A reviewer can reproduce the published setup and identify exactly which
  app/client/network/provider combinations were actually verified.
- [ ] An operator restart/outage does not lose acknowledged reservations or
  authorize duplicate inference/settlement; applicable recovery remains usable.
- [ ] Current preview memory/disk headroom and restart/recovery are measured on
  the selected host. Long-term capacity qualification is deferred by the user
  on 2026-10-08 JST and is not a completion gate for this preview.
- [ ] All P0 evidence is linked, versioned and redacted; no production/mainnet,
  ceremony, audit or full I10/G1-G4 claim is inferred from a Devnet preview.

## PD-11 — Keep broader follow-ups explicit

These are separate from proving the first public Chat integration:

- Additional live providers/APIs, multi-model combinations and the remaining
  I10 acceptance matrix; do not silently drop direct/proxy requirements.
- Claude Code and Codex compatibility: current production request-shape blockers
  are recorded in [integration docs](integrations/README.md). Design versioned
  supported subsets and real handler/provider acceptance before advertising them.
- Linux, Windows, Intel macOS distributions and Apple signing/notarization.
  The existing verified package is macOS ARM64; other-platform support is not
  proven by it.
- Portable browser custody backup/migration, origin changes and note lifecycle
  UX; keep current storage limitations visible.
- Production setup/ceremony, independent review/audit, authority policy,
  infrastructure isolation/fencing/KMS, production recovery drills, full
  release gates and subsequent mainnet deployment under I11/I12.
- npm registry publication is optional distribution work, not the definition
  of a usable SDK.

## Suggested execution order and completion record

1. Revalidate the baseline, select the public Devnet operator/setup and resolve
   artifact redistribution (PD-01/02). Existing evidence is input, not a reason
   to rebuild the protocol.
2. Freeze the compatible public profile, transport, model/tariff and access/
   funding policy (PD-03 through PD-06).
3. Run clean-environment onboarding and read-only validation (PD-07).
4. Run the separately budgeted browser live cases, with failures and recovery
   preserved (PD-08); run PD-09 before advertising native public-service readiness.
5. Publish the immutable release/profile, operations handoff and scoped
   evidence (PD-10); schedule PD-11 separately.

For every task, append or link an evidence record under `docs/evidence/`
containing: task ID, owner, source/release/profile hashes, commands, environment,
public artifacts, expected/observed results, failures, remaining limitations and
any financial test's budget/transaction/receipt references. Do not publish
secrets, custody files, private RPC credentials or raw private journals.

Final acceptance is a fresh independent consumer completing the documented
public Devnet lifecycle from public inputs. A build, mock UI response, HTTP 200
health check, faucet transaction, earlier private-profile success or a published
SDK tarball alone does not satisfy it.
