# Implementation handoff

- Start with `docs/implementation-ready.md`, then its referenced specifications and `docs/implementation-plan.md`.
- ADR-0001 selects layout 2 / transition_proof / proof_bound with mandatory v0_buffer. Read `docs/specs/tree-transition.md`; I02-B is complete (docs/evidence/I02B.md); resume at I03, then I04. Reuse zkapi-layout2 bindings/codec and the host tree prover. Measurement state/accounts are not the production Vault; programs/i02-layout2 uses the normative payload wire.
- Required scope: USDC on Solana, upstream direct modes, third-party proxy. Ollama and native SOL billing are outside the initial release.
- Upstream baseline: `ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`. Keep its license and record intentional differences.
- Execute I01 onward. Do not mark real-proof, SVM, provider, recovery or release gates passed from mock-only results.
- Preserve original circuit/hash semantics until I02 establishes compatibility and compute cost. Follow the specified fallback, not an unrecorded hash replacement.
- All financial state uses integer units. Nullifier reservation, budget reservation, idempotency, and sign-once settlement are required invariants.
- Never silently replay uncertain upstream inference or switch a user from direct mode to proxy.
- Record each implementation task's commands, artifacts and limitations in `docs/evidence/Ixx.md`.
- `python3 scripts/check_design.py` checks design artifacts; it is not a substitute for runtime tests.
