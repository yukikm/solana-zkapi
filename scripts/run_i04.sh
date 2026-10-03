#!/usr/bin/env bash
# Local test keys/mint: real SBF + SDK + finalized-history replay. No release gate.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(cargo-build-sbf --version | sed -n '1p')" == 'cargo-build-sbf 4.1.0' ]]
mkdir -p target/i04
export RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-4}"
python3 scripts/check_upstream.py
python3 scripts/check_i02_reproducibility.py
cargo test --locked --manifest-path programs/zkapi-vault/Cargo.toml
build_vault() {
  local zkapi_features="$1" zkapi_output="$2" zkapi_log="$3"
  cargo build-sbf --manifest-path programs/zkapi-vault/Cargo.toml \
    --tools-version v1.54 --arch v0 --features "$zkapi_features" \
    --sbf-out-dir "$zkapi_output" -- --locked 2>&1 | tee "$zkapi_log"
  if grep -Ei 'stack offset .*exceeded|stack frame size.*exceed' "$zkapi_log"; then
    echo 'FAIL: SBF stack exceeds the supported frame size' >&2
    exit 1
  fi
}
build_vault sbf-entrypoint target/i04-sbf target/i04/sbf-build.log
build_vault sbf-entrypoint,wrong-vk target/i04-sbf-wrong target/i04/sbf-wrong-build.log
cargo run --locked --manifest-path tests/svm/Cargo.toml --bin buffer
cargo run --locked --manifest-path tests/svm/Cargo.toml --bin vault -- \
  target/i04-sbf/zkapi_vault.so target/i04-sbf-wrong/zkapi_vault.so target/i04/i03-regression
cargo run --locked --manifest-path tools/vault-idl/Cargo.toml
python3 scripts/check_vault_idl.py
python3 scripts/test_check_vault_idl.py
npm run typecheck
npm test
cargo run --locked --manifest-path tests/svm/Cargo.toml --bin sdk_transport
cargo test --locked --manifest-path services/indexer/Cargo.toml
cargo run --locked --manifest-path services/indexer/Cargo.toml --example verify_history -- \
  target/i04/sdk-svm-history.json > target/i04/indexer-results.json
python3 scripts/check_i04_results.py
cargo fmt --manifest-path services/indexer/Cargo.toml -- --check
cargo clippy --locked --manifest-path services/indexer/Cargo.toml --all-targets -- -D warnings
cargo clippy --locked --manifest-path programs/zkapi-vault/Cargo.toml --all-targets -- -D warnings
cargo clippy --locked --manifest-path tests/svm/Cargo.toml --all-targets -- -D warnings
