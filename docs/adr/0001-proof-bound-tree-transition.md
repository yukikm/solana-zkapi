# ADR-0001: Verify tree updates with a Groth16 proof

The protocol uses `layout_version=2`, `tree_backend=transition_proof` and
`tree_tag_policy=proof_bound`. See the [tree transition contract](../specs/tree-transition.md).

## Reason

The upstream request/withdrawal circuits, Poseidon sponge and 32-level tree must
remain compatible. Computing the original tree or its transition tag directly
in SBF exceeds the 1,000,000 CU design budget. Solana's standard Poseidon syscall
uses a different sponge and cannot replace the original hash.

## Decision

1. The `solana.zkapi.tree.v1` circuit constrains the original leaf hash, old and
   new roots using the same 32 siblings, u32 index, u64 amount/expiry, operation
   0/1/2 and transition tag. It has 11 public inputs.
2. The program verifies all 11 inputs with a fixed VK and binds them to actual
   accounts, the instruction and any request/withdrawal proof. It does not
   recompute the leaf, path or tag with Poseidon. The tag remains in the circuit
   and public inputs.
3. Original request/withdrawal circuits, their 12/14 public inputs, Baby-JubJub
   signatures and nullifier formulas remain unchanged. Solana H2F bindings and
   integer USDC accounting follow the [protocol specification](../specs/protocol-solana.md).
4. Proof verification, state changes and USDC transfers occur in one instruction.
   Uploading a buffer does not verify a proof or reserve funds.
5. `v0_buffer` remains required. [ADR-0003](0003-single-transaction-deposit.md)
   permits compact transport for new deposits with authenticated capability
   support. Additional transaction formats require cluster, RPC, SDK, wallet
   and serialization verification before advertisement.
6. A native prover is required. Users must be able to generate tree proofs
   locally without a particular worker service. Tree provers receive public
   tree data, never note secrets, balance signatures or provider credentials.

## Security and consequences

The proof establishes the original relation: old and new roots derive from the
same path and the old root equals the current root. This relies on circuit
correctness, the setup assumptions and Groth16 soundness, plus the program's
binding checks.

The transition tag does not replace authorization or withdrawal tags. Omitting
public inputs, accepting arbitrary VKs or using the tag instead of account
binding violates this decision. A tree proof alone does not authorize withdrawal.
Note/root/Vault/destination/key/clearance, nullifier, status, deadline and token
account checks remain required. A challenge verifies its historical request
proof without replacing its root.

| Operation | Tree proof |
|---|---|
| Deposit, mutual close, initiate escape, challenge, expiry | Required |
| Finalize escape, administration, ordinary API authorization | Not required |

Ordinary authorization gains no note ID or wallet identity. The extra circuit
adds setup trust and proving latency, including regeneration after root
conflicts. All financial instructions must remain within the CU and transaction
size targets; checks cannot be removed to meet those targets.

## Alternatives

- Direct SBF hashing preserves semantics but exceeds the design budget.
- The standard Poseidon syscall changes roots, commitments and circuit meaning.
- Splitting state and funds across transactions requires a different atomicity design.
- Replacing or removing the tag changes the circuit without being necessary.
