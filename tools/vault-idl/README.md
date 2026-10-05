# Vault deployment pins and compiler-generated IDL

The default `local-test` build keeps the published local program ID, fixture
initializer and fixture mint. Generate that IDL with:

```sh
cargo run --locked --manifest-path tools/vault-idl/Cargo.toml
```

The `devnet` feature uses the Circle devnet USDC mint and requires two public
build inputs. Set `ZKAPI_DEVNET_PROGRAM_ID` to the dedicated program keypair's
public address and `ZKAPI_DEVNET_INITIALIZER` to the intended initialization
signer's public address. These inputs contain no private keys. The build rejects
missing, noncanonical, zero or incorrectly sized addresses and rebuilds when
either input changes.

Use the same values for the SBF build and IDL generation:

```sh
export ZKAPI_DEVNET_PROGRAM_ID='<program public address>'
export ZKAPI_DEVNET_INITIALIZER='<initializer public address>'
mkdir -p target/i10-devnet-vault
cargo run --locked --manifest-path tools/vault-idl/Cargo.toml \
  --no-default-features --features devnet -- target/i10-devnet-vault/vault-idl.json
cargo build-sbf --manifest-path programs/zkapi-vault/Cargo.toml \
  --tools-version v1.54 --arch v0 --no-default-features \
  --features devnet,sbf-entrypoint --sbf-out-dir target/i10-devnet-sbf -- --locked
```

Use the repository's pinned `cargo-build-sbf 4.1.0`. The IDL generator forwards
the selected deployment feature to Anchor's nested compiler invocation and
checks its resulting address against the host-compiled Vault ID. Devnet requires
an explicit output path and cannot overwrite `docs/contracts/zkapi_vault.json`.
Instruction and account layouts remain shared with the local IDL.

These commands build artifacts only. Before deployment, independently verify
the RPC genesis, the selected program keypair's public address, actual ELF and
IDL hashes, initializer and upgrade authorities, mint, pool configuration and
the approved devnet budget. The build uses the existing public test setup and
role keys; `production` still fails compilation. The local and devnet features
are mutually exclusive. Keep devnet artifacts separate from local acceptance
artifacts and never label this test setup as a production ceremony.
