# I05 control service and isolated signer

The control service implements the USDC authorization ledger, quotes, receipts, session recovery, dispatch ownership contract, and Baby-JubJub settlement/clearance signing. Financial writes use one PostgreSQL connection per pool; that same connection owns the advisory lock. Losing it stops writes. The signer reads the primary through a separate read-only connection and preserves its own append-only, fsynced journal.

This build is a **local test profile**. It embeds the existing test request VK and the Vault's role-specific test public keys. `controld` requires `local_test_only: true` and a loopback listener; `signerd` requires `--local-test`. The only advertised adapter is `openai / i05-local-only`, a synthetic local acceptance fixture. OA-org/OpenRouter key issuance, real provider inference/SSE, production KMS/mTLS/egress fencing, live RPC/wallet acceptance, and G1–G4 release gates remain outside this result.

## Reproduce the local acceptance suite

Use the repository's Rust 1.90.0 toolchain, pinned SBF tools, Python 3, and PostgreSQL binaries (`initdb`, `pg_ctl`, `psql`, `pg_dump`) on `PATH`. PostgreSQL 16 is the CI target; the report records the exact server actually used. All commands below run from the repository root as a non-root account.

```sh
scripts/install_sbf_tools.sh
mkdir -p target/i04-sbf
cargo build-sbf --manifest-path programs/zkapi-vault/Cargo.toml \
  --tools-version v1.54 --arch v0 --features sbf-entrypoint \
  --sbf-out-dir target/i04-sbf -- --locked
bash scripts/run_i05.sh
```

Inspect the SBF build output for oversized-stack diagnostics; the CI job rejects them. An existing verified `target/i04-sbf/zkapi_vault.so` from `bash scripts/run_i04.sh` also works. `ZKAPI_VAULT_ELF` may select another build of that same pinned test Vault.

`run_i05.sh` starts a disposable, socket-only PostgreSQL cluster with `fsync` enabled. It ignores inherited PostgreSQL/database configuration, exports real Vault account bytes, runs **all service tests including ignored runtime tests** serially, runs formatting/clippy, consumes the new signer result through the real SBF Vault, and checks design/DDL contracts. It stops the temporary database on exit. No existing database or provider credential is needed.

Results are written to `target/i05/`: `runtime-report.json` records versions and commands; `control-process-results.json` records the four control crash/restart boundaries; `http-results.json` records the real proof/HTTP/signature chain; `svm-results.json` records the Vault execution. These artifacts distinguish local RPC fixtures and synthetic usage from live provider/cluster acceptance. The workflow definition is not evidence that hosted CI has run.

For an existing **disposable test cluster**, selected suites can be run with `ZKAPI_TEST_DATABASE_URL`; their login needs database/role creation permissions because each suite creates isolated test databases and roles:

```sh
cargo test --locked --manifest-path services/control/Cargo.toml --lib signer::tests
cargo test --locked --manifest-path services/control/Cargo.toml --test signer_process -- --ignored --nocapture
cargo test --locked --manifest-path services/control/Cargo.toml --test control_process -- --ignored --nocapture
```

The two runtime commands require `ZKAPI_TEST_DATABASE_URL` to be set. The control process suite also requires `target/i05/chain.json`, produced by the SBF export in `run_i05.sh`. Design checks alone do not establish runtime correctness.

## Persistent local configuration

Build the three binaries with `cargo build --locked --manifest-path services/control/Cargo.toml --bins`. Keep all runtime files outside source control in an owner-only directory (`0700`). Quote, receipt, state, and clearance seed files contain exactly 32 raw bytes and have mode `0600`. Journal files are also owner-only. Never place a raw token, note secret, inference body, or provider credential in a manifest, command argument, receipt, or log.

`control.json` is the strict [`RuntimeConfig`](src/config.rs) object:

| Field | Required local value |
|---|---|
| `local_test_only` | `true` |
| `listen` | A loopback socket address, for example `127.0.0.1:8788` |
| `manifest` | Full trusted local manifest matching the pinned layout-2 profile, actual Vault PoolConfig, role keys, USDC mint/token program, cap, origins, and tariff hashes |
| `trusted_manifest_hash` | Independently supplied SHA-256 of JCS(manifest), excluding `manifest_hash` and `manifest_signature`; must equal the manifest's hash |
| `primary_rpc`, `secondary_rpc` | Two distinct configured RPC origins; both are checked for the expected genesis and confirmed ExitNullifier state |
| `indexer_origin` | Origin serving the ready I04 `/zkapi/v1/tree/root` endpoint |
| `signer_socket` | Absolute path to the signer's Unix socket in its owner-only directory |
| `quote_seed_file`, `receipt_seed_file` | Absolute paths to distinct Ed25519 seed files whose public keys match the manifest |
| `enable_local_adapter` | `true` only for the synthetic local adapter; otherwise `false` and `tariffs: []` |
| `tariffs` | Strict `wire::Tariff` objects; local provider `openai`, model `i05-local-only`, valid time interval, integer rational rates, and zero operator fee |

