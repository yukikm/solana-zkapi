# Ethereum parity privacy and trust review

Date: 2026-10-07 JST. Reviewed Solana commit
`664db46e00f77659203b81482f2859ca04d25fc8` after the requested pull, against the
vendored Ethereum source at `045b444ea1b52538d1b40273c7cb6ed09468a052`.
This is a scoped engineering review, not a third-party audit or new live-provider
acceptance. Existing funded deployments, journals and provider budgets were not
read or changed by this review.

## Result and corrections

The ordinary authorization path preserves the same intended separation between
the public deposit and the proof-backed API authorization. No additional
actionable bypass was found in the reviewed common-snapshot path, native/WASM
reconstruction or independently pinned public-profile boundary. This conclusion
does not imply anonymity against network correlation, malicious app distribution
or a colluding provider/operator.

The application review identified inaccurate memory-only conversation wording.
Independent inspection confirms that `ControlClient.prepareOperation` stores the
full request in `bodyBase64` before proxy dispatch, and `sendDirectOperation`
does the same before direct dispatch. Successful settlement in `accept` moves
those operations into retained history; emergency escape preserves the pending
session too.
Prior assistant text is therefore retained when a later request includes it as
context. The SDK does not separately journal the incoming response body.

**P2 — Persisted direct-provider keys conflicted with memory-only short-lived-key
custody.** The pulled source stored an accepted `providerKey` in `PendingSession`
(`control.ts:568-570`, saved at `:598` in the review baseline).
`WalletClient.beginEmergencyEscape` copied that field into its archive, where it
could survive recovery/finalization. The Ethereum native client's `cachedLease` is an in-memory field
(`zkapi-clientd/internal/zkapi/client.go:51,470`); the browser similarly exposes
the key from its active in-memory lease (`browserWalletRuntime.js:2332-2354`).

The correction keeps newly received keys only in the current `ControlClient`,
bound to the local note and exact saved authorization/request ID. Its `save`
method omits `providerKey` from the durable record and retains a volatile key only
after the CAS succeeds; failed writes forget that cache. Its `record` method
ignores any legacy disk key and hydrates only a matching active session from its
own memory. Close, settlement and application disposal clear the cache. A fresh
client closes/settles the saved session through the existing recovery path,
without reviving the key, changing mode or replaying inference.

OA evidence remains encrypted in the journal, but is neither a usable key nor a
persisted trust assertion. Current-instance sends still validate expiry and the
exact key/evidence/pin binding, rechecking changed evidence with the pinned
verifier. New emergency-escape archives omit legacy key fields while preserving
exact AUTH, operation bytes and state. Existing journals/archives are not migrated
on read, and historical backups can still retain encrypted keys. Expiration and
revocation do not establish secure erasure of those old bytes. The journal schema
and financial state machine are unchanged.

