# Public wallet read-route correction

The public gateway now admits the exact wallet proof-path GETs required by the released SDK. Local validation passed **44 tests, zero failures or skips**. The gateway-only deployment completed, and the unchanged installed `SolanaWalletChain.snapshot()` subsequently authenticated an unfunded snapshot through stock native egress. No deposit, AUTH or inference was performed by this validation. Exact retained digests are in the [JSON evidence](PD-public-wallet-route-fix.json).

## Cause and correction

The [earlier deposit-preparation failure](PD-public-admission-recovery.md) occurred before a saved wallet operation. At 06:32 UTC on 2026-10-08, both a direct public GET and the unchanged stock relay returned HTTP 400 for `/zkapi/v1/tree/notes/0/zero-path`. The public method allowlist omitted the per-note `path` and `zero-path` endpoints even though the bounded indexer forwarder already supported them. Shared-snapshot preflight had passed because it uses different read routes.

Two source lines admit GET only for `/zkapi/v1/tree/notes/{note_id}/path` and `/zkapi/v1/tree/notes/{note_id}/zero-path`, where the ID is canonical decimal within u32. Query, encoding, sign, overflow, extra-path and method variants remain rejected. Existing browser origin/CORS, native metadata, credential rejection, bounded upstream, invitation and financial guards remain unchanged.

The local matrix checks accepted boundary IDs, rejected variants and credential/origin rules. A separate test invokes the actual SDK wallet snapshot against coherent synthetic finalized accounts, genesis and block anchors through the gateway. The 44-test run took 1.641 seconds wall time and retained all four guarded source hashes. This is local fixture evidence.

## Actual deployment and released-client read

The deployed source changed from `82673784a2565a981e1f27d720f353593dee2fd9c6dca8d99eda7577c206bff5` to `ff23574d51bd7ba95de8ec2afd53035b581fb67b37ec87ade2359629082ecc0c`. The completed receipt SHA is `6d8293b163f084c2f4095e8a809838df607fb6ccc58cb6752d92430e9c4a5d01`. It records one gateway stop/start, five other processes unchanged, the original admission records preserved, configuration unchanged and admission still enabled. Reservations and session/settlement rows remained zero; the operation did not write grant state or transfer original capacity.

At 06:42:41 UTC, the released installed SDK completed `SolanaWalletChain.snapshot()` through the existing stock Go egress. Two tree GETs and four read-only RPC calls returned HTTP 200. The validated snapshot was at finalized slot **508729783**, chain clock **1791441760**, with next note ID zero, 32 siblings and an unpaused Pool. The SDK's existing manifest, finalized-account and block-anchor checks ran normally.

The first diagnostic harness attempt failed before any request because its module destructuring selected the wrong export. That source and failure remain preserved. Only the harness import list was corrected; immutable SDK, native and prover artifacts were unchanged. The successful probe checked its exact release manifest, Node, four directly imported SDK modules and runtime configuration pin; it is not a new full installed-file inventory.

This checkpoint ends at the read-only snapshot. Deposit preparation, funding, AUTH, provider use, settlement, recovery/backup and withdrawal remain separate acceptance steps; no full hosted-CI result follows from it.
