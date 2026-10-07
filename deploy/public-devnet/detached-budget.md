# New AWS seven-cap authority

The user approved **seven additional USDC** of maximum provider exposure for
B-01–B-03 and N-01–N-04. This selects one new AWS authority with seven
1,000,000-micro-USDC reservations. The roughly USD50/month AWS hosting plan was separately approved on
2026-10-08 JST. No actual historical export, grant initialization, new reservation,
provider call, funding or cloud mutation was performed by this implementation.

`scripts/provider_detached_budget.py` implements `supplemental-detached-v2`.
Use this selection for the fresh public deployment. The earlier
[`supplemental-v1`](supplemental-budget.md) remains available for a supplement
under the existing local lock, but **the same seven-USDC approval must be used
once: never initialize both V1 and V2 or a second V2 authority**. Record the one
selected grant UUID, exact authorization digest and responsible operator in the
deployment record before initialization.

## Historical reference and active authority

The original local campaign keeps its existing files, lock, services and
recovery paths. Its 17 reservations, totaling 9,154,216 micro-USDC at the recorded
checkpoint, remain intact. The remaining 845,784 is neither copied nor transferred
to AWS. Original lower-cap helpers may still operate within their own unchanged
rules; they do not gain seven more USDC through this selection.

An explicit export command reads the original plan, identity and reservation
state under its **existing** flock, without creating a lock or writing original
files. Its one private JSON snapshot contains exact original identity/state
bytes, their SHA-256 values, the canonical plan and an aggregate summary. The
export validates the original ledger using its existing reader. The approved
new grant pins the entire snapshot bytes plus original anchors/count/amount.

The AWS runtime reads that snapshot solely for provenance and a historical
UUID/AUTH-hash collision blacklist. It never receives a writable original
ledger directory or a legacy plan argument, never initializes or reserves old
capacity, and rejects **all** historical UUID/hash matches, including an exact
old AUTH retry. Historical recovery stays with the original authority. The
gateway additionally validates AUTH deployment ID, Pool, signed quote, tariff
and cap against the selected fresh authenticated manifest before reservation.
Fresh deployment pins and service state must be reviewed; a new budget does not
authorize cloning an existing funded Pool or financial signer/coordinator.

The snapshot is a point-in-time record. Later original reservations are not
visible to AWS. Random new UUIDs, distinct reviewed deployment/Pool pins and
explicit ownership boundaries are required; a snapshot is not live
cross-authority deduplication. Public status describes only the active new
seven-cap grant and labels history as `live: false` with zero transferred
capacity. It never publishes a live combined 17-USDC balance.

## Prepare the exact inputs after hosting approval

These are operator commands for the selected host, not commands already run.
Keep all snapshots and approvals private. Export immediately before final
deployment review; do not create a real export merely to test this workflow.

On the original host, use an existing plan with its original source evidence
and the canonical existing state directory. The export opens only the existing
lock and reads original files. Shell noclobber prevents replacing an earlier
snapshot:

```sh
umask 077
set -C
python3 scripts/provider_detached_budget.py export-history \
  --plan /reviewed/original-plan.json \
  --state-dir /canonical/original-campaign \
  > /reviewed/new-public-history.json
```

Check command exit status and parse/hash the complete output before accepting
it; a failed command is a redacted error, not a usable snapshot. Independently
compare the three original anchors and recorded 17-row checkpoint. The export
does not change local service admission or recovery policy.

On the newly approved AWS host, use one non-root `zka-gateway` service account.
Install the reviewed snapshot at `/srv/zka/history/original-snapshot.json`, owned
by `root:zka-gateway`, mode `0440`. Every ancestor must be a real root-owned
directory without group/other write permission; `/srv/zka/history` may be
`0750`, group `zka-gateway`. The helper rejects a runtime-owned, world-readable,
writable or symlinked snapshot and rejects writable/untrusted ancestors. The
runtime cannot chmod, replace or initialize the original snapshot; root is the
trusted installation authority.

Create a **new, empty** `/srv/zka/budget-seven` directory, owner
`zka-gateway:zka-gateway`, mode `0700`, and one empty `budget.lock` inside it,
same owner, mode `0600`. Refuse any existing target instead of cleaning it.
The helper never creates the authority directory or its lock. Keep approvals
and gateway configuration outside that directory, owner `zka-gateway`, mode
`0600`, under protected `/srv/zka/config`. No original budget identity/state
files, old live database or signer/challenger journal are installed there.

