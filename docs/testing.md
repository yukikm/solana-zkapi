# Testing

Start with the checks in [Contributing](../CONTRIBUTING.md). Run only the suites
needed for the changed component. Commands below run from the repository root.

| Area | Command |
|---|---|
| Contracts and documentation links | `python3 scripts/check_design.py` |
| Pinned upstream inputs and notices | `python3 scripts/check_upstream.py` |
| SDK and examples | `npm run typecheck && npm test` |
| SDK distribution | `npm run build:sdk && npm run test:sdk-distribution` |
| Vault transport and indexer | `bash scripts/run_i04.sh` |
| Ledger and signer | `bash scripts/run_i05.sh` |
| Provider adapters | `bash scripts/run_i06_i07.sh` |
| SDK native/WASM integration | `python3 scripts/run_i08.py` |
| Native clientd | `python3 scripts/run_i08_clientd.py` |
| Challenger | `python3 scripts/run_i09_challenger.py` |
| Operations and restore | `python3 scripts/run_i09_operations.py` |
| Compact deposits | `python3 scripts/run_single_deposit_acceptance.py` |

Rust/SBF suites need pinned tools, proof artifacts and component prerequisites.
See the [clientd](../apps/clientd/README.md), [control](../services/control/README.md),
[indexer](../services/indexer/README.md) and [challenger](../services/challenger/README.md)
READMEs. Browser storage tests need Chromium; set `ZKAPI_TEST_CHROME` if necessary.
A skipped browser check does not verify browser custody.

Ordinary checks use local fixtures and do not need provider keys or public-chain
transactions. Synthetic responses do not establish live provider compatibility.
Public provider or wallet tests require separate authorization and fresh capacity;
never replay a historical lifecycle.

Generated reports are ignored local outputs; CI may retain them as artifacts.
Fresh clones must not require old run reports. Stable regression data belongs in
`tests/fixtures/`, with provenance.
