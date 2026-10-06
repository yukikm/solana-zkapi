# Private authorization snapshot follow-up

Review baseline: `a9c3364a89990e22b0a3c3d0bddee82493017987`; upstream
`ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`.
Date: 2026-10-06 UTC. This record concerns local implementation and validation.

## Finding and correction

Ordinary authorization previously fetched the selected note's indexer path and
Note/Pending PDAs. An indexer/RPC could associate that public deposit with the
requesting network client even though the later AUTH proof hid its note ID.

The SDK, native clientd, browser demo, provider acceptance client and devnet
challenge preparation now use `sessionSnapshot`. It downloads a common descriptor
and content-addressed full snapshot from the independently configured indexer
origin. The descriptor cannot select another fetch origin. Redirects, credentials,
noncanonical JSON, oversized bodies, invalid field encodings, duplicate/unsorted
notes, overlaps and inconsistent metadata are rejected.

The reader authenticates the RPC genesis and finalized PoolConfig, TreeState and
Clock in one account cut, checks the indexer's source block, and compares root,
sequence and next note ID. The sequence/next-ID checks prevent accepting an old
tree view merely because a root has returned to an earlier value. A hash alone
does not authenticate snapshot contents. The original Poseidon note/node hashes
reconstruct the root in the installed native or WASM prover before exposing a
membership path. Sparse maps avoid allocation proportional to a high note ID.

Every selected note uses the same HTTP routes and RPC account keys. Even an
absent selected note is rejected only after those shared reads. Authorization
does not fall back to financial `snapshot`; custom adapters must implement the
private interface explicitly. Financial deposit/withdrawal/recovery keeps its
individual account authentication. Snapshot pending metadata is syntax-checked
but never used as authority for financial decisions.

## Focused validation

- `node --test packages/sdk/test/session-snapshot.test.ts scripts/i10-wallet-ui/host.test.ts`:
  24 passed, zero skips. Includes different/missing selected notes with identical
  captured network selectors, finalized root/counter/genesis substitutions,
  malformed content, bounds, worker failures, exact relay routes and no fallback.
- `cargo test --locked --manifest-path apps/clientd/prover/Cargo.toml --lib snapshot::tests`:
  three passed. Original request-circuit root calculation and upstream MerkleTree
  paths agree for multiple leaves. The final possible `u32` leaf is supported
  without dense allocation; omissions and changed values fail.
- A fresh native prover and `wasm32-unknown-unknown` release build ran
  `packages/sdk/test/session-snapshot-runtime.ts`: one passed, zero skips. Both
  execute the new command against the tracked real-proof fixture's original
  root, agree on all 32 siblings, reject changed root/deposit/omitted/duplicate
  notes and invalid selection, and remain usable after rejection. This WASM
  test runs in Node, not a claim of new browser provider acceptance.
- SDK and example TypeScript checks passed. The full SDK suite initially passed
  259 tests, zero skips; later independent-review follow-ups are recorded in the
  [aggregate](I10-parity.md).

Saved logs and digests are under [components](I10-parity-components/artifacts.json).
The runtime command accepts `ZKAPI_TEST_NATIVE_PROVER` and
`ZKAPI_TEST_WASM_PROVER` to identify freshly built artifacts. It is deliberately
separate from the artifact-free default unit suite and does not silently skip
when a required build is missing.

## Boundaries

The initial limits are 4 MiB and 16,384 active plus pending records per snapshot.
Larger pools fail closed; pagination or authenticated incremental updates are
future scaling work. Network addresses/timing and public funding/withdrawal are
still observable. Pool size, note amounts, timing and colluding infrastructure
can affect practical anonymity. Trusted app/worker distribution, independent
manifest pins and an honest finalized RPC remain required. This corrects a
selected-note read leak; it does not promise network anonymity or remove the
operator/provider trust involved in issuing keys and reporting usage.
