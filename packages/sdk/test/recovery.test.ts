/** Recovery storage tests use the actual local backup HTTP service and synthetic state, never live funds. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRecoveryKit, createRecoveryStorage, restoreRecoveryStorage, openRecoveryStorage } from '../src/recovery.ts';
import { saveRecoverySessionFile, loadRecoverySessionFile, writeRecoveryKitFile, readRecoveryKitFile } from '../src/recovery-node.ts';
import { EncryptedJournal, importJournalKey, JournalIntegrityError } from '../src/journal.ts';
import { recoveryContext, recoveryEndpoint, recoveryNoteId, recoveryState, recoveryJournal, recoveryServer, validateRecoveryState } from './recovery-fixture.ts';

test('Node process restores latest full private state after every original local file is deleted', { timeout: 30_000 }, async t => {
  const server = await recoveryServer(t);
  const root = await mkdtemp(join(tmpdir(), 'zkapi-recovery-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, 'lost-device'), backup = join(root, 'independent-backup'), fresh = join(root, 'replacement-device');
  for (const directory of [original, backup, fresh]) await mkdir(directory, { mode: 0o700 });
  const kit = await createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  const kitPath = join(backup, 'recovery-kit.json'); await writeRecoveryKitFile(kitPath, kit);
  const storage = await createRecoveryStorage(kit, { fetch: server.fetch });
  await saveRecoverySessionFile(join(original, 'session.json'), storage.session);
  assert.equal((await stat(join(original, 'session.json'))).mode & 0o777, 0o600);
  const journal = recoveryJournal(storage), initial = recoveryState(); initial.state.balance_micro_usdc = '2000000';
  await journal.create(recoveryNoteId, initial);
  await journal.compareAndSwap(recoveryNoteId, 1, recoveryState());
  const checkpoint = (await journal.read(recoveryNoteId))!.head;
  await storage.close();
  await rm(original, { recursive: true });
  await assert.rejects(access(original), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(JSON.stringify(await readRecoveryKitFile(kitPath))), kit);
  // A new process has neither the old CryptoKey nor the old session object in memory.
  const program = `
    import { readRecoveryKitFile, saveRecoverySessionFile } from ${JSON.stringify(new URL('../src/recovery-node.ts', import.meta.url).href)};
    import { restoreRecoveryStorage } from ${JSON.stringify(new URL('../src/recovery.ts', import.meta.url).href)};
    import { EncryptedJournal } from ${JSON.stringify(new URL('../src/journal.ts', import.meta.url).href)};
    const kit=await readRecoveryKitFile(process.argv[1]);
    const mappedFetch=(input,init)=>fetch(process.argv[3]+new URL(typeof input==='string'?input:input.url).pathname,init);
    const restored=await restoreRecoveryStorage(kit,{previousOwnerStopped:true,expectedEndpoint:${JSON.stringify(recoveryEndpoint)},fetch:mappedFetch});
    const journal=new EncryptedJournal(restored.store,restored.key,kit.context,value=>{if(!value||value.schema!==1)throw Error('invalid fixture');});
    const saved=await journal.read(${JSON.stringify(recoveryNoteId)});
    await saveRecoverySessionFile(process.argv[2],restored.session);await restored.close();
    process.stdout.write(JSON.stringify(saved));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, kitPath, join(fresh, 'session.json'), server.origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '', errors = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { errors += chunk; });
  const [exitCode] = await once(child, 'exit'); assert.equal(exitCode, 0, errors);
  const restored = JSON.parse(output); assert.deepEqual(restored.value, recoveryState()); assert.deepEqual(restored.head, checkpoint);
  const freshSession = await loadRecoverySessionFile(join(fresh, 'session.json')); assert.ok(freshSession);
  assert.notEqual(freshSession.ownerToken, storage.session.ownerToken);
  const reopened = await openRecoveryStorage(freshSession, { fetch: server.fetch });
  assert.deepEqual((await recoveryJournal(reopened).read(recoveryNoteId))?.value, recoveryState()); await reopened.close();
});

test('restore needs explicit old-process-stop acknowledgement and fences every old session operation', async t => {
  const server = await recoveryServer(t), kit = await createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  const old = await createRecoveryStorage(kit, { fetch: server.fetch });
  const journal = recoveryJournal(old); await journal.create(recoveryNoteId, recoveryState());
  await assert.rejects(async () => restoreRecoveryStorage(kit, { fetch: server.fetch } as Parameters<typeof restoreRecoveryStorage>[1]));
  const restored = await restoreRecoveryStorage(kit, { previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: server.fetch });
  await assert.rejects(journal.read(recoveryNoteId));
  await assert.rejects(journal.compareAndSwap(recoveryNoteId, 1, recoveryState()));
  await assert.rejects(old.store.withLock('aa'.repeat(32), async () => assert.fail('old owner entered operation')));
  await assert.rejects(openRecoveryStorage(old.session, { fetch: server.fetch }));
  assert.deepEqual((await recoveryJournal(restored).read(recoveryNoteId))?.value, recoveryState());
  await restored.close(); await old.close();
});

test('failed remote save fails closed before any caller effect and preserves the previous backup', async t => {
  const server = await recoveryServer(t), kit = await createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  let failWrites = false, externalEffects = 0;
  const fetchWithFailure: typeof fetch = async (input, init) => failWrites && init?.method === 'PUT'
    ? new Response(JSON.stringify({ error: 'storage_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    : server.fetch(input, init);
  const storage = await createRecoveryStorage(kit, { fetch: fetchWithFailure }), journal = recoveryJournal(storage);
  await journal.create(recoveryNoteId, recoveryState());
  failWrites = true;
  await assert.rejects((async () => { await journal.compareAndSwap(recoveryNoteId, 1, { ...recoveryState(), pending: { ...recoveryState().pending, exactRequest: 'NOT_DURABLY_SAVED' } }); externalEffects++; })());
  assert.equal(externalEffects, 0); failWrites = false;
  assert.deepEqual((await journal.read(recoveryNoteId))?.value, recoveryState());
  await storage.close();
});

test('lost PUT response can resolve only the exact already-committed ciphertext', async t => {
  const server = await recoveryServer(t), kit = await createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  let lose = false, lost = false;
  const fetchWithLoss: typeof fetch = async (input, init) => {
    const response = await server.fetch(input, init);
    if (lose && !lost && init?.method === 'PUT' && response.ok) { lost = true; await response.body?.cancel(); throw new TypeError('synthetic connection lost after durable commit'); }
    return response;
  };
  const storage = await createRecoveryStorage(kit, { fetch: fetchWithLoss }), journal = recoveryJournal(storage);
  await journal.create(recoveryNoteId, recoveryState());
  lose = true;
  const next = { ...recoveryState(), state: { ...recoveryState().state, balance_micro_usdc: '1666123' } };
  // A transport may either recover the exact acknowledgement or report uncertainty.
  // It must never create a second revision or overwrite a different record.
  try { await journal.compareAndSwap(recoveryNoteId, 1, next); } catch { /* Explicit subsequent read reconciles the saved record. */ }
  assert.equal(lost, true);
  const saved = await journal.read(recoveryNoteId); assert.equal(saved?.revision, 2); assert.deepEqual(saved?.value, next);
  const recordsKey = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['zkapi-client-journal-v1', recoveryContext.deploymentId, recoveryContext.pool, recoveryNoteId])));
  const key = Buffer.from(recordsKey).toString('hex'), encrypted = await storage.store.read(key); assert.ok(encrypted);
  await storage.store.compareAndSwap(key, 1, encrypted);
  assert.equal((await journal.read(recoveryNoteId))?.revision, 2);
  await assert.rejects(storage.store.compareAndSwap(key, 1, { ...encrypted, ciphertextHex: (encrypted.ciphertextHex[0] === '0' ? '1' : '0') + encrypted.ciphertextHex.slice(1) }));
  await storage.close();
});

