# Public Devnet consumer implementation candidate

Recorded 2026-10-07 JST, based on source
`eb9a5d1e384cee97a545e7482c0f3c223da0b2ac`. The changes are an uncommitted,
unreleased `0.2.0-devnet.2` candidate. The existing immutable
`v0.2.0-devnet.1` release and its evidence remain unchanged.

The [backlog disposition](../public-devnet-implementation.md#backlog-disposition)
maps each PD task to implemented source and external completion requirements.
**No public acceptance checkbox is closed by these local results.** There is
still no selected hosted operator, complete public proof bundle or published
profile that can populate an independent app's deployment configuration.

## Implemented behavior

- An independently pinned public profile authenticates the existing complete
  bundle, deployment trust, explicit provider mode, model tariffs and feature
  restrictions. Immutable installed-profile bindings prevent silently switching
  a funded or unresolved browser namespace.
- Read-only preflight checks the public manifest/catalog, Devnet genesis,
  finalized Pool and shared tree snapshots. Downloads and RPC reads have byte
  limits, deadlines, credential omission and redirect refusal. Component errors
  are redacted. It does not verify live credit, signer readiness or deployed ELF
  bytes; the result explicitly leaves operator admission unverified.
- The independent browser adapter retains response consumption, settlement and
  explicit recovery. Existing custody can open for recovery despite catalog or
  preflight unavailability, while new sends stay blocked until refreshed.
- The standalone API gateway needs no UI checkout or build. Canonical
  control/tree/RPC routes use exact HTTPS origins, strict CORS, optional native
  transport and the existing signed-transaction, exact-AUTH and durable budget
  guards. Admission suspension keeps exact reserved AUTH, settlement and
  withdrawal paths available. Client aborts propagate without automatic replay.
- Review identified that a public client could consume reservations using an
  invalid proof before the backend rejected it. New public AUTH now requires an
  operator-issued invitation before creating a reservation. Missing or invalid
  invitations can use only an identical existing reservation. This addresses
  unauthenticated budget exhaustion; proof verification still occurs downstream.
  Invitations do not replace service rate limits or accountable access policy.
- Browser invitations remain in memory and are attached only to authenticated
  session AUTH POSTs. The native relay loads a canonical owner-only token file
  once and injects the header only on the exact reviewed HTTPS AUTH route.
  Incoming headers cannot override it; other routes and redirects cannot carry
  it. Native configuration is generated from the same authenticated profile.
- A read-only publication gate requires exact bundle/file hashes and an explicit
  distribution decision per file. It neither grants redistribution rights nor
  publishes anything. The [four-file review](PD-02-asset-distribution-review.md)
  still lacks authoritative redistribution terms for the omitted upstream keys.

## Verification

The [machine-readable report](PD-public-devnet-readiness.json) hashes all saved
component reports and logs. Counts below overlap; do not add them into one total.

| Scope | Result |
|---|---|
| Full SDK regression | 365/365, zero skipped; includes local headless Chrome custody fixtures |
| Canonical gateway, historical host and admission/recovery | 36/36, zero skipped; gateway TypeScript check passed |
| Independent installed SDK tarball | 70/70, zero skipped; Node imports, declarations and browser/worker bundles passed |
| Installed-package consumer helpers | Browser adapter 6, native network configuration 4, native file installer 1; fixtures only |
| Installed native/WASM proofs | One real local prover check passed; existing fixture artifacts, no public download or live chain claim |
| Go race suite | 26 top-level tests plus 43 nested tests passed, zero skipped across three packages; includes real local TLS invitation transport |
| Python budget / publication gate / build provenance | 9 / 5 / 6 passed in separate scopes |
| New native installation | 7,257 file hashes, help/Node/public-profile import checks passed; 532 build inputs unchanged |

The final independent-package run is
[external-invitation/results.json](PD-public-devnet-components/external-invitation/results.json).
Its helper inputs remained unchanged during the run. The full SDK log does not
have a separately recorded before/after source guard; do not infer one from its
test count. The native build has its own exact
[532-input snapshot](PD-public-devnet-components/native-build-inputs.json), checked
before and after the build and again during installed-file verification.

The SDK candidate SHA-256 is
`25a8f44183bc00c19122f8028c6c953b13a571753437a5575867e0b373df1c9e`.
The local native installation includes the same SDK bytes; its `release.json`
SHA-256 is `ee520af54f4fd5cf88db985886aecb4e610ad44d92b3724ca978bcee6c89d499`.
This is a macOS ARM64 local build with measured minimum macOS 13.5, Node 24.19.0
and Go 1.25.0. It has not been published, signed, notarized, downloaded
anonymously or used for a new public native lifecycle.

Reproduction commands, using the pinned tools and a fresh output directory:

```sh
npm test
node --test scripts/public_devnet_gateway.test.ts scripts/browser_chat_devnet_host.test.ts scripts/devnet-browser-relay/host.test.ts
python3 scripts/run_external_sdk_acceptance.py --output /absolute/new-output --real-provers
target/toolchains/go/bin/go -C apps/clientd test -race -json ./...
python3 -m unittest discover -s scripts -p test_provider_demo_budget.py
python3 -m unittest discover -s scripts -p test_public_bundle_release.py
python3 -m unittest discover -s scripts -p test_clientd_release_provenance.py
python3 scripts/build_clientd_distribution.py --output /absolute/new-native-install
```

Local socket/cache permissions are necessary for relevant tests. The initial
SDK sandbox run retained local-listener EPERM and a native async-id SIGABRT;
the permitted rerun passed. Initial external npm packing failed on sandbox cache
access, with the failed report retained. The initial gateway run passed 34/35:
the test's fetch implementation replaced the supplied Host header. The test now
uses native HTTP to model the TLS reverse proxy; runtime Host checks were not
weakened. The earlier successful external runs remain separate source snapshots.

## Preserved state and remaining launch work

The existing budget retained 17 reservations totaling 9,154,216 micro-USDC;
845,784 remains and cannot admit a new full 1,000,000-micro-USDC AUTH. Its exact
before/after SHA-256 is
`513d46d07ac617d07e9620f3aac1d1809a8f5474cb22e442e46481f9055a2e29`.
No new reservation, paid inference, funding, public transaction, service restart
or release action occurred. Existing journals, credentials, deployment pins and
the separately running historical browser services were not migrated. The
independent chat app and unrelated `work/single-deposit-review/` were not edited.

Launch still requires an operator/domain/platform decision, persistent services
and authenticated readiness observations, complete asset redistribution and
public downloads, a reviewed public profile, an explicit subsidy/access/rate
policy with sufficient newly authorized capacity, and current real browser and
native lifecycles through that deployment. The nginx template has not been
syntax-tested or exercised over public TLS. Fresh provider issuance, streaming,
settlement, interrupted recovery, withdrawal and emergency operation drills
remain separate acceptance work. No new hosted CI, full I10/G1–G4, production,
mainnet or additional-platform claim follows from this candidate.
