# Compact deposit contract

[ADR-0003](../adr/0003-single-transaction-deposit.md) defines `deposit_compact_v1`:
one v0 financial transaction using the existing WalletClient, encrypted journal,
proofs and financial handler.

A normal self-funded deposit has one wallet signature request, one Ed25519
signature, one transaction and one finalized receipt. Proof verification, Note
creation, USDC transfer and tree update succeed or roll back together. Reconciliation
after a lost response does not itself request another signature.

A definitively finalized root, note-ID or expiry rejection requires new contents
and a new signature. The contract does not promise permanent approval across
conflicts. API authorization, inference and settlement add no wallet transaction
signatures after deposit.

## Wire

The canonical deposit has 692-byte arguments, including duplicated roots, ID,
amount and other tree inputs. Compact encoding removes only these duplicates.
It requires no new tree circuit, trusted relayer, ALT, batch approval or v1
transaction support.

Anchor instruction `deposit_compact_v1` has 436-byte arguments, or 444 bytes with
its discriminator. The name's v1 is its wire version, independent of Solana
transaction version and account layout. Existing deposit discriminator, arguments
and buffer payload remain unchanged. No variable Vec, arbitrary public-input
array or compressed curve point is introduced.

| Argument offset | Field | Bytes / encoding |
|---:|---|---|
| 0 | expected_id | 4 / u32 LE |
| 4 | expected_root | 32 / canonical Fr BE |
| 36 | expiry | 8 / u64 LE |
| 44 | commitment | 32 / canonical Fr BE |
| 76 | amount | 8 / u64 LE micro-USDC |
| 84 | new_root | 32 / canonical Fr BE |
| 116 | new_leaf | 32 / canonical Fr BE |
| 148 | transition_tag | 32 / canonical Fr BE |
| 180 | tree_proof | 256 / existing uncompressed proof wire |

After validating PoolConfig owner/PDA/layout/profile, reconstruct every public input:

| Index | Value |
|---:|---|
| 0 | Verified PoolConfig.vault_binding |
| 1 | args.expected_root |
| 2 | args.new_root |
| 3 | Fr(args.expected_id) |
| 4 | Fr(0) |
| 5 | args.new_leaf |
| 6 | args.commitment |
| 7 | Fr(args.amount) |
| 8 | Fr(args.expiry) |
| 9 | Fr(0), deposit tree operation |
| 10 | args.transition_tag |

Verify the same 11 inputs, proof and VK. Do not recompute new_leaf or transition_tag
with Poseidon in the program. Request/withdrawal/tree circuits, PK/VK, Poseidon,
hash domains, note secrets, integer accounting and layout 2 remain unchanged.

`crates/zkapi-layout2` strictly decodes and expands into the original 692-byte
canonical deposit. Require exact length, canonical fields and zero-extended
integers. Binding comes from the caller's verified pool, never arbitrary wire data.
SDK compression requires every duplicate, constant and manifest binding to agree;
omission must not hide disagreement. Verify
`expand(compress(canonical)) == canonical` with fixed vectors and generated proofs.

## Vault and account contract

Use existing DepositAccounts: Financial plus token_owner_signer. Preserve unused
slots aliased to payer, independent owner/payer roles and IDL account order.
No separate financial handler or reduced account mapping is introduced.

1. Strict entrypoint requires the discriminator and exact 444-byte instruction.
   Reject trailing bytes and incompatible wire.
2. Existing validation checks token_owner_signer matches Financial.token_owner,
   signatures and PoolConfig.
3. Expand compact arguments to canonical deposit.
4. Call `handlers::run(financial, Operation::Deposit, canonical)`.
5. Shared handling checks root, next ID, expiry, amount, all 11 inputs, fixed VK,
   USDC mint/authority/source/vault, then creates Note, transfers USDC, updates
   tree/sequence/outstanding and emits the existing event atomically.

