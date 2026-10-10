# Contributing

Start with the [project README](README.md), [architecture](docs/architecture/overview.md)
and [current status](docs/status.md). For application integration, use the
[SDK guide](docs/sdk/README.md). For protocol changes, read `AGENTS.md` and the
relevant [protocol](docs/specs/protocol-solana.md), [API](docs/specs/api-proxy.md)
or [operations](docs/specs/operations.md) specification.

## Local checks

Use Node 24.19.0 and npm 11.9.0 as pinned in `package.json`; Rust work uses
`rust-toolchain.toml`. From the repository root:

```sh
git submodule update --init --recursive
npm ci --ignore-scripts
npm run typecheck
npm run build:sdk
npm run test:sdk-distribution
npm test
python3 scripts/check_design.py
```

The browser storage test uses Chromium; set `ZKAPI_TEST_CHROME` if it cannot find
your installation. A skipped browser check is not a pass for browser custody.
Synthetic chain/provider/prover fixtures are labelled as such in their tests.

For SDK/compact transport changes, `python3 scripts/run_single_deposit_acceptance.py`
runs the isolated local matrix. It requires Node 24.19.0, `cargo-build-sbf 4.1.0`,
the schema-validation Python environment and the wrong-verification-key fixture
at `target/i04-sbf-wrong/zkapi_vault.so`. The runner supports `ZKAPI_NODE`,
`ZKAPI_SBF` and `ZKAPI_SCHEMA_PYTHON` overrides and reports missing prerequisites.
See [ADR-0003](docs/adr/0003-single-transaction-deposit.md) for the design and
[the runner](scripts/run_single_deposit_acceptance.py) for the complete matrix.
For adapter changes, use the [provider checks](docs/development/provider-acceptance.md#local-regression-checks).
Ordinary SDK tests require no provider keys or public-chain sends.

The demonstration UI is maintained and tested in the separate
[client repository](https://github.com/yukikm/solana-zkapi-client). Core checks do
not require that checkout.

## Change boundaries

- Keep the existing `ControlClient`, `WalletClient` and encrypted journal as the
  sole owners of authorization, accounting and recovery state.
- Never automatically replay uncertain inference, replace uncertain financial
  transactions or switch direct users to proxy.
- Use integer micro-USDC strings for balances/caps and retain exact signed bytes.
- Do not update a funded deployment's pins, reset journals or reset test budgets
  as a side effect of development work.
- Keep commands, outputs, source hashes and limitations under `docs/evidence/`
  or `target/`; both are local, ignored output directories. Do not force-add
  reports or logs. Commit reproducible tests, intentional fixtures, release
  notes and user/developer documentation instead. See [verification](docs/development/verification.md)
  for the historical archive and CI artifact policy.
- Keep public-facing examples typechecked and label deployment prerequisites,
  synthetic tests and live acceptance separately. Never include `.env`, keys,
  RPC secrets, note secrets or raw private logs in commits.

Newly authored work uses the [MIT license](LICENSE). Preserve upstream license
notices and source pins; see [provenance](vendor/README.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
