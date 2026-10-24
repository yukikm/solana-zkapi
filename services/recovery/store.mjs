/** Encrypted backup storage only. This service never interprets financial state. */
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, mkdirSync, lstatSync, fstatSync, realpathSync, chmodSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_VAULT_BYTES = 64 * 1024 * 1024;
const hex64 = /^[0-9a-f]{64}$/;
export class RecoveryServiceError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new RecoveryServiceError(status, code); };
export function validHex(value) { return typeof value === 'string' && hex64.test(value); }
export function exactObject(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}
function requireHex(value) { if (!validHex(value)) fail(400, 'invalid_request'); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function authenticated(token, expected) { return validHex(token) && timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(expected, 'hex')); }
function validRecord(value) {
  return exactObject(value, ['schema', 'revision', 'ivHex', 'ciphertextHex']) && value.schema === 1
    && Number.isSafeInteger(value.revision) && value.revision > 0
    && typeof value.ivHex === 'string' && /^[0-9a-f]{24}$/.test(value.ivHex)
    && typeof value.ciphertextHex === 'string' && value.ciphertextHex.length >= 32
    && value.ciphertextHex.length <= MAX_BODY_BYTES && value.ciphertextHex.length % 2 === 0 && /^[0-9a-f]+$/.test(value.ciphertextHex);
}
function sameRecord(a, b) { return a.schema === b.schema && a.revision === b.revision && a.ivHex === b.ivHex && a.ciphertextHex === b.ciphertextHex; }
function validState(value) {
  if (!exactObject(value, ['schema', 'authHash', 'ownerHash', 'previousOwnerHashes', 'context', 'epoch', 'records', 'locks'])
    || value.schema !== 1 || !validHex(value.authHash) || !validHex(value.ownerHash) || !validHex(value.context)
    || !Number.isSafeInteger(value.epoch) || value.epoch < 1
    || !Array.isArray(value.previousOwnerHashes) || value.previousOwnerHashes.length > 4096
    || value.previousOwnerHashes.some(item => !validHex(item) || item === value.ownerHash)
    || new Set(value.previousOwnerHashes).size !== value.previousOwnerHashes.length
    || value.epoch !== value.previousOwnerHashes.length + 1) return false;
  for (const field of ['records', 'locks']) {
    if (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field]) || Object.keys(value[field]).length > 4096) return false;
    for (const [key, item] of Object.entries(value[field])) {
      if (!validHex(key) || (field === 'records' ? !validRecord(item) : !validHex(item))) return false;
    }
  }
  return true;
}
function safeFile(path, maximum) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maximum || (info.mode & 0o077)) fail(503, 'storage_unavailable');
    const data = readFileSync(fd, 'utf8');
    // A prior save may have renamed successfully but lost its acknowledgement
    // while fsync failed. Reading visible bytes alone is not durable evidence.
    fsyncSync(fd);
    return data;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export class RecoveryStore {
  constructor(directory, { maxVaults = 1024, maxTotalBytes = 1024 * 1024 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxVaults) || maxVaults < 1 || maxVaults > 100000
      || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < MAX_VAULT_BYTES) throw new Error('invalid recovery capacity');
    const absolute = resolve(directory);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    const info = lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('recovery storage must be a real directory');
    chmodSync(absolute, 0o700);
    this.directory = realpathSync(absolute);
    this.maxVaults = maxVaults; this.maxTotalBytes = maxTotalBytes;
    const lock = join(this.directory, 'writer-lock.sqlite');
    try { if (lstatSync(lock).isSymbolicLink()) throw new Error('invalid recovery lock'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.database = new DatabaseSync(lock);
    chmodSync(lock, 0o600);
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec('PRAGMA journal_mode = DELETE');
  }
  close() { this.database.close(); }
  path(id) { requireHex(id); return join(this.directory, `${id}.json`); }
  syncParent() {
    const parent = openSync(this.directory, constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
  load(id) {
    try {
      const state = JSON.parse(safeFile(this.path(id), MAX_VAULT_BYTES));
      if (!validState(state)) fail(503, 'storage_unavailable');
      this.syncParent();
      return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error instanceof RecoveryServiceError) throw error;
      fail(503, 'storage_unavailable');
    }
  }
  atomic(action) {
    let acquired = false;
    try {
      this.database.exec('BEGIN EXCLUSIVE'); acquired = true;
      return action();
    } catch (error) {
      if (error instanceof RecoveryServiceError) throw error;
      fail(503, 'storage_unavailable');
    } finally { if (acquired) this.database.exec('ROLLBACK'); }
  }
  save(id, state, isNew = false) {
    if (!validState(state)) fail(400, 'invalid_request');
    const data = JSON.stringify(state), size = Buffer.byteLength(data);
    if (size > MAX_VAULT_BYTES) fail(507, 'capacity_reached');
    let count = 0, total = 0;
    for (const name of readdirSync(this.directory)) {
      if (/^[0-9a-f]{64}\.json$/.test(name)) {
        count++; if (name !== `${id}.json`) total += statSync(join(this.directory, name)).size;
      }
    }
    if ((isNew && count >= this.maxVaults) || total + size > this.maxTotalBytes) fail(507, 'capacity_reached');
    const target = this.path(id), temporary = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { writeFileSync(fd, data, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    // An interrupted write leaves its original JSON or complete replacement. Do not
    // delete orphaned temporary files on startup or infer successful acknowledgement.
    renameSync(temporary, target);
    this.syncParent();
  }
  create(id, token, body) {
    requireHex(id); requireHex(token);
    if (!exactObject(body, ['ownerToken', 'context'])) fail(400, 'invalid_request');
    requireHex(body.ownerToken); requireHex(body.context);
    if (body.ownerToken === token) fail(400, 'invalid_request');
    return this.atomic(() => {
      const current = this.load(id);
      if (current) {
        if (!authenticated(token, current.authHash)) fail(401, 'unauthorized');
        if (!authenticated(body.ownerToken, current.ownerHash) || body.context !== current.context) fail(409, 'vault_exists');
        return { created: false, context: current.context, epoch: current.epoch };
      }
      const state = { schema: 1, authHash: hash(token), ownerHash: hash(body.ownerToken), previousOwnerHashes: [], context: body.context, epoch: 1, records: {}, locks: {} };
      this.save(id, state, true);
      return { created: true, context: state.context, epoch: state.epoch };
    });
  }
  takeover(id, token, body) {
    if (!exactObject(body, ['ownerToken', 'previousOwnerStopped']) || body.previousOwnerStopped !== true) fail(400, 'invalid_request');
    requireHex(body.ownerToken); requireHex(token);
    if (body.ownerToken === token) fail(400, 'invalid_request');
    return this.atomic(() => {
      const state = this.load(id); if (!state) fail(404, 'not_found');
      if (!authenticated(token, state.authHash)) fail(401, 'unauthorized');
      if (!authenticated(body.ownerToken, state.ownerHash)) {
        const nextHash = hash(body.ownerToken);
        if (state.previousOwnerHashes.includes(nextHash)) fail(409, 'owner_retired');
        if (state.previousOwnerHashes.length >= 4096 || !Number.isSafeInteger(state.epoch + 1)) fail(409, 'epoch_exhausted');
        state.previousOwnerHashes.push(state.ownerHash);
        state.ownerHash = nextHash; state.epoch++; state.locks = {};
        this.save(id, state);
      }
      return { context: state.context, epoch: state.epoch };
    });
  }
  withOwner(id, token, action) {
    return this.atomic(() => {
      const state = this.load(id); if (!state) fail(404, 'not_found');
      if (!authenticated(token, state.ownerHash)) fail(401, 'unauthorized');
      return action(state);
    });
  }
  status(id, token) { return this.withOwner(id, token, state => ({ context: state.context, epoch: state.epoch })); }
  read(id, token, key) { requireHex(key); return this.withOwner(id, token, state => ({ record: state.records[key] ?? null })); }
  compareAndSwap(id, token, key, body) {
    requireHex(key);
    if (!exactObject(body, ['expectedRevision', 'record']) || !validRecord(body.record)
      || !(body.expectedRevision === null || Number.isSafeInteger(body.expectedRevision) && body.expectedRevision > 0)
      || body.expectedRevision !== null && body.record.revision !== body.expectedRevision + 1) fail(400, 'invalid_request');
    return this.withOwner(id, token, state => {
      const current = state.records[key] ?? null;
      // An exact retried commit has already reached durable storage. Never accept
      // an equal revision with different ciphertext or an older record.
      if (current && sameRecord(current, body.record)) return { ok: true };
      if ((current?.revision ?? null) !== body.expectedRevision) fail(409, 'revision_conflict');
      state.records[key] = structuredClone(body.record); this.save(id, state);
      return { ok: true };
    });
  }
  acquire(id, token, key, body) {
    requireHex(key); if (!exactObject(body, ['token'])) fail(400, 'invalid_request'); requireHex(body.token);
    return this.withOwner(id, token, state => {
      const held = state.locks[key], wanted = hash(body.token);
      if (held !== undefined && !timingSafeEqual(Buffer.from(held, 'hex'), Buffer.from(wanted, 'hex'))) fail(409, 'lock_held');
      if (held === undefined) { state.locks[key] = wanted; this.save(id, state); }
      return { ok: true };
    });
  }
  release(id, token, key, body) {
    requireHex(key); if (!exactObject(body, ['token'])) fail(400, 'invalid_request'); requireHex(body.token);
    return this.withOwner(id, token, state => {
      const held = state.locks[key];
      if (held !== undefined && !timingSafeEqual(Buffer.from(held, 'hex'), Buffer.from(hash(body.token), 'hex'))) fail(409, 'lock_held');
      if (held !== undefined) { delete state.locks[key]; this.save(id, state); }
      return { ok: true };
    });
  }
}
