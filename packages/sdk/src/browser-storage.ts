import { IndexedDbJournalStore } from './journal.ts';

export class BrowserStorageMissing extends Error {
  constructor() { super('No browser wallet storage. Initialize explicitly only for a new wallet.'); this.name = 'BrowserStorageMissing'; }
}
/** Same-origin browser custody. This is not a portable backup or OS keychain.
 * Missing keys never cause automatic initialization or a reset of ciphertext. */
export async function openBrowserStorage(name: string, options: { initialize?: boolean } = {}) {
  if (!name || name.length > 512 || !globalThis.indexedDB || !globalThis.navigator?.locks) throw new Error('Named storage, IndexedDB and Web Locks required');
  return navigator.locks.request('zkapi-browser-custody:' + name, async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('zkapi-browser-custody-v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('keys');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('Browser custody unavailable'));
      r.onblocked = () => reject(new Error('Browser custody upgrade blocked'));
    });
    let store: IndexedDbJournalStore | undefined;
    try {
      let key = await new Promise<unknown>((resolve, reject) => {
        const tx = db.transaction('keys'), r = tx.objectStore('keys').get(name);
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('Browser custody unavailable'));
      });
      if (key === undefined && !options.initialize) throw new BrowserStorageMissing();
      store = await IndexedDbJournalStore.open(name);
      if (key === undefined) {
        if (!await store.isEmpty()) throw new Error('Journal exists without its key; restore custody, never reset');
        key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('keys', 'readwrite', { durability: 'strict' }); tx.objectStore('keys').add(key, name);
          tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(new Error('Browser custody commit failed'));
        });
      }
      if (!(key instanceof CryptoKey) || key.extractable || key.type !== 'secret' || key.algorithm.name !== 'AES-GCM'
        || (key.algorithm as AesKeyAlgorithm).length !== 256 || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) throw new Error('Invalid stored custody; no reset allowed');
      const opened = store;
      return { store: opened, key, close: () => opened.close() };
    } catch (error) { store?.close(); throw error; }
    finally { db.close(); }
  });
}
