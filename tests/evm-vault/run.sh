#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
zkapi_evm_tools="${ZKAPI_EVM_TOOLS:-$HOME/.cache/zkapi/evm-1.3.1}"
if [[ ! -x "$zkapi_evm_tools/forge" || ! -x "$zkapi_evm_tools/solc-0.8.28" ]]; then
  bash scripts/install_i02_evm_tools.sh
fi
if [[ "${1:-}" == --generate ]]; then
  cargo run --locked --release -p zkapi-tree-prover --example evm_vault
fi
mkdir -p target/i03/evm-traces
# Only this runner's generated JSON is removed; checked-in evidence is untouched.
find target/i03/evm-traces -maxdepth 1 -name '*.json' -delete
"$zkapi_evm_tools/forge" test --root tests/evm-vault --use "$zkapi_evm_tools/solc-0.8.28" --json > target/i03/evm-results.json
python3 tests/evm-vault/compare.py --collect
