/** Portable, client-encrypted custody. The independently selected service is
 * authoritative for availability and freshness; it never receives decryption
 * keys. Every journal write is durable there before a financial effect proceeds.
 * One active device only. Recovery requires stopping the previous device first. */
import { importJournalKey, validateEncryptedRecord, JournalConflictError, type AtomicJournalStore, type EncryptedRecord } from './journal.ts';

export interface RecoveryContext { deploymentId: string; pool: string; wallet: string }
export interface RecoveryKit { schema: 1; endpoint: string; vaultId: string; secret: string; context: RecoveryContext }
export interface RecoverySession { schema: 1; endpoint: string; vaultId: string; context: RecoveryContext; ownerToken: string; keyHex?: string }
export interface RecoveryOptions { fetch?: typeof globalThis.fetch; key?: CryptoKey; expectedEndpoint?: string }
export class RecoveryStorageError extends Error {
  readonly code: 'unavailable' | 'ownership_changed' | 'locked' | 'invalid';
  constructor(code: RecoveryStorageError['code']) {
    super(({ unavailable: 'The encrypted backup could not be saved or checked. Reconnect before continuing.', ownership_changed: 'This deposit backup was opened elsewhere. Close this client and use the restored device.', locked: 'A saved operation is still locked. Stop the previous client before explicitly restoring its backup.', invalid: 'The recovery file or backup does not match this installation.' })[code]);
    this.name = 'RecoveryStorageError'; this.code = code;
  }
}
const encoder = new TextEncoder();
const hex = (v: Uint8Array) => Array.from(v, b => b.toString(16).padStart(2, '0')).join('');
const raw = (v: string) => Uint8Array.from(v.match(/../g) ?? [], h => parseInt(h, 16));
const random = (length = 32) => hex(crypto.getRandomValues(new Uint8Array(length)));
const hash = async (value: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
function validHex(value: unknown, length: number): value is string { return typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value); }
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecoveryStorageError('invalid');
}
function endpoint(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 2048) throw new RecoveryStorageError('invalid');
  let u: URL; try { u = new URL(value); } catch { throw new RecoveryStorageError('invalid'); }
  if (u.username || u.password || u.hash || u.search || value.endsWith('/') ||
    u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))) throw new RecoveryStorageError('invalid');
}
function context(value: unknown): asserts value is RecoveryContext {
  object(value);
  if (Object.keys(value).sort().join(',') !== 'deploymentId,pool,wallet' || Object.values(value).some(v => typeof v !== 'string' || !v.length || v.length > 256)) throw new RecoveryStorageError('invalid');
}
function common(value: Record<string, unknown>): void {
  if (value.schema !== 1 || !validHex(value.vaultId, 64)) throw new RecoveryStorageError('invalid');
  endpoint(value.endpoint); context(value.context);
}
export function validateRecoveryKit(value: unknown): asserts value is RecoveryKit {
  object(value); common(value);
  if (Object.keys(value).sort().join(',') !== 'context,endpoint,schema,secret,vaultId' || !validHex(value.secret, 64)) throw new RecoveryStorageError('invalid');
}
export function validateRecoverySession(value: unknown, options: { externalKey?: boolean } = {}): asserts value is RecoverySession {
  object(value); common(value);
  if (Object.keys(value).some(k => !['schema','endpoint','vaultId','context','ownerToken','keyHex'].includes(k)) || !validHex(value.ownerToken, 64) ||
    (value.keyHex !== undefined ? !validHex(value.keyHex, 64) : !options.externalKey)) throw new RecoveryStorageError('invalid');
}
export function createRecoveryKit(input: { endpoint: string; context: RecoveryContext }): RecoveryKit {
  endpoint(input.endpoint); context(input.context);
  return { schema: 1, endpoint: input.endpoint, vaultId: random(), secret: random(), context: structuredClone(input.context) };
}
export function serializeRecoveryKit(kit: RecoveryKit): string { validateRecoveryKit(kit); return JSON.stringify(kit, null, 2) + '\n'; }
export function parseRecoveryKit(text: string): RecoveryKit {
  if (typeof text !== 'string' || text.length > 8192) throw new RecoveryStorageError('invalid');
  let value: unknown; try { value = JSON.parse(text); } catch { throw new RecoveryStorageError('invalid'); }
  validateRecoveryKit(value); return value;
}
async function contextHash(c: RecoveryContext): Promise<string> { return hash(JSON.stringify([c.deploymentId, c.pool, c.wallet])); }
async function derive(kit: RecoveryKit) {
  validateRecoveryKit(kit);
  const root = await crypto.subtle.importKey('raw', raw(kit.secret), 'HKDF', false, ['deriveBits']);
  const salt = encoder.encode(JSON.stringify(['zkapi-recovery-v1', kit.vaultId, await contextHash(kit.context)]));
  const bits = async (purpose: string) => hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(purpose) }, root, 256)));
  return { keyHex: await bits('journal-encryption'), authentication: await bits('recovery-authentication') };
}
async function request(base: { endpoint: string; vaultId: string }, token: string, path: string, method: string, body: unknown, fetcher: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${base.endpoint}/vaults/${base.vaultId}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  } catch { throw new RecoveryStorageError('unavailable'); }
  if (response.status === 401 || response.status === 403) throw new RecoveryStorageError('ownership_changed');
  if (response.status === 409) throw new JournalConflictError();
  if (!response.ok) throw new RecoveryStorageError(response.status >= 500 || response.status === 429 ? 'unavailable' : 'invalid');
  // Opaque records are bounded; no remote error text or credentials enter logs.
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4 * 1024 * 1024 + 4096) throw new RecoveryStorageError('invalid'); chunks.push(next.value); }
  } catch (e) { if (e instanceof RecoveryStorageError) throw e; throw new RecoveryStorageError('unavailable'); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  if (!size) return {};
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); } catch { throw new RecoveryStorageError('invalid'); }
}

