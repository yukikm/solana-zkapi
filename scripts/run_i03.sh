#!/usr/bin/env bash
# I03 real Vault tests using public TEST keys. Not a production release gate.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(cargo-build-sbf --version | sed -n '1p')" == 'cargo-build-sbf 4.1.0' ]]
mkdir -p target/i03
export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-4}"
python3 scripts/check_upstream.py
python3 scripts/check_i02_reproducibility.py
cargo run --release --locked -p zkapi-tree-prover --example vault_fixtures
python3 scripts/check_vault_fixtures.py
cargo test --locked --manifest-path programs/zkapi-vault/Cargo.toml
build_vault() {
  local zkapi_features="$1" zkapi_output="$2" zkapi_log="$3"
  cargo build-sbf --manifest-path programs/zkapi-vault/Cargo.toml \
    --tools-version v1.54 --arch v0 --features "$zkapi_features" \
    --sbf-out-dir "$zkapi_output" -- --locked 2>&1 | tee "$zkapi_log"
  # LLVM may report an oversized SBF frame without failing cargo-build-sbf.
  if grep -Ei 'stack offset .*exceeded|stack frame size.*exceed' "$zkapi_log"; then
    echo 'FAIL: SBF stack exceeds the supported frame size' >&2
    exit 1
  fi
}
build_vault sbf-entrypoint target/i03-sbf target/i03/sbf-build.log
build_vault sbf-entrypoint,wrong-vk target/i03-sbf-wrong target/i03/sbf-wrong-build.log
cargo run --locked --manifest-path tests/svm/Cargo.toml --bin vault
cargo run --locked --manifest-path tools/vault-idl/Cargo.toml
python3 scripts/check_vault_idl.py
bash tests/evm-vault/run.sh --generate
python3 tests/evm-vault/compare.py
python3 scripts/check_i03_results.py
