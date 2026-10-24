# Recoverable custody

SDK `0.2.0-devnet.18` adds a shared, client-encrypted recovery store for browser
and Node.js integrations. This is an explicit opt-in custody change. Existing
local journals, keys, deployment bindings and retired runtimes are not replaced
by installing the release. The existing payment state machine is unchanged.

## What is saved

The service is the authoritative, durable journal store. Every encrypted journal
revision is acknowledged by the service before the SDK proceeds with an external
effect. There is no asynchronous upload queue or local-only fallback. A failed
write blocks the operation; an uncertain acknowledgement is resolved by checking
the exact encrypted record. This preserves note witnesses, changing private
balances, pending AUTH credentials, exact request bytes, signed transactions and
recovery history. Application deposit catalogs must use the same store too.

A recovery kit contains a version, independently selected service endpoint,
random vault identifier, 256-bit random recovery secret, and deployment/Pool/wallet
binding. HKDF-SHA-256 derives separate AES-256-GCM journal and service-authentication
keys. The recovery secret and decryption key never go to the service. The service
retains only hashed credentials and opaque encrypted records. Record encryption
continues to use the existing deployment/Pool/local-ID/revision authenticated
context. The kit grants access to sensitive payment information: keep it private,
outside the device data being protected. Do not put it in URLs, logs, source
control, environment variables or analytics. The kit is not a wallet seed.

The recovery kit is a key to a continually updated external backup, not a static
copy of a balance. A downloaded ciphertext snapshot alone does not prove freshness.
Losing both the kit and device access is not recoverable. Adding this feature
cannot reconstruct secrets that were already deleted. It also cannot restore a
retired control service or extend a note's expiry.

## Shared API

```ts
import {
  createRecoveryKit, createRecoveryStorage, openRecoveryStorage,
  restoreRecoveryStorage, serializeRecoveryKit, parseRecoveryKit,
} from '@zkapi/solana-sdk/recovery';

const kit = createRecoveryKit({
  endpoint: independentlySelectedRecoveryEndpoint,
  context: { deploymentId, pool, wallet: wallet.publicKey },
});
// Save serializeRecoveryKit(kit) OUTSIDE the origin/device directory and confirm
// the user can retrieve it before enabling deposits on this storage.
const storage = await createRecoveryStorage(kit);
const client = await createZkApiClient({ ...configuration, storage });
```

`RecoveryStorage` supplies the normal `store` and nonextractable `key` plus a
binding checked against the selected wallet and authenticated deployment. It
also returns a device `session` and `close()`. Closing does not delete the backup.
Do not mutate or log a session. The returned session contains a device credential
and, before browser persistence, encryption-key material.

Browser factories accept `storage` as a caller-owned option. They still validate
the independently installed WASM and deployment, and dispose their own prover;
the caller owns the supplied storage's lifetime. Omitting `storage` preserves the
original local-only custody behavior. The factory's browser-persistence result
does not describe external backup protection.

```ts
import { saveRecoverySession, loadRecoverySession } from '@zkapi/solana-sdk/recovery-browser';
const name = JSON.stringify([applicationName, deploymentId, pool, wallet.publicKey]);
await saveRecoverySession(name, storage.session);
// Later: the browser retains only a nonextractable CryptoKey and device binding.
const binding = await loadRecoverySession(name);
if (binding) {
  const reopened = await openRecoveryStorage(binding.session, { key: binding.key });
  const browser = await createBrowserClient({ ...browserConfiguration, storage: reopened });
}
```

Node.js uses `saveRecoverySessionFile` / `loadRecoverySessionFile` and
`writeRecoveryKitFile` / `readRecoveryKitFile` from `./recovery-node`. They require
private, owned directories (0700) and files (0600); commits are atomic and fsynced.
The kit's directory must be separate from the disposable device-state directory.
No browser, passkey or interactive wallet-message API is required by recovery.
Node session files contain key material; protect the host and its filesystem.

Initial creation durably saves an encrypted key-check record before returning
usable storage. Opening or restoring must decrypt this record, including for an
empty vault, so a corrupt local encryption key cannot fund a new, unrecoverable
note. A missing or corrupt check is never silently repaired. If initial setup
fails before its first check is committed, that incomplete vault has never been
usable for funding; create and independently save a new recovery kit instead.

## Restore after device-data loss

1. Stop the original application and its other tabs/processes. This release
   supports one active device, not concurrent use on multiple devices.
2. Read and validate the independently retained kit. Confirm its endpoint,
   deployment and wallet against the application's installed configuration.
3. Call `restoreRecoveryStorage(kit, { previousOwnerStopped: true, expectedEndpoint })` explicitly.
   The required `expectedEndpoint` must come from independently installed configuration, never from the imported file. This rotates the device credential, invalidates old reads/writes and clears
   the old operation locks. It does not authorize a payment or imply settlement.
4. Save the new device session, open the existing encrypted catalog and original
   note IDs, and create the normal SDK client with this storage.
5. Inspect normal SDK status. Pending authorization, transaction, withdrawal and
   settlement gates remain in force. Use the existing explicit recovery actions;
   never replay uncertain inference or replace an unresolved note.

An existing device binding can change owner only with the explicit
`replaceOwner: true` persistence option, and only for the same vault/key/context.
Different bindings are never silently overwritten.

There are no expiring distributed operation locks. A crashed or disconnected
owner may leave a lock; reopening does not steal it. Stop that client, then use
the explicit restore flow. Rotating a token cannot cancel a request already sent
to a provider. Such requests remain in the journal and must finish existing
reconciliation. Never use takeover as an online device-switching shortcut.

## Enroll existing local data

Keep the original key and journal. Stop other old SDK tabs/processes, dispose the
owned client when idle, and hold the application's original operation lock across
the entire migration. For every local ID in the authenticated catalog, construct
the normal `EncryptedJournal` with its original validator and call
`journal.copyTo(id, recoveryStorage)`. Copy the catalog too. This authenticates and
re-encrypts the complete record while retaining its exact revision and financial
state; a conflicting destination fails. A matching retry is idempotent. A local ID
with no record returns `null` and does not create a financial note.

Verify all destination records before saving the new device binding and selecting
the new storage. Only then enable operations. Preserve the original local bytes
as historical recovery material; do not fall back to them after enrollment.
Older SDK processes cannot observe the new binding, which is why stopping them is
a prerequisite. An interrupted enrollment leaves the original intact. A recovery
kit exported before enrollment completed must not be advertised as a completed
backup; finish enrollment from the original data before resuming use.

## Service and trust boundary

The included Node service is described in `services/recovery/README.md`. The
selected service is trusted for availability, durable acknowledgement, monotonic
revisions and single-owner enforcement. Encryption prevents it reading financial
secrets, but does not hide network metadata, record sizes or update timing. It
cannot prevent a malicious service rolling back all records after device loss.
Do not describe this feature as trustless storage or end-to-end anonymity.

The first release covers browser-origin loss and Node device-directory loss while
the external service and kit remain available. Operator disk/host disaster
recovery, service-independent offline exit and multi-device concurrency require
separate deployment guarantees. Do not serve a stale filesystem snapshot as the
latest vault after a service failure. SDK/runtime compatibility and the existing
deployment services are still required to use or withdraw recovered notes.
