#!/usr/bin/env bash
# Pinned Linux x86_64 test toolchain. Network access uses the inherited proxy.
set -euo pipefail
[[ "$(uname -sm)" == "Linux x86_64" ]] || { echo 'Requires Linux x86_64'; exit 1; }
if ! command -v cargo-build-sbf >/dev/null || ! cargo-build-sbf --version | head -1 | grep -qx 'cargo-build-sbf 4.1.0'; then
  cargo install cargo-build-sbf --version 4.1.0 --locked
fi
zkapi_tools="$HOME/.cache/solana/v1.54/platform-tools"
if [[ ! -x "$zkapi_tools/rust/bin/rustc" ]]; then
  zkapi_tmp=$(mktemp -d)
  trap 'rm -rf "$zkapi_tmp"' EXIT
  curl --fail --location --silent --show-error \
    https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-linux-x86_64.tar.bz2 \
    -o "$zkapi_tmp/platform-tools.tar.bz2"
  (cd "$zkapi_tmp" && echo 'fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e  platform-tools.tar.bz2' | sha256sum --check)
  mkdir -p "$zkapi_tools"
  tar xjf "$zkapi_tmp/platform-tools.tar.bz2" -C "$zkapi_tools"
fi
cargo-build-sbf --version
"$zkapi_tools/rust/bin/rustc" --version
