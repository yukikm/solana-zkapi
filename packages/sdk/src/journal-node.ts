/** Node-only encrypted journal adapter. Node 24 built-in SQLite provides crash-released process locks;
 * records use fsync + atomic rename + directory fsync. The lock databases contain no client state. */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readFile, rename, unlink, chmod, realpath, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { JournalConflictError, JournalIntegrityError, validateEncryptedRecord } from './journal.ts';
import type { AtomicJournalStore, EncryptedRecord } from './journal.ts';

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
// A suspended callback may retain no externally reachable Promise resolver.
// Keep the native handle rooted until explicit rollback; otherwise V8 can
// finalize the connection while the logical operation is still suspended.
const activeLocks = new Set<DatabaseSync>();
export class NativeJournalStore implements AtomicJournalStore {
  private readonly directory: string;
  private readonly lockTimeoutMs: number;
  private constructor(directory: string, lockTimeoutMs: number) { this.directory = directory; this.lockTimeoutMs = lockTimeoutMs; }
  static async open(directory: string, options: { lockTimeoutMs?: number } = {}): Promise<NativeJournalStore> {
    const absolute = resolve(directory), timeout = options.lockTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new Error('invalid journal lock timeout');
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('journal directory must be a private real directory');
    await chmod(absolute, 0o700);
    return new NativeJournalStore(await realpath(absolute), timeout);
  }
  private path(key: string): string { return join(this.directory, `${digest(key)}.json`); }
  async read(key: string): Promise<EncryptedRecord | null> {
    try { const record: unknown = JSON.parse(await readFile(this.path(key), 'utf8')); validateEncryptedRecord(record); return record; }
    catch (error) { if (missing(error)) return null; throw new JournalIntegrityError(); }
  }
  async compareAndSwap(key: string, expectedRevision: number | null, next: EncryptedRecord): Promise<void> {
    validateEncryptedRecord(next);
    const snapshot = structuredClone(next);
    await this.withLock(`storage:${key}`, async () => {
      const previous = await this.read(key);
      if ((previous?.revision ?? null) !== expectedRevision || expectedRevision !== null && snapshot.revision !== expectedRevision + 1) throw new JournalConflictError();
      const target = this.path(key), temporary = `${target}.${randomUUID()}.tmp`;
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(snapshot), 'utf8');
        await file.sync();
      } finally { await file.close(); }
      try {
        await rename(temporary, target);
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
    });
  }
  async withLock<R>(key: string, action: () => Promise<R>): Promise<R> {
    const path = join(this.directory, `${digest(`lock:${key}`)}.sqlite`);
    // SQLite is solely an OS-owned lock, so a terminated owner cannot leave a lease that allows
    // overlapping writers or requires guessing whether an old PID will resume.
    const database = new DatabaseSync(path);
    activeLocks.add(database);
    let locked = false;
    try {
      await chmod(path, 0o600);
      database.exec('PRAGMA busy_timeout = 0');
      const deadline = Date.now() + this.lockTimeoutMs;
      for (;;) {
        try { database.exec('BEGIN EXCLUSIVE'); locked = true; break; }
        catch (error) {
          if ((error as { errcode?: number }).errcode !== 5 && (error as { errcode?: number }).errcode !== 6) throw error;
          if (Date.now() >= deadline) throw new Error('journal locked by another process; operation was not started');
          await delay(10);
        }
      }
      return await action();
    } finally {
      try { if (locked) database.exec('ROLLBACK'); }
      finally { try { database.close(); } finally { activeLocks.delete(database); } }
    }
  }
}
