# Implementation handoff

- Start with `docs/implementation-ready.md`, then its referenced specifications and `docs/implementation-plan.md`.
- ADR-0001 selects layout 2 / transition_proof / proof_bound with mandatory v0_buffer. I01–I04 local implementation is complete (docs/evidence/I04.md); resume at I05 Postgres ledger, quote and signer. Reuse the actual Anchor Vault, generated IDL, SDK transport/recovery, finalized indexer, zkapi-layout2 codec and host tree prover. Read ADR-0002 for build-validated role-specific signing keys. Live wallet/RPC, hosted CI and G1–G4 release gates remain unverified. Measurement accounts in programs/i02-layout2 are not the Vault.
- Required scope: USDC on Solana, upstream direct modes, third-party proxy. Ollama and native SOL billing are outside the initial release.
- Upstream baseline: `ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`. Keep its license and record intentional differences.
- Execute I01 onward. Do not mark real-proof, SVM, provider, recovery or release gates passed from mock-only results.
- Preserve original circuit/hash semantics until I02 establishes compatibility and compute cost. Follow the specified fallback, not an unrecorded hash replacement.
- All financial state uses integer units. Nullifier reservation, budget reservation, idempotency, and sign-once settlement are required invariants.
- Never silently replay uncertain upstream inference or switch a user from direct mode to proxy.
- Record each implementation task's commands, artifacts and limitations in `docs/evidence/Ixx.md`.
- `python3 scripts/check_design.py` checks design artifacts; it is not a substitute for runtime tests.