Keep signature, proof, token, PDA and pause checks identical across transports.
Measure expansion stack/heap/CU in actual SBF; old deposit measurements do not
establish compact performance. Compiler-generated IDL, length guards, codec and
indexer must agree. Pool, Note, TreeState and event layouts do not change.
See [Vault](../../programs/zkapi-vault/src/lib.rs),
[handler](../../programs/zkapi-vault/src/handlers.rs),
[transport](../../packages/sdk/src/transport.ts) and
[WalletClient](../../packages/sdk/src/wallet.ts).

## Transaction limits

Serialize actual messages with signatures, SDK-derived accounts, compute-unit
limit and nonzero compute-unit price. Reference layouts have these sizes:

| Layout | Bytes |
|---|---:|
| Canonical inline deposit, self-funded | 1,263 |
| Compact, same accounts, self-funded, no ALT | 1,007 |
| Compact, separate owner and payer | 1,103 |
| Compact, separate owner, Note rent payer and fee payer | 1,199 |

These are layout-specific values, not permission to skip serialization. Require
<=1,232 bytes before signing. Self-funded is the normal path. Sponsored layouts
have two or three total transaction signatures and need explicit roles and
separate measurements. Do not fill spare bytes with unreviewed instructions.

An ALT introduces provisioning, pins and availability dependencies. Batch signing
four buffer transactions does not make them atomic. Relayed buffers add service
signing, rent and availability responsibilities. v1 requires separate deployment/
RPC/wallet verification. None is required by this compact format.

## SDK execution and journal

1. `beginDeposit` chooses provisional note ID/expiry from a finalized snapshot
   and creates the private witness/state. Persist secret, amount, operation ID
   and transport chosen from authenticated capabilities before costly proving,
   signing or sending.
2. Generate and locally verify the existing tree proof for the saved state and
   snapshot. Compare public inputs before and after compression.
3. Recheck pool/root/next ID/expiry before signing. An unsigned plan may refresh
   preparation while preserving secret/amount; this does not reserve tree state.
4. Fetch a fresh blockhash after proving. Apply existing preparation commitment,
   preflight and fee limits; fix the message and request the wallet signature.
5. `signV0` verifies the unchanged message and all signatures. CAS-save exact
   signed bytes in the encrypted journal before any send.
6. Verify the finalized receipt matches the exact message, then inspect actual
   Note/commitment/amount/expiry/status at or after its slot before marking active.
   The existing ControlClient can then use the note.

`InlineDepositPlanRecord` and `InlineDepositAttempt` extend existing operation/
attempt unions. Do not invent fake buffers/nonces or another note state machine.
Treat `deposit_inline` as a financial terminal step like execute/finalize. API,
Go clientd and browser integrations use the same WalletClient.

Plans save transport, deployment/program/pool/mint, all accounts/roles,
discriminator, exact compact bytes, expanded canonical payload/digest, amount,
expected root/ID/expiry, snapshot slot/sequence and fee conditions. Attempts save
signed message/wire, signature, blockhash and last-valid height.
inlineInstructionDigest and canonical payload digest remain separate;
buffer digest semantics do not change.

Inline roles are tokenOwner, Financial payer (Note rent) and transaction feePayer.
Do not silently inherit buffer uploader/rentPayer roles. Adapters accepting the
old role object must explicitly map roles and reject ambiguous funding before signing.

Inline operations require NoteJournal plaintext schema 2. The shared validator
explicitly validates schemas 1 and 2, preserving encryption envelope, AAD, CAS
and locks. Schema 2 validates transport/plan/attempt discriminated unions,
allowlisted fields, exclusive structures and signed-wire consistency. Verify old
schema-1-only SDKs reject it.

New SDKs interpret missing schema-1 transport as buffer. Read-only access must not
rewrite records or convert old operations. Every ControlClient writer preserves
schema 2; never construct a replacement schema-1 record. Keep old buffer history,
failures and signatures.

## Recovery

