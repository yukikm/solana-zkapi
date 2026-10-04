# clientd implementation starting point

`companion/` is the first native piece of I08: an offline Rust verifier invoked by the shared TypeScript control client. The Go loopback daemon on 127.0.0.1:8787, wallet/admin credentials, inference routes, key reuse, Tor and distribution packages are **not implemented yet**.

The companion reads one JSON command on stdin and emits either a verified result or a fixed redacted failure. It never performs network calls, saves note state, issues provider keys or holds signing secrets. `prepare` verifies the real RP and quote/tariff/credential/private-state bindings; `settle` verifies the same saved request without reapplying admission freshness, all signed receipts and the successor balance/commitment/signature. The SDK owns the single encrypted journal and state machine that the later Go wrapper must reuse.

```sh
cargo build --locked --manifest-path apps/clientd/companion/Cargo.toml
python3 scripts/run_i08.py
```

The build currently reuses `zkapi-control`'s fixed test VK, wire, quote and receipt validation, and upstream `zkapi-proof::compact`/`zkapi-core::v2` for the original Baby-JubJub and hash semantics. It intentionally excludes upstream Ethereum RPC/wire, native ETH payments and plaintext file storage. The source reference is `ethereum/zkapi@045b444ea1b52538d1b40273c7cb6ed09468a052`, particularly `protocol/rust/crates/zkapi-client/src/wallet.rs::apply_response`, `note_state.rs`, and the existing Go `zkapi-clientd/`. Vendor files and licenses remain unchanged.

`tests/support/mod.rs` adapts the repository's I05 test helper and uses explicitly public deterministic test entropy to generate real RP fixtures. It is not part of the shipped verifier. Generated command fixtures contain test private state and are written 0600 under ignored `target/i08/`; CI uploads reports/logs, not these witness files. The real test build is not a production setup or signed distribution.