The manifest must contain the complete `Manifest` object defined by [OpenAPI](../../docs/contracts/openapi.json), with no unknown fields, a canonical 64-byte base64 manifest signature, and the pinned generated IDL hash. The local trust anchor is the independently supplied manifest hash; production manifest distribution and governance validation remain later gates. Local fixture authority/multisig values and signatures are test data, not deployed governance.

Financial integers and times in quote/tariff/proof wire objects use canonical decimal or field strings. A tariff's hash is SHA-256 of its JCS body with `tariff_hash` excluded. Each tariff must be listed in the manifest. A ready indexer does not replace the control service's independent PoolConfig and two-RPC exit checks.

[`tests/control_process.rs`](tests/control_process.rs) contains an executable complete local manifest/config fixture, using the real SBF fixture and local HTTP RPC servers. Its `support::complete_local_manifest` helper fills the public manifest contract and signs it with a public test key. It is suitable for reproducing tests, not as a production manifest. Known public fixture state/clearance scalar seeds are 31/37; changing these keys requires a matching build and new pool under [ADR-0002](../../docs/adr/0002-build-validated-signing-keys.md).

Export `signer.json` from `controld signer-config control.json` after validating trusted local configuration. Its exact [`SignerConfig`](src/signer.rs) fields are `authorization`, `pool`, `binding`, `state_key`, `clearance_key`, and `receipt_key`. `authorization` contains the deployment/pool, field binding, two state-key coordinates, cap, both origins, and quote public key. Raw 32-byte values in this internal config are JSON byte arrays; the authorization field elements are canonical `0x` strings and its cap is a decimal string. This export keeps the signer independently pinned to the trusted manifest instead of deriving its configuration from restored ledger rows.

## Database roles and first start

Use three separate local logins: a migration owner, a runtime writer, and a signer reader. Neither runtime login may own the database, tables, or schema. Local authentication and connection secrets are provisioned separately. As the disposable/persistent local cluster administrator, create the group roles before the migration owner runs migrations:

```sql
CREATE ROLE zkapi_control_writer NOLOGIN;
CREATE ROLE zkapi_control_reader NOLOGIN;
CREATE ROLE zkapi_migration LOGIN;
CREATE ROLE zkapi_writer LOGIN;
CREATE ROLE zkapi_signer LOGIN;
CREATE DATABASE zkapi_i05 OWNER zkapi_migration;
GRANT zkapi_control_writer TO zkapi_writer;
GRANT zkapi_control_reader TO zkapi_signer;
GRANT CONNECT ON DATABASE zkapi_i05 TO zkapi_writer, zkapi_signer;
```

Run this bootstrap once; reuse the existing group roles if another local test database created them. The migration owner owns the schema objects. Migrations grant the writer SELECT/INSERT/UPDATE on financial tables and sequence access, and grant the reader SELECT. Runtime DELETE/TRUNCATE/DDL are forbidden. The separate migration checksum table is readable but not writable by runtime roles. The migration owner need not have `CREATEROLE` when the two group roles already exist.

Set `ZKAPI_MIGRATION_DATABASE_URL`, `ZKAPI_WRITER_DATABASE_URL`, and `ZKAPI_READER_DATABASE_URL` to the corresponding **local** connections. Prefer a local Unix socket. These binaries currently use PostgreSQL `NoTls`; they are not a production network database deployment. Then execute this sequence:

```sh
zkapi_bin=services/control/target/debug
zkapi_state=/absolute/private/i05-state

ZKAPI_DATABASE_URL="$ZKAPI_MIGRATION_DATABASE_URL" "$zkapi_bin/controld" migrate
ZKAPI_DATABASE_URL="$ZKAPI_WRITER_DATABASE_URL" "$zkapi_bin/controld" \
  signer-config "$zkapi_state/control.json" > "$zkapi_state/signer.json"
chmod 600 "$zkapi_state/signer.json"
ZKAPI_DATABASE_URL="$ZKAPI_WRITER_DATABASE_URL" "$zkapi_bin/controld" \
  provision "$zkapi_state/control.json"

"$zkapi_bin/signerd" --local-test --config "$zkapi_state/signer.json" \
  --journal "$zkapi_state/signer.journal" --initialize-journal

ZKAPI_SIGNER_DATABASE_URL="$ZKAPI_READER_DATABASE_URL" "$zkapi_bin/signerd" \
  --local-test --config "$zkapi_state/signer.json" \
  --journal "$zkapi_state/signer.journal" --socket "$zkapi_state/signer.sock" \
  --state-seed-file "$zkapi_state/state.seed" \
  --clearance-seed-file "$zkapi_state/clearance.seed"
```

