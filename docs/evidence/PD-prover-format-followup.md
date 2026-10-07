# Prover formatting follow-up — 2026-10-08 JST

The prover source now passes the pinned Rust 1.90 formatter check. The change only expands the `Command::SnapshotPath` destructuring at `apps/clientd/prover/src/lib.rs:312` into the formatter's multiline layout and adds one trailing comma. Every other token and every literal/comment byte is unchanged.

The completed [hosted wallet component failure](https://github.com/yukikm/solana-zkapi/actions/runs/37696330290/job/113048864103), at source `169e929d534b0ea6961cbf084c43db90c7401421`, stopped at the prover formatting check before wallet runtime tests. Its wallet/prover formatter logs and the original source bytes are retained. This local correction does not turn that failed run into a pass.

The single changed file moves from SHA256 `89e4684e737d6f1aacb9a35ae937e00b53f7708b21960ef74eb6d6b50667ba8a` to `9bba46d458d059fbfc8ef415c0be1f540cdb2e0d04262c5577c2e049fe9b9ab0`. Formatting used `rustfmt +1.90.0 --edition 2021 --config skip_children=true apps/clientd/prover/src/lib.rs`, so child modules were not rewritten. All seven other guarded prover inputs, including its manifest and lockfile, remain byte-identical.

The full prover check passed:

```sh
cargo +1.90.0 fmt --manifest-path apps/clientd/prover/Cargo.toml -- --check
```

A separate read-only root check also passed the root workspace, control, companion, challenger, indexer, SVM and explicit wallet formatter surfaces. These are formatting checks, not runtime tests. The [machine-readable record](PD-prover-format-followup.json) pins the original failure logs, before-image inventory, exact diff, token comparison and successful check results.

For integration, verify the recorded source hash and rerun the command above against the exact candidate. No build, proof, host action, financial action or release-artifact replacement occurred. Existing distributed native/WASM artifacts and historical acceptance reports retain their original source scope. A later hosted run must establish the corrected workflow outcome separately.
