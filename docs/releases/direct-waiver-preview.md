# Direct operator waiver patch candidate (.16)

This is a local SDK/verifier patch candidate, not a published GitHub or npm
release. Existing release assets remain immutable.

An explicit, signed operator approval can assume unknown OpenRouter provider
cost and charge the user zero. This is not evidence that issuance never
occurred or that provider usage was zero. By default, ordinary missing-key
recovery leaves the session unresolved and cannot create this approval.
Operators may explicitly enable the prospective [automatic recovery
policy](../getting-started/direct-auto-recovery.md) to accept unknown provider
costs for eligible new sessions after the required expiry and shutdown checks.

The version 1 direct receipt uses `waived_unknown` and
`UNKNOWN_OPERATOR_LOSS`, with `operation_id`, provider request ID, reported USD,
observed cost and operator loss all null, empty usage and zero charged cost.
Its provider evidence digest commits to the immutable signed operator approval.
Only direct OpenRouter tariffs permit this form. The independent signer must
validate the approval and ledger predicates before signing the existing
successor. Receipt identity, tariff, full cap, signatures, unique charge,
successor algebra and state signature checks remain mandatory.

The TypeScript client retains the same settlement state machine. It reads the
signed terminal response and receipts, verifies them through the shared Rust
verifier, then atomically records the successor and clears the pending session.
Verification failure preserves the original encrypted journal. Recovery never
replays inference. A fresh message remains an explicit user action.

The SDK archive does not contain the WASM verifier. Browser applications need a
matching independently installed, hash-pinned WASM build. Existing funded
profile bytes, financial manifests, proving assets, Pool and custody bindings
must remain unchanged. A narrowly pinned application verifier update may select
the new binary for its exact reviewed deployment; other profiles and retired
recovery installations keep their original runtime. `.13` through `.15` profile
compatibility and legacy schema 1 compatibility remain supported.

Local validation includes real Groth16 authorization, signed receipts and
Baby-JubJub successors in the native companion and matching WASM. To reproduce:

```sh
ZKAPI_DIRECT_WAIVER_FIXTURE_DIR="$PWD/target/direct-waiver-verifier" \
  cargo test --locked --manifest-path apps/clientd/companion/Cargo.toml \
  --test verification direct_operator_waiver_real_proof
cargo build --locked --release --manifest-path apps/clientd/prover/Cargo.toml \
  --target wasm32-unknown-unknown --lib
ZKAPI_PREVIOUS_SDK_ARCHIVE=/absolute/path/zkapi-solana-sdk-0.2.0-devnet.15.tgz \
  node --test packages/sdk/test/direct-waiver-runtime.ts
```

The fixture uses public test keys and no network. It verifies unknown-value
preservation, invalid signed receipt rejection and real `.15` encrypted journal
recovery with no inference or transaction. These checks do not establish public
payment resolution, paid provider acceptance, production or mainnet support.