Keep the signer running under the local supervisor or in that terminal. In a second terminal with the same path/connection settings, start the writer:

```sh
ZKAPI_DATABASE_URL="$ZKAPI_WRITER_DATABASE_URL" "$zkapi_bin/controld" \
  serve "$zkapi_state/control.json"
```

`provision` registers immutable pool settings with admission disabled. Journal initialization is a one-time operation and refuses an existing path. The signer must start successfully before the writer: both verify schema checksums, and the writer checks chain health plus signer/ledger reconciliation before accepting new work. A transient RPC/indexer outage or pool pause leaves admission disabled while the service can recover already accepted settlement/clearance targets, including after restart. An observed genesis or PoolConfig mismatch still rejects startup. Starting a second writer for the same pool fails; starting a second signer against the same journal fails its exclusive file lock. Migration reruns verify applied checksums and apply only missing versions. Editing an already-applied migration or introducing an unknown version blocks startup.

Control routes under `/zkapi/v1` cover config/catalog/tariffs/quotes, sessions/status/close, operations/status, receipts, clearance, and nullifier status. Tree routes stay with the I04 indexer. Provider-facing operation admission/metering are internal adapter contracts; I05 does not expose working provider inference endpoints or distribute real direct keys. Saved session recovery authenticates the original credential and exact request digest; a direct key is never replayed.

## Restart and restore

Restart with the same manifest, primary ledger, role-specific keys, and **same independently stored journal**. Before removing a stale Unix socket, the supervisor must establish that its previous signer process has exited and cannot resume. The daemon deliberately neither removes an existing socket nor infers death from a timeout. Remove only that confirmed-dead socket; preserve the journal. Never initialize an empty journal to replace a missing one.

A new writer takes the advisory lock on its dedicated connection, advances the epoch, and reconciles before admission. An epoch or lease expiry does not prove that an old dispatcher has stopped. An uncertain dispatch keeps its immutable attempt/owner and cannot be sent again. `LocalOwner::stop` produces local fencing evidence only after killing and waiting for that exact process; a timer or manually set database flag cannot supply it. Real provider egress fencing remains later work.

I06 adapters must persist a discovered provider management reference before awaiting the final chain check. A failed check or interrupted delivery must retain that reference for disable/delete and final-usage recovery. A stored reference is not permission to return a key: only the first successful activation may deliver it; a retry drains the key. I07 adapters must use the final one-shot dispatch claim as well as the initial attempt commit. The claim rechecks pool admission, session expiry/close, and the operation state; a stopped pool or an operation already marked unknown cannot start a new send.

The signer pins `(pool, N)`, AUTH/CLEARANCE kind, request ID, role key, frozen target and message before signing, then fsyncs its generated signature before returning it. It independently reloads the request proof/binding, frozen quote/tariff, terminal operations, stopped dispatches, signed receipt arithmetic, and successor commitment/anchor. The ledger tariff must equal the hash authorized by the signed quote, including on recovery. The writer verifies and saves the returned signature before exposing SETTLED/clearance results. Zero-charge sessions still receive exactly one successor.

Any journal target missing or changed in a restored ledger, any signed ledger target missing from the journal, unknown schema, invalid receipt total, or unfenced dispatch stops signing. Preserve both stores, stop new admission, establish the primary/writer/dispatcher identities, and reconcile with retained evidence. Do not repair this by deleting reservations, rewriting settlement randomness, clearing attempt ownership, replaying inference, swapping signing keys, or manufacturing stop evidence. A partial/tampered journal, a missing header, or an empty frame also fails closed and needs explicit operator reconciliation; it is not silently truncated.

Fault injection is test-only: `ZKAPI_LOCAL_CRASH_AT=reserved|sign_pending|signature|settled` exits controld at the named durable boundary. Signerd's `--crash-at intent|signature|synced` exercises its journal boundaries. Leave these unset for ordinary local use. Local recovery tests do not establish production RPO/RTO, hosted CI completion, provider acceptance, or release readiness.
