# SDK/native .8 privacy and recovery usability publication

Published **2026-10-09T19:57:10Z** (2026-10-10 JST) as immutable
[`v0.2.0-devnet.8`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.8),
release ID `408291337`, exact source `fb95814720033fea4075cababe594b6c5bb7de26`,
committed and pushed to `main`. The user's follow-up requested the three proposed
high-priority privacy/usability improvements. Work reused the isolated managed
checkout and preserved the original working tree and custody.

## Delivered

- Local `upgradePlan()` and the native management command identify responses,
  wallet/session recovery, emergency archives and unclosed notes. An offline CLI
  can inspect status exported by an older runtime without opening its journal.
  Missing/ambiguous status remains unknown; no in-place custody migration occurs.
- Explicit `checkModelAvailability()` and native/consumer commands use a keyless
  public ZDR catalog GET, intersected with pinned models. Listed, not listed,
  unknown and not-applicable states remain distinct. Status/model listing does
  not trigger a network poll. Runtime management uses its installed transport.
- Structured `privacy` status exposes content recipients, routing policy,
  transport-dependent IP visibility, deletion limits, lease reuse and retention.
  Existing notice strings remain compatible. OpenRouter HTTP errors retain their
  HTTP status and receive safe actionable codes, with no raw provider messages,
  secret-bearing metadata, inference retry or weaker privacy policy.

See the [consumer guide](../releases/usability-preview.md) for commands, API
semantics, older-installation handling and remaining limitations.

## Verification

- Final source suite: **543 passed, zero failures/skips** (422 SDK, 45 provider
  collectors and 76 recovery tests). The preceding run also included the offline
  CLI fixture, totaling 544 passes. Typecheck/build and browser bundles passed.
- Actual tarball installed in an independent application: **224 passed, zero
  failures/skips**, plus the offline upgrade CLI, consumer and browser checks.
  Old status, active zero-balance notes, closed-but-unresolved escapes, missing
  fields, partial/failed catalogs, unsafe error payloads and no-retry settlement
  behavior have regression coverage.
- [Client CI](https://github.com/yukikm/solana-zkapi/actions/runs/37983187847): both
  jobs passed at the exact source, including 422 SDK and 224 installed-package
  tests, real Chrome, Go race and helper checks. Its SDK tarball hash matches the
  local release and native embedded tarball.
- Three local Go race packages passed. Release-provenance tests passed 6 cases;
  all 23 pinned upstream source/setup files matched.
- Extracted native **7,264 files**, **583 source inputs**, and **1,725 Git source
  archive files** verified. Native files remained unchanged after public reads.
- Release attestation, all **six asset attestations**, and all **six anonymous
  downloads** passed. The signed statement binds the exact source and all assets.
- [Implementation CI](https://github.com/yukikm/solana-zkapi/actions/runs/37983187856)
  had 3 successful and 6 running jobs at the immutable manifest cut. Later status
  is preserved separately in the receipt; no all-nine-job pass is claimed here.

| Artifact | SHA-256 |
|---|---|
| SDK `.8` | `cd9226f4526c0b3561a557e4c7beb4f495dcbad6c995c624f4c442b6621414da` |
| macOS ARM64 archive | `14154d038bc0e79347076b9983754eeca2fbde78159be21e5ca7b0cddca632ac` |
| Native `release.json` | `20c194668cbb9b13fecf8170c709fb03dd055bbd1b67b93b6e652dcfe7d118be` |
| Revision-6 profile | `ec10c1ab41bb5105222d3e25c7e1eba6b96b1b397abd0f854657030269992a77` |

## Actual public observations and preserved limitation

The installed new metadata helper passed at **19:53:59 UTC**. Of 21 configured
models, 19 were listed in the public ZDR catalog; `anthropic/claude-fable-5` and
`anthropic/claude-fable-5.1` were not listed. This is a dated metadata observation,
not a live inference, account-access or credit test. Pinned models were not removed.

The existing public preflight **failed at catalog verification**. Independent GET
at **19:54:55 UTC** returned HTTP200 with `{"models":[]}`. The original immutable
SDK/native `.7` reproduced the same failure using its original profile. The
profile tariff's validity extends to November 6; the live empty-catalog cause
remains unproven. No host change or guard weakening was attempted. **No ten-check
public preflight pass is claimed for `.8`**, and public new-consumer setup remains
blocked at that check. The public ZDR metadata helper is a separate observation.

All five older public profile hashes were re-fetched unchanged. Revision 6 changes
only revision and SDK version; all 21 models, deployment/proofs, tariffs and policy
remain. Existing custody and gateway discovery retain original bindings. The
release remains GitHub assets rather than npm; native is macOS ARM64, macOS 13.5+,
without Apple signing/notarization.

Publication added one immutable static profile and performed **zero live AUTH,
provider inference, wallet/grant actions, service restarts, program changes or
existing-custody migrations**. The prior request grant remains exhausted. Manual
settled-history erasure is unchanged; configurable automatic retention was not one
of the three high-priority changes. Program/setup/USDC trust differences remain.

Full signed subjects, CI cuts, public observations and preservation records are in
the [machine-readable receipt](PD-sdk8-publication-20261010.json). Two initial
patch-context checks failed before mutation; corrected contexts applied. An
abbreviated-SHA CI search returned no runs, and an incorrect artifact name returned
no match; full-SHA lookup and the listed artifact succeeded. Preserve those
preparations, public preflight failures, initial passing run and all earlier evidence.
