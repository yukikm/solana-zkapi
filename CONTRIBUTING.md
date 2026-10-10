# Contributing

Read the [README](README.md), [architecture](docs/architecture.md),
[support scope](docs/support.md) and the relevant component README.
Public documentation and examples are English.

## Local checks

Use the versions pinned in `package.json` and `rust-toolchain.toml`:
Node 24.19.0, npm 11.9.0 and Rust 1.90.0.

```sh
git submodule update --init --recursive
python3 scripts/check_upstream.py
npm ci --ignore-scripts
npm run typecheck
npm run build:sdk
npm run test:sdk-distribution
npm test
python3 scripts/check_design.py
```

See [testing](docs/testing.md) for component and real-proof/SBF checks.
The [reference app](https://github.com/yukikm/solana-zkapi-client) has its own tests.

## Change rules

- Reuse `ControlClient`, `WalletClient`, `ClientDaemon`, the encrypted journal
  and the shared ledger. Keep integer financial units and exact signed bytes.
- Do not replay uncertain inference or transactions, switch direct users to
  proxy, replace custody, reset journals or reuse historical spending approval.
- Preserve upstream source pins and licenses. Document intentional changes to
  the protocol, circuits, trust model or deployment requirements.
- Put local logs, reports and operational handoffs in ignored `target/`.
  Keep reproducible tests, fixtures, specifications, release notes and guides tracked.
- Never commit secrets, private RPC URLs, mutable financial state or raw private logs.
- Label synthetic tests, real proof/SBF checks, public Devnet observations and
  CI separately. A past successful run does not establish current availability.
- Published releases are immutable. Compare runtime inputs before creating a new release.

New user or operator procedures belong in [docs/getting-started/](docs/getting-started/README.md).
API and configuration details belong in [docs/sdk/](docs/sdk/README.md);
protocol contracts belong in `docs/specs/` and `docs/contracts/`.
Do not add implementation diaries, progress checklists or task backlogs.

New work uses [MIT](LICENSE). Preserve [third-party notices](THIRD_PARTY_NOTICES.md).
