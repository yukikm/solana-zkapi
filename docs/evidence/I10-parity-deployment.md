# Public devnet cryptographic profile

The parity review found that the existing I10 deployment deliberately used public fixture signing keys and a deterministic tree setup. This change adds a separate, offline preparation path for a **new experimental devnet program and pool**. It does not migrate existing notes, rewrite a funded manifest, upgrade an existing program, deploy to mainnet, or claim an audit or setup ceremony.

## Implementation

`scripts/prepare_public_devnet_profile.py` packages the exact tree/proof sources and lockfile, then runs the `public_devnet_setup` Rust example. The example generates independent state/clearance scalars and quote/receipt Ed25519 seeds from `OsRng`, and generates a fresh Groth16 tree setup from `OsRng`. A fresh tree proof is created and verified before the public descriptor is emitted. No setup trapdoor is serialized. Its destruction is not independently attested.

The output must be a new directory beneath the ignored repository `target/`. Creation refuses an existing output, so a failed run retains its partial private directory and cannot overwrite a previously generated profile. Directories use mode `0700`; emitted files, including the four private role seeds, use `0600`. The build reads only public profile artifacts. Private role seeds are loaded explicitly by the backend and are never placed in source, build inputs, command arguments, or public reports.

The request and withdrawal keys remain the upstream, OS-random, single-party artifacts. The tree circuit, original request/withdrawal circuit semantics, public input counts, Poseidon, Baby-JubJub, tree depth and token units are unchanged. `setup_profile` remains `test_only` with null ceremony transcripts; the separate descriptor states `tree_setup: single_party_os_random`. A generated hash establishes artifact identity, not an independently verified ceremony or proof that an operator discarded randomness.

`programs/zkapi-vault/build_profile.rs` authenticates the descriptor against an independently supplied SHA256, verifies all artifact digests and the circuit profile, validates state/clearance curve and subgroup membership, and rejects the known public fixture role keys, duplicate roles, the deterministic tree keys and the legacy profile. It deserializes the new tree VK canonically, validates its points and exact public input count, and reconstructs the embedded Solana verifier bytes from that VK. The runtime continues to compare the exact role keys and profile on every operation.

`local-test` retains its original fixtures. A legacy `devnet` build now requires `ZKAPI_ALLOW_LEGACY_DEVNET_FIXTURES=1`; a public build instead requires `ZKAPI_PUBLIC_DEVNET_PROFILE` and `ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256`. These modes cannot be combined. The public path never silently falls back to fixture keys.

The backend adds the paired `--public-devnet-profile` and `--public-devnet-profile-sha256` arguments. The schema-2 deployment build manifest, public manifest and independently pinned profile must agree before private role seeds are loaded. Existing backend identity and signer journals remain write-once; switching a funded deployment to a different profile is refused. Historical fixtures are available only with `--allow-legacy-devnet-fixtures` and the legacy schema-1 build manifest.

The isolated signer receives the explicit public descriptor path and independent SHA256 in its immutable `SignerConfig`. It authenticates the descriptor itself and compares all four role public keys before accepting new signing keys. The optional field is omitted for historical configurations, preserving their serialized configuration and journal digest. New keys cannot be selected by changing a role seed file alone.

## Offline preparation and validation

Run from the repository with the pinned Rust toolchain:

```sh
python3 scripts/prepare_public_devnet_profile.py --output target/public-devnet/my-new-demo
python3 scripts/check_public_devnet_profile.py \
  --profile target/public-devnet/my-new-demo \
  --sha256 PUBLIC_PROFILE_SHA256_FROM_PREPARATION
```

`scripts/check_public_devnet_build.py` additionally runs the actual host Vault build against two independently generated profiles. It verifies fresh key separation, wrong descriptor pins, fixture signing keys, duplicate roles, deterministic tree VKs, a valid PK paired with the other setup's VK, ambiguous public/legacy selection and explicit legacy compatibility. It does not submit a transaction or read private role seeds.

Retain the returned public descriptor SHA256 independently of the directory. Do not copy the `private/` directory into a web server or published artifact bundle. The public descriptor lists the public distribution files; it never lists private seed files.

For the new program build, set the newly allocated public program and initializer addresses, plus:

```sh
export ZKAPI_PUBLIC_DEVNET_PROFILE=/absolute/path/to/target/public-devnet/my-new-demo
export ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256=PUBLIC_PROFILE_SHA256_FROM_PREPARATION
```

Use a separate deployment directory, backend database, signer journal and client note journal for the new program/pool. The launcher integration and schema-2 bootstrap checks are described in `I10-parity-public-profile.md`. Public transactions and provider requests require their normal explicit execution path; preparation performs neither.

For a backend belonging to the new deployment:

