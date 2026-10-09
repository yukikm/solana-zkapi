# SDK/native 0.2.0-devnet.6 publication

Published **2026-10-09T09:02:13Z** as the immutable
[`v0.2.0-devnet.6` release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.6) from exact source
`ac2c9be39084c78375122bbfaa12b5ccf454f563`, committed and pushed to `main`. The user's explicit request covered
GitHub commits, push and SDK/native publication. This record follows the earlier
[source-only session reuse checkpoint](PD-session-reuse-20261009.md), which remains
unchanged as a dated observation.

## Distribution and compatibility

The GitHub release contains six assets: SDK tarball, macOS ARM64 native archive,
superproject source archive, revision-4 profile, release manifest and SHA256SUMS.
The SDK's `private: true` policy remains; distribution uses the release tarball,
not an npm registry package. The native package requires macOS 13.5 or later and
is not Apple signed/notarized. Other operating systems are not claimed.

| Artifact | SHA-256 |
|---|---|
| SDK `.6` | `4c36a3cff38efcd33978a0896b605c986bc4bb0a8b88be00e485681a5ed10002` |
| macOS ARM64 archive | `b4418217b7364bfaabeaa4e42c13bd56c5cee88707301779b13209e164db85a0` |
| Native `release.json` | `99cf5fe8c1691bc0125ed63d52dc3835dfa4c8e3678696667b047f7bc292a94d` |
| Revision-4 profile | `3f8af848ea882f478d5b00c30d677fa5147a5b45d2bf1aceaa4f645a62d50179` |

The [consumer release guide](../releases/session-reuse-preview.md) provides
installation commands and the exact profile URL. This new immutable profile
preserves revision 3's 21 models, bundle, routes, tariffs and capabilities; only
revision and supported SDK version differ. The original three profile digests
remain unchanged. Gateway discovery continues to return the `.3` profile.
Existing custody keeps its original SDK/runtime, profile, journal and recovery
inputs. No independent chat application or existing client installation changed.

## Verification

- GitHub's release attestation and **all six asset attestations** passed.
  All six assets were downloaded anonymously and matched exact hashes/sizes.
- The native archive's **7,257 files** matched its authenticated manifest, including
  after public preflight and public-input generation. All **577 build inputs**
  match the exact source commit and pinned Ethereum submodule. The source archive's
  **1,714 files** match Git. Vendor contents require the recorded submodule checkout.
- Local and hosted SDK suites: **397/397 passed**, zero skips. Independent installed
  package: **84/84 passed**, zero skips. Hosted and local SDK tarballs are identical.
  Typecheck, builds, browser/worker bundles, model-profile tests and design checks passed.
- [SDK/clientd CI](https://github.com/yukikm/solana-zkapi/actions/runs/37906874782):
  **both jobs passed**, including real Chrome, isolated package, Go race and helper tests.
- [Implementation CI](https://github.com/yukikm/solana-zkapi/actions/runs/37906874764):
  **7/9 jobs passed and 2 still running** at the release cut. No full-suite pass is claimed; follow the linked run for later results.
- Public native **ten-check read-only preflight** passed with the `.6` revision-4
  profile. Public input generation also passed and produced 21 models, 60-second
  reuse and a 120-second settlement wait. It created no custody and started no daemon.
- The original immutable `.3` release metadata and asset identities/digests are unchanged.

Full public facts, artifact URLs, pins, CI job conclusions and scope are in the
[machine-readable receipt](PD-sdk6-publication-20261009.json).

## Preserved preparation failures and boundaries

The first offline profile verifier used an incorrect relative import and failed
before reading profile data; the corrected verifier passed 27 local reads and
rejected an old custody binding before any fetch. The first native/source join
rejected commit `583fd12c4d02a7ec664ac693e669840036dbf787` because the updated
workspace `package-lock.json` was not staged. Successor `ac2c9be39084c78375122bbfaa12b5ccf454f563` includes
those exact already-built bytes, and the complete source join passed without
changing the packaged inputs. A draft-release tag lookup returned HTTP404;
listing existing drafts found the same release and verified the uploaded assets.
No duplicate release or asset overwrite was needed. After every new-release
download, attestation and native archive check passed, the final old-release
metadata GET returned HTTP502. A separate metadata retry succeeded; continuation
rehashed the saved downloads and verified the original `.3` release was unchanged.
Earlier source tests and
HTTPS preparation failures remain in the preceding source-only evidence.

Publication added one immutable static profile object. It performed **zero live
AUTH, paid inference, wallet transactions, grant changes, service restarts or
custody migrations**. The existing seven-request grant remains exhausted. Local
fixtures, CI and read-only preflight do not establish paid multi-request `.6`
acceptance, arbitrary application integration or long-term production availability.
