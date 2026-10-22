# Layout 2 circuit fixtures

These test-only fixtures pin the original tree circuit, proving/verifying keys
and circuit profile. They do not establish production setup trust.

`source/Cargo.lock` preserves the exact dependency-lock bytes used by the pinned
source archive. It is copied from the root `Cargo.lock` at commit
[`cf66438410bea482e571bf5319a576fa80dded81`](https://github.com/yukikm/solana-zkapi/blob/cf66438410bea482e571bf5319a576fa80dded81/Cargo.lock),
with SHA-256 `e4489876e3ee37a9a67647a272729444535aa3d6279ae15807d5ae0535113291`.
All 131 packages belong to the transitive dependency closure of
`zkapi-tree-prover`, including its test dependencies.

`scripts/build_i02_source.sh` first compares that closure with the current
workspace lock, including package versions, sources, checksums and dependency
edges. Unrelated workspace packages are ignored. Missing, ambiguous or changed
prover dependencies fail before an archive is written. The archived lock keeps
the original member name `Cargo.lock`, preserving the existing source archive,
profile, keys and program bindings byte for byte when the circuit is unchanged.

Do not refresh the snapshot just to make CI pass. Intentional circuit dependency
changes require reviewing the source archive and profile under the
[tree transition contract](../../../docs/specs/tree-transition.md#circuit-profile-and-setup).
Existing deployments and published artifacts retain their original bindings.

Run `python3 scripts/check_i02_reproducibility.py` with Python 3.11 or newer and
GNU tar to verify archive metadata, workspace isolation and drift rejection.
The local report is written under `target/i02b/`; real proof and SBF checks are
separate gates in [testing](../../../docs/testing.md).
