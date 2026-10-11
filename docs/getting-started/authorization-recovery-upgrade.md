# Deploy balance-preserving authorization recovery

This additive upgrade enables SDK `.10` to retire an exact never-admitted AUTH
without clearing its note or balance. Keep all existing deployment/custody pins.
See [the recovery contract](../specs/api-proxy.md#retiring-a-never-admitted-authorization).

1. Build the reviewed control-service binaries and matching public gateway.
   The control writer, **signer** and operations tools all verify exact migration
   checksums; deploy matching `controld`, `signerd` and any installed `opsd`.
   Updating only the writer leaves the older signer incompatible with migration 3.
2. Suspend new admission while preserving recovery routes. Check that sessions
   are settled and no dispatcher calls remain unfinished before planned maintenance.
   Never force-settle work or mark an uncertain dispatch completed.
3. Back up the primary database, original binaries/configuration, signer journal
   and recovery material privately. Record immutable financial rows and key hashes.
   Stop control before signer; verify both process groups have exited. Preserve
   dispatcher claims. The systemd-managed signer socket directory may be recreated
   only after its previous process has stopped; never recreate the signer journal.
4. Apply the reviewed checksummed migration 0003 with the database migration role.
   It adds immutable request/quote fences and admission triggers; it does not clear
   notes, reserve nullifiers, alter balances or replace the signed manifest.
   Install the matching binaries and the two gateway route changes.
5. Start signer with its original keys/configuration/journal, then control. Verify
   reconciliation, fresh readiness, gateway recovery routing and the three applied
   migration checksums. Compare financial rows and signer journal before/after.
   Only then resume admission and verify public read-only preflight.
6. Application maintainers install SDK `.10` and rebuild their application and
   prover worker. Keep the original authenticated profile hash and browser storage
   identity. Old `.8`/`.9` apps do not gain the new recovery flow from a server
   update alone. An already permanently cleared note remains withdrawal-only.

Keep acknowledged retirement fences in every backup and restore checkpoint.
After migration, old binaries fail schema verification. Prefer a forward fix
with admission suspended if startup fails; do not delete migration records or
restore a database missing acknowledged fences. SDK journals with new retirement
archives likewise require `.10` or a compatible successor. Keep backups and
operational evidence in ignored `target/` locally or protected server storage.
