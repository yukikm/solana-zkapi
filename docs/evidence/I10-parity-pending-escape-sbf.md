# Pending authorization emergency escape: actual SBF evidence

The SDK can now start its explicit emergency escape from the last verified balance when an accepted session remains unresolved during an operator outage. The exact saved authorization and inference intent remain in the same encrypted journal. This is a challengeable financial exit, not a claim that the authorization was cancelled or cleared.

[The fresh runtime report](I10-parity-pending-escape-sbf-results.json) records one complete integration test, with **10 actual signed-v0 Vault transactions, maximum 335,201 CU and 1,232 bytes**, completed in 20.350 seconds. The test uses the production `ControlClient`, `WalletClient`, encrypted journal, native cryptographic prover and actual Vault SBF in LiteSVM.

The test creates and deposits a new random note, generates a new request proof, and verifies that proof and its signed quote through the shared Rust session verifier. Its local HTTP fixture acknowledges the exact authorization as ACTIVE once, then loses the response to one inference request and becomes unavailable. The normal withdrawal path remains fenced. Explicit emergency escape archives the exact closing authorization, credentials, request proof and inference operation alongside the unchanged verified state before producing an escape proof or signing any transaction.

The test reopens the encrypted journal and verifies byte-preserving archive recovery. AUTH resubmission, inference retransmission and new session preparation are refused. The fresh withdrawal/tree proofs execute against the actual SBF verifier. A lost escape-execute acknowledgment is recovered after another journal reopen using its finalized local receipt, without resending the signed transaction. Finalization is refused before the challenge deadline and succeeds at the deadline. The destination receives 5,000,000 micro-USDC; the Vault and treasury end at zero. The original unresolved session remains archived after withdrawal. Counters establish one AUTH request, one inference request, zero inference replays and zero financial signature retransmissions.

The interactive SVM adapter now accepts an optional explicit ELF path and a separate report name. Its historical default remains available. The focused SDK test builds its own authenticated local manifest, so it does not require a running control service, PostgreSQL or an old generated I05 manifest.

## Reproduction

From the repository, with its pinned Node/Rust tools and a separately built local-test SBF ELF:

```sh
mkdir -p target/i08-wallet
bash scripts/build_i02_source.sh target/i08-wallet/circuit-source.tar
cargo test --locked --manifest-path services/challenger/Cargo.toml --lib \
  tests::generates_a_new_real_challenge_proof_using_pinned_test_setup -- --exact --nocapture
cargo build --locked --release --manifest-path apps/clientd/prover/Cargo.toml \
  --bin zkapi-client-prover
cargo build --locked --manifest-path tests/svm/Cargo.toml --bin wallet
ZKAPI_TEST_VAULT_ELF=/absolute/path/to/local-test/zkapi_vault.so \
ZKAPI_TEST_WALLET_SVM=/absolute/path/to/cargo-target/debug/wallet \
ZKAPI_TEST_NATIVE_PROVER=/absolute/path/to/cargo-target/release/zkapi-client-prover \
node --test-reporter=tap packages/sdk/test/wallet-pending-escape-sbf.ts
```

Use the actual binary paths for the selected `CARGO_TARGET_DIR`. Without one, the wallet adapter is under `tests/svm/target/debug/`, and the native prover is under `apps/clientd/prover/target/release/`. The targeted challenger test recreates the existing known-public test tree key and verifies a real proof; it needs no database. The source archive hash matches the unchanged committed local circuit profile. Runtime reports are written to `target/i08-wallet/pending-escape-*.json`.

The first setup command used an incomplete exact test name and ran zero tests; the corrected fully qualified command ran one test successfully. Initial integration fixture errors in quote/receipt separation, URL comparison and local HTTP policy were fixed before the complete successful run. These setup attempts are not counted as passes.

## Boundaries

AUTH admission, inference failure, chain finality envelopes and clock advancement are local fixtures. Proof generation, request verification, transaction signatures, Vault proof verification, account creation and SPL Token CPI are real. This run uses the explicitly known-public local cryptographic setup, separately from the new public-devnet profile. It does not submit public transactions, contact a provider, exercise challenged-escape successor settlement, or establish a third-party audit. Historical public receipts and the fresh-profile SBF suite retain their separate scopes.
