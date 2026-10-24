# Encrypted client recovery service

This Node 24 service stores encrypted SDK journals independently of the client
device. It does not have the encryption key, inspect financial state, call the
control service or provider, sign, send, replay, or settle transactions.
The shared SDK owns encryption and the existing payment state machine.
The intended public endpoint is
`https://d366buuvadnp3.cloudfront.net/recovery/v1`; deployment must be verified
before advertising it as available.

The server retains opaque vault and record identifiers, encrypted records,
hashed authentication credentials, and durable operation locks. It can observe
traffic, record sizes and updates. Its latest stored state is trusted for
availability and freshness: end-to-end encryption does not prove that a server
has not rolled back all its storage. Do not restore the server from an older
snapshot and resume admission. Preserve the newest state and investigate first.

## API

Every identifier, context digest and token is 32 bytes encoded as 64 lowercase
hex characters. `Authorization: Bearer TOKEN` carries the separate recovery
authentication token for create/takeover and the current device owner token for
all other routes. The recovery authentication token must not be the encryption
key. Creation refuses an owner token equal to the recovery authentication token.
The SDK supplies an independent random owner token for each takeover.

All paths below follow `/recovery/v1`. Bodies and responses use JSON.

| Method and path | Body | Successful response |
|---|---|---|
| `POST /vaults/{id}` | `{ownerToken, context}` | `201 {context, epoch:1}`; exact retry `200` |
| `POST /vaults/{id}/takeover` | `{ownerToken, previousOwnerStopped:true}` | `200 {context, epoch}` |
| `GET /vaults/{id}` | None | `200 {context, epoch}` |
| `GET /vaults/{id}/records/{key}` | None | `200 {record: EncryptedRecord \| null}` |
| `PUT /vaults/{id}/records/{key}` | `{expectedRevision: number \| null, record: EncryptedRecord}` | `200 {ok:true}` |
| `POST /vaults/{id}/locks/{key}` | `{token}` | `200 {ok:true}` |
| `DELETE /vaults/{id}/locks/{key}` | `{token}` | `200 {ok:true}` |

`EncryptedRecord` is the existing SDK schema: exactly `schema:1`, positive safe
integer `revision`, 12-byte lowercase `ivHex`, and lowercase `ciphertextHex`
including its authentication tag. First import (`expectedRevision:null`) can
retain a prior journal's revision. Subsequent writes require the current revision
and exactly its successor. Exact record retries succeed; changed bytes at the
same revision, stale writes and missing expected records fail with `409`.

Locks persist without a timeout across server/client restarts. The same lock
token can repeat acquire/release after an uncertain response. Another token
cannot acquire or release an occupied lock. A takeover rotates the device token,
increments the epoch and clears locks atomically; all later old-owner requests
fail. Repeating the same takeover token is idempotent and does not clear locks
acquired since its first success. Retired owner hashes are retained, so a delayed
retry cannot reactivate a previous owner after a newer takeover. After 4096
rotations the service refuses further takeovers; never clear this history to
bypass the limit. A storage epoch cannot stop an already-running
wallet or provider call. The previous device must really be stopped before the
user explicitly takes over; the boolean is an acknowledgement, not independent
proof of that condition. There is no automatic TTL or takeover.

Errors contain only a fixed `{error:code}`: invalid shape `400`, unauthorized
`401`, rejected origin `403`, unknown path/vault `404`, method `405`, conflict
`409`, request size `413`, body encoding `415`, unavailable storage `503`, or
capacity `507`. No errors expose request bodies, file paths or tokens. There are
no request logs, cookies, redirects or cacheable responses. Node requests omit
Origin; browser requests must match the exact configured HTTPS origin. OPTIONS
allows only Authorization and Content-Type. `/health` reports process readiness,
not proof of future successful durable writes or disaster recovery.

## Durability and limits

Each vault is a private `0600` JSON file in a `0700` directory. A SQLite exclusive
transaction serializes every state check and mutation across processes. SQLite
holds only an operating-system lock; it is not a second financial database.
Writes use an exclusive temporary file, file fsync, atomic rename, and directory
fsync before acknowledgement. Reads also fsync the opened vault and its parent
directory before returning. If a prior rename was visible but its fsync failed,
neither a read nor an exact retry can acknowledge durability until both barriers
succeed. Process death releases the SQLite lock. Startup
never replaces vaults, clears client operation locks or removes staging files.
Invalid/corrupt files and symlinks fail closed. Keep orphaned staging files for
inspection rather than interpreting them as committed state.

Requests are bounded to 4 MiB, vaults to 64 MiB, and each vault to 4096 records
and locks. Defaults allow 1024 vaults and 1 GiB of total committed vault data;
capacity failure preserves existing data. The dedicated volume must have space
for temporary writes as well as these committed records. The proxy must apply
request-rate limits. This is Devnet preview capacity, not an unlimited public
storage service. Host administrators can still deny service or roll back files.

The acknowledgement durability boundary is the mounted persistent EBS volume.
Restoring after browser IndexedDB or Node local-directory deletion is supported
while this service retains its latest records. EBS/region loss, older server
snapshots and service retirement require a separate operational recovery design.
An optional archival copy is not a reason to acknowledge before local fsync or
to accept stale records later. Client recovery-code loss is also separate from
device-data loss.

## Run and test

There are no third-party runtime dependencies. Use pinned Node 24.22.1.

```sh
node --test services/recovery/recovery.test.mjs
node services/recovery/server.mjs /absolute/path/recovery.json
```

The exported `startRecoveryServer` supports a port-zero HTTP test fixture only
when `localTestOnly:true`. The production CLI refuses that flag and always binds
loopback, behind the existing HTTPS proxy. See the
[deployment procedure](../../deploy/recovery/README.md).

Tests use disposable directories and synthetic encrypted-record bytes. They
verify HTTP authentication, immutable bindings, CAS races, takeover fencing,
persisted locks, restart, process death during the SQLite transaction after the
durable rename, orphan staging, cross-process CAS, quota and corruption refusal,
bounded bodies and CORS. SDK browser/Node tests separately exercise actual
encryption and local-data deletion through this service.