The SDK [deployment guide](../sdk/deployment.md) and
[recovery guide](../sdk/recovery.md#local-request-retention) now explain this
retention, the lack of a selective-erasure API, and the distinction between
clearing a visible chat and deleting financial custody. They distinguish the new
memory-only direct-key behavior from old encrypted records/backups.
[SDK internals](../../packages/sdk/INTERNALS.md) describe the changed low-level
recovery contract. The example's copy is corrected in the separate application
review. No historical operation bytes or financial evidence are migrated.
Encryption protects the stored records but not against trusted same-origin code
using its stored key, or a compromised local host. Equivalent protocol privacy
does not establish identical application data-retention policies.

## Reviewed boundaries

| Boundary | Evidence and remaining assumption |
|---|---|
| Selected note during AUTH | Ethereum `sdk/services/browserWalletRuntime.js:829` downloads a common snapshot and selects locally. Solana `packages/sdk/src/session-snapshot.ts:60-70` also downloads common routes, ignores any descriptor-selected origin, and later reads only PoolConfig, TreeState and Clock. `:118-121` selects the note only after those shared reads. The adapter refuses a missing private interface instead of falling back to financial note queries (`:25-27`). |
| Snapshot authenticity | Solana checks independent genesis/pool pins, finalized source block and account cut, tree root, sequence and next ID. `apps/clientd/prover/src/snapshot.rs` reconstructs the original Poseidon root with sparse maps and returns 32 siblings only for an included active leaf. Pending metadata is not financial authority. The configured RPC and chain finality remain trusted. |
| Prompt routes | `ControlClient.sendDirectOperation` goes to the independently configured provider base, while proxy inference necessarily exposes content to the proxy. AUTH contains proof/quote/authorization data, not inference bodies. Control/proxy/provider usage and key-management behavior remain trust points; ZK does not prove model correctness or provider usage accuracy. |
| Network metadata | Cookie omission, redirect rejection and ordinary AUTH's common selectors reduce accidental linkage. Funding, withdrawal, note amounts, network addresses and timing remain observable. Tor support has separate historical local tests; this review did not verify live Tor. |
| Local prover and custody | The pinned native process receives commands via stdin with a cleared environment and discards stderr (`prover-node.ts:16-29`). Browser proof execution uses the pinned WASM and application-installed worker. The browser stores a nonextractable AES key and encrypted journal in the same origin. App/worker distribution and device integrity remain trust points. |
| Setup and roles | The fresh generator uses OS randomness for independent signing roles and tree Groth16 setup; the public loaders, Vault build and service config bind independent descriptor/build hashes and reject known fixture material. Request/withdrawal keys retain the upstream single-party setup. The newly added tree circuit adds another setup assumption; no ceremony or independently attested erasure is claimed. |
| Settlement authority | USDC issuer controls and Solana program upgrade authority are additional differences from upstream native-ETH settlement with immutable verifiers. The deployment launcher checks ProgramData bytes and authority; client pool/artifact checks do not remove upgrade-authority trust. The SDK deployment guide now states these differences directly. |

The public-profile checks reviewed include
`programs/zkapi-vault/build_profile.rs:81`,
`scripts/public_devnet_profile.py`, `scripts/i10_public_devnet_profile.ts`,
`services/control/src/config.rs:125-190`, and the separate signer configuration.
Historical fixture profiles remain explicitly legacy and are not evidence for a
fresh public deployment.

## Fresh local validation

Commands were run from the repository root. The
[artifact archive](I10-parity-review-privacy-components/artifacts.json) records
reviewed-source hashes and exact saved-log hashes.

| Command | Result |
|---|---|
| `target/i08-toolchain/bin/node --test packages/sdk/test/session-snapshot.test.ts packages/sdk/test/trust.test.ts scripts/i10_public_devnet_profile.test.ts` | 28 passed, zero failed or skipped. Common selectors for different/missing notes, malformed/tampered snapshot rejection, no fallback, manifest/artifact pins and synthetic public-profile configuration guards. |
| `cargo test --locked --manifest-path apps/clientd/prover/Cargo.toml --lib snapshot::tests` | 3 passed, zero failed or ignored. Actual original Poseidon tree reconstruction, upstream-path agreement, sparse final-u32 leaf and malformed/omitted-note rejection. |
| `cargo build --locked --release --manifest-path apps/clientd/prover/Cargo.toml` | Fresh native prover build passed. |
| `cargo build --locked --release --target wasm32-unknown-unknown --manifest-path apps/clientd/prover/Cargo.toml --lib` | Fresh WASM build passed. |
| `target/i08-toolchain/bin/node --test packages/sdk/test/session-snapshot-runtime.ts` | 1 passed, zero skipped. Fresh native and WASM agree on the tracked real-proof fixture root and all 32 siblings; changed root/amount, omitted/duplicate notes and invalid selection fail. Both engines remain usable afterward. |
| `cargo test --locked --manifest-path services/control/Cargo.toml --test devnet_config public_profile_` | 2 focused offline tests passed, 8 filtered out, zero ignored. Independent pin, legacy identity and fixture-material rejection. |
| `target/i08-toolchain/bin/node --test packages/sdk/test/control.test.ts packages/sdk/test/clientd.test.ts packages/sdk/test/client.test.ts packages/sdk/test/wallet-emergency-escape.test.ts` | 138 passed, zero failures or skips after the memory-only correction. Synthetic provider/chain/proofs, real encrypted storage and shared lifecycle. Covers normal use/close/restart, no inference replay, OA current-key/evidence binding, failed key-delivery persistence, cache clearing, changed AUTH and persisted-key injection, keyless new emergency archives, and preserved historical archive reads. |
| `target/i08-toolchain/bin/node node_modules/typescript/bin/tsc --noEmit -p packages/sdk/tsconfig.json` | Passed after the memory-only source and focused tests changed. |

The first focused memory-only run exposed obsolete assertions requiring persisted
keys and restarted-key reuse; its failed log is preserved. Those expectations
were replaced with explicit keyless-journal and restart-close behavior, and the
new regression cases above passed. These component results are not a full SDK
or live acceptance result.

The first control-test command used `cargo test --locked -p zkapi-control` from
the root workspace, but the service owns a separate workspace. It failed before
running tests with an unknown package ID; the failed log is retained alongside
the corrected `--manifest-path` invocation. No result is claimed for its filtered
DB, dispatcher or other tests.

The rebuilt native SHA256 is
`e0f6891e4320040db6f54e03eb03b11f5de194a42ddd477ab26dd376c42df8d6`;
WASM SHA256 is
`c06a247e1ff88f1ac415ea127bcf49d486b5b4954715cdf00f133b5ac71c1f30`
(3,678,975 bytes). The runtime check used Node, not Chrome or Phantom. Synthetic
profile tests do not establish a setup generation or SBF transaction. The prior
fresh-profile directory was absent on this checkout, so it was neither recreated
nor represented as a new accepted public profile.

No new RPC transaction, provider request, funded deposit, public deployment,
mainnet deployment or external audit was performed in this scope. Mainnet and
third-party auditing are later milestones, not defects of the requested devnet
demonstration. Broad public parity still needs the independent live acceptance
matrix described in [the parity handoff](I10-parity.md).
