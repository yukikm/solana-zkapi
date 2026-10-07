# Same-state preview restart and backup procedure

This is an unexecuted procedure prepared for the AWS preview on 2026-10-08 JST.
It becomes eligible only after the first native acceptance request has a verified
signed settlement and the coordinator explicitly starts this maintenance step.
The current archive startup work is separate. This document records no restart,
backup upload, restore, boot qualification, or additional provider request.

The maintenance target is the existing mounted `/srv/zka` volume and the existing
initialized detached seven-cap authority. The original local seventeen-row
authority remains independent and unchanged. A backup is recovery evidence; it
does not grant permission to operate a second financial writer or reuse an AUTH.

## Establish the maintenance boundary

1. Record the accepted native request UUID, exact AUTH digest, signed successor,
   settlement receipt, client journal identity, and the current server binary and
   configuration hashes in protected evidence. Verify the client has no unknown
   inference operation and do not send another inference during maintenance.
2. The coordinator suspends new admission in the existing gateway configuration
   and verifies the public status. Preserve the previous configuration bytes and
   hash. Keep recovery available until the accepted request is fully settled.
3. Record read-only control/database counts and challenger health. Require no
   active dispatch child, unknown transaction signature, unfinished challenger
   job, or unresolved accepted AUTH before proceeding. An absent row alone is
   insufficient evidence that an uncertain external action did not happen.
4. Record the mounted filesystem UUID, original PostgreSQL system identifier,
   `/srv/zka/budget-seven` device/inode, and its existing `budget.lock`
   device/inode. Validate the already approved V2 authorization and aggregate
   reservation count using the configured existing authority. Never invoke grant
   initialization or replace the lock, marker, authorization, or reservation file.

## Quiesce the existing writers

After the coordinator authorizes the prepared maintenance cut, stop the gateway
first so no new reservation or client operation enters. Stop the control daemon
with its configured SIGINT and wait for its dispatcher children to exit. Stop the
challenger gracefully and require successful exit after its validated archive
prefix is flushed. Then stop the signer. Keep PostgreSQL available for the
read-only consistency capture, and stop it only after that capture completes.

Use the existing units, without initialization commands:

```sh
systemctl stop zka-gateway.service
systemctl stop zka-control.service
systemctl stop zka-challenger.service
systemctl stop zka-signer.service
```

Inspect `ActiveState`, `Result`, `ExecMainStatus`, and remaining processes in each
unit cgroup before advancing. A forced termination, timeout, or nonzero exit is
retained as a failed observation and requires review; do not clear markers or
start a second writer to bypass it. After stopping the gateway, hold the existing
budget lock during the financial-state capture. Closing that descriptor after
capture is allowed; recreating the lock file is not.

The read-only indexer can remain running for a financial-services restart. Its
current implementation rebuilds replay from the original start slot when its
process restarts; saved content-addressed snapshots are not an authenticated
startup shortcut. A test that retains this process is financial-services
same-state restart evidence, not full operator or host reboot evidence. A full
indexer restart requires its own complete catch-up before public admission can
resume, without advancing the original start slot.

## Capture a coherent protected backup

While financial writers are stopped, use the PostgreSQL 16 tools as the existing
`postgres` user and its local peer-authenticated socket:

```sh
umask 077
maintenance_dir=/root/zkapi-bootstrap/maintenance-N01
mkdir -m 700 "$maintenance_dir"
runuser -u postgres -- pg_dump -h /run/zkapi-postgresql -U postgres -d zkapi -Fc > "$maintenance_dir/zkapi.dump"
runuser -u postgres -- pg_dumpall -h /run/zkapi-postgresql -U postgres --globals-only > "$maintenance_dir/globals.sql"
```

The reviewed execution wrapper must use fail-fast behavior and refuse an
existing maintenance directory, so output files cannot be reused or overwritten.
Both commands write owner-only files, never SSM standard output. The globals
dump contains sensitive role material. Record the dump
hashes and matching database system identifier and schema state. Then stop
PostgreSQL cleanly if a physical directory capture or database restart is in
the selected test.

Capture the retained signer journal; dispatcher recovery state; challenger
journal, owner lock and health; existing budget directory including its marker,
authorization and reservations; historical snapshot; public deployment files;
private runtime configuration/keys; and installed binary/configuration hash
inventory. The relevant directories are `/srv/zka/signer`, `/srv/zka/dispatcher`,
`/srv/zka/challenger`, `/srv/zka/budget-seven`, `/srv/zka/history`,
`/srv/zka/runtime`, `/srv/zka/config`, and `/srv/zka/deployment`. Preserve ownership
and mode metadata. If capturing `/srv/zka/postgres`, do so only after PostgreSQL
stops cleanly; a running filesystem copy is not a database backup.

The challenger now uses the explicitly migrated v2 archive. Capture its entire
directory: the small `journal.json` head, all `archive-v2/` chunks, retained
`legacy-v1.json`, existing `owner.lock`, and any retained staging files. Preserve
the exact selected reader binary and its verification record alongside the
configuration. The head alone is not a recoverable archive. Record total logical
and allocated storage across these files, deduplicating hard-linked inodes for
allocated bytes. Do not delete orphan or staging files to make a backup pass.

A normal restart opens the existing format. Do not invoke `migrate-archive`
again, replace the v2 head with the legacy copy, or select an older binary that
does not support the committed format. Any ambiguity requires a reviewed
recovery plan with all retained files preserved.

Write a versioned inventory with each included file's digest, size, and mode,
plus the original live authority identities and quiescence observations. Encrypt
before upload to a new, unique key under the existing private backup bucket's
`encrypted/` prefix. Pin the ciphertext digest and returned S3 VersionId; no
public artifacts prefix may contain private state. Arrange an independently
retained decryption capability before calling this a recoverable backup: the
host's bootstrap recipient private key existing only on that host is insufficient
for recovery after host loss. No new decryption key or backup object has been
created by this procedure.

## Restart the same mounted state

If PostgreSQL was stopped, start the existing `zka-postgresql.service` and require
its readiness check, unchanged system identifier, and expected existing schema.
Start the signer against the retained journal, then control and challenger
against their existing configuration and state. Start the gateway with new
admission still suspended. These are `systemctl start` operations; do not run
`initdb`, `provision`, challenger `init`, or either budget initializer.

Compare exact financial identities, prior reservations and signed receipts to
the maintenance cut. Revalidate the existing V2 authorization against the live
directory and lock identities. Recover or inspect the already saved native
operation explicitly; never create a replacement UUID or replay inference to
make the test succeed. Verify independent indexer root/snapshot readiness and
current challenger readiness, lag, pending jobs, unknown signatures, available
memory, and disk space. Only the coordinator may restore new admission after
these checks pass.

Service enablement for boot remains a separate final action after the selected
restart test passes. A same-process restart does not prove reboot readiness:
mount ordering and Linux device numbers can change across boots, and the V2
authority deliberately fails closed if its pinned device/inode identities no
longer match. Retaining the same EBS volume or filesystem UUID alone must not be
treated as authorization to rewrite those identities. No unit is enabled by
this document.

Do not restore a saved backup over the current live volume as part of this test.
That would roll back financial history and can replace the authority's lock
inode. A future loss/restore procedure needs explicit single-writer fencing and
authority review, and must first verify the backup in an isolated non-admitting
environment. This preview procedure provides no distributed fencing or automatic
financial-authority migration.
