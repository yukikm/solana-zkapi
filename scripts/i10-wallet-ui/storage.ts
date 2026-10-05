/** Browser custody only: a nonextractable AES key is structured-cloned by IDB.
 * This is persistence in one Chrome profile, not a backup or OS keychain. */
export async function journalKey(name: string): Promise<CryptoKey> {
  if (!navigator.locks || !indexedDB) throw Error('IndexedDB and Web Locks are required');
  return navigator.locks.request('zkapi-i10-ui-key:' + name, async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('zkapi-i10-ui-custody', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('custody unavailable'));
    });
    try {
      const existing = await new Promise<unknown>((resolve, reject) => {
        const request = database.transaction('keys').objectStore('keys').get(name);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(Error('custody unavailable'));
      });
      if (existing !== undefined) {
        if (!(existing instanceof CryptoKey) || existing.extractable || existing.type !== 'secret'
          || existing.algorithm.name !== 'AES-GCM' || (existing.algorithm as AesKeyAlgorithm).length !== 256) throw Error('invalid stored custody; no reset allowed');
        return existing;
      }
      const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('keys', 'readwrite'); tx.objectStore('keys').add(key, name);
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(Error('custody commit failed')); tx.onabort = () => reject(Error('custody commit failed'));
      });
      return key;
    } finally { database.close(); }
  });
}
