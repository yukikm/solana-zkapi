# PD-02 notice packaging checkpoint

Recorded 2026-10-07. The [source redistribution follow-up](PD-02-redistribution-followup.md)
resolved the earlier missing-license-evidence reason for omitting four unchanged
request/withdrawal setup files. This checkpoint implements authenticated notice
distribution for those files; it does not publish a bundle or claim PD-02's full
downloaded-byte/proof acceptance.

The [exact-file decision](../../deploy/public-devnet/upstream-setup-distribution.json)
selects Apache-2.0 from the original root README's `MIT OR Apache-2.0` declaration.
Its four setup SHA-256 values match the pinned upstream lock. Four accompanying
upstream/standard documents preserve their original Git blob identities and
byte hashes. The fifth document, [PROVENANCE.md](../../deploy/public-devnet/upstream-notices/PROVENANCE.md),
is explicitly our added provenance note. It invents no copyright holder and
retains the single-party development-setup limitations. This record applies to
these four files, not arbitrary setup files or every complete bundle component.

The offline packager accepts optional public notice paths and emits descriptor
schema 2. The SDK requires every notice byte sequence to match the descriptor's
size and hash before returning authenticated `assets.notices`. A missing or
modified notice fails the entire load. Bounds are 32 entries, 1 MiB per notice
and 4 MiB total, within the existing global bundle limits. Labels and filenames
are bounded flat names; references cannot collide with manifest, proof or WASM
files. No-notice packaging retains schema 1 and earlier descriptor snapshots
are unchanged. Older SDK releases do not understand schema 2.

The [local results](PD-02-notice-packaging.json) record 25 passing Node tests:
10 deployment-loader tests, 10 public-profile tests and 5 packager tests.
Ten Python publication-review tests also passed. These overlapping local
fixture scopes cover exact notice copies, mandatory retrieval/hash checks,
caller mutation isolation, invalid paths/collisions/counts, size bounds and
refusal to overwrite existing output. The installed SDK/native-helper checks
and actual public download/proof acceptance belong to separate integration
reports. No test performed funding, setup regeneration, public publication or
external network activity.

The complete candidate must have its own exact-file publication review, immutable
SDK/profile/bundle pins and downloaded native/WASM proof acceptance. Preserve the
old evidence and immutable releases; this checkpoint creates no new funded or
public-provider success claim.
