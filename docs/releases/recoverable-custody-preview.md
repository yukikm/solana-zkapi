# SDK recoverable custody preview

SDK `0.2.0-devnet.18` adds encrypted external custody with a portable recovery kit,
shared browser and Node.js storage, explicit single-device ownership restoration,
and safe enrollment of existing authenticated journals. See the
[integration and recovery contract](../sdk/recoverable-custody.md).

This SDK-only release also includes the previously local `.16` explicit operator
waiver support and `.17` read-only wallet transaction observation. It preserves
the authenticated public profile, Pool, note IDs and existing financial validation.
Native clientd installers remain at `.15`; installing this tarball is not a
native-installer upgrade. npm registry publication remains disabled.

The `.16` waiver path requires the matching independently pinned client prover
WASM (SHA-256 `395465e39aef68ff1e9fd3167cb80d03a653bab09a54c83c18cbf8df06c60d84`).
Do not substitute a verifier solely because it is served beside an SDK package.
Retain the installed artifact provenance and original recovery runtimes.

## Install

Download the tarball, `release-manifest.json` and `SHA256SUMS` from the immutable
[GitHub SDK release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.18).
Authenticate the release and downloaded assets with `gh release verify` and
`gh release verify-asset`, following the existing
[release authentication procedure](../getting-started/direct-recovery-upgrade.md#authenticate-and-install).
Compare the tarball SHA-256 to the authenticated manifest, then install that exact
file with the pinned Node 24.22.1 toolchain. Existing local custody remains local
until the user explicitly sets up recovery.

## Validation scope

Local tests use synthetic payment/provider/finality fixtures. Browser tests erase
IndexedDB custody and device bindings and restart the browser context; Node tests
remove the original device directory and restore in a fresh process. Both recover
the latest encrypted state using only the separately retained kit and service.
They also cover ownership fencing, failed/uncertain writes, invalid keys/context,
authenticated record copying, and pending-state preservation. These tests do not
claim a new funded public Devnet lifecycle, paid provider acceptance, all browser
coverage, or production readiness.

Restoration still requires the external service, the kit, the correct wallet,
compatible runtime and deployment. Stop old clients first. Recovery does not
recreate already-lost secrets or repair unavailable retired Pools.
