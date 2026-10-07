/** Durable encrypted storage for the shared client state machine. No network or accounting decisions live here. */
export interface EncryptedRecord { schema: 1; revision: number; ivHex: string; ciphertextHex: string }
export interface JournalHead { revision: number; digest: string }
export interface JournalRecord<T> { revision: number; value: T; head: JournalHead }
export type JournalValidator<T> = ((value: unknown) => asserts value is T) | ((value: unknown) => Promise<void>);
export interface AtomicJournalStore {
  read(key: string): Promise<EncryptedRecord | null>;
  /** Must atomically check the old revision and durably commit before resolving. No upsert on conflict. */
  compareAndSwap(key: string, expectedRevision: number | null, next: EncryptedRecord): Promise<void>;
  /** Cross-tab/process exclusive operation lock, separate from the short storage CAS lock. */
  withLock<R>(key: string, action: () => Promise<R>): Promise<R>;
}
export class JournalConflictError extends Error { constructor() { super('journal revision conflict; reconcile before continuing'); this.name = 'JournalConflictError'; } }
export class JournalIntegrityError extends Error { constructor(message = 'journal integrity failure; reconcile before continuing') { super(message); this.name = 'JournalIntegrityError'; } }

const encoder = new TextEncoder();
function hex(bytes: Uint8Array): string { return Array.from(bytes, v => v.toString(16).padStart(2, '0')).join(''); }
function bytes(value: unknown, size?: number): Uint8Array {
  if (typeof value !== 'string' || value.length % 2 || !/^[0-9a-f]*$/.test(value) || size !== undefined && value.length !== size * 2) throw new JournalIntegrityError();
  return Uint8Array.from(value.match(/../g) ?? [], v => parseInt(v, 16));
}
function identifier(value: string): void { if (typeof value !== 'string' || !value.length || value.length > 1024) throw new JournalIntegrityError('invalid journal context'); }
export function validateEncryptedRecord(value: unknown): asserts value is EncryptedRecord {
  const v = value as EncryptedRecord;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== 'ciphertextHex,ivHex,revision,schema' || v.schema !== 1 || !Number.isSafeInteger(v.revision) || v.revision < 1) throw new JournalIntegrityError();
  bytes(v.ivHex, 12);
  if (bytes(v.ciphertextHex).length < 16) throw new JournalIntegrityError();
}
async function head(record: EncryptedRecord): Promise<JournalHead> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([record.schema, record.revision, record.ivHex, record.ciphertextHex])))));
  return { revision: record.revision, digest };
}
function checkHead(actual: JournalHead, minimum: JournalHead): void {
  if (!Number.isSafeInteger(minimum.revision) || minimum.revision < 1 || !/^[0-9a-f]{64}$/.test(minimum.digest) || actual.revision < minimum.revision || actual.revision === minimum.revision && actual.digest !== minimum.digest) throw new JournalIntegrityError('stale or divergent journal; reconcile before continuing');
}
export async function importJournalKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('journal key must contain 32 random bytes');
  return crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Context is authenticated, encrypted records never contain public note identifiers or raw secrets.
 * The application owns the one-unresolved-authorization state machine in T and its validator.
 * Keep a trusted head outside a restored backup, or reconcile against the authoritative chain/control
 * state before allowing a fresh-device restore. Encryption alone cannot detect whole-device rollback.
 */
