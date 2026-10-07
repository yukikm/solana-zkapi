# PD-02 proof asset distribution review

Recorded: 2026-10-07 JST. Scope: read-only source/provenance review. This review
does not approve redistribution, publish a bundle, generate a setup, change an
existing deployment or establish live acceptance. The four upstream setup
assets remain excluded from public release preparation until a reviewed
distribution decision is recorded. No conclusion that redistribution is
legally prohibited follows from the missing evidence.

## Exact assets and provenance

The selected source is
[`ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`](https://github.com/ethereum/zkapi/tree/045b444ea1b52538d1b40273c7cb6ed09468a052).
The local [upstream lock](../../vendor/upstream-lock.json) pins these bytes:

| File under `protocol/setup/v2/` | SHA-256 | Distribution decision |
|---|---|---|
| `request.pk` | `c894b261a13f571d0df36be29734aabf2a8cd7162baddc5e08a50341aa076584` | Unresolved; excluded |
| `request.vk` | `8011244c99fa1a8524870906462d430fc86366b8ad821736c5fa726b479e6d97` | Unresolved; excluded |
| `withdrawal.pk` | `8e41398092fdd02b9ff86c6ccbecbd7ce2402e6f22ec162e6124d1d04fe0a668` | Unresolved; excluded |
| `withdrawal.vk` | `2a8ea7f07176e369a93d1d816124192a798d1466c99fd6dc47850ba82094b679` | Unresolved; excluded |

The pinned upstream [protocol provenance](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/VENDORED.md)
records an import from
[`mingyech/zkAPI@8b2d4e3da921f956e1eb6b93afbf722a877c060c`](https://github.com/mingyech/zkAPI/tree/8b2d4e3da921f956e1eb6b93afbf722a877c060c)
and states that the setup files were unchanged. The
[setup README](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/setup/v2/README.md)
describes OS-random single-party generation, matching verifier/prover pins and
the absence of a multiparty ceremony; it does not supply redistribution terms.
The pinned
[Rust workspace](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/protocol/rust/Cargo.toml)
declares `MIT OR Apache-2.0`. The setup binaries are outside that workspace's
crate directories. The separate
[clientd license](https://github.com/ethereum/zkapi/blob/045b444ea1b52538d1b40273c7cb6ed09468a052/zkapi-clientd/LICENSE)
does not establish coverage of every upstream directory.

Local pinned-tree inspection found no root LICENSE. Read-only GitHub Contents
responses for the current `ethereum/zkapi` root and the original imported
`mingyech/zkAPI` revision also listed no root LICENSE. A later recursive online
inventory could not complete after a network/approval interruption, so this is
not an exhaustive claim about all current branches, issues or external grants.
No authoritative per-file redistribution grant was established from the
examined sources. The existing [third-party notices](../../THIRD_PARTY_NOTICES.md)
and [release omission](../releases/devnet-preview.md) remain accurate.

## Existing packaging and the required decision

The offline [bundle packager](../../scripts/package_sdk_distribution_assets.mjs)
already verifies the signed manifest, independent trust policy, all nine named
artifact fields, additional manifest artifacts and the exact WASM digest. It
writes a new directory and a bounded descriptor containing file sizes/hashes;
it does not upload files or decide their redistribution terms. The
[SDK loader](../../packages/sdk/src/deployment.ts) verifies that descriptor and
the artifacts for independent consumers. Keep these mechanisms and the
[distribution format](../../packages/sdk/DISTRIBUTION.md).

Before publishing a complete bundle, record for each of the four exact hashes:
the rights/provenance evidence URL or preserved grant, the reviewed decision,
review date and reviewer, and required notices. A declaration covering only
another directory or package is insufficient evidence for this record. If
permission must be sought, contact with upstream is a separate user-authorized
action; no message was sent during this review. Public-release preparation
should fail closed when any file lacks its reviewed record. Local offline
packaging is not publication and need not be disabled.

After a distribution decision, package the selected deployment's full bundle,
publish immutable bytes through the reviewed release channel, then test actual
anonymous downloads with the installed SDK, real matching native/WASM proofs,
and missing/modified/mixed-artifact rejection. A local packaging pass does not
complete PD-02's downloadable-byte acceptance.

## Alternative: a new complete experimental setup

Generating new request/withdrawal keys is technically available via the pinned
[setup example](../../vendor/ethereum-zkapi/protocol/rust/crates/zkapi-proof/examples/setup.rs)
and `zkapi_proof::compact::setup`. That uses OS randomness and requires a new
output directory. It produces an incompatible setup, not replacements for
currently pinned keys. Generation alone is neither a reviewed ceremony nor a
distribution-rights determination for included source and generated material.

The current Solana
[public setup generator](../../crates/zkapi-tree-prover/examples/public_devnet_setup.rs)
generates fresh role keys and tree keys but **copies the same four upstream
request/withdrawal files**. Running it again does not resolve their omission.
A complete alternative requires a versioned implementation and fresh acceptance:

1. Generate request, withdrawal and tree artifacts into a new isolated setup;
   record source revisions, generator/build provenance, file sizes/hashes,
   limitations and an explicit distribution decision. Preserve old assets.
2. Extend the [Python profile reader](../../scripts/public_devnet_profile.py),
   [TypeScript profile reader](../../scripts/i10_public_devnet_profile.ts) and
   [Rust build-profile validator](../../programs/zkapi-vault/build_profile.rs)
   under an explicit versioned contract. They currently require the four old
   request/withdrawal hashes. Do not merely remove their pin checks.
3. Derive and validate all matching verifier constants. The
   [Vault](../../programs/zkapi-vault/src/lib.rs) selects a generated tree verifier
   for public Devnet but still imports request/withdrawal constants from
   [the existing harness](../../programs/i02-harness/src/vk.rs). A new complete
   setup needs build-selected request/withdrawal verifiers and corresponding
   PK/VK/circuit correspondence checks.
4. Build and test a new program/Pool and separately versioned manifest/profile,
   binding compiler-backed IDL, verifier constants, circuit profile, build,
   signing roles, WASM/native artifacts and independent trust anchors. Exercise
   real proofs and negative mixed-setup checks before funded acceptance.
5. Publish and accept the new deployment as a separate identity. Existing notes,
   recovery routes, funded/uncertain journals and immutable releases retain
   their original program/Pool/setup pins.

No alternate setup, program, Pool or release was created in this review. PD-02
remains open pending the distribution decision and actual public-byte proof
acceptance.
