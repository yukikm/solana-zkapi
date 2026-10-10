# ADR-0003: Send compact deposits in one v0 transaction

The [compact deposit contract](../specs/compact-deposit.md) defines the wire,
journal, capability and recovery requirements.

## Reason

A buffer deposit requires create, append, seal and execute transactions. The
canonical inline deposit duplicates public-input values and can exceed the
1,232-byte transaction limit with the existing accounts and compute-budget
instructions.

## Decision

1. `deposit_compact_v1` carries 436-byte arguments that reconstruct the canonical
   692-byte deposit and all 11 public inputs. It uses the same proof, fixed VK
   and financial handler.
2. Preserve DepositAccounts, circuits, Poseidon, PK/VK, account layout, integer
   USDC accounting, authorization and settlement.
3. New deposits may use one v0 transaction when both independent build pins and
   the signed manifest support `v0_inline_deposit_v1`. ALT, relayers and v1
   transactions are not required.
4. Extend the existing WalletClient and encrypted journal with transport-specific
   plans and attempts. An uncertain send cannot trigger another deposit,
   rebasing or automatic buffer fallback.
5. Inline records require NoteJournal schema 2, which older SDKs reject. New
   SDKs recover schema 1 buffer operations using their saved transport.
6. `v0_buffer` remains mandatory for existing operations, withdrawal, escape,
   challenge and other supported buffer operations. Never convert existing
   proofs, signatures or journals.

A normal self-funded deposit needs one wallet signature. A transaction with a
definitively finalized root, note-ID or expiry rejection needs a new signature after its
contents change. Persistent approval across such retries would require a
separate signed-intent/nonce/relayer design.

ALT adds deployment and availability dependencies. Batch signing four
transactions reduces prompts but does not provide atomic single-transaction
deposit. Compact transport removes duplicate values while preserving verification.
