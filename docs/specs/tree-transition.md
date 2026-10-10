# Tree transition contract

[ADR-0001](../adr/0001-proof-bound-tree-transition.md) fixes
`transition_proof / proof_bound / layout_version=2`. All account, authority,
funding and state rules in the [protocol specification](protocol-solana.md) apply.

## Circuit and program responsibilities

The request/withdrawal circuits remain unchanged. The tree circuit is
`solana.zkapi.tree.v1`: Groth16 BN254, Arkworks 0.5, 32 levels. It uses the original
`zkapi-core::v2` Poseidon constants, width=3, rate=2, capacity=1, 8 full rounds,
57 partial rounds, alpha=5, domains, absorption and output rules. Do not replace
it with Solana's standard Poseidon syscall.

Verify all 11 public inputs in this order. Each is a canonical 32-byte BE Fr;
external values must not be normalized modulo r.

| index | Name | Circuit constraint and program binding |
|---|---|---|
| 0 | vault_binding | Bound to the tag; matches PoolConfig and actual pool/program/genesis/mint/token program |
| 1 | old_root | Derived from old_leaf and path; matches current TreeState.root |
| 2 | new_root | Derived from new_leaf and the same path; the only root written after verification |
| 3 | note_id | Matches u32 bit decomposition and the next deposit ID or referenced Note ID |
| 4 | old_leaf | Operation selects 0 or L; the program does not recompute L |
| 5 | new_leaf | Operation selects L or 0; the program does not recompute L |
| 6 | commitment | Bound to L/tag; matches deposit arguments or Note.commitment |
| 7 | deposit | Matches a u64 witness, L/tag and deposit arguments or Note.deposit |
| 8 | expiry | Matches a u64 witness, L/tag and deposit arguments or Note.expiry |
| 9 | op | Exactly 0, 1 or 2; matches the instruction's tree operation |
| 10 | transition_tag | `H([Fr(BE("solana.zkapi.tree.v1")), p0,…,p9])`; verified through the fixed VK, not recomputed by the program |

The private witness contains only 32 canonical Fr siblings.
`L=H([Fr(BE("zkapi.v2.leaf")), id,C,D,expiry])`. Insert (op=0) and restore (op=2)
use `(old_leaf,new_leaf)=(0,L)`; remove (op=1) uses `(L,0)`. At each level, LE ID
bits select left/right for `H([Fr(BE("zkapi.v2.node")), left,right])`. Old and new
paths use the same siblings and ID. Note secrets, balances and signatures are
not circuit inputs.

The program may check the operation's zero leaf directly. The proof establishes
L; do not add a rule rejecting a hash that equals zero. The program checks amount
limits, D>0, C!=0, expiry rounding, next ID, status and authorities before integer
to Fr conversion.

The empty root is z32 where `z0=0; z[i+1]=H_node(zi,zi)`. Embed the independently
verified constant and its hash. Initialization does not recompute 32 levels in
SBF. Clients and indexers can verify the same constant.

## Instruction binding

TP denotes tree inputs, WP withdrawal inputs and RP request inputs. Decode
canonically before comparison. Every account must have the correct pool, PDA,
owner and layout.

| Instruction | Tree op / leaf | Required binding and state |
|---|---|---|
| deposit | 0 / 0→L | expected_root=TP1=current root; expected_id=TP3=next_note_id, with TreeFull at 2^32; C/D/expiry=args=TP6/7/8; valid amount and rounded expiry; token owner signature; unused Note |
| mutual_close | 1 / L→0 | WP8=Note.id=TP3; WP3=TP1=current root; WP2=TP0=pool binding; WP0=2, WP1=namespace, WP4..7=config keys, WP12=1; Active; WP9<=D; WP11 unused; WP10=H2F(actual destination owner); valid WP proof |
| initiate_escape | 1 / L→0 | Same Note/root/binding/keys/destination/amount/N checks as close, but WP12=0; Active→Pending; consume N; save B, actual owner, N, old root and deadline; no transfer |
| challenge_escape | 2 / 0→L | instruction note_id=Note.id=TP3; TP1=current root; TP0=RP2=pool binding; RP0=2, RP1=namespace, RP4..5=config state key, RP8=Pending.nullifier; Pending and Clock<deadline; valid historical RP proof |
| claim_expired | 1 / L→0 | instruction note_id=Note.id=TP3; TP1=current root; TP0=pool binding; Active and Clock>=Note.expiry; no request/withdrawal proof; transfer D to treasury |
| finalize_escape | None | Pending and Clock>=deadline; pay saved B/owner; root unchanged; no new proof |

For every operation except deposit, TP6/7/8 must match the stored Note. Neither
self-reported TP4/5 nor another uploader-supplied Note is authoritative. A remove
proof alone does not authorize close, escape or expiry; their separate authority,
time and clearance rules remain required.

