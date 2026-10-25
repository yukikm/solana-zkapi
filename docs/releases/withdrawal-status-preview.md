# SDK withdrawal status preview

SDK `0.2.0-devnet.19` gives browser and Node.js applications semantic wallet-operation progress and an explicit read-only check for delayed withdrawal eligibility. It retains the `.18` recoverable-custody API and its portable recovery kits.

`status().walletOperation.progress` reports the current proof or transaction stage, the next action, and confirmed proof-upload chunks when the exact plan is available. Submitted transactions remain confirmation work; observation never signs or resends them. These fields are projections of the existing encrypted journal, not a new payment state machine.

`checkEscapeWithdrawal()` verifies the finalized Note, Pending and Clock accounts. It returns a verified deadline and waiting/ready/unavailable status, or fails with an unknown cached status. `status()` remains local-only. Reopening a client or changing the journal invalidates this cached observation. Finalization verifies eligibility again immediately before wallet signing. See the [API reference](../sdk/api.md).

## Install

Download the exact tarball and manifests from the immutable [GitHub release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.19). Authenticate them using `gh release verify` and `gh release verify-asset`, then compare the SHA-256 before installation. The package remains a GitHub tarball, not an npm registry publication. Native installers remain at `.15`.

The browser verifier is byte-identical to the published `.18` verifier (SHA-256 `395465e39aef68ff1e9fd3167cb80d03a653bab09a54c83c18cbf8df06c60d84`). Its original build provenance and notices are retained. No backend, recovery-service, program, profile, Pool, journal schema or custody migration is needed.

## Validation scope

Tests cover every proof-upload stage, signed transaction observation, restored progress, unverified and waiting deadlines, readiness and pre-sign eligibility checks. The SDK suite also exercises browser and fresh-process Node.js restoration after deleting local data. Independent tarball acceptance installs the released package rather than importing its source. Results use synthetic provider and chain fixtures; they do not establish a fresh funded public Devnet lifecycle or paid inference.

Recovery still requires the separately retained kit and available recovery service. An existing browser stores a nonextractable device key, not the recovery secret, and cannot re-download a lost kit. Keep the usable browser and withdraw funds before clearing it. Safe kit replacement requires a separately designed revocation protocol; this release does not create parallel financial journals.
