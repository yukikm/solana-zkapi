import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startRecoveryServer } from './server.mjs';
import { RecoveryStore, MAX_BODY_BYTES } from './store.mjs';

const hex = () => randomBytes(32).toString('hex');
const record = (revision, byte = 'ab') => ({ schema: 1, revision, ivHex: '12'.repeat(12), ciphertextHex: byte.repeat(16) });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-recovery-service-'));
  let service = await startRecoveryServer({ directory, port: 0, localTestOnly: true, allowedOrigins: ['https://dzt0611ozdx70.cloudfront.net'], ...options });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const id = hex(), auth = hex(), owner = hex(), context = hex();
  const request = async (method, suffix = '', body, token = owner, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${service.address.port}/recovery/v1/vaults/${id}${suffix}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error',
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
  };
  const create = () => request('POST', '', { ownerToken: owner, context }, auth);
  return { directory, id, auth, owner, context, request, create,
    restart: async () => { await service.close(); service = await startRecoveryServer({ directory, port: 0, localTestOnly: true, allowedOrigins: ['https://dzt0611ozdx70.cloudfront.net'], ...options }); } };
}

test('create authenticates immutable context and keeps only hashed credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.create()).status, 201);
  assert.equal((await f.create()).status, 200);
  assert.equal((await f.request('POST', '', { ownerToken: f.owner, context: hex() }, f.auth)).status, 409);
  assert.equal((await f.request('POST', '', { ownerToken: f.owner, context: f.context }, hex())).status, 401);
  assert.equal((await f.request('GET', '', undefined, f.auth)).status, 401);
  assert.deepEqual((await f.request('GET')).body, { context: f.context, epoch: 1 });
  const file = join(f.directory, `${f.id}.json`), persisted = await readFile(file, 'utf8');
  assert.ok(!persisted.includes(f.auth)); assert.ok(!persisted.includes(f.owner));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
});

test('CAS is atomic, exact retries are safe, and divergent or stale revisions are refused', async t => {
  const f = await fixture(t); await f.create(); const key = hex();
  assert.deepEqual((await f.request('GET', `/records/${key}`)).body, { record: null });
  const first = { expectedRevision: null, record: record(6) }; // Import existing custody.
  assert.equal((await f.request('PUT', `/records/${key}`, first)).status, 200);
  assert.equal((await f.request('PUT', `/records/${key}`, first)).status, 200);
  assert.equal((await f.request('PUT', `/records/${key}`, { ...first, record: record(6, 'cd') })).status, 409);
  const updates = await Promise.all(['ab', 'cd'].map(byte => f.request('PUT', `/records/${key}`, { expectedRevision: 6, record: record(7, byte) })));
  assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
  assert.equal((await f.request('PUT', `/records/${key}`, first)).status, 409);
  assert.equal((await f.request('PUT', `/records/${key}`, { expectedRevision: 7, record: record(9) })).status, 400);
  assert.equal((await f.request('GET', `/records/${key}`)).body.record.revision, 7);
});

test('locks persist after restart; takeover fences old owner and duplicate takeover does not erase new locks', async t => {
  const f = await fixture(t); await f.create(); const key = hex(), lock = hex(), newer = hex();
  assert.equal((await f.request('POST', `/locks/${key}`, { token: lock })).status, 200);
  assert.equal((await f.request('POST', `/locks/${key}`, { token: lock })).status, 200);
  await f.restart();
  assert.equal((await f.request('POST', `/locks/${key}`, { token: hex() })).status, 409);
  assert.equal((await f.request('DELETE', `/locks/${key}`, { token: hex() })).status, 409);
  assert.equal((await f.request('POST', '/takeover', { ownerToken: newer, previousOwnerStopped: false }, f.auth)).status, 400);
  const body = { ownerToken: newer, previousOwnerStopped: true };
  assert.deepEqual((await f.request('POST', '/takeover', body, f.auth)).body, { context: f.context, epoch: 2 });
  assert.equal((await f.request('PUT', `/records/${key}`, { expectedRevision: null, record: record(1) })).status, 401);
  assert.equal((await f.request('DELETE', `/locks/${key}`, { token: lock })).status, 401);
  assert.equal((await f.request('POST', `/locks/${key}`, { token: lock }, newer)).status, 200);
  assert.equal((await f.request('POST', '/takeover', body, f.auth)).body.epoch, 2);
  assert.equal((await f.request('POST', `/locks/${key}`, { token: hex() }, newer)).status, 409);
  assert.equal((await f.request('DELETE', `/locks/${key}`, { token: lock }, newer)).status, 200);
  assert.equal((await f.request('DELETE', `/locks/${key}`, { token: lock }, newer)).status, 200);
});

