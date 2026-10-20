# Fresh PoC setup for current-state synchronization

The source binaries implement
[`account_state_poc_v1`](../specs/pool-history-acquisition.md), with config v2 and
challenger journal v3. The implementation has local SBF, mock RPC and disposable
database tests. The public backend now uses this mode with the fresh
`public-devnet-20261021-state-v1` Pool. Use the authenticated
[Devnet inputs](devnet.md) for a new client installation; the server reset does
not change the immutable SDK/native `.13` release.

The owner selected a clean, single-user test installation and explicitly waived
compatibility with its previous test configuration, funds and journals. The new
runtime therefore needs no archive converter, financial-state importer or client
custody migration. This exception defines this PoC reset; ordinary recovery of
the new installation must still preserve financial state and Unknown attempts.

## What is recreated

| Item | Fresh PoC choice |
|---|---|
| Pool | Initialize a new pool ID and its derived accounts; do not attach an empty ledger to the old Pool |
| Manifest/profile | New deployment identity and Pool bindings; regenerate matching service and client configuration |
| PostgreSQL | Empty database initialized through the existing schema/provisioning path |
| Signer/challenger journals | New empty private directories using matching new codecs and Pool bindings |
| Client wallet/note state | New explicit test profile and custody namespace; old notes are not imported |
| Indexer state | New current-state cache/socket paths; no archive, start slot or historical checkpoint |
| Program/build/proving assets | Reuse the verified deployed program and matching pinned assets if their code and immutable role keys are unchanged |
| Provider/RPC integration | Reuse suitable credentials and endpoint settings through private files; no new paid plan is inherently required |

A different Pool does not by itself require deploying a new Vault program,
changing circuits or generating new proving keys. The program's build-pinned
initializer and role keys still constrain who may initialize that Pool. If those
keys or program semantics change, use a matching new build/deployment and manifest;
do not claim the reset removes those checks.

Deleting a local journal cannot erase on-chain balances or recover old note
secrets. The fresh setup makes no promise to migrate or recover the previous
test balances. It also does not reuse old spending grants or replay old requests.

## Fresh setup

1. Stop the old workers, clientd and provider dispatcher so they cannot continue
   generating requests while the replacement is being configured.
2. Verify the chosen program/build/IDL, initializer, role keys and proof artifacts.
   Select a fresh Pool identity. Prepare the matching new manifest and private
   configurations using the existing deployment/provisioning tools where applicable.
3. Initialize the new Pool and empty financial services in distinct directories.
   Do not use automatic format detection or recovery to reinterpret old state.
4. Configure one indexer state reader with `chain_state.mode="account_state_poc_v1"`,
   idle polling at ten seconds and active polling at two seconds. Connect the
   challenger to its private `state_socket`. Keep Control's two request-time RPC
   backends. Disable the previous full-history writer/follower processes. Copy
   the strict [indexer example](../../services/indexer/README.md) and
   [challenger example](../../services/challenger/README.md) into private files.
   Both use the same manifest hash, independently verified deployed ELF/loader
   metadata and socket. Use a private 0700 parent and the same OS user for both
   services. On Linux, both processes must be able to read
   `/proc/sys/kernel/random/boot_id`; use `ProcSubset=all` (the default), not
   `ProcSubset=pid` or an inaccessible `/proc`. Keep the remaining service
   hardening, and allow `AF_UNIX` for the shared socket. An archive follower's
   old mount namespace and `archive-indexer` command are unsuitable here.
   Config v2 rejects old archive/start-slot settings.
5. Start the reader and verify the empty Pool's root, principal and account bindings.
   Start Control, signer and challenger, then create the new client profile.
6. Check local health and method counters. An idle installation should show batched
   account reads, light headers and infrequent identity checks, with zero full-block
   history reads and no periodic chain probes from other idle daemons.
