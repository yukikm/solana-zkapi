# Back up and restart an operator

Use this procedure for an existing **Linux deployment with systemd** and the
supplied [service units](../../deploy/public-devnet/systemd/README.md).
Keep its program, Pool, keys, ledger, journals and deployment pins unchanged.
A backup does not authorize a second financial writer.

## 1. Suspend new work

Set the gateway's `allowNewAdmissions: false`, keeping recovery writes enabled.
Finish or explicitly reconcile accepted sessions. Record a private maintenance
cut: service/configuration hashes, PostgreSQL system identifier, ledger and signer
state, dispatcher ownership, challenger jobs and unknown transaction signatures.
Uncertain actions need reconciliation; an absent row does not prove non-execution.

## 2. Stop writers

```sh
systemctl stop zka-gateway.service
systemctl stop zka-control.service
systemctl stop zka-challenger.service
systemctl stop zka-signer.service
```

Verify each service exited successfully and its process group is empty. Preserve
failed-stop observations and all dispatcher claims. Stop any archive follower
before copying its mutable state. Keep PostgreSQL available for database export.

## 3. Save a coherent backup

For the supplied PostgreSQL socket and database, run as the operator administrator:

```sh
set -eu
umask 077
backup_dir=/absolute/private/new-backup
mkdir -m 700 "$backup_dir"
runuser -u postgres -- pg_dump -h /run/zkapi-postgresql -U postgres -d zkapi -Fc > "$backup_dir/zkapi.dump"
runuser -u postgres -- pg_dumpall -h /run/zkapi-postgresql -U postgres --globals-only > "$backup_dir/globals.sql"
```

Use a new directory. The globals dump contains sensitive role material.
Capture the matching signer journal, dispatcher claims, challenger journal and
complete archive, configurations, private keys, public deployment files, and
installed binaries. Preserve ownership, modes and every existing finite-budget
lock/authority if configured. Record file digests and the PostgreSQL identity.

For archive v2, retain the head, all `archive-v2/` chunks, `legacy-v1.json`, owner
lock and staging files. The head alone is not a backup. A raw PostgreSQL directory
copy requires a clean database stop; use supported physical backup/WAL tools for
other cases. See [restore verification](operations.md#recovery-and-wal).

Encrypt the backup before uploading it to private storage. Retain its digest,
storage version and decryption capability independently of the original host.
Do not copy private state into the public artifact bucket.

## 4. Restart the existing state

If PostgreSQL was stopped, start `zka-postgresql.service` first and verify its
original system identifier and schema. Start signer and indexer, wait for signer
reconciliation and finalized indexer catch-up, then start control, challenger and
gateway. Keep new admission suspended until all checks pass.

Do not run `initdb`, `provision`, journal initialization, archive migration or
budget initialization during a restart. Preserve the archive reader compatible
with its stored format. Do not advance the original archive start slot.

Compare financial records to the saved cut. Check signer, tree, challenger,
unknown signatures, disk space and [consumer preflight](devnet.md). Resume
admission only after reconciliation. Do not replay inference to test recovery.

Verify a backup in an isolated, non-admitting environment before relying on it.
Restoring over live financial state can roll back reservations and signatures.
A host reboot additionally requires mount, device/lock identity and service-order
checks; a successful process restart does not establish reboot recovery.