| Observation | WalletClient behavior |
|---|---|
| Unsigned or wallet rejects signing | Retain unsent plan; request signing only on explicit resume; no send |
| Signed-byte persistence fails or crash precedes commit | No send; reread journal. Without a committed attempt, explicit resume may sign the unsent plan; if only the commit response was lost, use the saved attempt |
| Finalized success with exact message | Validate Note at/after receipt slot and activate; repeat reconciliation after a crash before CAS |
| Finalized StaleRoot/StaleNoteId/InvalidExpiry | Preserve old attempt; reprove same operation/secret/amount on a new snapshot and explicitly sign the new message; no buffer to close |
| Other finalized rejection | Preserve failed state; after fixing its cause use explicit retryRejected-style preparation |
| Lost ACK, confirmed-only result, missing history, RPC disagreement or blockhash expiry alone | Keep unresolved; no new deposit, rebase to another note ID or automatic buffer fallback |

Reuse exact-byte/signature observation. Unknown sends do not gain automatic
resubmission; preserve the existing explicit identical-byte recovery policy.
Never apply `reconcileExpiredCreation` or `refreshExpiredUpload` to financial
instructions. A missing buffer does not prove a deposit failed.

Monotonic next_note_id and unused Note PDA prevent duplicate debit at one expected
ID. Local operation UUID is not an on-chain idempotency key: rebasing an uncertain
send to a different ID/root can let both succeed. Do not create another financial
attempt before a definitively finalized rejection under this contract.

Permanent approval across retries would require a separately designed signed
intent, stable deposit nonce/receipt PDA, source/amount/pool/mint/deadline/commitment
bindings and relayer reproving authority. Compact transport does not add these.

## Indexer, trust and deployment

Indexer expands the new discriminator to the same canonical command and reuses
transition/event/root reconstruction with the verified historical PoolConfig
binding. Ignore failed-transaction logs; replay instructions when events are missing.

The signed manifest advertises `v0_inline_deposit_v1`, meaning only
`deposit_compact_v1`; never redefine `v0_inline`. `v0_buffer` remains required for
other supported operations and old journals. Independently distributed
`ManifestTrustPolicy.build.transactionFormats` must also contain both capabilities.
The signed manifest alone cannot enable compact transport. Check the hashed IDL's
discriminator, arguments and roles, and revalidate saved manifest hashes at every
entry point for unresolved work.

SDK/trust, OpenAPI, native/Go/control/challenger validators and distribution pins
must agree. Circuit profile/account layout stay fixed; update affected IDL/ELF/
distribution/manifest hashes. UI or unauthenticated RPC flags cannot select transport.

Validate new deployments using an isolated program/pool and fresh journal. For an
explicitly authorized compatible upgrade, deploy indexer/readers first; verify
old instructions and funded-note recovery, then upgrade Vault and distribute the
new manifest. A different program/pool changes binding and does not migrate notes.
New SDKs must still recover old buffer-only deployments. Old SDKs that do not
understand a manifest stop rather than guessing. Never replace unresolved
operations' trust pins with a new manifest.

## Verification requirements

- Normal deposit: one financial instruction and one self-funded signature;
  <=1,232 bytes and <=1,000,000 CU. Measure separate-payer layouts independently.
- Reject each changed field, binding, coordinate/input, mixed valid proofs, wrong
  wire and trailing bytes without weakening checks.
- Insufficient/frozen USDC, wrong mint/token program/owner/source/PDA, pause and
  overflow roll back Note/root/sequence/outstanding/USDC. Network fees do not roll back.
- Duplicate signed bytes and same payload with a different blockhash debit once.
  Reprove root/ID/day-boundary conflicts only after finalized rejection.
- Reject wallet message/signature changes, CAS conflicts and competing tabs.
  Before durable commit, crash means no send. After commit, lost ACK or crash
  before receipt CAS recovers the exact saved attempt without new deposit/rebase/signature.
- Pruned history, expiry plus absent Note, another user's Note, wrong receipt and
  RPC disagreement never trigger automatic signing/rebase/fallback.
- Verify schema-1 buffer recovery, old-SDK schema-2 rejection, schema-2 preservation
  in ControlClient and unchanged withdrawal/escape/challenge behavior.
- Reject mismatched program/IDL/capability before signing. Older indexers must not
  silently skip unknown financial instructions.

Offline serialization, real SBF proof/token execution and real wallet/public-chain
acceptance are distinct verification scopes. Report the scope actually exercised.
