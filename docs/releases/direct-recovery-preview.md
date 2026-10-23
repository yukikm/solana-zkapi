# SDK/native 0.2.0-devnet.15

This Devnet repair makes direct provider issuance failures diagnosable and
distinguishes completed recovery from unresolved or failed recovery. Follow the
[installation and operator upgrade guide](../getting-started/direct-recovery-upgrade.md).

## Changes

- The control service retains bounded issuance and lookup diagnostics in its
  existing durable checkpoint. Provider HTTP rejection, transport, response
  decoding, dispatcher and claim-storage errors have separate safe codes.
  Raw stderr, provider error bodies and credentials are excluded.
- Empty key lookups explicitly require operator investigation. Failed lookups
  remain distinguishable. The original issuance observation survives both.
- `ClientDaemon.start()` and application `recover()` return `completed`,
  `pending` or `failed`. Application status exposes the server state and safe
  recovery reasons even when the local session phase is `closing`.
- A new header opts into diagnostic response fields. The matching public gateway
  permits and forwards it; old SDKs keep their closed response contract.

A public Devnet investigation found a dispatcher claim-directory configuration
outside the control service's writable systemd paths. This prevents the durable
pre-send claim from being created and stops key issuance. Operator configuration
must bind the actual retained claim directory to the service sandbox; ordinary
host permissions and offline manifest checks alone do not verify that access.

These changes retain the shared financial ledger and signer, integer accounting,
exact authorization bytes, one-use dispatcher claims and sign-once settlement.
An absent key never permits reissuance, inference replay or zero-charge settlement.
Historical unknown attempts keep their reservations and original evidence.

## Compatibility and distribution

The [GitHub release](https://github.com/yukikm/solana-zkapi/releases/tag/v0.2.0-devnet.15)
contains a separate SDK tarball and macOS ARM64 native package, source archive,
checksums and release manifest. Authenticate the immutable release and its asset
attestations. Published `.13` and `.14` assets are unchanged; npm publication
remains disabled. Node 24.22.1, npm 11.19.1 and Solana Kit 8.4.0 remain pinned.

Authenticated `.13`/`.14` profiles remain accepted without changing bytes, hashes
or custody. Legacy schema 1 `.8` through `.12` compatibility is retained. Existing
native profiles remain pinned to their original installation. There is no Pool,
program, circuit, tariff, database schema or custody migration.

## Verification scope

Regression coverage uses local HTTP providers and disposable PostgreSQL to check
failed issuance followed by key absence, successful issuance with lost response
and later discovery, failed key listing, restart persistence and dispatcher IPC.
SDK and gateway fixtures verify explicit outcomes, browser negotiation, legacy
compatibility, and no duplicate issuance or inference. The release body records
final package/native/CI results separately.

No paid inference or public wallet transaction is required for these checks.
A corrected server configuration and successful read-only checks do not prove
that a historical unknown session is settled or that a new paid chat succeeds.
The public selection remains direct OpenRouter on the existing Devnet Pool.
Production, mainnet, full provider/browser coverage and long-term availability
remain outside the [recorded support scope](../support.md).
