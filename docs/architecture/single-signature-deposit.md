# Single-transaction deposits

`deposit_compact_v1` places the complete deposit in one version-0 transaction.
The ordinary self-funded path requires one wallet signing request, one
Ed25519 signature and one finalized financial transaction. Proof verification,
Note creation, USDC transfer and tree updates succeed or roll back together.
The existing `WalletClient` and encrypted journal own this flow.

The design decision is [ADR-0003](../adr/0003-single-transaction-deposit.md).
[Support status](../status.md) describes verified release scope; this design is
not a record of public-wallet acceptance. Exact wire definitions are in the
[tree-transition contract](../contracts/tree-transition.json).

## Scope and transport choice

The canonical deposit payload is 692 bytes, or 700 bytes with its Anchor
discriminator. With the existing account roles, signatures and compute-budget
instructions, the ordinary inline transaction is 1,263 bytes and exceeds the
[1,232-byte limit](https://solana.com/docs/core/transactions). Compact encoding
removes duplicate public-input values and preserves the full proof contract.
It requires no new circuit, trusted relayer, address lookup table or batch
wallet approval.

The SDK selects compact transport for a new deposit only when independently
trusted build pins and the authenticated manifest enable
`v0_inline_deposit_v1`. Buffer transport remains required for old operations,
withdrawals, escapes and challenges. Existing operations retain their saved
transport and trust pins.

A connection loss after durable signing is recovered using the saved attempt.
A transaction bound to an old root, note ID or expiry may instead be definitively
rejected; preparing a changed transaction then needs a new wallet signature.
The design does not promise a single approval across all possible rejections.
Off-chain API authorization, inference and settlement do not add deposit wallet
transaction signatures.

## Compact wire and proof inputs

The Anchor instruction name is `deposit_compact_v1`, with discriminator
`adee5c1edb1f80e9`. Here `v1` versions the instruction encoding, not the Solana
transaction or account layout. The existing `deposit` discriminator, payload
and buffer encoding remain unchanged.

Compact arguments have exactly 436 bytes; complete instruction data has exactly
444 bytes. There is no variable-length vector, arbitrary public-input array or
compressed curve-point encoding.

| Argument offset | Field | Bytes and encoding |
|---:|---|---|
| 0 | `expected_id` | 4, u32 little-endian |
| 4 | `expected_root` | 32, canonical Fr big-endian |
| 36 | `expiry` | 8, u64 little-endian |
| 44 | `commitment` | 32, canonical Fr big-endian |
| 76 | `amount` | 8, u64 little-endian, micro-USDC |
| 84 | `new_root` | 32, canonical Fr big-endian |
| 116 | `new_leaf` | 32, canonical Fr big-endian |
| 148 | `transition_tag` | 32, canonical Fr big-endian |
| 180 | `tree_proof` | 256, existing uncompressed proof wire |

After validating the PoolConfig owner, PDA, layout and profile, the program
restores all 11 public inputs from the verified pool and arguments:

| Index | Restored value |
|---:|---|
| 0 | Verified `PoolConfig.vault_binding` |
| 1 | `args.expected_root` |
| 2 | `args.new_root` |
| 3 | `Fr(args.expected_id)` |
| 4 | `Fr(0)` |
| 5 | `args.new_leaf` |
| 6 | `args.commitment` |
| 7 | `Fr(args.amount)` |
| 8 | `Fr(args.expiry)` |
| 9 | `Fr(0)`, the deposit tree operation |
| 10 | `args.transition_tag` |

The same 11 inputs, proof and verification key are verified. The program does
not replace proof-bound `new_leaf` or `transition_tag` with an on-chain Poseidon
calculation. Request, withdrawal and tree circuits, PK/VK, Poseidon, domains,
note secrets, integer accounting and layout 2 remain unchanged.

The [Rust codec](../../crates/zkapi-layout2/src/compact.rs) strictly decodes and
expands compact arguments into the original 692-byte canonical payload. It
checks exact length, canonical fields and integer zero extension. Pool binding
is a separately validated input, never an arbitrary value from compact wire.
The [SDK codec](../../packages/sdk/src/layout2.ts) compresses only when every
duplicate value, constant and binding agrees. Fixed vectors and generated
proofs must satisfy `expand(compress(canonical)) == canonical`; compression
cannot conceal a contradictory original input.

## Vault execution and accounts

The instruction preserves `DepositAccounts`: the existing Financial accounts
and `token_owner_signer`. Account order, unused-account payer aliases and
owner/payer roles remain unchanged. It delegates to the shared financial
handler, with these checks:

1. Require the correct discriminator and exactly 444 instruction bytes;
   reject trailing bytes and confusion with canonical wire.
2. Verify the owner signature, its equality to `Financial.token_owner`, and
   the actual PoolConfig using the existing account validators.
3. Expand compact arguments into the canonical deposit payload.
4. Run the common deposit handler. It checks root, next ID, expiry, amount,
   all public inputs, fixed VK, mint, token authority, source and vault.
5. Atomically create the Note, perform `TransferChecked`, update the tree,
   sequence and outstanding deposit total, and emit the existing event.

Compact deposits retain the existing proof, signer, token, PDA and pause
checks. Pool/Note/TreeState account layouts and event layouts do not change.
Compiler-generated IDL, entrypoint length guards, SDK codecs and indexer
decoding must agree. Measure the compact entrypoint's stack, heap and compute
cost in real SBF execution rather than reusing the canonical deposit's cost.

## Transaction size and payer roles

The [offline sizing script](../../scripts/analyze_single_deposit_transaction.ts)
uses current Solana Kit codecs and SDK account derivation, including signature
slots, compute-unit limit, a nonzero compute-unit price and actual v0 account
indices. Its reference configurations have these serialized sizes:

| Configuration | Transaction bytes | Signatures |
|---|---:|---:|
| Canonical deposit inline, self-funded | 1,263, exceeds limit | 1 |
| Compact deposit, self-funded, no lookup table | 1,007 | 1 |
| Compact deposit, owner separate from shared rent/fee payer | 1,103 | 2 |
| Compact deposit, separate owner, rent payer and fee payer | 1,199 | 3 |

Every actual transaction must be serialized and rejected before signing if it
exceeds 1,232 bytes. A sponsored transaction has more total signatures even
when the user approves only once. Its roles and costs must be explicit; spare
bytes do not authorize unreviewed memo or transfer instructions.

Inline roles are `tokenOwner`, Financial `payer` for Note creation, and
transaction `feePayer`. Buffer `uploader` and `rentPayer` roles do not silently
carry into an inline plan. Adapters reject ambiguous role mappings before
signing. Address lookup tables, relayer-prepared buffers and batch signing are
not prerequisites; they introduce separate dependencies and do not define this
single-transaction flow.

## SDK flow and durable state

1. `beginDeposit` obtains a finalized snapshot, selects the provisional note ID
   and expiry, and creates private witness/state. Persist the secret, amount,
   operation ID and selected transport in the encrypted journal before expensive
   proof generation, signing or sending.
2. Generate and locally verify the tree proof using that saved witness and
   snapshot. Check that compact expansion preserves all public inputs.
3. Recheck pool, root, next ID and expiry before signing. Before an attempt is
   signed, preparation can update the snapshot while retaining the secret and
   amount. This does not reserve a root or exclude competing users.
4. Obtain a fresh blockhash after proving. Preserve preparation commitment,
   preflight and fee limits, freeze the message and request the wallet signature.
5. Verify unchanged message bytes and all signatures, then atomically persist
   exact signed bytes with the encrypted journal's compare-and-swap operation.
   Send only after that durable commit.
6. Verify the exact finalized transaction message and its receipt. Check the
   actual Note's commitment, amount, expiry and status at or after the receipt's
   slot before making the note active and available to `ControlClient`.

`InlineDepositPlanRecord` and `InlineDepositAttempt` extend the existing
[transport](../../packages/sdk/src/transport.ts) and
[wallet](../../packages/sdk/src/wallet.ts) unions. `deposit_inline` is a financial
terminal step, alongside execute/finalize. It has no fictitious buffer or
separate note state machine. Browser and native flows use the same WalletClient.

A plan binds transport, deployment/manifest/program/pool/mint, accounts and roles,
discriminator, exact compact bytes, canonical payload/digest, amount, expected
root/ID/expiry, snapshot slot/sequence and fees. An attempt retains the signed
transaction bytes, signature, blockhash and last-valid block height.
`inlineInstructionDigest` is distinct from the canonical payload digest; the
existing buffer digest definition does not change.

## Journal compatibility and recovery

Inline records use NoteJournal plaintext schema 2. Validators explicitly accept
schema 1 and schema 2 with their respective structures. Encryption envelopes,
authenticated data, compare-and-swap and locking remain unchanged. Schema 2
validates transport discriminants, allowed fields, mutually exclusive plan
types and signature/wire consistency. Schema-1-only clients must reject it.

New clients read schema-1 operations as the legacy buffer transport. Reading
does not rewrite the record or convert an existing buffer operation into an
inline deposit. ControlClient updates preserve schema 2. Previous signatures,
rejected attempts and buffer history remain available for recovery.

| Observation | WalletClient behavior |
|---|---|
| Unsigned plan or wallet rejection | Keep it unsent. Request a signature only when the user resumes. |
| Signed-byte persistence failure or crash before commit | Send nothing. Reload the journal; use a committed attempt if present, otherwise the unsigned plan can be signed again. |
| Exact finalized successful message | Verify the Note at or after the receipt slot and activate it. Repeat verification after a crash before the local commit. |
| Exact finalized `StaleRoot`, `StaleNoteId` or `InvalidExpiry` rejection | Retain the attempt, reprove at a fresh snapshot with the same operation/secret/amount, and explicitly sign the new message. No buffer close is needed. |
| Other finalized rejection | Preserve failure; use the existing explicit rejected-operation retry after resolving its cause. |
| Lost acknowledgment, confirmed-only status, missing history, inconsistent RPCs or blockhash expiry alone | Remain unresolved. Do not create another deposit, rebase to a new ID or fall back to buffer transport. |

Recovery shares exact-message and signature observation with existing financial
operations. It does not add automatic retransmission; explicit recovery may
resend the identical recorded bytes. Buffer helpers such as
`reconcileExpiredCreation` and `refreshExpiredUpload` do not apply to this
financial instruction. An absent buffer or Note, or an expired blockhash, does
not prove that the deposit failed.

Monotonic next-note IDs and unused Note PDAs prevent a second debit for the same
expected ID. The local operation UUID is not an on-chain idempotency key.
Rebasing an unknown transaction could allow both old and new deposits to
succeed. A new financial attempt therefore requires an exact finalized
rejection of the previous attempt, revalidated before reproving.

Removing renewed approval after a definitive rejection would require a separate
protocol for stable deposit nonces, signed intents and relayer permissions.
Compact encoding does not introduce that protocol.

## Indexer, manifest and deployment compatibility

The indexer expands the compact discriminator into the same canonical command,
using the verified pool binding at that historical point. Existing transition,
event and root replay rules apply, including instruction reconstruction when
events are missing. Failed transaction logs must not become successful deposits.

The signed manifest's `transaction_formats` capability
`v0_inline_deposit_v1` refers only to `deposit_compact_v1`; it does not redefine
`v0_inline`. Independently installed
`ManifestTrustPolicy.build.transactionFormats` must include both `v0_buffer`
and `v0_inline_deposit_v1`. A signed capability alone is insufficient. The
hash-verified IDL must also match the discriminator, arguments and account roles.
Recovery rechecks the saved manifest hash at each unresolved-operation entry.

Validators and distribution pins across SDK, native clients, control and
challenger must agree. Circuit profiles and account layouts stay fixed;
changed IDL, program and release artifacts receive their corresponding new
hashes and manifest. Unauthenticated UI or RPC flags cannot enable transport.

For a compatible pool upgrade, deploy indexer/read support first, verify that
old instructions and funded-note recovery still work, then upgrade the program
and publish the authenticated manifest. An isolated Devnet pool and new journal
provide the initial canary environment. A changed program or pool changes its
binding and does not migrate existing notes. Never replace unresolved custody
pins with the new manifest.

New clients can recover old buffer-only operations; older clients that do not
understand new capabilities must fail closed. New deposits can prefer compact
transport on a verified compatible deployment, while general buffer support and
old journals remain mandatory.

## Acceptance criteria

- The ordinary self-funded path has one financial instruction, one wallet
  signing request and one signature. Serialize every transaction at no more
  than 1,232 bytes and verify real SBF execution within the 1,000,000-CU limit.
  Measure sponsored role configurations separately.
- Reject mutations of every compact field, pool binding, proof coordinate and
  public input, mixtures of independently valid proofs, old wire and trailing
  bytes. Strict codec round trips and compiler-generated IDL must agree.
- Insufficient/frozen USDC, wrong mint/token program/owner/source/PDA, pause and
  overflow must roll back Note, root, sequence, outstanding total and USDC.
  Network fees are outside that rollback.
- Replaying identical signed bytes or the same payload with a new blockhash
  cannot debit twice. Reprove root/ID/day-boundary conflicts only after exact
  finalized rejection.
- Reject wallet message/signature changes and concurrent journal writers.
  Verify zero sends before durable signed-attempt commit. After commit,
  acknowledgment loss or a crash between receipt and local commit recovers the
  saved attempt without a new deposit, rebase or additional signature.
- Pruned RPC history, expiry plus absent Note, another user's Note, mismatched
  receipts and inconsistent RPCs must not trigger new signatures or fallback.
- Verify old buffer recovery, rejection of schema 2 by old clients, schema-2
  preservation by all writers, and withdrawal/escape/challenge regressions.
- Replay mixed buffer, legacy-inline and compact history with missing events,
  failed logs and restarts to the same finalized cut, root and sequence. An
  indexer lacking the new discriminator must not silently skip it.
- Reject incompatible program, IDL, build-pin and manifest-capability
  combinations before signing. Verify actual supported wallets and public
  finality separately from offline sizing and local runtime tests.

The existing local runner is
[`scripts/run_single_deposit_acceptance.py`](../../scripts/run_single_deposit_acceptance.py).
Its prerequisites and scope are documented in [Contributing](../../CONTRIBUTING.md).
Offline serialization establishes byte layout and size; real proof/SBF tests
establish local execution, while public wallet/deployment acceptance requires
its own observed results.