test('CORS permits only configured origins and no cache, cookies, redirects or unsupported headers', async t => {
  const f = await fixture(t); await f.create();
  const allowed = await f.request('GET', '', undefined, f.owner, { origin: 'https://dzt0611ozdx70.cloudfront.net' });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://dzt0611ozdx70.cloudfront.net');
  assert.match(allowed.headers.get('cache-control'), /no-store/); assert.equal(allowed.headers.get('set-cookie'), null);
  assert.equal(allowed.headers.get('location'), null);
  assert.equal((await f.request('GET', '', undefined, f.owner, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await f.request('OPTIONS', '', undefined, f.owner, { origin: 'https://dzt0611ozdx70.cloudfront.net', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization, content-type' })).status, 204);
  assert.equal((await f.request('OPTIONS', '', undefined, f.owner, { origin: 'https://dzt0611ozdx70.cloudfront.net', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-secret' })).status, 403);
});

test('a delayed takeover retry cannot reactivate a retired owner after a newer restore', async t => {
  const f = await fixture(t); await f.create(); const key = hex(), first = hex(), second = hex();
  await f.request('PUT', `/records/${key}`, { expectedRevision: null, record: record(1) });
  const firstRequest = { ownerToken: first, previousOwnerStopped: true };
  assert.equal((await f.request('POST', '/takeover', firstRequest, f.auth)).body.epoch, 2);
  assert.equal((await f.request('POST', '/takeover', { ownerToken: second, previousOwnerStopped: true }, f.auth)).body.epoch, 3);
  const delayed = await f.request('POST', '/takeover', firstRequest, f.auth);
  assert.equal(delayed.status, 409); assert.equal(delayed.body.error, 'owner_retired');
  assert.equal((await f.request('GET', '', undefined, first)).status, 401);
  assert.deepEqual((await f.request('GET', '', undefined, second)).body, { context: f.context, epoch: 3 });
  assert.deepEqual((await f.request('GET', `/records/${key}`, undefined, second)).body, { record: record(1) });
  const persisted = JSON.parse(await readFile(join(f.directory, `${f.id}.json`), 'utf8'));
  assert.equal(persisted.previousOwnerHashes.length, 2);
  assert.ok(!JSON.stringify(persisted).includes(first));
});

test('invalid request shapes, unknown paths, unsupported body encodings and bounded payloads fail closed', async t => {
  const f = await fixture(t); await f.create(); const key = hex();
  assert.equal((await f.request('PUT', `/records/${key}`, { expectedRevision: null, record: { ...record(1), secret: 'forbidden' } })).status, 400);
  assert.equal((await f.request('PUT', `/records/${key}`, { expectedRevision: null, record: record(1) }, f.owner, { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await f.request('PUT', `/records/${key}`, { padding: 'x'.repeat(MAX_BODY_BYTES) })).status, 413);
  assert.equal((await f.request('GET', '?ignored=true')).status, 404);
  assert.equal((await f.request('PATCH')).status, 405);
  assert.equal((await f.request('GET', '/records/not-a-key')).status, 404);
});

test('capacity failure retains the existing vault and does not create another', async t => {
  const f = await fixture(t, { maxVaults: 1 }); await f.create();
  const second = new RecoveryStore(f.directory, { maxVaults: 1 });
  try { assert.throws(() => second.create(hex(), hex(), { ownerToken: hex(), context: hex() }), { status: 507 }); }
  finally { second.close(); }
  assert.equal((await f.request('GET')).status, 200);
});

test('corrupt original records and symlinks are refused without replacement', async t => {
  const f = await fixture(t); await f.create(); const file = join(f.directory, `${f.id}.json`);
  await writeFile(file, '{bad-json', { mode: 0o600 });
  assert.equal((await f.create()).status, 503);
  assert.equal(await readFile(file, 'utf8'), '{bad-json');
  await rm(file); await symlink('missing.json', file);
  assert.equal((await f.create()).status, 503);
});

test('fresh processes retain committed state after an unacknowledged crash and ignore orphaned staging files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-recovery-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = hex(), auth = hex(), owner = hex(), context = hex(), key = hex();
  const store = new RecoveryStore(directory); store.create(id, auth, { ownerToken: owner, context }); store.close();
  // Abrupt termination immediately after durable save means the client received
  // no acknowledgement. Reopening must return the exact committed ciphertext.
  const source = `import {RecoveryStore} from ${JSON.stringify(new URL('./store.mjs', import.meta.url).href)}; const s=new RecoveryStore(${JSON.stringify(directory)});const save=s.save.bind(s);s.save=(...args)=>{save(...args);process.kill(process.pid,'SIGKILL');};s.compareAndSwap(${JSON.stringify(id)},${JSON.stringify(owner)},${JSON.stringify(key)},{expectedRevision:null,record:${JSON.stringify(record(1))}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore' });
  const [, signal] = await once(child, 'exit'); assert.equal(signal, 'SIGKILL');
  await writeFile(join(directory, `${id}.json.orphan.tmp`), 'incomplete temporary data', { mode: 0o600 });
  const restored = new RecoveryStore(directory);
  try {
    assert.deepEqual(restored.read(id, owner, key), { record: record(1) });
    assert.deepEqual(restored.compareAndSwap(id, owner, key, { expectedRevision: null, record: record(1) }), { ok: true });
    assert.equal(await readFile(join(directory, `${id}.json.orphan.tmp`), 'utf8'), 'incomplete temporary data');
  } finally { restored.close(); }
});

test('independent processes cannot both commit conflicting revisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-recovery-concurrent-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = hex(), auth = hex(), owner = hex(), key = hex();
  const original = new RecoveryStore(directory); original.create(id, auth, { ownerToken: owner, context: hex() }); original.close();
  async function attempt(byte) {
    const source = `import {RecoveryStore} from ${JSON.stringify(new URL('./store.mjs', import.meta.url).href)}; const s=new RecoveryStore(${JSON.stringify(directory)});try{s.compareAndSwap(${JSON.stringify(id)},${JSON.stringify(owner)},${JSON.stringify(key)},{expectedRevision:null,record:${JSON.stringify(record(1, byte))}});process.stdout.write('200');}catch(e){process.stdout.write(String(e.status));}finally{s.close();}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = ''; child.stdout.on('data', data => { output += data; });
    const [code] = await once(child, 'exit'); assert.equal(code, 0); return output;
  }
  assert.deepEqual((await Promise.all([attempt('ab'), attempt('cd')])).sort(), ['200', '409']);
});

test('rename without directory fsync never becomes a successful read or idempotent acknowledgement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-recovery-durability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new RecoveryStore(directory), originalFsync = fs.fsyncSync;
  const id = hex(), auth = hex(), owner = hex(), context = hex(), key = hex();
  try {
    store.create(id, auth, { ownerToken: owner, context });
    // The first barrier authenticates the old vault; fail after the new rename.
    let directorySyncs = 0;
    fs.fsyncSync = fd => {
      if (fs.fstatSync(fd).isDirectory() && ++directorySyncs >= 2) throw Object.assign(new Error('synthetic directory fsync failure'), { code: 'EIO' });
      return originalFsync(fd);
    };
    syncBuiltinESMExports();
    assert.throws(() => store.compareAndSwap(id, owner, key, { expectedRevision: null, record: record(1) }), { status: 503 });
    assert.equal(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).records[key].revision, 1);
    assert.throws(() => store.read(id, owner, key), { status: 503 });
    assert.throws(() => store.status(id, owner), { status: 503 });
    assert.throws(() => store.create(id, auth, { ownerToken: owner, context }), { status: 503 });
    assert.throws(() => store.compareAndSwap(id, owner, key, { expectedRevision: null, record: record(1) }), { status: 503 });
    assert.throws(() => store.acquire(id, owner, key, { token: hex() }), { status: 503 });
    fs.fsyncSync = originalFsync; syncBuiltinESMExports();
    assert.deepEqual(store.read(id, owner, key), { record: record(1) });
    assert.deepEqual(store.compareAndSwap(id, owner, key, { expectedRevision: null, record: record(1) }), { ok: true });
  } finally { fs.fsyncSync = originalFsync; syncBuiltinESMExports(); store.close(); }
});

test('the production CLI starts through an atomic release symlink', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-recovery-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const launcher = join(directory, 'current-server.mjs'), config = join(directory, 'config.json');
  await symlink(fileURLToPath(new URL('./server.mjs', import.meta.url)), launcher);
  await writeFile(config, JSON.stringify({ directory: join(directory, 'custody'), port, allowedOrigins: ['https://dzt0611ozdx70.cloudfront.net'] }));
  const child = spawn(process.execPath, [launcher, config], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CLI did not report readiness')), 5000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('recovery service ready')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`CLI exited before readiness: ${code}`)); });
  });
  const response = await fetch(`http://127.0.0.1:${port}/recovery/v1/health`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ready: true });
  child.kill('SIGTERM'); const [code] = await once(child, 'exit'); assert.equal(code, 0);
});