7. Record startup, idle and active-work costs separately. Compare applied provider
   method rates and all process totals with the allowance/headroom chosen for this
   PoC. The [contract](../specs/pool-history-acquisition.md#cost-and-acceptance)
   defines the offline idle target and required local proof/SBF validation.

After preparing the new Pool, manifest and empty ledger through
[deployment](deployment.md) and [operator provisioning](proxy-operator.md),
build the native services with the pinned toolchains:

```sh
cargo build --release --locked --manifest-path services/indexer/Cargo.toml --bin indexerd
cargo build --release --locked --manifest-path services/challenger/Cargo.toml --bin challengerd
```

Run the reader in its service process, then initialize the **new** journal once:

```sh
services/indexer/target/release/indexerd /private/zkapi-poc/indexer.json
# In a separate shell, once the reader is ready:
services/challenger/target/release/challengerd init /private/zkapi-poc/challenger.json
services/challenger/target/release/challengerd status /private/zkapi-poc/challenger.json
services/challenger/target/release/challengerd scan /private/zkapi-poc/challenger.json
services/challenger/target/release/challengerd run /private/zkapi-poc/challenger.json
```

`init` refuses an existing journal. Restart uses `run`, never another `init`.
`scan` validates current accounts and looks up AUTH evidence; it does not prove,
sign or send. `run` can send challenges when retained AUTH evidence requires it.
No archive migration/conversion or new reset flag is needed. Test funding and
provider calls remain explicit operations through the existing clients.

Control's normal recovery loop makes no idle chain probe. Its actual admissions
still authenticate endpoints and read finalized Pool/confirmed exit accounts on
the two configured backends; distinct commitments/backends are not merged into a
single request. The operations collector defaults to
`independent_chain_probes:false` (omitting the field has this effect). It consumes
the owner's `/health` and reports `current_state_age_seconds` instead of inventing
fee-payer balance or independent slot lag. `true` explicitly enables the older
deep chain probes and adds their RPC cost. Run deep readiness on demand, not as
an idle timer in this profile.

## Local verification

Use the pinned Rust/Node toolchains in `CONTRIBUTING.md`. These commands use local
fixtures and test services; they do not query a public RPC or API provider:

```sh
# If the test ELF/fixtures do not exist, build them with scripts/run_i04.sh first.
# Regenerate account cuts including actual SBF Vault and Clock bytes:
cargo run --locked --manifest-path tests/svm/Cargo.toml --bin sdk_transport
cargo test --locked --manifest-path services/indexer/Cargo.toml --test current_state -- --nocapture
cargo test --locked --manifest-path services/indexer/Cargo.toml --test current_state_service
# ZKAPI_NODE may select the pinned absolute Node executable for the native bridge:
cargo test --locked --manifest-path services/challenger/Cargo.toml current_state
node --test packages/sdk/test/challenger.test.ts
cargo test --locked --manifest-path services/control/Cargo.toml --test binding_chain
# Requires initdb/pg_ctl on PATH and the local chain export from scripts/run_i05.sh:
python3 scripts/test_current_state_idle.py
```

The new fixtures use actual Vault SBF account bytes and a real pinned test tree
proof. Finalized RPC envelopes, loader metadata, time advancement and provider
failures are simulated. Tests cover:

- Active/Pending/Closed and empty pools; zero-leaf Pending completeness; root,
  principal, Clock, owner, PDA and inventory checks; stable multi-batch reads.
- Cold start/restart without history, corrupt disposable cache, 24 concurrent
  consumers, HTTP paths/snapshot hash, local health/socket with no extra RPC.
- Bounded retries, shared 429 cooldown, stale slots, capacity/response limits,
  and a latched program-change fence. A failed verification clears readiness
  before a stalled retry completes; startup identity and account acquisition
  share the same thirty-second refresh budget.
- Nullifier-stable job identity, real challenge proof without archive, restart,
  Pending disappearance preserving Unknown, and receipt-only fenced recovery.
- Twenty idle Control recovery cycles and background monitoring with zero RPC,
  followed by actual admission checks that still read both configured backends.

On the same recorded SBF cut, legacy acquisition uses **24** RPC calls versus
**2** current-state calls (91.7% fewer); current restart also uses two. Starting
the owner adds two identity calls (genesis plus full Program/ProgramData), while
the challenger adds no synchronization calls. With example weights of ten per
block call and one per other call, the comparison is 213 versus 11 weighted
units; these weights are illustrative, not provider prices.

At the tested two calls per one-batch refresh, ten-second idle polling and one
metadata check per minute model **580,320 calls per 31 days**, before startup,
retries and actual client/financial work. This projection is tested arithmetic,
not a month-long public-provider observation. N includes Closed notes; at N > 48
additional batches cost more, and N > 4096 is unsupported. Actual deployment
acceptance must measure all process traffic and apply the provider's real prices.

## What remains durable after the reset

Within the new installation, keep authorization evidence, ledger reservations,
signer records, the encrypted client journal and exact signed Unknown attempts.
Only the derived current-state cache can be discarded and rebuilt from accounts.
Restart must never create a second job for the same Pending nullifier or turn an
unknown outcome into a fresh request. The current-state reader removes historical
synchronization; it does not replace these financial recovery obligations.
