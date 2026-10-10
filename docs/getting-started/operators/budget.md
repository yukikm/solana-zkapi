# Provider spending policies

Devnet USDC does not pay real OpenRouter charges. The operator chooses the
gateway's spending policy independently of client note balances and hosting
costs. The current preview uses operator-funded usage; its historical seven
request slots remain consumed. See [current status](../../status.md).

## Operator-funded usage

Set this explicit policy in the private gateway configuration:

```json
{"budget": {"kind": "operator-funded"}}
```

This removes the gateway's lifetime request count and campaign allowance.
It does not reset old grants or create a second financial ledger. The existing
control ledger still validates signed quote/proof and exact AUTH transcripts,
reserves note balance durably, enforces the pinned per-session cap and settles
once. The operator pays provider charges and must maintain provider credit.

`GET /provider-budget` returns schema 2 with `budget_scope: operator_funded`,
`trial_limits: false`, the unchanged `request_max_cost_micro_usdc`, admission
flags and `provider_credit: not_checked`. It does not report a remaining request
count or promise unlimited credit. No OpenRouter setting removes a gateway
trial allowance; this is an explicit local policy selection.

When admission is suspended or an invitation is required, AUTH recovery first
requires an authenticated existing-session read. The control ledger then checks
the original transcript without reissuing the provider key. Missing or
unavailable sessions do not permit new AUTH. Every forward remains single-attempt;
recovery never authorizes inference replay.

## Retained finite authorities

Finite selections remain supported for deployments that already use them.
They return schema 1 and retain their original reservations, lock and identity.

| Selection | Authority and recovery |
|---|---|
| `{planPath, stateDir, caseId}` | Original campaign and its existing helper |
| `supplemental-v1` | One seven-cap supplement under the original campaign lock; original anchors must remain unchanged |
| `supplemental-detached-v2` | One separate seven-cap authority with a read-only historical snapshot; old recovery stays with the original authority |

Each supplemental reservation consumes 1,000,000 micro-USDC before AUTH
forwarding. Failure, cancellation, low actual charges, settlement and withdrawal
never refund capacity. Uncertain persistence permits no forward even if capacity
was consumed. An exact current-authority retry re-fsyncs retained bytes before
recovery; changed bytes, UUID/hash collisions and unknown grants fail closed.

The original local authority, its 17 reservations and recovery path remain
independent from the detached AWS authority. A detached snapshot transfers zero
capacity and rejects all matching historical UUIDs/AUTH hashes, including exact
old recovery. It is a point-in-time reference, not cross-host deduplication.
Status must not present original and detached balances as a live combined pool.

### Detached V2 configuration

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

This object is the value of `budget`; placeholders are deliberately invalid.
There is no original `planPath` or writable historical ledger path. The snapshot
must be `root:zka-gateway`, mode `0440`, with real root-owned ancestors that are
not group/other writable. `/srv/zka/history` may be `0750`, group `zka-gateway`.
Runtime-owned, writable, world-readable or symlinked snapshots fail validation.
The authority directory and its existing `budget.lock` belong to `zka-gateway`,
with modes `0700` and `0600`. Keep authorization/configuration outside it.

Gateway startup uses `status` and later `reserve`; it never initializes an
authority or exports history. It compares authorization pins to the loaded
profile, manifest, bundle and tariff. Retain the grant UUID, directory and lock
device/inode, immutable marker/index, authorization, reservations and original
snapshot. Missing or partial records are consumed state requiring inspection.

The gateway service needs only its reservation authority writable. Preserve:

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

Validate confinement on the target host. The root-owned history must remain
outside all writable paths. Control, signer, database and challenger retain
their own identities and state.

### Local V1 configuration

`supplemental-v1` uses the same authorization/release digest fields as V2, with
`planPath` instead of `historySnapshotPath` and the original campaign `stateDir`.
It locks the existing parent `budget.lock`, pins the original plan, identity and
state hashes, and freezes the original ledger. Subsequent original changes stop
the supplement. It recognizes exact earlier direct AUTHs and rejects collisions
across original and supplemental rows. A proxy row without an exact AUTH hash
cannot authorize direct AUTH recovery. New availability uses only supplement
slots, never the original remainder.

## Validation, new authorities and restoration

Inspect command options in `scripts/provider_detached_budget.py` or
`scripts/provider_supplemental_budget.py`. Their `validate-authorization` commands
validate private input without initialization. For retained V2:

```sh
python3 scripts/provider_detached_budget.py validate-authorization \
  --state-dir /srv/zka/budget-seven \
  --history-snapshot /srv/zka/history/original-snapshot.json \
  --authorization /srv/zka/config/approved-seven-cap.json \
  --authorization-sha256 APPROVED_SHA256
```

New finite authorities require separately reviewed spending scope and exact
deployment pins. The historical seven-USDC approval is consumed and cannot be
reused. `prepare-proposal` emits an unapproved proposal; a JSON approval boolean
does not establish human consent. `initialize-approved` is a one-time explicit
operation, never startup, maintenance or recovery. One approval must never
initialize both V1 and V2 or two copies of either authority.

Supplemental deployment pins include exact `profile_sha256`, `manifest_sha256`,
`bundle_sha256`, `sdk_sha256`, `native_sha256`, `tariff_sha256`, `mode`, `provider`,
`model`, `cap_micro_usdc`, `session_ttl_seconds` and `max_output_tokens`.
The implemented seven-case contract requires `direct_openrouter`, `openrouter`,
a concrete model, cap `"1000000"`, TTL 60 and output limit 128, with Chat,
streaming and tools advertised in the profile. These are acceptance pins:
AUTH cannot attest the remote binary or inspect direct-provider request bodies.

Local lock, inode and fsync checks do not provide distributed fencing or safe
stale-backup promotion. Keep one selected writer/volume. Restore requires
reconciling consumed reservations and authority identity; never delete markers,
replace locks, clone ledgers or choose a new UUID to regain capacity. See
[same-state maintenance](same-state-restart.md) and
[restoration checks](operations.md).
