# I03 real-proof EVM / SBF Vault parity

`VaultParity.t.sol` deploys the immutable upstream `ZkApiVault` and its real
`Groth16ProofAdapter`, pinned to `045b444ea1b52538d1b40273c7cb6ed09468a052`.
It does not modify, etch, or replace the upstream verifier. The maximum-ID
boundary test alone sets the upstream counter to avoid billions of deposits.

The four proofs in `fixtures.json` are produced by
`crates/zkapi-tree-prover/examples/evm_vault.rs`, locally verified against the
original pinned setup, and verified again by the actual EVM adapter. Every
request and withdrawal uses a genuine non-genesis state signature. No mock
proof adapter or mocked proof success is used. Original EVM deposit/expiry
need no Groth16 proof; they execute the original Poseidon Merkle path logic.

Shared integers are D=5,000,000, B=4,900,000, IDs 0 and 1,
time=3,000,000,000, TTL=2,592,000 and challenge=86,400 seconds. Same secrets,
anchors, commitments, original hash, leaves and expiry produce identical roots
and nullifiers. EVM chain/address/destination and Solana H2F bindings have their
own valid proofs. EVM units are whole gwei; Solana units are micro-USDC.
Solana's initial pool accepts the exact role-specific signing-key pair checked
at build time under `docs/adr/0002-build-validated-signing-keys.md`; another valid
pair requires a new program build and pool. The EVM constructor permits arbitrary
field-bounded nonzero pairs. This initialization difference is recorded separately
from the shared financial traces.

Run from the repository root:

```sh
# Optional: regenerate deterministic test fixtures under the unchanged VKs.
cargo run --locked --release -p zkapi-tree-prover --example evm_vault
bash tests/evm-vault/run.sh
# After the real SBF Vault runner has emitted its traces and rejections:
python3 tests/evm-vault/compare.py
```

Seven independent traces cover signed mutual close, escape deadline finalize,
historical request A → deposit B → escape A → challenge with the original
request, Active expiry, and pause during challenge/finalize/expiry. The tests
assert all 14 exported rejection conditions leave the state and balances
unchanged, including same-N reuse after challenge and exact deadline rules.

The comparator requires exact equality of 27 observed states across 13 fields:
root, time, next ID, both statuses, active leaves, Pending presence/B/N/deadline,
N consumption, user/treasury deltas, and vault amount. Concrete chain error
names are mapped explicitly, never inferred from proof failure alone.
Results live in `docs/evidence/I03-{evm-traces,evm-rejections,evm-results,parity}.json`.

This is local runtime protocol parity, not provider inference or settlement API
testing. Gas excludes no test harness operations and must not be interpreted as
per-transaction gas. Proof fixtures and keys are test-only. Production ceremony,
transport, browser, provider, recovery and release gates remain separate.
