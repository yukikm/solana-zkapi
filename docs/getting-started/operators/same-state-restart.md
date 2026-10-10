# Same-state preview restart and backup procedure

Use this runbook to stop and restart an existing operator while retaining its
mounted `/srv/zka` state, financial ledger, signer journal and budget authority.
Plan a maintenance window, suspend new admission and resolve accepted work before
stopping recovery services. See [incident handling](incidents.md)
and [current status](../../status.md) for recorded verification scope.

A backup does not authorize a second financial writer or reuse of an AUTH.
Finite grant identities remain immutable even when the gateway uses
[operator-funded policy](budget.md).

## Establish the maintenance boundary

1. Record relevant accepted request UUIDs, exact AUTH digests, signed successors,
   settlement receipts, client journal identities, and the current server binary
   and configuration hashes in protected evidence. Verify the client has no unknown
   inference operation and do not send another inference during maintenance.
2. The operator suspends new admission in the existing gateway configuration
   and verifies the public status. Preserve the previous configuration bytes and
   hash. Keep recovery available until the accepted request is fully settled.
3. Record read-only control/database counts and challenger health. Require no
   active dispatch child, unknown transaction signature, unfinished challenger
   job, or unresolved accepted AUTH before proceeding. An absent row alone is
   insufficient evidence that an uncertain external action did not happen.
4. Record the mounted filesystem UUID, original PostgreSQL system identifier,
   any retained finite-budget directory/lock device and inode. For detached V2,
   these are `/srv/zka/budget-seven` and its existing `budget.lock`. Validate its
   authorization and aggregate reservation count. Never invoke grant
   initialization or replace the lock, marker, authorization, or reservation file.

## Quiesce the existing writers

After the operator verifies the prepared maintenance cut, stop the gateway
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
finite-budget lock, if configured, during the financial-state capture. Closing
that descriptor after capture is allowed; recreating the lock file is not.

The read-only indexer can remain running for a financial-services restart.
A test that retains it does not verify a full operator or host reboot. If it is
restarted, require authenticated replay/checkpoint validation and complete
finalized catch-up before admission resumes, without advancing the original
start slot. Public snapshots alone are not a startup shortcut; retained runtime
caches have separate binding checks described in the
[archive storage runbook](archive-storage.md).

## Capture a coherent protected backup

While financial writers are stopped, use the PostgreSQL 16 tools as the existing
`postgres` user and its local peer-authenticated socket:

```sh
umask 077
maintenance_dir=/srv/zka/maintenance/UNIQUE_MAINTENANCE_ID
mkdir -m 700 "$maintenance_dir"
runuser -u postgres -- pg_dump -h /run/zkapi-postgresql -U postgres -d zkapi -Fc > "$maintenance_dir/zkapi.dump"
runuser -u postgres -- pg_dumpall -h /run/zkapi-postgresql -U postgres --globals-only > "$maintenance_dir/globals.sql"
```

Create an owner-only parent directory and choose a new maintenance ID.
The execution wrapper must use fail-fast behavior and refuse an
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

Capture the entire original challenger directory in whichever format the
deployment uses. A fresh v1 journal keeps its history in `journal.json`; an
explicitly migrated v2 journal needs the small `journal.json` head, every
`archive-v2/` chunk and the retained `legacy-v1.json`. In both cases preserve
the existing `owner.lock`, any retained staging files, the exact reader binary,
its verification record and configuration. A v2 head alone is not a recoverable
archive. Record total logical and allocated storage across these files,
deduplicating hard-linked inodes for allocated bytes. Do not delete orphan or
staging files to make a backup pass.

A normal restart opens the existing format. Do not migrate as part of this
restart, replace a v2 head with the legacy copy, or select an older binary that
cannot read the committed format or compression. The separate
[archive migration procedure](archive-storage.md#migrate-a-v1-journal-to-v2)
requires its own maintenance cut. Any ambiguity requires a reviewed recovery
plan with all retained files preserved.

Write a versioned inventory with each included file's digest, size, and mode,
plus the original live authority identities and quiescence observations. Encrypt
before upload to a new, unique key under the existing private backup bucket's
`encrypted/` prefix. Pin the ciphertext digest and returned S3 VersionId; no
public artifacts prefix may contain private state. Arrange an independently
retained decryption capability before calling this a recoverable backup: the
host's bootstrap recipient private key existing only on that host is insufficient
for recovery after host loss.

## Restart the same mounted state

If PostgreSQL was stopped, start the existing `zka-postgresql.service` and require
its readiness check, unchanged system identifier, and expected existing schema.
Start the signer against the retained journal, then control and challenger
against their existing configuration and state. Start the gateway with new
admission still suspended. These are `systemctl start` operations; do not run
`initdb`, `provision`, challenger `init`, or either budget initializer.

Compare exact financial identities, prior reservations and signed receipts to
the maintenance cut. Revalidate any retained finite authority against its live
directory and lock identities. Recover or inspect already saved client
operations explicitly; never create a replacement UUID or replay inference to
make the test succeed. Verify independent indexer root/snapshot readiness and
current challenger readiness, lag, pending jobs, unknown signatures, available
memory, and disk space. The operator may restore new admission after
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
