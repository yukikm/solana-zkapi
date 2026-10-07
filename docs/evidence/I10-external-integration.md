# External application integration and UI repository separation

Recorded 2026-10-07 JST. This work evaluates independent SDK applications and
existing OpenAI-compatible agents separately from presentation UI quality.
The [aggregate and component hashes](I10-external-integration-results.json)
record the completed requested scope and its remaining release boundaries.

## Repository separation

The presentation code now lives in the independently managed
[solana-zkapi-client repository](https://github.com/yukikm/solana-zkapi-client),
locally at `/Users/yukikimura/work/solana-zkapi-client`. `browser-chat/` contains
the configurable application; `legacy-wallet/` preserves the earlier fixed
demonstration. The core no longer contains either presentation directory.
The client installs a real compiled SDK tarball, with its own lockfile and build
tools. It does not import sibling checkout source or require a workspace link.

The bounded devnet operator relay stays in core under
[`scripts/devnet-browser-relay`](../../scripts/devnet-browser-relay/README.md).
It serves explicitly selected independently built files. Financial relay,
budget reservation and RPC restrictions remain operator responsibilities.
The separate client's HTTP test server uses fixtures and has no provider
credentials, transaction relay or funding behavior.

The [source migration inventory](../source-migrations.json) retains the original
Git revision and all 50 original file hashes. Historical evidence links retain
their original meaning; the design checker permits only inventoried historical
paths within `docs/evidence`. Current guides resolve to current files or the
separate repository. Old funded profiles, private state and running operator
configuration were not migrated into the client repository.

## Distribution and native integration

The [SDK distribution evidence](I10-sdk-distribution.md) records actual tarball
installation outside the checkout, explicit JavaScript/type exports, browser
and worker bundling, real native/WASM reconstruction, and separately pinned
public deployment assets. See the [distribution guide](../sdk/distribution.md).

The [native evidence](I10-clientd-external.md) records private `setup`, `run`,
authenticated `request` and `openclaw-config` commands, a current-platform
installation with pinned dependencies, actual local Vault SBF and actual
OpenClaw CLI compatibility/recovery tests. The [quickstart](../sdk/clientd-quickstart.md)
and [OpenClaw guide](../integrations/openclaw.md) explain funding, API credentials,
retry controls and recovery. No second financial client state machine was added.

## Local aggregate and independent SDK lifecycle

The [six-stage application SDK aggregate](I10-external-integration-components/app-sdk-results.json)
passed in **27.715 seconds**, with **315/315 SDK tests**, zero skips and **495
guarded inputs unchanged**. It includes real isolated Chromium custody, a fresh
SDK build, independent npm installation, declaration/browser/worker builds and
design/link checks. These tests use fixture services. The preceding aggregate
failed a browser navigation race; its report/log is preserved. The
[test-only readiness correction](I10-browser-readiness.md) waits for the actual
document before initializing storage and does not retry financial operations.

The separate client repository passed **77/77 tests**, both application builds
and a clean independent npm installation, with **54 inputs unchanged**. Its
configured build verified all five deployment asset hashes. These are UI/local
checks, separate from real wallet/provider evidence. The final SDK archive SHA
is `fc37358ce00fa7bcb5c43367c8f09b3908c617f9235e8646ae78003a21040c91`.
The relocated operator host and launchers passed strict TypeScript checking and
[26 host tests](I10-external-integration-components/relay-checks.json). Eight
existing shared-budget tests and ten live-harness/collector tests passed in
separate, overlapping scopes; these are not additional provider cases.

An application installed in the separate client repository, using only public
package exports, completed a real public-devnet lifecycle on Pool
`2aeTCsHthoockF8LC8N3UfP312BZ8uJ6sfuMbA2rot1w`: two-USDC compact deposit,
OpenRouter Chat JSON, tools, corrected SSE consumption, verified settlement and
ordinary mutual-close withdrawal. It used the pre-existing bounded operator
relay for control/RPC/indexer and its immutable parent budget; inference went
directly to OpenRouter. It did not use the presentation UI.

The [independent read-only chain collector](I10-external-sdk-devnet-results.json)
verified six finalized v0 transactions, exact signed wire hashes and Ed25519
signatures, maximum **357,103 CU / 1,232 bytes**, and **30,000 lamports** in
transaction fees. The compact deposit wire is 995 bytes. It reconstructed the
mutual-close payload: **2,000,000 deposited**, **1,999,992 returned principal**,
and **8 micro-USDC difference**. At finalized slot 508312645 the note was closed,
Vault zero and wallet 36,010,000 micro-USDC. This wallet also owns the treasury;
its restored balance does not erase the separately verified charge.

Five intentional provider calls and five AUTH reservations were recorded across
this lifecycle, with no recorded inference replay or exact-signature resend.
The [provider/settlement join](I10-external-sdk-provider.md) records all five
exact operation IDs and read-only management checkpoints. The zero-charge
observations for three calls do not establish that provider inference was free.
The first SSE attempt failed without sufficient diagnostics. A separate new
request exposed an OpenRouter terminal-usage parsing incompatibility; the
[narrow SDK correction](I10-sdk-sse-parser.md) was verified offline and then with
a different, newly authorized request. That final SSE call consumed 16 text
characters in three deltas and the required terminal marker. Neither earlier
failure is relabeled as a pass.

Each initial inference command retained pending asynchronous settlement.
Explicit same-journal `settle` observations obtained signed successors without
resending inference. Initial deposit and withdrawal observations also stopped;
explicit `advance` recovered the saved finalized sends, with no additional
transaction dispatch. These observations do not prove a particular network
fault or automatic unknown-send crash recovery. The
[archived public process reports](I10-external-integration-components/sdk-live-source-reports.json)
preserve initial failures, subsequent recoveries and original/fixed package
scopes. Private custody and provider response captures remain excluded.

## Actual OpenClaw and native devnet lifecycle

[Actual OpenClaw **2026.9.8**](I10-openclaw-devnet.md) completed a streamed text turn and a real file-read
tool roundtrip, including its follow-up inference, through the local
OpenAI-compatible endpoint. There were **three distinct inference dispatches**
and **two distinct authorizations**. The two tool-related requests reused the
same direct session within the configured 60-second window. The exact number of
AUTH HTTP packets is not independently recorded. No inference operation or
signed transaction was resent.

The native SDK verified charges of **627 + 659 = 1,286 micro-USDC**. A new process
reopened the same settled custody/journal and retained its balance/head before
withdrawal, without an additional inference. This clean settled restart is
separate from the local fixture/SBF interruption and unknown-operation tests.

The [independent native chain collector](I10-native-openclaw-devnet-chain-results.json)
verified six finalized transactions, maximum **348,111 CU / 1,232 bytes** and
**30,000 lamports** in transaction fees. The decoded payload returned
**1,998,714 micro-USDC** from the two-USDC deposit. At finalized slot 508316171
the note was closed, Vault zero and shared wallet/treasury balance 36,010,000.
The public live path used an installed SDK/runtime and production Go HTTP
handler with a custom, bounded devnet acceptance relay. Its immutable live
package retained SDK `3e601fae…`; the final portable package with SDK `fc37358c…`
passed a fresh installed-supervisor/SBF and OpenClaw fixture run. This does not
claim a public production operator or a stock-supervisor public transport test.

## Preserved state and budget

The [state/budget comparison](I10-external-integration-components/preserved-state-and-budget.json)
checks exactly 19 previously snapshotted files. Only the expected shared budget
state changed; retained profiles, manifest/build pins and sampled old journal
files remain byte-identical. Reconstructing the original ten-row budget prefix
and identity reproduces its exact pre-work SHA-256. No reservation was reset or
released. Seven new reservations bring the parent to **17 rows**, **9,154,216
micro-USDC reserved** and **845,784 remaining**. Reservations are conservative
bounds, not charges: the two new live lifecycles verified **1,294 micro-USDC** in
total. The remaining reservation capacity cannot admit another full one-USDC
authorization cap. Preserve the closed new journals and the original running
operator services; migration does not replace their state.

## Verification boundaries

The older `scripts/check_evidence.py` compares today's tree against
`docs/evidence/implementation-results.json`. Before this work, 95 of its 811
recorded artifact hashes already differed from the original checked-out HEAD;
none were missing. The post-migration observation has 93 hash mismatches and
38 removed presentation paths. Its historical pins are preserved. This task does not claim
that checker or hosted CI passed, and does not replace its old report with a
new unrelated source snapshot. The separate design/link checker is not runtime
acceptance.

Production deployment availability, repository-wide license selection, signed
multiplatform distribution, mainnet, independent audit and full I10/G1–G4 remain
separate. A locally transferable tarball is not a claim that a public release
or operator service has been published.
