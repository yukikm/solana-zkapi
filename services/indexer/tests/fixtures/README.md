# Public devnet v1 archive regression

`devnet-v1-initialize-block.json` contains the original block metadata and two
unchanged transactions selected from finalized devnet slot **507277497**, fetched
on 2026-10-04 using `getBlock`, JSON encoding, full transactions and
`maxSupportedTransactionVersion: 1`. It retains an unrelated v1 transaction and
the actual I10 Vault v0 `initialize_pool` transaction. Three unrelated legacy/v0
transactions were removed. This is a selected decoder fixture, not the complete
block or independent proof of finality. It contains only public chain data.

Original complete JSON SHA-256:
`3de71b81d60bcc2e7c886cc4e740e7f737f7772d1d72699b014b8f3eddca2c41`.
Genesis: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.

The original max-version-0 request failed with RPC error `-32015`; version 1
opt-in returned the initialized pool's block. Solana's official
[larger transaction sizes upgrade documentation](https://solana.com/upgrades/larger-transaction-sizes)
specifies the RPC ceiling, v1 inline accounts without ALTs, and the separate
`transactionConfig` fields. The decoder validates this envelope and replays
instructions; it does not calculate fees from ComputeBudget instructions or
v1 config. Its four config fields accept null or their unsigned wire integer
width (u32 limits, u64 total priority fee).
The widths and header/account layout are specified by
[SIMD-0385](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md).
This JSON reader does not perform full consensus sanitization or verify v1
signatures; the configured finalized archive remains its trust boundary.

This change enables **reading** mixed legacy/v0/v1 blocks. SDK transaction
construction, wallet capabilities, signature recovery and the 1232-byte send cap
remain v0-only. Account-cut reconciliation remains a separate requirement.

`public-base58-instruction-data.json` preserves all 40 outer and inner compiled
instruction payloads from the complete public blocks at slots 507277497 and
507289003. It includes the two original JSON hashes and a length-framed SHA-256
of their decoded bytes (each payload prefixed by its u64 little-endian byte
length). No foreign-program payload is omitted or truncated. This fixture
checks exact equivalence of the large-payload decoder with bs58 0.5.1; it is not
a full-block or finality fixture. The optimized path uses the already locked
num-bigint 0.4.8 for instruction data only; signature and key decoding keep the
existing implementation.
