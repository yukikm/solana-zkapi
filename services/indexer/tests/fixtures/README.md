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


## Runtime log truncation regression

`devnet-log-truncated-block.json` is the exact public finalized Devnet
`getBlock` JSON response at slot 508615470 (parent 508615469), fetched read-only
on 2026-10-08. SHA256:
`1cb64ee1a19f96a52356488312e3a563f673b328ff1b57f2e252bb160f109b1c`.
It contains nine complete transactions and no RPC URL, request credentials or
private operator state. Transaction index 2 has the runtime `Log truncated`
marker followed by a later short success line. The prior native decoder
rejected this transaction; the regression preserves every transaction and
instruction while treating post-marker logs as unavailable evidence.

Official behavior: [Agave v2.3.13 log collector](https://github.com/anza-xyz/agave/blob/v2.3.13/log-collector/src/lib.rs#L23-L37)
can retain shorter messages after dropping an over-limit line because dropped
bytes do not advance its byte counter. [Stable log formatting](https://github.com/anza-xyz/agave/blob/v2.3.13/program-runtime/src/stable_log.rs#L30-L40)
prefixes program-generated text with `Program log: `; that prefixed text is not
the runtime marker. This fixture demonstrates offline decoding only, not
live operator recovery, snapshot readiness or a funded lifecycle.
