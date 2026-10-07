# I10 Devnet Preview publication

The user requested correction of the external-integration review finding and
publication of the SDK/clientd. They explicitly selected public visibility for
both existing repositories, including their history/Actions, and MIT licensing
for newly authored code. No new provider budget, inference or public-chain
transaction is part of this publication.

## Correction and distribution

`clientd openclaw-config` now rejects selected legacy string-only model entries.
The ID alone cannot establish Chat capability: a valid legacy Anthropic tariff
supports Messages, while the generated OpenClaw provider uses Chat. Explicit
reviewed object entries with `apis` containing `chat` remain supported. Tests
cover legacy Anthropic/OpenAI rejection, explicit Messages rejection and explicit
Chat success. The runtime's legacy model parsing and financial guards are unchanged.

The SDK is version `0.1.0-devnet.1`, retains `private: true`, and includes its MIT
LICENSE. Its tarball SHA256 is
`eb3164d5b7a54c7b97e523ec742033b39547eda5842648490ae9f68048b07504`.
Historical `0.1.0` artifacts and evidence remain unchanged. The independent client
repository pins the new archive and preserves its older archive and provenance.

Native notice packaging retains complete matching Node.js, Go and Rust standard
library notices, 265 Rust package entries and 61 installed npm entries. Supplied
third-party notices and exact declarations are preserved, including explicitly
identified declaration-only entries. No global upstream license is invented.
The four upstream setup PK/VK files with unestablished redistribution terms are
omitted from public release assets. Existing ignored proof bundles are preserved.

The only native platform prepared here is macOS ARM64, minimum macOS 13.5 from
the bundled executables, tested on macOS 26.6.2. There is no Apple notarization or
cross-platform acceptance claim. The archive packager validates the complete
installation and exact SDK, joins build input hashes to the source commit, and
uses relative paths with normalized archive metadata.

## Credential-free validation

- Pinned Node 24.19.0 ran all SDK tests: **315 passed, zero skipped**.
- Independent SDK tarball acceptance passed all nine stages, including 59
  installed fixture tests and a separate real native/WASM test. Real public
  bundle hashes/WASM initialization were checked locally; no network admission.
- The migrated client independently installed, typechecked and built both UIs:
  **77 tests passed, zero skipped**, 56 source inputs unchanged. Its evidence is
  in the separate client repository.
- The pre-provenance native candidate passed **48 Go race tests/subtests**, five
  secret helper tests, seven notice helper tests, one installed SBF lifecycle
  (nine transactions, maximum 429,010 CU / 1,232 bytes), and ten actual OpenClaw
  CLI fixture checks. The initial candidate report is preserved separately.

Commands use `scripts/run_external_sdk_acceptance.py`, pinned Node's `--test`
SDK suite, `go test -race`, `scripts/test_clientd_secrets.py`,
`scripts/test_clientd_release_notices.py`, `packages/sdk/test/clientd-sbf.ts`,
and `scripts/run_openclaw_clientd_acceptance.ts`. Component reports/logs are
retained under `I10-devnet-preview-components/`. Final guarded-package results
are recorded there separately from the initial candidate.

The final guarded native installation independently passed the installed SBF
lifecycle (nine signed transactions, maximum **421,504 CU / 1,232 bytes**) and
all ten actual OpenClaw fixture checks in 34.322 seconds. Its four executables,
runtime and 54 compiled SDK files are byte-identical to the earlier tested
candidate. Final installed `release.json` SHA256:
`be30b5edada52e8754d46c5b861026698b22817e67ff7d1a248a75b4a6d456d0`.
Six additional disposable-Git provenance regressions passed, including wrong
commit, missing source and incorrect upstream joins. These checks make no live
provider or public-chain calls.

## Publication scope and preserved limitations

A limited publication scan inspected all reachable source history (20 core
commits / 1,839 blobs, one initial client commit), 18 historical core Actions
log archives and 65 artifacts (83 ZIPs / 1,463 files), plus current source and
SDK archive candidates. No actual credential matches or read errors were found
for the tested patterns. Synthetic fixtures were distinguished from credentials.
This is not a comprehensive security audit; historical local paths remain in
the original evidence. `.env`, private profiles/journals, `target` and unrelated
`work/single-deposit-review` are excluded from commits and release assets.

The focused `client-preview.yml` workflow covers SDK fixtures/browser custody,
external package installation and clientd Go/helper tests. It is separate from
the existing full implementation workflow and its already-stale historical
evidence snapshot comparison. A passing preview workflow does not establish the
full implementation matrix. Publication/hosted results are added as a follow-up
after the remote operations complete.

The release provides no default operator or complete deployment bundle. OpenClaw
live evidence still used a custom bounded devnet relay. Claude Code and Codex
remain blocked by their actual request formats. No new public-provider, mainnet,
full I10/G1–G4 or audit acceptance is claimed. All earlier failures and immutable
budget reservations remain preserved.
