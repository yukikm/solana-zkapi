# PD-02 upstream redistribution evidence follow-up

Recorded: 2026-10-07, 12:47 UTC. Scope: read-only GitHub research and local
artifact hashing. This follows the interrupted inventory in
[the initial asset review](PD-02-asset-distribution-review.md), which remains
preserved. No upstream message, issue, release, setup generation, funding or
deployment action occurred.

## New evidence changes the licensing assessment

The **original repository has a repository-level license declaration**. Its
[root README at the exact imported revision](https://github.com/mingyech/zkAPI/blob/8b2d4e3da921f956e1eb6b93afbf722a877c060c/README.md#L97)
ends with a License section stating `MIT OR Apache-2.0`. The
[current root README](https://github.com/mingyech/zkAPI/blob/f87d3c80d7dba826e2ac593d4cc4aa931e56eb2b/README.md#L174)
repeats that declaration and expressly describes the four request/withdrawal
setup files as part of the project. This declaration is not limited to a Rust
workspace directory. The earlier review did not inspect this original root
README and therefore missed material evidence.

The original four setup blobs are identical to the locally pinned files and
the files imported into `ethereum/zkapi`, as shown below. The reviewed root
README declares the project's license without a stated setup-file exclusion;
no contrary setup-specific terms were found in the examined files or public
issue discussions. These are affirmative source facts, stronger than merely
finding a Cargo license field. They should be included in the release review.

No top-level license text file or original project copyright notice was found
in the examined original repository trees. GitHub repository metadata reports
`license: null` for both repositories, despite the original README declaration;
that metadata is not evidence that the README declaration does not exist.
**Distribution review decision: select the Apache-2.0 branch of the explicit
upstream repository-level declaration for the four unchanged files below, and
include the declaration, provenance and full standard license with the bundle.**
No conflicting restriction was found. The absence of a separate LICENSE file
is not treated as absence of a license declaration or as requiring new per-file
permission. This operational release review does not fabricate a copyright
holder, endorse a setup ceremony, or itself publish a release. It supersedes
the earlier missing-evidence reason for omitting these exact four files.

## Revisions and exact artifact identity

Live default-branch observations:

| Repository | Selected/pinned revision | Current `main` observed | Tree inventory |
|---|---|---|---|
| `ethereum/zkapi` | `045b444ea1b52538d1b40273c7cb6ed09468a052` | Same revision; commit time 2026-10-02 05:20:54 UTC | 570 entries, `truncated: false` |
| `mingyech/zkAPI` | `8b2d4e3da921f956e1eb6b93afbf722a877c060c` | `f87d3c80d7dba826e2ac593d4cc4aa931e56eb2b`; commit time 2026-09-28 15:02:40 UTC | 169 entries at each revision, `truncated: false` |

The pinned Ethereum
[provenance record](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/VENDORED.md)
identifies the original import and says its setup files were unchanged.
The three GitHub recursive tree responses independently list the same four
blob IDs and sizes. Local SHA-256 and Git blob SHA-1 calculations match those
identities and [the upstream lock](../../vendor/upstream-lock.json).

| File | Bytes | SHA-256 | Git blob SHA-1 |
|---|---:|---|---|
| `request.pk` | 5,935,783 | `c894b261a13f571d0df36be29734aabf2a8cd7162baddc5e08a50341aa076584` | `5fb7bd7e5c8db0426f293228187c16ce994b341d` |
| `request.vk` | 671 | `8011244c99fa1a8524870906462d430fc86366b8ad821736c5fa726b479e6d97` | `33666441aa6d5553d174f64df62874dd5f1f77d5` |
| `withdrawal.pk` | 7,783,719 | `8e41398092fdd02b9ff86c6ccbecbd7ce2402e6f22ec162e6124d1d04fe0a668` | `5f8e4cb5e8086215f6f7d6a26616ee4834b9e393` |
| `withdrawal.vk` | 735 | `2a8ea7f07176e369a93d1d816124192a798d1466c99fd6dc47850ba82094b679` | `3f0dc9b5652989e327293627e53641b865b73c0a` |

Exact inventories:

- [Ethereum pinned/current recursive tree](https://api.github.com/repos/ethereum/zkapi/git/trees/045b444ea1b52538d1b40273c7cb6ed09468a052?recursive=1).
- [Original imported recursive tree](https://api.github.com/repos/mingyech/zkAPI/git/trees/8b2d4e3da921f956e1eb6b93afbf722a877c060c?recursive=1).
- [Original current recursive tree](https://api.github.com/repos/mingyech/zkAPI/git/trees/f87d3c80d7dba826e2ac593d4cc4aa931e56eb2b?recursive=1).

The original trees contain no tracked path matching LICENSE, COPYING or NOTICE.
The Ethereum tree contains license files for forge-std, OpenZeppelin and clientd,
plus a release-notice collection script; none is a setup-directory license
file. These inventories cover the returned trees, not the contents of external
Git submodules or every historical branch.

The Ethereum [notice collection script](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/zkapi-clientd/scripts/collect-release-notices.py)
preserves dependency license declarations and explicitly avoids assigning the
clientd copyright notice to protocol sources lacking their own top-level
license text. It supplies useful upstream packaging practice, not separate
authorization for these four outputs.

The original [setup README](https://github.com/mingyech/zkAPI/blob/f87d3c80d7dba826e2ac593d4cc4aa931e56eb2b/setup/v2/README.md)
records OS-random single-party generation and warns that matching file hashes
do not prove destruction of setup secrets. It requires matching new verifiers
for regenerated setups and preservation of old wallet recovery data. Those
technical limitations remain applicable regardless of the distribution
decision.

## Public issue and discussion checks

The GitHub APIs returned 24 total open/closed Ethereum issue and pull-request
bodies, 12 issue-conversation comments and zero inline pull-request comments
with `per_page=100`. Titles/bodies and returned comments were searched for
license, redistribution, copyright, permission and setup-terms language. The
matches concerned an Xcode license or private filesystem permissions; no
setup-output licensing clarification was found. This is the examined public
API scope, not a claim about private communication or every review record.

- [All Ethereum issues and pull-request bodies](https://api.github.com/repos/ethereum/zkapi/issues?state=all&per_page=100).
- [Ethereum issue-conversation comments](https://api.github.com/repos/ethereum/zkapi/issues/comments?per_page=100).
- [Ethereum inline pull-request comments](https://api.github.com/repos/ethereum/zkapi/pulls/comments?per_page=100).
- [Original repository metadata](https://api.github.com/repos/mingyech/zkAPI) reports issues disabled; its [issues endpoint](https://api.github.com/repos/mingyech/zkAPI/issues?state=all&per_page=100) returned an empty array.

## Bundle notices and release record

The per-file distribution record should state `Apache-2.0`, unchanged upstream
bytes, the selected imported revision, the SHA-256 above, and this review as its
decision evidence. The bundle must accompany the files with:

1. The exact original root README from the imported revision, preserving its
   `MIT OR Apache-2.0` declaration. Record the chosen Apache-2.0 branch without
   rewriting the source declaration to appear Apache-only.
2. The full standard Apache License 2.0 text. An independently versioned source
   is [SPDX's standard text at `31ba1a50e5397e00a304dbadc76531740e89ee48`](https://github.com/spdx/license-list-data/blob/31ba1a50e5397e00a304dbadc76531740e89ee48/text/Apache-2.0.txt).
   Preserve the standard appendix as boilerplate; do not fill its placeholder
   with a guessed copyright owner or transfer the clientd copyright notice.
3. The exact imported setup README and Ethereum `protocol/VENDORED.md`, plus an
   added project provenance note identifying the source repositories, revisions,
   paths, unchanged file hashes and selected license branch. Label this as our
   provenance note, not a purported upstream NOTICE file.
4. Applicable existing upstream notices and single-party setup limitations.
   No separate original NOTICE file was found in these two original-repository
   trees; the inspected setup manifest has no license, copyright or notice
   field. Preserve notices for any additional source/dependency materials in
   the complete bundle under their own scopes.

Publication must retain the exact proof bytes and independent descriptor/profile
trust anchors. This decision does not alter old releases or imply a new setup.
Actual public downloads and installed native/WASM proof acceptance remain
PD-02 work after packaging and publication.

## Optional clarification draft, not a release prerequisite

If the operator elects to obtain additional upstream confirmation, the question
can remain narrow. It is not required by this source review solely because the
repository expresses its license in README rather than a separate file:

> Does the root README's `MIT OR Apache-2.0` declaration apply to the four
> unchanged generated files `setup/v2/request.pk`, `request.vk`, `withdrawal.pk`
> and `withdrawal.vk` at `mingyech/zkAPI@8b2d4e3da921f956e1eb6b93afbf722a877c060c`,
> imported into `ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`?
> We intend to redistribute those exact bytes in an immutable Solana Devnet
> client proof bundle, preserving source attribution, hashes and single-party
> setup warnings. Please confirm the applicable license choice and the exact
> copyright/license/notice text we should include, or identify any separate
> terms for these outputs. The four byte hashes are listed in the table above.

This is a draft only. Sending an issue, email or other message requires explicit
user authorization; no contact has been made. Its possible recipients are the
current importing repository's maintainers and the original source owner; this
report does not claim either person's legal authority over another contributor.

The previously described complete-new-setup path remains technically possible,
but the missing-evidence rationale for selecting it has been removed. No keys
or existing deployment pins were changed. PD-02's full acceptance still requires
the recorded per-file decision and notice packaging, immutable public
publication and actual downloadable-byte proof validation.
