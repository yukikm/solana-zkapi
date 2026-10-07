# Native Solana Kit migration — 2026-10-07 JST

The active SDK, native clientd runtime, operational scripts and separate Demo UI
now use `@solana/kit` 8.4.0. The dependency checks found zero legacy Solana
imports or installed legacy packages in their declared scopes: 286 active core
source files / 142 locked installed packages and 38 client source files / 61
locked installed packages. See the [core](I10-kit-migration-components/core-dependency-guard.json)
and [client](I10-kit-migration-components/client-dependency-guard.json) reports.
Historical evidence, old published artifacts and captured compatibility fixtures
retain their original library names and bytes.

The SDK version is `0.2.0-devnet.1`. At this evidence checkpoint, publication of
that version is pending; the existing immutable public release remains
`v0.1.0-devnet.1`. These local results do not retroactively retest the old public
devnet/provider lifecycles with Kit. No new public-chain send, provider inference,
funding, budget reservation or private-journal migration was performed.

## Implementation and compatibility

The migration uses native `Address`, `Rpc<SolanaRpcApi>`, `Instruction` and
`Transaction` values. It does not expose legacy classes behind a Kit adapter.
The [migration guide](../sdk/kit-migration.md) documents the breaking application
API, asynchronous PDA/validation functions, signer integration and bounded
custom-fetch RPC helper. Finalized account observations retain explicit minimum
slots, canonical base64 decoding and integer range checks. Financial quantities
remain integer values; RPC error codes alone receive checked normalization for
the existing rejection/reproof decisions.

Asynchronous journal validation snapshots caller data before awaiting, and
storage waits for successful validation. Existing exact signed-wire recovery,
no-inference-replay rules, explicit recovery operations and budget guards remain
in place. The compiler preserves the prior encounter order of account keys
before encoding the native Kit message. This matters for previously signed
journal entries even when a different valid account ordering would execute the
same instructions.

The [golden fixture](../../tests/fixtures/kit/transport-wire-v1.json) contains 31
fully signed transactions captured with the pre-migration SDK at `bae1240`.
The [regression](../../packages/sdk/test/kit-wire.test.ts) rebuilds and signs them
with Kit, compares exact bytes, and exercises recovery of saved old plan/wire
records without sending. Its scope includes all five buffer operations, payload
close steps, finalize, and compact deposits with priority fees zero and one.
This is a compatibility test over public synthetic fixtures, not a migration of
any funded user journal.

## Recorded local results

These suites overlap and must not be added together as a total test count.

| Check | Recorded result | Scope |
|---|---|---|
| [Application SDK aggregate](I10-kit-migration-components/app-sdk-results.json) | Six stages; 353/353 SDK tests; zero failures/skips; 39.491 seconds; 515 guarded inputs unchanged | Typecheck, build, SDK tests including real browser custody, independent package, documentation links and diff check |
| [Independent installed SDK](I10-kit-migration-components/external-sdk-results.json) | Eight stages; 59/59 lifecycle/trust tests plus one real native/WASM check; 46 inputs unchanged; 10.088 seconds | Actual tarball installed in a temporary independent application, exports/declarations, browser and worker builds; no asset-bundle verification was requested in this run |
| [Focused transport and recovery](I10-kit-migration-components/focused-checks.json) | 56 transport/wallet/golden tests; separate 84 recovery/operational-helper tests | Local fixtures; finalized-error handling, exact-message recovery, uncertainty fences and bigint boundaries |
| [Go race tests](I10-kit-migration-components/focused-checks.json) | 48 passed, zero failed/skipped, across three packages | Native clientd local tests with race detection |
| [SDK transaction SBF](I10-kit-migration-components/sdk-sbf-results.json) | 53 transaction rows, four scenarios; maximum 425,431 CU / 1,232 bytes | Kit-signed v0 wires executed in actual Vault ELF under LiteSVM; finality envelopes are synthetic |
| [Compact deposit SBF](I10-kit-migration-components/compact-sbf-results.json) | 61 cases; maximum compact-case 179,147 CU | Actual SDK compact wire: one signature request, one durable save, 1,007 bytes, 178,542 CU; separate legacy buffer-close compatibility is also recorded |
| [WASM close](I10-kit-migration-components/wasm-close-sbf-results.json) / [escape](I10-kit-migration-components/wasm-escape-sbf-results.json) | Nine / ten transactions; maximum 417,105 / 333,802 CU; both maximum 1,232 bytes | Existing real WASM withdrawal/tree proof fixtures through current Kit transport and actual SBF; this run does not claim newly generated WASM proofs |
| [Pending escape](I10-kit-migration-components/pending-escape-integration-results.json) | Ten transactions; maximum 332,196 CU / 1,232 bytes; one synthetic AUTH, one synthetic inference, zero inference replays or exact financial resends | Encrypted pending archive survives restart, real native request/withdrawal/tree proofs, escape/finalize, and execute acknowledgement-loss recovery through actual SBF |
| [Final installed clientd SBF](I10-kit-migration-components/native-sbf-results.json) | Nine transactions; maximum 418,509 CU / 1,232 bytes | Final local distribution, production Go supervisor/shared SDK/native proof/Vault SBF; synthetic RPC/finality and isolated journal |
| [Actual OpenClaw CLI fixture](I10-kit-migration-components/openclaw-results.json) | Ten checks; eight synthetic inference sends; zero uncertain inference replays | Pinned OpenClaw 2026.9.8, production Go frontend, compiled SDK and encrypted journal; text, stream, actual read tool continuation, HTTP503, cancellation and explicit recovery across OpenClaw processes |

