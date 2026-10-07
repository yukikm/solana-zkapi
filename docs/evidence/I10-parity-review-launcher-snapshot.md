# Devnet launcher private authorization snapshot follow-up

The live coordinator reported a snapshot-stage failure immediately after a finalized compact deposit and before quote, budget reservation, AUTH or inference. This follow-up fixes the launcher integration. The live failure and funded-state observations belong to the parent run's separate evidence; the commands below made no public RPC, provider, signing or funded-state changes.

## Findings and correction

`scripts/run_i10_devnet_vault.ts` wrapped `SolanaWalletChain` to add read-only snapshot waits, but exposed only the financial `snapshot`, `buffer` and `blockhash` methods. The SDK correctly refused authorization because the wrapper omitted `sessionSnapshot`; it did not fall back to a selected-note endpoint.

The launcher now uses `scripts/i10_devnet_snapshot_chain.ts`. Its required `DevnetSnapshotChain` type preserves `sessionSnapshot` and `bufferObservation` at compile time. Authorization passes the original note ID, prover and minimum slot through the existing common snapshot adapter. Both snapshot methods create a fresh deadline scope covering their indexer and RPC reads. Only the existing named transient read failures retry. Financial buffer observation and blockhash methods retain the original adapter and binding; they do not enter the retry loop. A later operation receives a fresh scope after a previous deadline or completed request.

The local pinned transport also lacked the two common snapshot routes. It now permits exactly `GET /zkapi/v1/tree/snapshot` and `GET /zkapi/v1/tree/snapshots/<64 lowercase hex digits>.json`. The download has the SDK's 4 MiB bound in both the frontend and pinned client. The descriptor retains the client's 64 KiB limit. Query strings, fragments, encoded selectors, uppercase or malformed digests, extra suffixes and POST requests remain rejected. No selected-note fallback was added.

The new helper is included in the launcher's `execution_helper_sha256` report. The immutable provider campaign source files were not edited. Existing journals, budgets, reservations, profiles and historical failures were not modified by this follow-up.

## Validation

Commands, logs and final source hashes are recorded in [results.json](I10-parity-review-launcher-snapshot-components/results.json).

- Twenty-two tests passed with zero failures, skips or cancellations. They cover the actual SDK common authorization adapter with synthetic account bytes and a local prover fixture, identical network selectors for different notes, a transient read retry, actual transport cancellation at the deadline, a successful later call, terminal missing membership, unchanged finance recovery forwarding, and actual loopback HTTP/TLS route and byte-limit enforcement.
- Strict TypeScript checking passed for the launcher, helper and transport tests, including the required authorization method on the wrapper.
- `git diff --check` passed.

The initial focused run's two failures are retained. Both came from a new test assertion comparing strict-JSON objects with null prototypes to ordinary fixture objects; comparison now uses canonical JSON bytes. They were not production adapter failures.

## Limits

These are offline integration results, not new provider, public finality, Phantom or I10 acceptance. The private snapshot test uses a synthetic local path prover; existing native/WASM proof evidence remains separate. Read deadlines cancel network activity and reject an over-deadline result, but the current prover interface does not support interrupting an in-progress local path computation. No hard CPU-time or public latency guarantee follows.
