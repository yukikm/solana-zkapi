#!/usr/bin/env bash
# Research only. Does not select a production backend or change the G1 gate.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(cargo-build-sbf --version | sed -n '1p')" == "cargo-build-sbf 4.1.0" ]] || { echo "Run scripts/install_sbf_tools.sh first"; exit 1; }
mkdir -p target/i02-research-results
cargo test --locked -p zkapi-poseidon --features research-dot-product
build() {
  local name="$1" arch="$2" features="$3"
  local flags=()
  if [[ -n "$features" ]]; then flags=(--features "$features"); fi
  cargo build-sbf --manifest-path programs/i02-harness/Cargo.toml \
    --tools-version v1.54 --arch "$arch" "${flags[@]}" \
    --sbf-out-dir "target/i02-research-$name" -- --locked
}
probe() {
  local name="$1"
  shift
  cargo run --locked --manifest-path tests/svm/Cargo.toml --bin poseidon_probe -- \
    "target/i02-research-$name/zkapi_i02_harness.so" "$@" \
    > "target/i02-research-results/$name.json"
}
build base v0 ""
probe base
build v2 v2 ""
probe v2
build v0-dot v0 research-dot-product
probe v0-dot
build v2-dot v2 research-dot-product
probe v2-dot
build syscall v0 research-syscall
probe syscall syscall
build proof-tag v0 research-proof-bound-tag
build proof-tag-wrong v0 research-proof-bound-tag,wrong-vk
cargo run --locked --manifest-path tests/svm/Cargo.toml --bin fallback_probe -- \
  target/i02-research-proof-tag/zkapi_i02_harness.so \
  target/i02-research-proof-tag-wrong/zkapi_i02_harness.so \
  > target/i02-research-results/proof-tag.json
python3 scripts/collect_i02_optimization.py
