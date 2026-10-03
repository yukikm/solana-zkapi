#!/usr/bin/env bash
# Fixed Linux x86_64 tools for the independent EVM empty-root check.
set -euo pipefail
[[ "$(uname -sm)" == "Linux x86_64" ]]
zkapi_evm_dir="${ZKAPI_EVM_TOOLS:-$HOME/.cache/zkapi/evm-1.3.1}"
mkdir -p "$zkapi_evm_dir"
if [[ ! -x "$zkapi_evm_dir/forge" ]]; then
  curl --fail --location --silent --show-error https://github.com/foundry-rs/foundry/releases/download/v1.3.1/foundry_v1.3.1_linux_amd64.tar.gz -o "$zkapi_evm_dir/foundry.tar.gz"
  (cd "$zkapi_evm_dir" && echo 'baad3e1b06d6f310d210c93e95258a03d923fe610f8d0742138f2245f94abd7c  foundry.tar.gz' | sha256sum --check)
  tar xzf "$zkapi_evm_dir/foundry.tar.gz" -C "$zkapi_evm_dir" forge
fi
if [[ ! -x "$zkapi_evm_dir/solc-0.8.28" ]]; then
  curl --fail --location --silent --show-error https://github.com/ethereum/solidity/releases/download/v0.8.28/solc-static-linux -o "$zkapi_evm_dir/solc-0.8.28"
  chmod +x "$zkapi_evm_dir/solc-0.8.28"
fi
(cd "$zkapi_evm_dir" && echo '9a0fb7e0db2c0641dbae1c5cc645dc686820c83af516226abb1c0a2f76636f25  solc-0.8.28' | sha256sum --check)
"$zkapi_evm_dir/forge" --version
