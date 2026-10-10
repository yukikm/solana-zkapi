# On-chain and cryptographic protocol

This contract preserves the state machine of
`ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`, with Solana bindings,
USDC accounting and transaction transport. Layout 2 uses the proof-based tree
update in [ADR-0001](../adr/0001-proof-bound-tree-transition.md) and the
[tree transition contract](tree-transition.md).

## Values and encoding

- USDC amounts: u64, intermediates at least u128, maximum
  `9_007_199_254_740_991`. HTTP uses decimal integer strings without leading zeros,
  except `0` itself.
- Note IDs: monotonically increasing u32 starting at zero, never reused. Only next_note_id is u64,
  allowing `2^32` as the full-tree sentinel. At that value reject with TreeFull;
  otherwise checked-convert to u32, allocate and increment. ID `2^32−1` is usable once.
- Timestamps: nonnegative u64 Unix seconds. Reject negative Solana Clock values
  and addition overflow.
- Fr: 32-byte BE, `0 <= x < r`, HTTP `0x` plus 64 lowercase hex digits. Reject
  noncanonical inputs rather than reducing them modulo r.
- BN254 scalar modulus r:
  `21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- Schnorr s and blind delta use the same hex format but must be canonical in the
  Baby-JubJub scalar field, whose modulus is
  `2736030358979909402780800718157159386076813972158567259200215660948447373041`.
  An Fr range check alone is insufficient. See the
  [pinned Arkworks declaration](https://docs.rs/ark-ed-on-bn254/0.5.0/src/ark_ed_on_bn254/fields/fr.rs.html).
- Proof coordinates use Fq, a different field. The original decoder/verifier
  checks canonical encoding, curve and subgroup membership.
- Pubkeys and hashes are 32 bytes. HTTP pubkeys use base58; SHA-256 uses 64
  lowercase hex digits without `0x`; UUIDs use canonical lowercase UUIDv4.
- Anchor Borsh integers are little-endian. Fr/proof byte arrays retain BE encoding.

### H2F

```text
frame(label, parts) = u16be(len(UTF8(label))) || UTF8(label)
  || u16be(parts.len) || concat(u32be(part.len) || part)
H2F(label, parts) = OS2IP_BE(SHA256(frame(label, parts))) mod r
```

Lengths count bytes. Do not normalize Unicode implicitly; labels are the exact
ASCII strings below.

| Value | Definition |
|---|---|
| chain_namespace | `0x534f4c` (5459788), a project namespace rather than an official chain ID |
| vault_binding | `H2F("solana-zkapi-vault-v1", [genesis_hash_raw32, program_id_raw32, pool_pubkey_raw32, token_program_id_raw32, usdc_mint_raw32, [6]])` |
| destination_binding | `H2F("solana-zkapi-destination-v1", [wallet_owner_raw32])` |
| request_context | `H2F("solana-zkapi-authorization-v1", [authorization_bytes])` from the [API contract](api-proxy.md) |

SDKs compare RPC genesis hash with the manifest. The program recomputes bindings
from immutable initialized config. Do not reduce wallet addresses directly to Fr.

## Circuits and proofs

Keep circuit `protocol_version=2`, independent of HTTP version. Request proofs
have these 12 Fr public inputs:

```text
[2, chain_namespace, vault_binding, active_root,
 state_key.x, state_key.y, request_time, solvency_bound,
 request_nullifier, authorization_tag, anonymous_commitment.x, anonymous_commitment.y]
```

Withdrawal proofs have these 14:

```text
[2, chain_namespace, vault_binding, active_root,
 state_key.x, state_key.y, clearance_key.x, clearance_key.y,
 note_id, final_balance, destination_binding, withdrawal_nullifier,
 has_clearance_0_or_1, withdrawal_tag]
