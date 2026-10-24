/** Browser binding for the common recovery store. The recovery kit is never
 * persisted here: keep it outside this origin so deleting site data is recoverable. */
import { importJournalKey } from './journal.ts';
import { validateRecoverySession, type RecoverySession } from './recovery.ts';

const databaseName = 'zkapi-recovery-bindings-v1';
interface BrowserBinding { session: RecoverySession; key: CryptoKey }

function requireName(name: string): void {
  if (!name || name.length > 512 || !globalThis.indexedDB || !globalThis.navigator?.locks) {
    throw new Error('Named recovery storage, IndexedDB and Web Locks required');
  }
}
function requireKey(key: unknown): asserts key is CryptoKey {
  if (!(key instanceof CryptoKey) || key.type !== 'secret' || key.extractable || key.algorithm.name !== 'AES-GCM'
    || (key.algorithm as AesKeyAlgorithm).length !== 256 || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) {
    throw new Error('Invalid browser recovery key; no reset allowed');
  }
}
function sameIdentity(a: RecoverySession, b: RecoverySession): boolean {
  return a.endpoint === b.endpoint && a.vaultId === b.vaultId && a.context.deploymentId === b.context.deploymentId
    && a.context.pool === b.context.pool && a.context.wallet === b.context.wallet;
}
function validateBinding(value: unknown): asserts value is BrowserBinding {
  if (!value || typeof value !== 'object' || !('session' in value) || !('key' in value)) throw new Error('Invalid browser recovery binding; no reset allowed');
  validateRecoverySession(value.session, { externalKey: true });
  if (value.session.keyHex !== undefined) throw new Error('Invalid browser recovery binding; raw key must not be persisted');
  requireKey(value.key);
}
async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Browser recovery binding unavailable'));
    request.onblocked = () => reject(new Error('Browser recovery binding upgrade blocked'));
  });
}
async function readBinding(db: IDBDatabase, name: string): Promise<BrowserBinding | null> {
  const value = await new Promise<unknown>((resolve, reject) => {
    const transaction = db.transaction('sessions');
    const request = transaction.objectStore('sessions').get(name);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(new Error('Browser recovery binding unavailable'));
  });
  if (value === undefined) return null;
  validateBinding(value);
  return value;
}
async function sameKey(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = crypto.getRandomValues(new Uint8Array(32));
  const additionalData = new TextEncoder().encode('zkapi-recovery-binding-key-check-v1');
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, a, plaintext);
    const decoded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, b, ciphertext));
    return decoded.length === plaintext.length && decoded.every((byte, index) => byte === plaintext[index]);
  } catch { return false; }
}

/** Saves only the device session, with a nonextractable AES key. It cannot
 * replace a different vault, deployment, wallet or encryption key. Replacing
 * a fenced owner after explicit restore requires replaceOwner: true.
 * Scope name as JSON.stringify([application, deploymentId, pool, wallet]). */
export async function saveRecoverySession(name: string, session: RecoverySession, options: { key?: CryptoKey; replaceOwner?: boolean } = {}): Promise<void> {
  requireName(name);
  const snapshot = structuredClone(session);
  validateRecoverySession(snapshot, { externalKey: options.key !== undefined });
  const key = options.key ?? await importJournalKey(Uint8Array.from(snapshot.keyHex!.match(/../g)!, byte => Number.parseInt(byte, 16)));
  requireKey(key);
  delete snapshot.keyHex;
  await navigator.locks.request('zkapi-recovery-binding:' + name, async () => {
    const db = await openDatabase();
    try {
      const previous = await readBinding(db, name);
      if (previous) {
        if (!sameIdentity(previous.session, snapshot) || !await sameKey(previous.key, key)) throw new Error('Recovery binding already exists for different custody; no replacement allowed');
        if (previous.session.ownerToken !== snapshot.ownerToken && !options.replaceOwner) throw new Error('Recovery owner changed; explicit restore is required');
        if (previous.session.ownerToken === snapshot.ownerToken) return;
      }
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('sessions', 'readwrite', { durability: 'strict' });
        transaction.objectStore('sessions').put({ session: snapshot, key }, name);
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(new Error('Browser recovery binding commit failed'));
      });
    } finally { db.close(); }
  });
}

/** Reopens a device session without creating or replacing custody. Pass the
 * returned key to openRecoveryStorage(session, { key }). Missing site data
 * returns null; recovery then requires the separately saved recovery kit. */
export async function loadRecoverySession(name: string): Promise<BrowserBinding | null> {
  requireName(name);
  return navigator.locks.request('zkapi-recovery-binding:' + name, async () => {
    const db = await openDatabase();
    try { return await readBinding(db, name); }
    finally { db.close(); }
  });
}
