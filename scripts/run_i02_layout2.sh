#!/usr/bin/env bash
# Completes the adopted I02-B measurement gate; full Vault G1 remains I03/I04.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(cargo-build-sbf --version | sed -n '1p')" == 'cargo-build-sbf 4.1.0' ]]
mkdir -p target/i02b
cargo fmt --all -- --check
# Exact portable archive bytes, not a hash of a directory listing.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf target/i02b/circuit-source.tar \
  Cargo.lock crates/zkapi-tree-prover/src/circuit.rs crates/zkapi-tree-prover/Cargo.toml \
  crates/zkapi-poseidon/src vendor/ethereum-zkapi/protocol/rust/crates/zkapi-proof/src/groth16.rs
cargo run --release --locked -p zkapi-tree-prover --example fixtures
cargo fmt --manifest-path programs/i02-layout2/Cargo.toml
cargo test --locked -p zkapi-tree-prover --test layout2
python3 - <<'PY'
import json
from pathlib import Path
p=Path('target/i02b')
p.joinpath('cli-witness.json').write_text(json.dumps(json.load(open('tests/fixtures/layout2/a.json'))['trees'][0]))
PY
zkapi_profile_hash=$(python3 -c 'import json; print(json.load(open("tests/fixtures/layout2/profile.json"))["circuit_profile_hash"])')
cargo run --locked --release -p zkapi-tree-prover --bin tree-prover -- --test-profile \
  tests/fixtures/layout2/profile.json "$zkapi_profile_hash" target/i02b/test-tree.pk \
  target/i02b/cli-witness.json target/i02b/cli-tree-update.bin
cargo build-sbf --manifest-path programs/i02-layout2/Cargo.toml --tools-version v1.54 --arch v0 --sbf-out-dir target/i02b/sbf -- --locked
cargo build-sbf --manifest-path programs/i02-layout2/Cargo.toml --tools-version v1.54 --arch v0 --features wrong-vk --sbf-out-dir target/i02b/sbf-wrong -- --locked
cargo run --locked --manifest-path tests/svm/Cargo.toml --bin layout2
zkapi_evm_dir="${ZKAPI_EVM_TOOLS:-$HOME/.cache/zkapi/evm-1.3.1}"
"${ZKAPI_FORGE:-$zkapi_evm_dir/forge}" test --root tests/evm-layout2 --offline \
  --use "${ZKAPI_SOLC:-$zkapi_evm_dir/solc-0.8.28}" --json > target/i02b/evm-empty-root.json
python3 scripts/check_i02_layout2.py