test('wrong recovery code or substituted Pool cannot take over or decrypt existing custody', async t => {
  const server = await recoveryServer(t), kit = await createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  const storage = await createRecoveryStorage(kit, { fetch: server.fetch }), journal = recoveryJournal(storage);
  await journal.create(recoveryNoteId, recoveryState());
  const differentSecret = kit.secret === 'ff'.repeat(32) ? 'ee'.repeat(32) : 'ff'.repeat(32);
  await assert.rejects(restoreRecoveryStorage({ ...kit, secret: differentSecret }, { previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: server.fetch }));
  await assert.rejects(restoreRecoveryStorage({ ...kit, context: { ...kit.context, pool: 'another-pool' } }, { previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: server.fetch }));
  assert.deepEqual((await journal.read(recoveryNoteId))?.value, recoveryState());
  const wrongKey = new EncryptedJournal(storage.store, await importJournalKey(new Uint8Array(32).fill(8)), recoveryContext, validateRecoveryState);
  await assert.rejects(wrongKey.read(recoveryNoteId), JournalIntegrityError); await storage.close();
});

test('ciphertext tampering is rejected before restoring a financial record', async t => {
  const server = await recoveryServer(t), kit = await createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  let tamper = false;
  const corruptingFetch: typeof fetch = async (input, init) => {
    const response = await server.fetch(input, init);
    if (tamper && (!init?.method || init.method === 'GET') && String(input).includes('/records/') && response.ok) {
      const body = await response.json() as { record: { ciphertextHex: string } | null };
      if (body.record) body.record.ciphertextHex = (body.record.ciphertextHex[0] === '0' ? '1' : '0') + body.record.ciphertextHex.slice(1);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return response;
  };
  const storage = await createRecoveryStorage(kit, { fetch: corruptingFetch }); await recoveryJournal(storage).create(recoveryNoteId, recoveryState());
  tamper = true;
  await assert.rejects(recoveryJournal(storage).read(recoveryNoteId), JournalIntegrityError); await storage.close();
});

test('a recovery file cannot select a different endpoint and expose its authentication secret', async () => {
  const kit = createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  let requests = 0;
  const attackerFetch: typeof fetch = async () => { requests++; assert.fail('untrusted endpoint received a request'); };
  await assert.rejects(async () => restoreRecoveryStorage({ ...kit, endpoint: 'https://attacker.invalid/recovery/v1' }, {
    previousOwnerStopped: true, expectedEndpoint: recoveryEndpoint, fetch: attackerFetch,
  }));
  assert.equal(requests, 0);
});

test('backup service files contain no note secret, exact AUTH, transaction bytes or decryption material', async t => {
  const server = await recoveryServer(t), kit = await createRecoveryKit({ endpoint: recoveryEndpoint, context: recoveryContext });
  const storage = await createRecoveryStorage(kit, { fetch: server.fetch }); await recoveryJournal(storage).create(recoveryNoteId, recoveryState());
  const forbidden = [kit.secret, storage.session.keyHex!, recoveryState().witness.secret, recoveryState().pending.controlToken, recoveryState().pending.exactRequest, recoveryState().wallet.operation.attempts[0].wireHex];
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name); if (entry.isDirectory()) await inspect(path);
      else { const bytes = await readFile(path); for (const secret of forbidden) assert.equal(bytes.includes(Buffer.from(secret)), false, 'backup service stored plaintext recovery material'); }
    }
  }
  await inspect(server.directory); await storage.close();
});
