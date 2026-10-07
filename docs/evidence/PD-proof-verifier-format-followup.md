# Offline proof verifier formatting follow-up

Date: 2026-10-08 JST.

Rust 1.90.0 formatting was applied to
`crates/zkapi-tree-prover/examples/verify_public_bundle.rs`. Its original bytes
are retained. Exact token comparison found only whitespace changes and two
trailing-comma insertions; every literal and comment remains byte-identical.
Input bounds, circuit selection, key/proof verification and redacted error
behavior are unchanged.

The local root-workspace formatting check passed. Root-workspace Clippy also
passed with `--locked --offline --all-targets -- -D warnings` in 17.15 seconds.
The [checkpoint](PD-proof-verifier-format-followup.json) pins both source
versions and the actual validation logs.

The original 187-input archive-indexer build manifest and all its copied
inputs remain unchanged. This formatted example is a distinct source snapshot;
no installed binary or release artifact was rebuilt or replaced. No new proof
generation/verification run, hosted CI success, public readiness, provider
request, funding or release-gate result is claimed.
