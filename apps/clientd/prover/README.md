# Offline client prover

This crate composes the original request/withdrawal circuits, Solana H2F bindings,
host tree prover and existing companion verifier. It provides the same JSON
command protocol on native stdin/stdout and a small raw WASM ABI. It has no
network client, storage, accounting state machine or trusted-setup generator.

Build the native executable and browser module with:

```sh
cargo build --locked --release --manifest-path apps/clientd/prover/Cargo.toml --bin zkapi-client-prover
rustup target add wasm32-unknown-unknown
cargo build --locked --release --manifest-path apps/clientd/prover/Cargo.toml --target wasm32-unknown-unknown --lib
```

`packages/sdk/src/prover.ts` is the typed interface. Its `NoteProver.create`
checks authenticated artifacts, then calls an installed, hash-pinned
`NativeProver` or the pinned `WorkerProver`/WASM module. Proving-key bytes are
passed over stdin or worker messages with their independently authenticated
PK/VK hashes. Inputs are bounded to 64 MiB, output JSON to 1 MiB, and failures
do not include witness values. Native executables must be installed in a
directory that untrusted processes cannot replace.

WASM exports `zkapi_alloc`, `zkapi_run`, `zkapi_free` and linear memory.
`zkapi_run` returns `(output_length << 32) | output_pointer`. The sole active
host function is `zkapi.random_fill`, wired to browser CSPRNG entropy. Unused
wasm-bindgen descriptor hooks retained by the shared quote module are explicit
traps. The SDK erases serialized input/output buffers on release and discards
a trapped instance. This does not promise complete erasure of managed JS/Rust
heap copies. Terminating the dedicated worker discards its entire instance.

Commands cover fresh deposit witnesses, provisional deposit rebasing,
private-state inspection, request proof, withdrawal proof, clearance validation,
public tree proof and the existing companion preparation/settlement verifier.
The note secret never enters a tree witness. Every generated RP/WP/tree proof is
locally verified. Circuit, Poseidon and original note-bound setup semantics are
unchanged. The shared companion verifier currently embeds the test request VK;
production setup requires an authenticated rebuild.

`tests/proofs.rs` and `examples/test_clearance.rs` use known-public test entropy.
The example signer is test scaffolding and must never be distributed as a
production signer. The native binary itself contains neither a clearance secret
nor setup generation. `python3 scripts/run_i08_wallet.py` reproduces native and
actual Chromium proof generation, native fallback, and actual Vault SBF
acceptance through SDK v0 buffers, recording the external/live limitations.