Prepare the exact deployment-pin JSON described in
[supplemental-budget.md](supplemental-budget.md#prepare-and-validate-without-initialization):
profile, canonical manifest, bundle, SDK/native archives, tariff, concrete
model, direct OpenRouter, cap 1,000,000, TTL 60 seconds and output limit 128.
The public profile must declare Chat, streaming and tools for this matrix.
Then, as `zka-gateway`, produce a new proposal:

```sh
umask 077
set -C
python3 scripts/provider_detached_budget.py prepare-proposal \
  --state-dir /srv/zka/budget-seven \
  --history-snapshot /srv/zka/history/original-snapshot.json \
  --deployment /srv/zka/config/deployment-pins.json \
  > /srv/zka/config/unapproved-seven-cap.json
```

The proposal is deliberately unapproved and does not validate deployment pins
as an approved grant. Retain its unique UUID. After reviewing the final pins,
record the **existing user approval**, actual reference/date and
`approval.approved: true` in a new authorization file. Independently pin those
exact final bytes. Do not invent another approval, change the grant UUID to
recover capacity or interpret the local boolean as evidence of human consent.

```sh
python3 scripts/provider_detached_budget.py validate-authorization \
  --state-dir /srv/zka/budget-seven \
  --history-snapshot /srv/zka/history/original-snapshot.json \
  --authorization /srv/zka/config/approved-seven-cap.json \
  --authorization-sha256 APPROVED_SHA256
```

Validation writes no files. Record the selected UUID, digest, snapshot anchors,
deployment pins and single-writer host/volume identity. The final authorization
binds the canonical **new** authority directory and lock device/inode. Run the
same command with `initialize-approved` in place of `validate-authorization`
exactly once. This is an explicit new-authority initialization, not migration
of the original campaign. Do not initialize a V1 grant under the same approval.

Initialization durably records `detached-grant-identity.json` before creating
`grants/<grant-uuid>/authorization.json`, `reservations.json`, and
`grants/index.json`. The root permits only one grant. Any existing or partial
marker, grant, extra file or substituted index refuses reset. Recover an
interrupted operation by reviewing its consumed namespace and durable bytes;
never remove markers to create another allowance.

## Gateway and service confinement

Use this exact versioned budget selection in the private gateway configuration:

```json
{
  "kind": "supplemental-detached-v2",
  "stateDir": "/srv/zka/budget-seven",
  "historySnapshotPath": "/srv/zka/history/original-snapshot.json",
  "authorizationPath": "/srv/zka/config/approved-seven-cap.json",
  "authorizationSha256": "<exact approved authorization SHA-256>",
  "sdkSha256": "<reviewed SDK archive SHA-256>",
  "nativeSha256": "<reviewed native archive SHA-256>"
}
```

There is no `planPath` or old ledger directory. Gateway startup invokes only
`status` and later `reserve`; it cannot invoke initialization/export through
the adapter. It matches the grant's deployment pins to the actual loaded
profile, manifest, bundle and tariff. Status must have exactly seven million
micro-USDC total and seven maximum requests. The gateway rejects a historical
recovery receipt or combined original-plus-new capacity from this helper.

Apply at least these systemd service settings to the gateway service, alongside
its existing exact command, network and startup dependencies:

```ini
[Service]
User=zka-gateway
Group=zka-gateway
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/srv/zka/history /srv/zka/config
ReadWritePaths=/srv/zka/budget-seven
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
```

Keep the root-owned history directory outside all writable paths. The gateway
needs only its separate writable reservation authority; control, signer,
database and challenger have their own reviewed identities and state. This
confinement configuration has not been exercised on an AWS host yet.

Reservations consume a full cap before forwarding AUTH and are never refunded
for cancellation, failure, small actual usage, settlement or withdrawal. File
and directory fsync complete before acknowledgement. An uncertain fsync grants
no forward permission even if its reservation already consumed capacity. An
exact current-grant retry re-syncs existing files and can recover during
suspension without an invitation. A missing/invalid invitation cannot reserve
a new slot. This permission is AUTH recovery only, never inference replay.

Selected SDK/native hashes, the output limit and seven-case labels are reviewed
acceptance records. AUTH cannot attest a remote binary or inspect the private
direct-provider request. Independent acceptance must verify those facts; the
public financial guard enforces invitation plus seven complete caps.

## Guarantees and tests

The lock, path/device/inode pins, grant marker/index and fsync protect one local
writer against accidental reuse, concurrency and partial initialization.
They do **not** prove that an administrator has not issued another authorization
on a different machine, provide distributed fencing, detect every filesystem
rollback or permit promotion of a stale backup. Use one selected host/volume;
no autoscaling, second writer or clone promotion. A changed inode/lock fails
closed. Restore requires explicit reconciliation of all consumed reservations
and the authority identity; no automatic restore may replenish capacity.

The synthetic local suite is:

```sh
python3 -m unittest discover -s scripts -p test_provider_detached_budget.py
node --test --test-name-pattern 'detached|supplemental' scripts/public_devnet_gateway.test.ts
```

Fourteen detached-helper tests cover exact export/read-only originals, seven
slots, historical denial, current exact recovery, corruption, duplicate grants,
partial initialization, mutation, original evolution, local clone/lock checks,
uncertain fsync and concurrent reservations. Gateway fixtures validate versioned
selection, active-only status, suspended recovery and pin/receipt rejection.
Tests use temporary synthetic ledgers and replace only the root-owned snapshot
reader because they do not install privileged files. A separate test confirms
the production reader rejects runtime-owned/symlinked inputs. These establish
no actual export, initialized grant, AWS permissions test or provider spend.