```sh
python3 scripts/run_i10_devnet_backend.py prepare \
  --deployment target/public-devnet/my-new-demo/deployment \
  --program target/public-devnet/my-new-demo/deployment/zkapi_vault.so \
  --output target/public-devnet/my-new-demo/backend \
  --public-devnet-profile target/public-devnet/my-new-demo \
  --public-devnet-profile-sha256 PUBLIC_PROFILE_SHA256_FROM_PREPARATION
```

The existing provider configuration and read-only RPC configuration arguments still apply. `prepare` does not send an inference or chain transaction. Existing legacy recovery commands must explicitly add `--allow-legacy-devnet-fixtures` and retain their existing deployment/journal paths.

Prepare a challenger against that new backend after its private PostgreSQL service is running:

```sh
python3 scripts/run_i10_devnet_challenger.py prepare \
  --deployment target/public-devnet/my-new-demo/deployment \
  --backend target/public-devnet/my-new-demo/backend \
  --output target/public-devnet/my-new-demo/challenger \
  --fee-key-file /absolute/private/path/to/challenger-fee-key.json \
  --tree-pk target/public-devnet/my-new-demo/tree.pk
```

The explicit `--tree-pk` selects the new setup. The historical default points to a legacy fixture and will fail the new deployment's artifact pin checks. Challenger `prepare` provisions its private database reader and local journal; its separate `serve` command is the transaction-sending operation. This preparation example has not been executed against a public backend.

## Validation scope

Fresh checks passed and are recorded in [I10-parity-deployment-results.json](I10-parity-deployment-results.json):

- Two independent OS-random generations, each with an actual locally verified Groth16 tree proof. All four role public keys and tree VKs differ between runs. Both private directories are `0700`; all private role files are `0600`.
- 19 public-artifact, independent-pin, fixture-key, tamper, symlink, private-file and backend mode-selection checks.
- 10 host-build checks, including the valid fresh profile and explicit legacy profile, rejection of seven invalid configuration/artifact cases, and independence of both generations. The wrong-PK case uses a genuine PK from the other successful setup with all replacement digests recalculated.
- An actual fresh-profile SBF v0 build using `cargo-build-sbf 4.1.0` and official platform tools `1.54` passed without stack-exceeded warnings. Its 380,728-byte ELF hashes to `44101e7b898d66b1ecfafaaea67b674d4e20149dfa472257192adad03c239515`. This artifact uses synthetic public compilation addresses and was not deployed.
- [Fresh-profile SBF/LiteSVM acceptance](I10-parity-public-devnet-svm-results.json) passed eight actual signed-v0 transactions, with a maximum of 205,191 CU and 1,202 bytes. Initialization accepts the new role keys and rejects the fixture and swapped keys; the runtime rejects a deliberately corrupted pool profile. Genuine freshly generated tree proofs complete compact deposit and expiry with real SPL Token CPI and checked note/tree/token balances. An old-setup proof and premature expiry are rejected. The local runtime uses a separately compiled 380,760-byte ELF (`e7fb90c69a845172b441b9b7e75473c234b9aaf0ef2405c8101bb269fab9d5a9`) with a known local test initializer, and seeded local mint balances/clock. No private role seed is read.

An initial host build attempted full canonical validation of every large PK query in an unoptimized build script and was stopped during that expensive validation. The final build authenticates the complete PK digest and canonically validates its embedded VK against the separate VK; the generator and client retain full PK/proof validation. The complete final host-build matrix passed after that change.

The fresh SVM test can be reproduced after offline profile preparation. Build the Vault with that profile, test program `9ZKaPRLwKibNaMpsz46iC7bpHQ9RoHsBbRuBFTBaHSp2` and test initializer `AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9`, using the `devnet,sbf-entrypoint` features and SBF v0 target. Those addresses are local test pins only. Then run:

```sh
cargo build --locked --release -p zkapi-tree-prover --bin tree-prover
cargo run --locked --manifest-path tests/svm/Cargo.toml --bin public_devnet -- \
  /absolute/path/to/fresh-test-elf/zkapi_vault.so \
  target/public-devnet/my-new-demo \
  PUBLIC_PROFILE_SHA256_FROM_PREPARATION \
  target/release/tree-prover \
  target/public-devnet-svm-results
```

When using a custom `CARGO_TARGET_DIR`, substitute its `release/tree-prover` path. An initial test preflight detected a mismatched synthetic initializer before any SVM transaction. Rebuilding with the actual test signer's public key produced the successful run above. The fresh-profile suite does not exercise state signatures, escape or challenge; those paths retain separate historical and updated legacy-fixture coverage.

Historical devnet receipts remain evidence for their original public-fixture deployment. They are not acceptance evidence for the newly generated profile. The new SVM result establishes the stated local execution scope; it does not establish public finality.

No new public deployment, provider request, funded deposit, browser wallet acceptance, mainnet deployment or third-party audit follows from these local checks. The extra tree circuit/setup, USDC issuer controls and Solana upgrade authority remain explicit differences from Ethereum native-ETH settlement.
