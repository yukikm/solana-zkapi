# Generic signing-key validation — failed CU diagnostic

This isolated program preserves the original unrestricted Baby-JubJub key
validation snapshot, its exact dependency locks, and a LiteSVM runner. It is not
the Vault, is not production code, and is excluded from normal CI. The supported
Vault uses the build-validated role-specific keys described in ADR-0002.

The runner first raises the local SVM budget to 100,000,000 CU solely to measure
one and two generic checks. It then repeats them with a real 1,000,000 CU limit.
Both admissible-budget transactions fail. The high-budget successes are not
release-gate passes. No account initialization, ATA creation or Vault state is
included in these numbers.

From the repository root with the pinned SBF tools installed:

```sh
cargo build-sbf --manifest-path tests/key-validation-diagnostic/program/Cargo.toml \
  --tools-version v1.54 --arch v0 --sbf-out-dir target/i03-key-diagnostic-sbf -- --locked
cargo run --locked --manifest-path tests/key-validation-diagnostic/host/Cargo.toml \
  -- target/i03-key-diagnostic-sbf/zkapi_bjj_probe.so
```

`program/src/keys_generic.rs` is the exact original source snapshot, including its
host tests. Run those with:

```sh
cargo test --locked --manifest-path tests/key-validation-diagnostic/program/Cargo.toml --lib
```

`output.txt` is the recorded runner output. `docs/evidence/I03-key-validation.json`
records source, lockfile, output and ELF SHA-256 values. The current Vault's real
initialization/account/ATA CU is recorded separately in `I03-svm-results.json`.

The build-time negative control copies the current Vault build script into a
temporary crate and substitutes an invalid state key, then an invalid clearance
key. Both builds must fail without editing the live deployment configuration:

```sh
python3 tests/key-validation-diagnostic/check_build_rejection.py
```
