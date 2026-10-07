# Public profile client release — 2026-10-08 JST

The immutable GitHub prerelease
[`v0.2.0-devnet.2`](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.2)
was published at `2026-10-07T20:29:36Z` (release ID `406136637`). Its tag resolves
to `5ded36bf39de9b9fb6bf27a10d744437abc6a9c7`. GitHub's release attestation and
the SDK and native asset attestations were verified locally. The
[machine-readable record](PD-public-client-publication.json) retains exact hashes
and the scope of those checks.

The SDK is SHA256
`fe9917b7f11e4bec0837bc7aac7624ad2965aa9bca007d61b877f263620143dc`;
the macOS ARM64 archive is
`9a2ab6759d99b3d7031b4c939ab654caeec2244763d1f16538e471bd5675cb56`.
These are the already validated public-profile client archives, copied without
rebuilding or repacking. All 551 recorded source inputs, including the upstream
gitlink, were joined to the exact release commit using an isolated Git index.
The main working checkout and earlier release tags were not replaced. Later
operator fixes have their own source snapshots and Linux build evidence.

All four release assets were downloaded anonymously using TLS verification and
matched their expected sizes and digests. The downloaded native archive was
independently extracted after member-type/path validation; all 7,257 installed
file hashes matched its pinned `release.json`
(`0b5733718f51eabcf4ca57f2406eb36bab641e23d642aac2436ca0e3090572ca`).
The downloaded clientd help, Node `v24.19.0`, and public consumer helper help
executed successfully. These checks created no custody and made no financial or
provider operation.

[Focused hosted CI](PD-public-client-hosted-ci.md) passed at the exact source
commit: 377 SDK tests, 75 installed-package fixtures, consumer helper tests and
three Go race packages, within their separately recorded scopes. Its generated
SDK digest matches the published archive. The workflow did not build the macOS
native archive; the release attestation authenticates GitHub's published
tag/assets and is not a native build attestation.

Release notes independently publish the current
[profile](https://d366buuvadnp3.cloudfront.net/releases/public-devnet-20261008-a/profile.json)
pin `5e868f8e57ef06961b73ba8cb755635e81d4bb168dd6ad498152496ac1b02d14`.
The complete proof bundle and notices are hosted separately. Frozen archive
documentation retains some build-time candidate wording and older `.1` examples;
the release notes and [current deployment guide](../sdk/public-devnet-preview.md)
select the `.2` downloads and current onboarding inputs.

Operator catch-up and funded browser/native/OpenClaw lifecycle acceptance remain
in progress. This publication does not establish them, Apple signing or
notarization, npm-registry publication, mainnet, audit, full I10 or G1–G4.
The earlier immutable releases and all existing budget reservations remain
preserved.
