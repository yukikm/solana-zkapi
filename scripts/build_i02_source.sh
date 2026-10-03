#!/usr/bin/env bash
# Canonical source bytes for the layout 2 circuit profile, independent of checkout metadata.
set -euo pipefail
cd "$(dirname "$0")/.."
zkapi_archive="${1:-target/i02b/circuit-source.tar}"
mkdir -p "$(dirname "$zkapi_archive")"
# Apply rw/r first, then add search permission only to directories. Source files
# are always 0644 and directories 0755, even under umask 077 or executable drift.
LC_ALL=C tar --format=gnu --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  --mode='u=rw,go=r,a+X' -cf "$zkapi_archive" \
  Cargo.lock crates/zkapi-tree-prover/src/circuit.rs crates/zkapi-tree-prover/Cargo.toml \
  crates/zkapi-poseidon/src vendor/ethereum-zkapi/protocol/rust/crates/zkapi-proof/src/groth16.rs
