#!/usr/bin/env bash
# Exact SBF test toolchain; release archive hashes from anza-xyz/platform-tools v1.54.
set -euo pipefail
case "$(uname -sm)" in
  "Linux x86_64") zkapi_platform=linux-x86_64; zkapi_sha=fcc41631c7f77561bf5412218bf297501dccf0305ea280f338f0ace2aab9f31e ;;
  "Darwin arm64") zkapi_platform=osx-aarch64; zkapi_sha=1c8b3af5e8614e1c459393a95c5b19bfbcc8ed13822a1cb539fae68471f9bfbb ;;
  *) echo 'Supported test hosts: Linux x86_64, Darwin arm64' >&2; exit 1 ;;
esac
if ! command -v cargo-build-sbf >/dev/null || ! cargo-build-sbf --version | head -1 | grep -qx 'cargo-build-sbf 4.1.0'; then
  cargo install cargo-build-sbf --version 4.1.0 --locked
fi
zkapi_tools="$HOME/.cache/solana/v1.54/platform-tools"
if [[ ! -x "$zkapi_tools/rust/bin/rustc" ]]; then
  zkapi_tmp=$(mktemp -d)
  trap 'rm -rf "$zkapi_tmp"' EXIT
  curl --fail --location --silent --show-error \
    "https://github.com/anza-xyz/platform-tools/releases/download/v1.54/platform-tools-$zkapi_platform.tar.bz2" \
    -o "$zkapi_tmp/platform-tools.tar.bz2"
  python3 - "$zkapi_tmp/platform-tools.tar.bz2" "$zkapi_sha" <<'CHECK'
import hashlib, pathlib, sys
actual = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
if actual != sys.argv[2]:
    raise SystemExit('SBF archive SHA-256 mismatch')
CHECK
  mkdir -p "$zkapi_tools"
  tar xjf "$zkapi_tmp/platform-tools.tar.bz2" -C "$zkapi_tools"
fi
cargo-build-sbf --version
"$zkapi_tools/rust/bin/rustc" --version