export class EncryptedJournal<T extends object> {
  private readonly seen = new Map<string, JournalHead>();
  private readonly context: Readonly<{ deploymentId: string; pool: string }>;
  private readonly store: AtomicJournalStore;
  private readonly key: CryptoKey;
  private readonly validate: JournalValidator<T>;
  constructor(store: AtomicJournalStore, key: CryptoKey,
    context: { deploymentId: string; pool: string }, validate: JournalValidator<T>) {
    identifier(context.deploymentId); identifier(context.pool);
    if (key.type !== 'secret' || key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256 || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) throw new Error('expected AES-256-GCM journal key');
    this.context = Object.freeze({ ...context });
    this.store = store; this.key = key; this.validate = validate;
  }
  private async storageKey(noteId: string): Promise<string> {
    identifier(noteId);
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(['zkapi-client-journal-v1', this.context.deploymentId, this.context.pool, noteId])))));
  }
  private aad(noteId: string, revision: number): Uint8Array<ArrayBuffer> {
    return encoder.encode(JSON.stringify(['zkapi-client-journal-v1', this.context.deploymentId, this.context.pool, noteId, revision]));
  }
  private remember(key: string, current: JournalHead): void {
    const previous = this.seen.get(key);
    if (!previous || current.revision > previous.revision) this.seen.set(key, { ...current });
    else if (current.revision === previous.revision && current.digest !== previous.digest) throw new JournalIntegrityError('divergent journal');
  }
  private async decode(noteId: string, record: EncryptedRecord): Promise<JournalRecord<T>> {
    validateEncryptedRecord(record);
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(bytes(record.ivHex)), additionalData: this.aad(noteId, record.revision), tagLength: 128 }, this.key, new Uint8Array(bytes(record.ciphertextHex)));
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
      await this.validate(value);
      return { revision: record.revision, value: value as T, head: await head(record) };
    } catch { throw new JournalIntegrityError(); }
  }
  async read(noteId: string, minimumHead?: JournalHead): Promise<JournalRecord<T> | null> {
    minimumHead = minimumHead && { ...minimumHead };
    const key = await this.storageKey(noteId), record = await this.store.read(key);
    const previous = this.seen.get(key);
    if (!record) {
      if (previous || minimumHead) throw new JournalIntegrityError('journal disappeared; reconcile before continuing');
      return null;
    }
    const result = await this.decode(noteId, record);
    if (previous) checkHead(result.head, previous);
    if (minimumHead) checkHead(result.head, minimumHead);
    // A concurrent read/commit may have finished while decryption was pending.
    const latest = this.seen.get(key); if (latest) checkHead(result.head, latest);
    this.remember(key, result.head);
    return result;
  }
  async create(noteId: string, value: T): Promise<JournalRecord<T>> { return this.commit(noteId, null, value); }
  async compareAndSwap(noteId: string, expectedRevision: number, value: T): Promise<JournalRecord<T>> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new JournalConflictError();
    return this.commit(noteId, expectedRevision, value);
  }
  private async commit(noteId: string, previous: number | null, value: T): Promise<JournalRecord<T>> {
    // Snapshot before awaits: a UI retaining the input object cannot replace saved bytes mid-commit.
    const plaintext = JSON.stringify(value), snapshot: unknown = JSON.parse(plaintext);
    await this.validate(snapshot);
    const revision = (previous ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new JournalConflictError();
    const key = await this.storageKey(noteId);
    const known = this.seen.get(key);
    if (known && (previous === null || previous < known.revision)) throw new JournalConflictError();
    // Never overwrite ciphertext that has not passed authentication and application validation.
    const existing = await this.read(noteId);
    if ((existing?.revision ?? null) !== previous) throw new JournalConflictError();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(noteId, revision), tagLength: 128 }, this.key, encoder.encode(plaintext));
    const record: EncryptedRecord = { schema: 1, revision, ivHex: hex(iv), ciphertextHex: hex(new Uint8Array(encrypted)) };
    await this.store.compareAndSwap(key, previous, record);
    const current = await head(record);
    this.remember(key, current);
    return { revision, value: snapshot as T, head: current };
  }
  async withNoteLock<R>(noteId: string, action: () => Promise<R>): Promise<R> { return this.store.withLock(await this.storageKey(noteId), action); }
  async exportBackup(noteId: string): Promise<{ backup: string; head: JournalHead }> {
    const key = await this.storageKey(noteId), record = await this.store.read(key);
    if (!record) throw new JournalIntegrityError('cannot back up missing journal');
    const result = await this.decode(noteId, record);
    const previous = this.seen.get(key); if (previous) checkHead(result.head, previous);
    this.remember(key, result.head);
    return { backup: JSON.stringify(record), head: result.head };
  }
  /** trustedHead must come from an independent checkpoint or a completed recovery reconciliation,
   * never from the untrusted backup itself. Existing newer records are never overwritten. */
  async restoreBackup(noteId: string, backup: string, trustedHead: JournalHead): Promise<JournalRecord<T>> {
    trustedHead = { ...trustedHead };
    let record: EncryptedRecord;
    try { record = JSON.parse(backup); validateEncryptedRecord(record); } catch { throw new JournalIntegrityError('invalid encrypted backup'); }
    const restored = await this.decode(noteId, record);
    checkHead(restored.head, trustedHead);
    if (restored.head.revision !== trustedHead.revision || restored.head.digest !== trustedHead.digest) throw new JournalIntegrityError('backup does not match trusted recovery checkpoint');
    const current = await this.read(noteId);
    if (current) {
      if (current.head.revision !== restored.head.revision || current.head.digest !== restored.head.digest) throw new JournalIntegrityError('backup differs from current journal; reconcile before continuing');
      return current;
    }
    const key = await this.storageKey(noteId);
    await this.store.compareAndSwap(key, null, record);
    this.remember(key, restored.head);
    return restored;
  }
}

export interface TransportJournalState<T> { schema: 1; attempts: T[] }
/** I04 Journal.save adapter; keeps every signed attempt so unknown sends survive process restarts.
 * Use the application's note operation lock around proof/sign/send/recovery. This adapter only
 * persists transport records and never infers transaction finality or advances secret note state. */