class RecoveryJournalStore implements AtomicJournalStore {
  private closed = false;
  private readonly session: RecoverySession;
  private readonly fetcher: typeof fetch;
  constructor(session: RecoverySession, fetcher: typeof fetch) { this.session = structuredClone(session); this.fetcher = fetcher; }
  close(): void { this.closed = true; }
  private call(path: string, method: string, body?: unknown): Promise<unknown> {
    if (this.closed) throw new RecoveryStorageError('ownership_changed');
    return request(this.session, this.session.ownerToken, path, method, body, this.fetcher);
  }
  private async idempotent(path: string, method: string, body: unknown): Promise<void> {
    try { await this.call(path, method, body); }
    catch (error) {
      if (!(error instanceof RecoveryStorageError) || error.code !== 'unavailable') throw error;
      await this.call(path, method, body);
    }
  }
  async read(key: string): Promise<EncryptedRecord | null> {
    const result = await this.call(`/records/${await hash(key)}`, 'GET'); object(result);
    if (result.record === null) return null;
    validateEncryptedRecord(result.record); return structuredClone(result.record);
  }
  async compareAndSwap(key: string, expectedRevision: number | null, next: EncryptedRecord): Promise<void> {
    validateEncryptedRecord(next);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || next.revision !== expectedRevision + 1)) throw new JournalConflictError();
    const record = structuredClone(next), path = `/records/${await hash(key)}`;
    if (JSON.stringify(record).length > 4 * 1024 * 1024) throw new RecoveryStorageError('invalid');
    try { await this.call(path, 'PUT', { expectedRevision, record }); }
    catch (error) {
      // A lost response must not lose a durable commit or silently resend an
      // external financial effect. Only exact ciphertext equality proves this CAS.
      if (!(error instanceof RecoveryStorageError) || error.code !== 'unavailable') throw error;
      const saved = await this.read(key);
      if (saved === null || JSON.stringify(saved) !== JSON.stringify(record)) throw error;
    }
  }
  async withLock<R>(key: string, action: () => Promise<R>): Promise<R> {
    const path = `/locks/${await hash(key)}`, token = random();
    try { await this.idempotent(path, 'POST', { token }); }
    catch (error) { if (error instanceof JournalConflictError) throw new RecoveryStorageError('locked'); throw error; }
    let failure: unknown;
    try { return await action(); }
    catch (error) { failure = error; throw error; }
    finally {
      try { await this.idempotent(path, 'DELETE', { token }); }
      catch (error) { this.closed = true; if (!failure) throw error; }
    }
  }
}
export interface RecoveryStorage { store: AtomicJournalStore; key: CryptoKey; session: RecoverySession; binding: RecoveryContext; close(): void }
export async function openRecoveryStorage(input: RecoverySession, options: RecoveryOptions = {}): Promise<RecoveryStorage> {
  validateRecoverySession(input, { externalKey: !!options.key });
  if (options.expectedEndpoint !== undefined && input.endpoint !== options.expectedEndpoint) throw new RecoveryStorageError('invalid');
  const session = structuredClone(input), fetcher = options.fetch ?? globalThis.fetch;
  const key = options.key ?? await importJournalKey(raw(session.keyHex!));
  if (key.type !== 'secret' || key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256 || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) throw new RecoveryStorageError('invalid');
  const info = await request(session, session.ownerToken, '', 'GET', undefined, fetcher); object(info);
  if (info.context !== await contextHash(session.context) || !Number.isSafeInteger(info.epoch) || (info.epoch as number) < 1) throw new RecoveryStorageError('invalid');
  const store = new RecoveryJournalStore(session, fetcher);
  return { store, key, session: structuredClone(session), binding: structuredClone(session.context), close: () => store.close() };
}
async function establish(kit: RecoveryKit, restore: boolean, options: Omit<RecoveryOptions, 'key'>): Promise<RecoveryStorage> {
  const input = structuredClone(kit), keys = await derive(input), ownerToken = random(), fetcher = options.fetch ?? globalThis.fetch;
  // The same token is reused only to reconcile an uncertain service response.
  const path = restore ? '/takeover' : '';
  const body = restore ? { ownerToken, previousOwnerStopped: true } : { ownerToken, context: await contextHash(input.context) };
  try { await request(input, keys.authentication, path, 'POST', body, fetcher); }
  catch (error) {
    if (!(error instanceof RecoveryStorageError) || error.code !== 'unavailable') throw error;
    await request(input, keys.authentication, path, 'POST', body, fetcher);
  }
  return openRecoveryStorage({ schema: 1, endpoint: input.endpoint, vaultId: input.vaultId, context: input.context, ownerToken, keyHex: keys.keyHex }, options);
}
export function createRecoveryStorage(kit: RecoveryKit, options: Omit<RecoveryOptions, 'key'> = {}): Promise<RecoveryStorage> { return establish(kit, false, options); }
/** This rotates device ownership, never signs or replays a transaction/request.
 * Stop old clients first. Pending work remains subject to the existing SDK
 * recovery gates; this function does not prove financial settlement. */
export function restoreRecoveryStorage(kit: RecoveryKit, options: Omit<RecoveryOptions, 'key'> & { previousOwnerStopped: true; expectedEndpoint: string }): Promise<RecoveryStorage> {
  // A file is untrusted input: do not send a recovery credential to an endpoint
  // chosen by that same file. Pin the independently configured service first.
  if (options.previousOwnerStopped !== true || typeof options.expectedEndpoint !== 'string' || kit.endpoint !== options.expectedEndpoint) throw new RecoveryStorageError('invalid');
  return establish(kit, true, options);
}
