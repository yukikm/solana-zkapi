# I03 Vault real-proof fixtures

These are **test-only** artifacts with public secrets, public signing keys and
deterministic public proving entropy. They cannot protect real funds. The
generator reads the immutable I02 circuit profile and verifies every generated
proof against its pinned request, withdrawal or tree verifying key. It neither
replaces the circuit setup nor rewrites the I02 fixtures/profile.

Regenerate from the repository root:

```sh
RAYON_NUM_THREADS=4 cargo run --locked --release -p zkapi-tree-prover --example vault_fixtures
```

The first run recreates the existing test tree proving key in
`target/i03/test-tree.pk` and verifies its pinned SHA-256. Subsequent runs verify
and reuse that local cache. Proving durations go to
`target/i03/proving-times.json`; they are host measurements, not production or
browser latency claims. `manifest.json` pins all fixture JSON bytes and records
the generator source hash and required trace composition. Run
`python3 scripts/check_vault_fixtures.py` to check these pins, the unchanged
circuit source/profile, independently derived PDA/H2F bindings and historical
trace preconditions. That static check does not replace real-proof verification
or SVM execution.

The local test program is `[43; 32]`, original Token Program is Tokenkeg, mint is
`[4; 32]`, genesis hash is `[0; 32]`, and destination owner is `[7; 32]`. Pool
addresses are real PDAs for `[b"pool", pool_id]`, using pool IDs `[2; 32]` and
`[9; 32]`. The SVM harness independently derives and checks those addresses.
These addresses are local test configuration, not a production deployment.

Every scenario contains three upstream proofs in `auth` (`request`,
`withdrawal` with clearance, `escape` without clearance), and three tree proofs
in `trees` (insert, remove, restore). Public inputs use canonical field bytes;
proofs use the unchanged 256-byte upstream wire. `trees[*].siblings` are public
tree paths, not secrets.

| Scenario | Meaning |
| --- | --- |
| `a` | Signed state of note 0, alone in the tree |
| `a-with-b` | Same note/state/nullifier as `a`, with note 1 present |
| `b-with-a` | Note 1, with note 0 present; insertion follows `a` insertion |
| `other-vault` | Same note metadata, valid proofs for the other pool |
| `max-id` | Note `u32::MAX`, exercising the final allocatable ID |
| `genesis-a` | Note 0 with genesis anchor 1 and full deposit balance |

The signed cases use deposit 5,000,000, balance 4,900,000, note secret 42 (43
for note 1), anchor 12,345, blinding 19, request rerandomization 23, request
context 98,765, state signing scalar 31 and clearance signing scalar 37.
Genesis uses the same deposit/note but anchor 1 and balance 5,000,000. Time is
3,000,000,000 seconds, TTL is 2,592,000 seconds, expiry is rounded upward to a
UTC day, and the challenge period is 86,400 seconds.

For the historical challenge, save `a.auth.request`, insert B with
`b-with-a.trees[0]`, initiate A's escape using `a-with-b.auth.escape` and
`a-with-b.trees[1]`, then challenge using the saved **unchanged** A request and
`a-with-b.trees[2]`. The saved request root differs from both the pending old
root and the current root; its nullifier still matches the pending nullifier.
That distinction exercises the protocol's historical-root rule.
