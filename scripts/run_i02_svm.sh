#!/usr/bin/env bash
# Success means reproducing the recorded PASS/FAIL cases, NOT passing G1.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(cargo-build-sbf --version | sed -n '1p')" == "cargo-build-sbf 4.1.0" ]] || { echo "Run scripts/install_sbf_tools.sh first"; exit 1; }
cargo run --locked -p zkapi-solana-crypto --example export_sbf
cargo run --locked --release -p zkapi-solana-crypto --example tree_setup
cargo fmt --all
cargo fmt --manifest-path programs/i02-harness/Cargo.toml
cargo fmt --manifest-path tests/svm/Cargo.toml -- --check
cargo build-sbf --manifest-path programs/i02-harness/Cargo.toml \
  --tools-version v1.54 --arch v0 --sbf-out-dir target/i02-sbf -- --locked
cargo build-sbf --manifest-path programs/i02-harness/Cargo.toml \
  --tools-version v1.54 --arch v0 --features wrong-vk --sbf-out-dir target/i02-sbf-wrong -- --locked
cargo run --locked --manifest-path tests/svm/Cargo.toml
python3 scripts/check_i02_results.py
