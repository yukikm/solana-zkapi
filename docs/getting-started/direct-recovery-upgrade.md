# Upgrade direct issuance recovery

SDK/native `0.2.0-devnet.15` exposes explicit recovery outcomes and safe direct
issuance diagnostics. The matching control service and gateway are required for
browser diagnostic negotiation. Read the [release notes](../releases/direct-recovery-preview.md).
This procedure preserves deployment pins and existing financial state.

## Authenticate and install

Use Node 24.22.1 and npm 11.19.1. Download into a new directory using an
authenticated GitHub CLI with immutable release verification support:

```sh
gh release download v0.2.0-devnet.15 --repo yukikm/solana-zkapi
gh release verify v0.2.0-devnet.15 --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.15 release-manifest.json --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.15 SHA256SUMS --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.15 zkapi-solana-sdk-0.2.0-devnet.15.tgz --repo yukikm/solana-zkapi
gh release verify-asset v0.2.0-devnet.15 zkapi-clientd-0.2.0-devnet.15-darwin-arm64.tar.gz --repo yukikm/solana-zkapi
shasum -a 256 -c SHA256SUMS
```

Retain earlier archives and lockfiles. Install the verified SDK tarball in the
application, rebuild its browser bundle and prover worker together, and display
the [structured recovery result](../sdk/recovery.md). Keep the same browser
origin, storage name, account, note ID, profile bytes/hash and deployment pins.
`.15` accepts authenticated `.13` and `.14` profiles in all supported schemas,
plus legacy schema 1 profiles listing `.8` through `.12`.

```sh
npm install --save-exact ./vendor/zkapi-solana-sdk-0.2.0-devnet.15.tgz
```

Extract native archives into a separate installation and verify every file
against `release.json`, itself pinned in the authenticated release manifest.
Existing native profiles pin their original installation. Do not edit that
binding, rerun setup on funded custody or replace the original journal. Preserve
the original runtime for unresolved work; a new archive is not a custody migration.

## Update an existing operator

1. Build matching `controld` and `dispatcherd` binaries from the reviewed commit
   with Rust 1.90.0 and locked dependencies. The diagnostic checkpoint extension
   requires no database migration or on-chain upgrade. Existing signer keys,
   manifests, profiles, tariffs and journals remain unchanged.
2. Suspend new admission and inspect pending sessions and dispatch ownership.
   An unresolved session may remain stored during this upgrade, but every
   original dispatch must have finished or been independently fenced before
   stopping its owner. Never mark an uncertain attempt finished to permit maintenance.
3. Back up the database, original binaries/configuration, signer journal and
   all dispatcher claims privately. Record hashes and financial rows at a
   maintenance cut. Stop gateway and control and verify process-group exit.
4. Keep the configured `claims_directory` and its complete historical contents.
   Its exact directory must be writable by the dispatcher in the control
   service's systemd mount namespace. A host-level permission check is
   insufficient under `ProtectSystem=strict`; `ReadWritePaths` must include the
   actual configured path. Retain previously permitted paths when repairing an
   existing installation. Do not replace, clear or reinitialize claims.
5. Install the matching dispatcher/control binaries and update the control
   configuration's dispatcher SHA-256 pin. Install the matching gateway relay
   files so browser preflight permits `X-Zkapi-Recovery-Diagnostics: 1` on session
   routes and forwards it unchanged. Old clients receive the legacy response shape.
6. Start control with its original database, Pool and signer, then gateway.
   Compare immutable financial rows, claim hashes and custody/configuration
   identities. Verify local readiness, authenticated status, legacy response
   compatibility and public browser preflight before resuming admission.

The provided control unit runs `dispatcherd CONFIG --check-storage` as
`ExecStartPre`. This creates, fsyncs and removes a uniquely named temporary probe
inside the actual service namespace without opening a provider connection or
creating an attempt claim. Retain this preflight when adapting the unit.
`python3 scripts/check_dispatcher_storage_binding.py --dispatcher-config CONFIG
--unit CONTROL_UNIT` checks the static path binding; repeat `--unit` for ordered
drop-ins. Static checks complement the real namespace probe.

After an enriched checkpoint is written, older server binaries that reject
unknown checkpoint fields cannot recover it. Keep control and dispatcher on the
matching release and use a compatible forward fix if deployment fails; never
delete diagnostic checkpoints or roll back financial history. Old clients remain
wire-compatible because the response extension is negotiated separately.

Keep operational evidence and private backups outside public distribution.
No step creates a provider key, replays inference, submits a wallet transaction
or resets a capacity grant. Readiness checks do not prove provider credit or
successful inference.

## Recover an existing unknown session

Use the original request ID, token and encrypted journal. The SDK returns
`pending` with `provider_key_absent` when a completed lookup finds no key, or
`provider_lookup_failed` when the lookup itself fails. Present
`ISSUANCE_UNKNOWN` to the application even if the local phase is `closing`.

If the key is later found, existing recovery disables it, captures usage and
performs signed settlement without delivering or replacing the key. If no key
is found, retain the session and seek operator investigation. Missing historical
diagnostics cannot be reconstructed by installing this release. Neither an empty
key list nor a repaired filesystem configuration alone authorizes retrospective
zero-charge settlement. Emergency withdrawal remains a separate explicit wallet
action governed by the [existing recovery contract](../sdk/recovery.md).
