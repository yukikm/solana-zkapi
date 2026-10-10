# Vault deployment pins and compiler-generated IDL

The default `local-test` build keeps the published local program ID, fixture
initializer and fixture mint. Generate that IDL with:

```sh
cargo run --locked --manifest-path tools/vault-idl/Cargo.toml
```

For a fresh Devnet deployment, follow the complete
[chain deployment guide](../../docs/getting-started/operators/chain-deployment.md).
It generates a new random setup, prepares program/initializer identities and
uses the same authenticated public pins for the compiler IDL and SBF program.
The required build variables are `ZKAPI_DEVNET_PROGRAM_ID`,
`ZKAPI_DEVNET_INITIALIZER`, `ZKAPI_PUBLIC_DEVNET_PROFILE` and
`ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256`. The profile path points to public setup
artifacts; builds do not consume its private role seeds. Fresh Devnet builds
use `--no-default-features --features devnet` for this tool and
`--no-default-features --features devnet,sbf-entrypoint` for the Vault SBF build.

Use the repository's pinned `cargo-build-sbf 4.1.0`. The IDL generator forwards
the selected deployment feature to Anchor's nested compiler invocation and
checks its resulting address against the host-compiled Vault ID. Devnet requires
an explicit output path and cannot overwrite `docs/contracts/zkapi_vault.json`.
Instruction and account layouts remain shared with the local IDL.

These commands build artifacts only. Before deployment, independently verify
the RPC genesis, the selected program keypair's public address, actual ELF and
IDL hashes, initializer and upgrade authorities, mint, pool configuration and
the approved devnet budget. Fresh Devnet builds reject known fixture role keys and deterministic tree
artifacts. The pinned upstream request/withdrawal setup remains experimental;
`production` still fails compilation. The local and devnet features
are mutually exclusive. Keep devnet artifacts separate from local acceptance
artifacts and never label this test setup as a production ceremony.