export class EncryptedTransportJournal<T extends { schema: 1; signature: string; wireHex: string }> {
  private readonly journal: EncryptedJournal<TransportJournalState<T>>;
  private readonly id: string;
  constructor(store: AtomicJournalStore, key: CryptoKey, context: { deploymentId: string; pool: string }, noteId: string, operationId: string) {
    identifier(noteId); identifier(operationId);
    this.id = JSON.stringify(['transport', noteId, operationId]);
    this.journal = new EncryptedJournal(store, key, context, (value: unknown): asserts value is TransportJournalState<T> => {
      const state = value as TransportJournalState<T>;
      if (!state || state.schema !== 1 || !Array.isArray(state.attempts)) throw new JournalIntegrityError();
      const signatures = new Set<string>();
      for (const attempt of state.attempts) {
        if (!attempt || attempt.schema !== 1 || typeof attempt.signature !== 'string' || !attempt.signature.length || typeof attempt.wireHex !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(attempt.wireHex) || signatures.has(attempt.signature)) throw new JournalIntegrityError();
        signatures.add(attempt.signature);
      }
    });
  }
  async save(attempt: T): Promise<void> {
    const snapshot: T = JSON.parse(JSON.stringify(attempt));
    await this.journal.withNoteLock(this.id, async () => {
      const current = await this.journal.read(this.id);
      const duplicate = current?.value.attempts.find(saved => saved.signature === snapshot.signature);
      if (duplicate) {
        if (JSON.stringify(duplicate) !== JSON.stringify(snapshot)) throw new JournalIntegrityError('signed attempt changed');
        return;
      }
      const value: TransportJournalState<T> = { schema: 1, attempts: [...(current?.value.attempts ?? []), snapshot] };
      if (current) await this.journal.compareAndSwap(this.id, current.revision, value);
      else await this.journal.create(this.id, value);
    });
  }
  async read(): Promise<T[]> { return (await this.journal.read(this.id))?.value.attempts ?? []; }
}

/** IndexedDB commits the revision and ciphertext in one strict-durability transaction.
 * Web Locks serialize complete note operations across tabs; unsupported browsers fail closed.
 */
export class IndexedDbJournalStore implements AtomicJournalStore {
  private readonly database: IDBDatabase;
  private readonly locks: LockManager;
  private readonly lockScope: string;
  private constructor(database: IDBDatabase, locks: LockManager, lockScope: string) { this.database = database; this.locks = locks; this.lockScope = lockScope; }
  static async open(name: string, factory: IDBFactory = indexedDB, locks: LockManager = navigator.locks): Promise<IndexedDbJournalStore> {
    identifier(name);
    if (!factory || !locks?.request) throw new Error('IndexedDB and Web Locks are required for durable journal storage');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('journal database upgrade blocked'));
    });
    database.onversionchange = () => database.close();
    return new IndexedDbJournalStore(database, locks, name);
  }
  close(): void { this.database.close(); }
  /** Custody initialization must never replace the missing key of existing ciphertext. */
  async isEmpty(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const tx = this.database.transaction('records'), request = tx.objectStore('records').count();
      tx.oncomplete = () => resolve(request.result === 0);
      tx.onabort = tx.onerror = () => reject(new JournalIntegrityError('cannot inspect existing journal'));
    });
  }
  async read(key: string): Promise<EncryptedRecord | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.database.transaction('records', 'readonly'), request = transaction.objectStore('records').get(key);
      let result: EncryptedRecord | null = null;
      request.onsuccess = () => { result = request.result ?? null; };
      transaction.oncomplete = () => { try { if (result) validateEncryptedRecord(result); resolve(result); } catch (error) { reject(error); } };
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new JournalIntegrityError());
    });
  }
  async compareAndSwap(key: string, expectedRevision: number | null, next: EncryptedRecord): Promise<void> {
    validateEncryptedRecord(next);
    const snapshot = structuredClone(next);
    await new Promise<void>((resolve, reject) => {
      const transaction = this.database.transaction('records', 'readwrite', { durability: 'strict' }), store = transaction.objectStore('records'), request = store.get(key);
      let failure: unknown;
      request.onsuccess = () => {
        try {
          const previous = request.result;
          if (previous !== undefined) validateEncryptedRecord(previous);
          if ((previous?.revision ?? null) !== expectedRevision || expectedRevision !== null && snapshot.revision !== expectedRevision + 1) throw new JournalConflictError();
          store.put(snapshot, key);
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(failure ?? transaction.error ?? new JournalIntegrityError());
    });
  }
  async withLock<R>(key: string, action: () => Promise<R>): Promise<R> {
    return this.locks.request(`zkapi-journal:${this.lockScope}:${key}`, { mode: 'exclusive' }, action);
  }
}