A challenge uses a historical authorization. Require neither
`RP3 == current_root` nor `RP3 == Pending.old_root`. RP8 binds it to the pending
nullifier; instruction/PDA/Pending identify the Note to restore. Do not apply API
quote expiry or request-time freshness to challenges. Keep the ExitNullifier
tombstone after success. WP13/RP9 remain the original withdrawal/authorization
tags, distinct from TP10.

Execution is atomic:

1. Decode lengths, fields and coordinates; verify accounts, signers and buffer
   pool/op/uploader/digest/seal/expiry.
2. Read current Clock/config/tree/Note/Pending and check all integer, state and
   input bindings. Simulation alone is insufficient.
3. Verify required request/withdrawal and tree proofs with fixed VKs.
4. Apply state changes, PDA/ATA creation, signed Token CPI, deposit invariant,
   sequence/event and buffer consumption in the same instruction. Any failure
   rolls back the transaction.

Buffer and inline paths share handlers and checks. Research harness account
layouts, opcodes and fixed transfers do not define production wire.

## Layout and wire

Program accounts begin with the 8-byte Anchor discriminator followed by
`layout_version:u8=2`. Reject layout 1; do not migrate existing pools in place.
Protocol version 2, HTTP `/zkapi/v1` and tree circuit v1 are separate version axes.

PoolConfig fixes `tree_backend:u8=1`, `tree_tag_policy:u8=1` and
`circuit_profile_hash:[u8;32]` from embedded constants. Callers cannot choose a VK
or policy. Every instruction compares the account profile with the build profile.

`TP=[F;11]` and `TreeUpdate={public:TP, proof:Proof}` encode public inputs first
(352 bytes), then proof (256 bytes): 608 bytes without length/tag prefixes.
The uncompressed proof uses the shared canonical Fq, infinity, curve, subgroup,
A-sign and G2-order rules. Destination owner remains an account bound to WP.

| Instruction | Arguments, excluding discriminator | Argument / instruction bytes |
|---|---|---:|
| deposit | expected_id:u32, expected_root:F, expiry:u64, commitment:F, amount:u64, tree:TreeUpdate | 692 / 700 |
| mutual_close | public:WP, proof:Proof, tree:TreeUpdate | 1,312 / 1,320 |
| initiate_escape | public:WP, proof:Proof, tree:TreeUpdate | 1,312 / 1,320 |
| challenge_escape | note_id:u32, public:RP, proof:Proof, tree:TreeUpdate | 1,252 / 1,260 |
| claim_expired | note_id:u32, tree:TreeUpdate | 612 / 620 |
| finalize_escape | note_id:u32 | 4 / 12 |

Buffer payloads contain exactly these arguments, without the Anchor discriminator.
Buffer operations are deposit=0, close=1, initiate escape=2, challenge=3, expiry=4;
they are distinct from tree operations. Reject wrong lengths, trailing bytes and
legacy 1,024-byte paths. SHA-256 covers exact payload bytes. Existing
pool/uploader/op/digest and signature binding rules apply.

Serialize every v0 transaction with its actual accounts, independent payers and
compute-budget instructions, and require <=1,232 bytes. Derive append chunk size
from serialization. ALT is not required. Buffer transport remains required for
buffer-supported operations; fitting inline operations use the same checks.
[Compact deposit](compact-deposit.md) is an authenticated additional capability.
Finalize uses its own inline instruction.

## Proving and recovery

The local prover interface is:

```text
prepare_tree_transition(snapshot, pool_config, note_or_deposit_args, operation, siblings)
  -> TreeWitness { public[11], siblings[32] }
prove_tree_transition(witness, pinned_tree_pk, rng) -> TreeUpdate
verify_tree_transition(update, pinned_tree_vk) -> Result
encode_layout2_args(operation, auth_inputs_and_proof, update) -> bytes
```

Preparation checks the original hash, old root/leaf/path, operation and integer
ranges. Verify the PK hash before proving; use a cryptographic RNG, locally
verify the result with the pinned VK and compare every expected public input
before upload. Never distribute a fixed test RNG in a production prover.

Workers receive only public pool/Note/path/operation data. Do not provide note
secrets, balance blindings, signatures or authorization-session mappings. Keep
request proving local. Tree work exposes note IDs, so do not log links to normal
authorization sessions. Verify worker proofs locally and provide a local proving
path when workers are unavailable.

The durable journal records pool, operation, expected ID/root, snapshot
sequence/slot, exact payload/digest, buffer, blockhash/last-valid height and
transaction signature. These records do not reserve tree state.

- Unknown send: query the exact signature, successful chain record and
  Note/root/status/N. Do not send another deposit or exit while unresolved.
- Finalized stale-root rejection: generate a new proof/digest/buffer from a fresh
  path. Close/escape also regenerate WP for the current root; retain clearance
  and nullifier state.