```

`authorization_tag = H_auth(N, request_context)` and
`withdrawal_tag = H_withdraw(N,destination_binding,B,has_clearance)` use the exact
original domains and Poseidon sponge in `zkapi-core/src/v2.rs`. Request context
is a private witness; the server recomputes it from authorization data and checks
the resulting tag against the public input.

Proof wire is base64-encoded 256 bytes: eight uncompressed 32-byte BE coordinates
`A.x,A.y,B.x.c0,B.x.c1,B.y.c0,B.y.c1,C.x,C.y`, as defined by
`compact.rs::proof_to_wire`. Only the conversion crate adjusts Solana G2 ordering
and A's sign; vectors must catch double negation. Request and withdrawal VKs are
separate, embedded in the program and SHA-256 pinned in the manifest. Do not load
arbitrary VKs from accounts.

Balance state is `E=B·G+r·H+L·J`, with `N=H_null(secret,anchor)`, genesis B=D and
anchor=1. Normal authorization sends only rerandomized E, not note ID, original
balance, secret, anchor or signature. Successor state is
`E_next=E_anon−charge·G+blind_delta·H`. Clients verify the successor signature,
points and integer balance before advancing their journals. State signatures
remain Baby-JubJub, not wallet Ed25519 signatures.

Compatibility tests may use the original setup artifacts. Production artifacts
follow the [operations contract](operations.md). Circuit changes require a new
circuit ID, VK and setup, with an explicit source/constraint difference record.

## Accounts and authorities

PDA prefixes are ASCII; integer seeds use the specified LE width. Accounts start
with an 8-byte Anchor discriminator and `layout_version:u8=2`. Program accounts
are owned by this program; USDC token accounts are owned by the SPL Token Program.

| Type | Seeds | Main fields |
|---|---|---|
| PoolConfig | `["pool", pool_id_32]` | bump, genesis_hash, mint, token_program, decimals=6, vault_binding, admin, treasury_owner, state/clearance pubkeys (64B each), TTL:u64, challenge:u64, cap:u64, paused:bool, tree_backend:u8=1, tree_tag_policy:u8=1, circuit_profile_hash:32B, pool_id:32B |
| TreeState | `["tree", pool]` | bump, root:Fr32, next_note_id:u64, sequence:u64, outstanding_deposits:u64 |
| VaultAuthority | `["vault", pool]` | PDA signer and USDC ATA authority |
| Note | `["note", pool, note_id_u32le]` | bump, note_id:u32, commitment:Fr32, deposit:u64, expiry:u64, status:u8 |
| PendingWithdrawal | `["pending", pool, note_id_u32le]` | bump, exists:bool, old_root:Fr32, nullifier:Fr32, balance:u64, destination_owner:Pubkey, deadline:u64 |
| ExitNullifier | `["exit", pool, nullifier_32be]` | bump, consumed:bool; permanent tombstone, never closed |
| PayloadBuffer | `["payload", pool, uploader, nonce_32]` | bump, uploader, op:u8, payload_len:u32, digest32, next_offset:u32, sealed:bool, expires:u64, rent_payer, payload:Vec<u8>, nonce:32B |

Exact field order and discriminators are fixed by the
[generated IDL](../contracts/zkapi_vault.json) and
[account types](../../programs/zkapi-vault/src/state.rs). Validate PDAs using saved
pool_id and nonce. Buffer nonce follows the variable-length payload; it is not
in the leading header.

Mint, keys, TTL and profile are immutable after initialization. Only the admin
can change treasury_owner and paused. Admin rotation is not a protocol operation;
manage membership through its external multisig. Reject mixed pools, incorrect
PDA seeds/bumps, arbitrary CPI programs and substituted token authorities/delegates.

Reject layout 1 and any backend/tag/profile differing from the embedded constants.
Note status is Active=1, PendingWithdrawal=2, Closed=3; zero is invalid.
Initialization requires ttl>0, challenge>0, `0<cap<=MAX` and nondefault
admin/treasury. Initial profile values are TTL=2,592,000 seconds,
challenge=86,400 seconds and cap=1,000,000 micro-USDC.

USDC mints are mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` and
Devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`. Pin the original SPL Token
Program; Token-2022 and transfer-fee tokens are unsupported. Verify mint owner,
decimals and freeze authority before release.

The vault is VaultAuthority's USDC ATA. Destination is the proved wallet owner's
USDC ATA; that recipient need not sign and a separate payer may fund ATA creation.
Rent is not deducted from the deposit. Finalize pays only the owner stored in
Pending. Treasury uses PoolConfig at payment time.

After each financial transition require `vault.amount >= outstanding_deposits`.
Deposit adds D; close/finalize/expiry subtract D; escape/challenge leave it
unchanged. Unsolicited USDC does not create notes, and there is no surplus
withdrawal instruction. Use checked arithmetic.

### Signing keys

[ADR-0002](../adr/0002-build-validated-signing-keys.md) fixes state and clearance
keys in the build. Build-time Arkworks checks canonical coordinates, curve,
subgroup and nonidentity. Initialization and every instruction require exact
role-specific matches. Manifest, actual PoolConfig and build pins must agree.
Different keys require a corresponding build and new pool, never replacement
inside an existing pool.

## Instructions

Discriminator is `sha256("global:"+snake_case_name)[0..8]`. Borsh arguments use
`F=[u8;32]`, `Proof=[u8;256]`, `TP=[F;11]`,
`TreeUpdate={public:TP,proof:Proof}`, `WP=[F;14]`, `RP=[F;12]`, with no array prefixes.

| Instruction / arguments | Signers | Writable accounts | Checks and effect |
|---|---|---|---|
| initialize_pool(pool_id32, genesis32, state_key64, clearance_key64, ttl:u64, challenge:u64, cap:u64, admin, treasury) | deployment authority, admin, payer | pool, tree, vault ATA | Pinned deployment authority; fixed mint, empty root/profile and validated keys; valid ranges; reject existing pool |
| deposit(expected_id:u32, expected_root:F, expiry:u64, commitment:F, amount:u64, tree:TreeUpdate) | token owner, payer | tree, note, source ATA, vault ATA | !paused; next ID/root match; 0<amount<=MAX; C!=0; expiry=ceil((Clock+TTL)/86400)*86400; 0→L; TransferChecked |
| mutual_close(public:WP,proof:Proof,tree:TreeUpdate) | payer | tree, note, exit, vault ATA, destination ATA, treasury ATA | !paused; clearance=1; current root/binding/keys and valid proof; Active; B<=D; unused N; L→0; Closed; consume N; transfer B and D−B |
| initiate_escape(public:WP,proof:Proof,tree:TreeUpdate) | payer | tree, note, exit, pending | !paused; clearance=0; current root and valid proof; Active; B<=D; unused N; L→0; Pending; consume N; deadline=Clock+challenge |
| challenge_escape(note_id:u32,public:RP,proof:Proof,tree:TreeUpdate) | payer | tree, note, pending | Pending; Clock<deadline; saved N; fixed binding/keys; valid historical RP; current 0→L; Active; retain exit tombstone |
| finalize_escape(note_id:u32) | payer | note, pending, tree, vault ATA, destination ATA, treasury ATA | Pending; Clock>=deadline; unchanged root; Closed; transfer saved B and D−B |
| claim_expired(note_id:u32,tree:TreeUpdate) | payer | tree, note, vault ATA, treasury ATA | Active; Clock>=expiry; L→0; Closed; transfer all D to treasury |
| set_treasury(new_owner:Pubkey) | admin | pool | Nondefault new owner; also applies to future payments of existing Pending records |
| pause() / unpause() | admin | pool | Change paused; challenge/finalize/expiry remain available |

[Tree input binding and wire](tree-transition.md) are mandatory; do not recompute
leaf/path/tag in the program. [Compact deposit](compact-deposit.md) reconstructs
the canonical deposit and invokes the same handler.

Validate pool, required System/Token/ATA programs and Clock for each operation.
Close/escape destination_owner must match WP's binding. Clear Pending.exists
after successful challenge/finalize so it can be reused; retain Closed Note
tombstones. Clearance and request share the nullifier namespace. Do not add an
expiry restriction to withdrawal that the original state machine lacks.

Never replace a challenge RP.active_root with the current root or require it to
equal Pending.old_root. Verify the historical RP unchanged; only the restoration
tree proof uses the current root. API quote/request-time freshness does not apply.

Transfers and tree changes are atomic within one instruction. Failed CPI, frozen
accounts, insufficient funds or invalid proofs roll back all state.
Tree.sequence increments on successful deposit/close/escape/challenge/finalize/
expiry, including unchanged-root finalize. Events never contain secrets, prompts
or runtime keys.

Errors have stable Anchor 6000-series assignments in the IDL: `Paused`,
`InvalidBinding`, `InvalidMint`, `InvalidTokenAccount`, `InvalidField`,
`InvalidProof`, `StaleRoot`, `StaleNoteId`, `InvalidExpiry`, `TreeFull`,
`InvalidBalance`, `ReplayedNullifier`, `NoteNotActive`, `NotPending`,
`ChallengeExpired`, `ChallengeNotExpired`, `NotExpired`, `InvalidBuffer`,
`ArithmeticOverflow`.

### Financial account order

`execute_payload` takes `payload` (writable), `uploader` (signer) and `rent_payer`
(writable), followed by exactly these 18 Financial remaining accounts. See the
[context](../../programs/zkapi-vault/src/accounts.rs) and
[SBF harness](../../tests/svm/src/vault_support.rs).

| Index | Account | Writable | Signer | Operations needing the actual account |
|---|---|---|---|---|
| 0 | pool | No | No | All |
| 1 | tree | Yes | No | All |
| 2 | note | Yes | No | All |
| 3 | pending | Yes | No | Escape, challenge, finalize |
| 4 | exit | Yes | No | Close, escape |
| 5 | vault_authority | No | No | All |
| 6 | mint | No | No | All |
| 7 | source | Yes | No | Deposit |
| 8 | vault | Yes | No | All |
| 9 | destination_owner | No | No | Close, escape, finalize |
| 10 | destination | Yes | No | Close, finalize |
| 11 | treasury_owner | No | No | Close, finalize, expiry |
| 12 | treasury | Yes | No | Close, finalize, expiry |
| 13 | token_owner | No | Deposit only | Deposit |
| 14 | payer | Yes | Yes | All |
| 15 | token_program | No | No | All |
| 16 | associated_token_program | No | No | All |
| 17 | system_program | No | No | All |

Keep unused slots and use the writable payer as their placeholder. Writable checks
also apply to unused slots, so executable programs are unsuitable placeholders.
Clock comes from `Clock::get()`; do not append it. Extra remaining accounts fail.

Though token_owner is unchecked in the common IDL context, deposit requires its
signature. Buffer deposit sets slot 13 `isSigner=true`. Uploader, payer and token
owner may differ. Inline deposit appends `token_owner_signer`, matching slot 13;
do not append it for buffer execution. Other inline financial instructions use
Financial alone; finalize does not use a buffer. These are instruction slots,
separate from deduplication in the transaction message. Measure signed v0 size/CU
with each supported signer and rent-payer arrangement.

### Events and replay

Each successful financial transition emits one `VaultTransitionV1` with Borsh
fields in this order:

```text
event_version:u8=1, pool:Pubkey, sequence:u64, op:u8, note_id:u32, status:u8,
old_root:F, new_root:F, commitment:F, deposit:u64, expiry:u64,
exit_nullifier:Option<F>, final_balance:Option<u64>,
destination_owner:Option<Pubkey>, deadline:Option<u64>
```

Options use Borsh 0/1 tags. Event operations are deposit=0, mutual_close=1,
initiate_escape=2, challenge_escape=3, finalize_escape=4, claim_expired=5, distinct
from buffer/tree enums. Deposit/expiry have no optional values. Mutual close
includes N/B/owner but no deadline. Escape uses the created Pending; challenge/
finalize use Pending before clearing it and include all four optional values.
C/D/expiry always come from the original Note. Initial sequence is zero;
administration and buffer operations do not increment it.

Indexers apply only finalized transactions with `meta.err=null`, in block
transaction order and invocation order including CPI. Validate program ID and
invocation stack. Logs emitted before a later failure do not imply success.
Reject sequence gaps and inconsistent duplicates; root alone is insufficient to
deduplicate finalize.

If logs are missing, recover from inline arguments or successful buffer
create/append/seal/execute/close history, subject to the same transaction and
invocation checks. Buffer identity includes creation transaction and execution
position, not just PDA. Check digest, offsets and execute.expected_digest.
Executed accounts may already be closed. Stop path serving if archive history
cannot support reconstruction.

## Transactions and payload buffers

The required baseline is v0 plus payload buffers, with each serialized send
<=1,232 bytes and no required ALT. Verify wallet v0 signing. All proof verification,
tree changes and transfers occur in the final execute instruction. Fitting inline
instructions use the same handler. Compact deposit requires its authenticated
capability.

Any future v1 capability requires verified cluster/RPC/SDK/wallet limits before
advertisement. Its CU/data configuration and total-lamport priority fee semantics
must be handled explicitly. Use the deployment's verified
maxSupportedTransactionVersion; baseline is 0.

```text
create_payload(op,len,digest,nonce,expires)
→ append_payload(offset,bytes)
→ seal_payload()
→ execute_payload(expected_digest:[u8;32])
```

Successful execute closes the buffer. `close_payload()` is for cancellation or
expiry recovery, not a required send after success.

Buffer op:u8: deposit=0, close=1, escape=2, challenge=3, expiry=4. Reject others.
Create arguments are u8/u32/[u8;32]/[u8;32]/u64 in that order; append is u32 offset
and Borsh Vec<u8>; seal/close have no arguments. The signed execute instruction
contains expected_digest.

The payload Vec length is u32 LE at account offset 124; bytes start at offset 128;
32-byte nonce starts at `128+payload.len()`. Total serialized account size is
`160+payload.len()`, including discriminator. `HEADER_SPACE=160` is total fixed
space, not payload offset. Seal/execute require
`payload.len() == payload_len == next_offset`. Rent allocation uses
`160+payload_len`. SHA-256 covers payload bytes only, excluding Vec length, nonce
and instruction discriminator.

Account order (`w` writable, `s` signer):

- Create: `[payload(w), pool, uploader(s), rent_payer(ws), system_program]`.
- Append/seal: `[payload(w), pool, uploader(s)]`.
- Close: `[payload(w), pool, closer(s), rent_payer(w)]`.
- Execute: its three-account prefix and Financial order above.

Create zero-fills the final payload length to fix nonce position; next_offset
tracks received data. Empty append is a valid no-op. Seal checks length/hash;
execute checks proof structure and validity. Indexers accept these histories.
At `now>=expires` any signer may close; earlier only uploader may close. Rent
always returns to the saved rent_payer.

- Require the operation's exact payload length, len<=4096 and
  `created_at < expires <= created_at+3600`.
- Append requires uploader signature, `offset=next_offset` and in-range writes.
  Existing bytes are immutable. Seal requires all bytes and matching SHA-256.
- Execute requires uploader signature, matching digest/pool/op, seal and valid
  expiry. Payload is exactly the canonical arguments without discriminator;
  reject old path formats and trailing bytes. Inline account checks also apply,
  including token-owner signature for deposit.
- Signed execute binds the buffer account and expected digest. Recreating the
  same PDA with different bytes invalidates the old signature. Sealing alone
  changes no funds, root or Note.
- Successful execute closes the buffer and returns rent. Failure leaves it sealed.
  Account absence alone does not establish success; check signature and state.
- Replaying the same payload through another buffer fails via ID/root/status/N.
  After finalized stale rejection, use a new path/proof/buffer and close the old one.

## Compute and deployment constraints

The tree circuit constrains leaf, old/new roots, common path, operation, ranges
and transition tag. The program verifies all 11 inputs with a fixed VK and binds
them to accounts and authorization proofs without on-chain Poseidon recomputation.
Original request/withdrawal circuits, Poseidon and the 32-level tree are retained.

The design target is worst-case <=1,000,000 CU per instruction and serialized
transactions within their selected format. This is a design budget, not Solana's
absolute limit. Include PDA/ATA creation, proof and state checks, Token CPI,
events and buffer handling. Do not remove checks or silently raise the target.
New profiles use new pools and corresponding builds; never overwrite an existing
pool's VK, backend or signing keys.
