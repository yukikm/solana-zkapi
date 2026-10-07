# Contributing

Start with the [project README](README.md). For application integration, use the
[SDK guide](docs/sdk/README.md); for protocol changes, read
[implementation-ready.md](docs/implementation-ready.md) and `AGENTS.md`.

## Local checks

Use the exact Node/npm versions in `package.json` and initialize the pinned
upstream submodule. After `npm ci --ignore-scripts`:

```sh
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
runs the existing isolated local matrix with pinned toolchains. It has additional
local Rust/SBF/proof-artifact prerequisites; see its [evidence](docs/evidence/I10-single-deposit-review.md).
No provider keys or public-chain sends are needed for ordinary SDK tests.

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
- Record commands, outputs, source hashes and limitations under `docs/evidence`.
  Keep historical reports; a hash inventory does not rerun their tests.
- Keep public-facing examples typechecked and label deployment prerequisites,
  synthetic tests and live acceptance separately. Never include `.env`, keys,
  RPC secrets, note secrets or raw private logs in commits.

Newly authored work uses the [MIT license](LICENSE). Preserve upstream license
notices and source pins; see [provenance](vendor/README.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