- Challenge: retain historical RP/proof, nullifier and request time. Regenerate
  only the tree proof for the current zero path.
- Deposit: recheck next ID and the expiry day boundary. Reprove when either
  changes; do not mark the note ID final before deposit confirmation.
- A sealed buffer can become stale. Failed execution preserves it for uploader
  rent recovery; expiry and closing rules remain unchanged.

A remove/restore sequence may make the same public transition valid again.
A tree proof is not a one-time token. Current root, status, next ID, exit N and
authorization determine validity; do not add sequence to the proof to prohibit
legitimate restoration.

## Circuit profile and setup

Manifest requires layout 2, `transition_proof`, `proof_bound` and `v0_buffer`.
Non-null `tree_proof_artifacts` contains circuit ID, 11-input count, source archive
hash, PK/VK hashes, verifier constants hash and transcript hash. Under
`test_only`, all three setup_transcript_hashes and the tree artifact transcript
hash must be null. `ceremony_verified` requires
verified transcripts for all three circuits.

```text
circuit_profile_hash = SHA256(JCS({
  protocol_layout_version, tree_backend, tree_tag_policy, circuit_id,
  request_pk_hash, request_vk_hash, withdrawal_pk_hash, withdrawal_vk_hash,
  tree_proof_artifacts, setup_profile, setup_transcript_hashes
}))
```

Use OpenAPI field names/types; omit manifest_hash and the profile hash itself.
PK/VK hashes cover entire distributed files. Tree verifier constants encode
`alpha G1(64) || beta G2(128) || gamma G2(128) || delta G2(128) || IC[0..11] G1(12*64)`:
canonical BE, Solana G2 c1,c0 order, non-negated alpha/IC. The source hash covers
exact archive bytes containing circuit source, Cargo.lock and hash constants.

Embed the same profile in the program and PoolConfig. Clients and servers reject
mismatches among signed manifest, actual pool and distributed artifacts. A new
setup/VK/profile requires a new pool and corresponding build; an upgrade must
not silently replace an existing profile.

Test fixtures use artifact name `solana.zkapi.tree.v1/test-only-arkworks-0.5`
(33,198 constraints), distinct from the circuit ID. Code relocation alone does
not justify setup reuse: compare constraints, witness behavior and cross-VK
verification. Changed constraints require new artifacts and setup.

Production requires reviewed setup/contribution/transcript verification for
request, withdrawal and tree circuits. Reject `test_only`, known test-key hashes
and unverified transcripts in production manifest/build/release checks. Renaming
the environment does not promote test artifacts.

## Verification requirements

| ID | Required verification |
|---|---|
| TT01 | Reject mutations to all 11 inputs, siblings, u32/u64 boundaries, operation and mismatched old/new paths. Independently compare original hash vectors, tag and empty root |
| TT02 | Reject combinations of individually valid WP/TP from different Notes, Vaults or roots, and RP/TP from different Pending records; byte mutation tests alone are insufficient |
| TT03 | Compare deposit, close, escape, challenge, finalize and expiry success/rejection conditions with the pinned reference contract |
| TT04 | Reject false accounts, pools, layouts, profiles, VKs, destinations, keys, clearance, statuses, TTLs, N and invalid maximum IDs. A second-CPI failure rolls back state, balances and sequence |
| TT05 | Check wire, payload length/op, public/proof order, buffer lifecycle, staleness after seal, old signatures against reused PDAs with different digests, replay, rollback and rent |
| TT06 | Measure all financial operations and normal failure paths at <=1,000,000 CU and each signed v0 transaction at <=1,232 bytes, including actual accounts, PDA/ATA creation, events and buffer close |
| TT07 | Provide native proving; measure browser-worker time/memory. Local withdrawal/challenge proving survives worker loss; recover root conflicts, expiry boundaries and unknown sends |
| TT08 | Reject test keys in mainnet configuration, modified PK/VK, profile/hash mismatches and missing transcripts. Verify all three setups and measure the production SBF build |

Reference comparisons use matching integer D/B/ID/time/operation sequences and
original hashes. Compare roots, leaves, next ID, Note status, Pending B/N/deadline,
nullifiers and user/treasury changes. Prove each chain's own address/binding;
identical proof bytes need not work across chains. Use real proofs for success
cases and label mock state-machine tests separately. Document intentional
USDC/H2F and u64-counter differences.

Required traces include funded usage/settlement/close, escape/finalize at deadline,
authorization followed by another deposit and then escape/challenge with the
historical RP, Active expiry, challenge/finalize/expiry while paused and rejection
of N reuse after challenge. Compare rejection rules as well as roots.

The native challenge path, including proof generation, upload, execution and
root conflicts, targets detection-to-send within five minutes. Measure browser
performance and provide a visible native fallback rather than indefinite waits.