The OpenClaw fixture uses synthetic control, provider, proof and chain inputs.
It establishes OpenClaw process cancellation/restart, not native clientd process
restart or funded live-provider acceptance. The final installed-clientd SBF test
is a separate local scope. Its 418,509-CU result must not be replaced with the
414,004-CU result from the earlier installed-package run.

## Package identity and source snapshots

The independently installed SDK tarball has SHA-256
`e6ff141b1c13c278f1c6d80dbe1397f187290270c583a32545df5fe4fbd45019`
and is 112,723 bytes. Its Node, browser and worker dependency graphs contain no
legacy Solana client. The same tarball is included in the final native package.

The [final native build](I10-kit-migration-components/native-distribution-result.json)
has installed `release.json` SHA-256
`d9867fb54dd8e0578e550c634deab0c41ee459819a0501da0c04c37d87c9fe94`.
It targets macOS ARM64 with measured minimum OS 13.5, bundles Node 24.19.0, and
retains Node/Go/Rust/npm notices. `production_signed` is false. This local build
record is not a public release download, GitHub signature verification, Apple
notarization, npm registry publication or another-platform installer result.

The aggregate's 515 input hashes belong to its own run. Afterward, the release
preparation script's validation reference changed from the old preview evidence
to this migration evidence, and the native package was rebuilt. The
[runtime comparison](I10-kit-migration-components/native-runtime-equivalence.json)
records that files covered by the installed manifests are identical to the
[OpenClaw-tested build](I10-kit-migration-components/native-openclaw-build.json)
except `share/zkapi-clientd/build-inputs.json`. The new final package was then
tested separately through installed-clientd SBF. The application aggregate is
not described as a source-guarded run of the later packaging metadata.

Focused Go, operational and SBF commands do not have the aggregate's complete
515-input guard. Their own reports/log hashes identify their narrower evidence.
The SBF summaries explicitly omit repeated block/account/log data and retain
the original ignored report paths and SHA-256 hashes. Exact copied public
reports and derived summaries are listed in the
[artifact index](I10-kit-migration-components/artifact-index.json). No private
wallet, passphrase, journal contents or provider-response capture is included.

## Failed observations retained

The [failure index](I10-kit-migration-components/failed-observations.json)
preserves outcomes and hashes of the original ignored logs. The earlier
[isolated package failure](I10-kit-migration-components/external-sdk-initial-failure.json)
and [aggregate failure](I10-kit-migration-components/app-sdk-initial-failure.json)
remain separate reports. The final passing results do not erase them.

- Initial SDK tests passed 351/353. One failure exposed Kit's bigint RPC error
  codes, requiring checked error normalization; one reflected a stale test
  expectation for explicit finalized commitment. Both were corrected.
- Intermediate recovery code/test consumers still used legacy Address/message
  APIs. They were migrated while preserving exact signed-message assertions.
- The first external package attempt detected `.ts` imports in generated
  declarations after two overlapping npm prepack/build invocations shared the
  SDK `dist` directory. A fresh serial pack passed declaration checks with the
  same guarded source inputs; no runtime or build-source fix was needed. The
  rejected `e7d5a40b...` artifact was never published. The first application
  aggregate later failed only at trailing-whitespace diff checking.
- The initial native SBF adapter still returned JSON transactions when the
  client requested base64. The fixture was corrected. A later final-package
  invocation used a wrong report path and failed before wallet driving; the
  corrected final invocation passed separately.
- Compact SBF initially failed on missing relative ELF/fixture paths from a
  stale compiled harness; the locked harness was rebuilt. Pending-escape SBF
  initially used an old wallet harness without that scenario's name in its
  allowlist; rebuilding it allowed the separate passing run.
- An early documentation check ran before the migration guide was created;
  the completed-document check later passed.

## Reproduction and limits

Use the pinned Node 24.19.0 toolchain. The aggregate runs its own isolated
temporary directory and records the complete commands and input hashes:

```sh
python3 scripts/run_app_sdk_acceptance.py
python3 scripts/run_external_sdk_acceptance.py \
  --output target/kit-migration/external-real-final --real-provers
target/toolchains/go/bin/go -C apps/clientd test -race -json ./...
target/i08-toolchain/bin/node --test --test-reporter=tap \
  scripts/i10_devnet_clearance_recovery.test.ts \
  scripts/i10_devnet_provider_recovery.test.ts scripts/solana-kit.test.ts
```

The [command record](I10-kit-migration-components/commands.json) lists the
additional focused SBF, transport, native-package and OpenClaw invocations.
Real-proof/SBF commands need their existing local build inputs and public test
fixtures; they do not deploy or fund a public network. Build into new output
directories when reproducing so the recorded artifacts remain intact.

This migration does not establish new public devnet or real-provider acceptance,
Phantom use, a default hosted operator, mainnet readiness, a third-party audit,
all hosted CI, complete I10, or G1–G4. The earlier published preview and its
separately scoped live evidence remain historical records. Setup-file
redistribution limitations and the existing immutable budget remain unchanged.
