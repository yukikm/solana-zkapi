import {fixtureSigner, kitAddress, signWith} from './kit-helpers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EncryptedJournal, EncryptedTransportJournal, importJournalKey, JournalConflictError, JournalIntegrityError } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';

interface State { schema: 1; noteSecret: string; pending: { requestId: string; token: string; bytes: string } | null }
function validate(value: unknown): asserts value is State {
  const state = value as State;
  if (!state || state.schema !== 1 || typeof state.noteSecret !== 'string' || state.pending !== null && (!state.pending || typeof state.pending.requestId !== 'string' || typeof state.pending.token !== 'string' || typeof state.pending.bytes !== 'string')) throw new Error('invalid state');
}
const context = { deploymentId: 'local-fixture-profile', pool: 'pool' };
const initial = (): State => ({ schema: 1, noteSecret: 'note-secret-never-in-plaintext', pending: null });
const pending = (): State => ({ ...initial(), pending: { requestId: 'request-uuid', token: 'secret-control-token', bytes: '7b202272657175657374223a202220227d' } });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-journal-'));
  const key = await importJournalKey(new Uint8Array(32).fill(7));
  const store = await NativeJournalStore.open(directory);
  return { directory, key, store, journal: new EncryptedJournal<State>(store, key, context, validate) };
}

test('native journal atomically persists exact request/token and old state without plaintext leakage; restart resumes', async t => {
  const { directory, key, journal } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));
  const created = await journal.create('note-0', initial());
  assert.equal(created.revision, 1);
  const next = pending(), saved = await journal.compareAndSwap('note-0', 1, next);
  next.pending!.token = 'changed-after-save';
  const restarted = new EncryptedJournal<State>(await NativeJournalStore.open(directory), key, context, validate);
  assert.deepEqual((await restarted.read('note-0'))?.value, pending());
  assert.equal(saved.value.noteSecret, created.value.noteSecret);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of await readdir(directory)) {
    const content = await readFile(join(directory, name));
    for (const secret of ['note-secret', 'request-uuid', 'secret-control-token', pending().pending!.bytes]) assert.equal(content.includes(Buffer.from(secret)), false);
    assert.equal((await stat(join(directory, name))).mode & 0o077, 0);
  }
});

test('concurrent native journals allow only one create and one revision CAS', async t => {
  const { directory, key, journal } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));
  const other = new EncryptedJournal<State>(await NativeJournalStore.open(directory), key, context, validate);
  const creates = await Promise.allSettled([journal.create('note', initial()), other.create('note', initial())]);
  assert.equal(creates.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(creates.filter(v => v.status === 'rejected' && v.reason instanceof JournalConflictError).length, 1);
  const writes = await Promise.allSettled([journal.compareAndSwap('note', 1, pending()), other.compareAndSwap('note', 1, pending())]);
  assert.equal(writes.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal((await journal.read('note'))?.revision, 2);
});

test('AES authentication rejects wrong keys, context substitution, ciphertext corruption and corrupted overwrite', async t => {
  const { directory, key, store, journal } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));
  await journal.create('note', initial());
  const backup = await journal.exportBackup('note');
  const wrong = new EncryptedJournal<State>(store, await importJournalKey(new Uint8Array(32).fill(9)), context, validate);
  await assert.rejects(wrong.read('note'), JournalIntegrityError);
  const mixed = new EncryptedJournal<State>(store, key, { ...context, pool: 'other-pool' }, validate);
  await assert.rejects(mixed.restoreBackup('note', backup.backup, backup.head), JournalIntegrityError);
  await assert.rejects(journal.restoreBackup('other-note', backup.backup, backup.head), JournalIntegrityError);
  const file = (await readdir(directory)).find(name => name.endsWith('.json'))!;
  const record = JSON.parse(await readFile(join(directory, file), 'utf8'));
  record.ciphertextHex = (record.ciphertextHex[0] === '0' ? '1' : '0') + record.ciphertextHex.slice(1);
  await writeFile(join(directory, file), JSON.stringify(record));
  await assert.rejects(journal.read('note'), JournalIntegrityError);
  await assert.rejects(journal.compareAndSwap('note', 1, pending()), JournalIntegrityError);
});

test('stale/divergent backups fail closed; fresh restore requires independently trusted exact head', async t => {
  const { directory, key, journal } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));
  await journal.create('note', initial()); const old = await journal.exportBackup('note');
  await journal.compareAndSwap('note', 1, pending()); const current = await journal.exportBackup('note');
  await assert.rejects(journal.restoreBackup('note', old.backup, old.head), /differs/);
  const freshDirectory = await mkdtemp(join(tmpdir(), 'zkapi-restored-')); t.after(() => rm(freshDirectory, { recursive: true, force: true }));
  const restored = new EncryptedJournal<State>(await NativeJournalStore.open(freshDirectory), key, context, validate);
  await assert.rejects(restored.restoreBackup('note', old.backup, current.head), /stale/);
  await assert.rejects(restored.restoreBackup('note', current.backup, old.head), /checkpoint/);
  assert.deepEqual((await restored.restoreBackup('note', current.backup, current.head)).value, pending());
  assert.equal((await restored.compareAndSwap('note', 2, initial())).revision, 3);
  const file = (await readdir(directory)).find(name => name.endsWith('.json'))!;
  await writeFile(join(directory, file), old.backup);
  await assert.rejects(journal.read('note'), /stale/);
  const restarted = new EncryptedJournal<State>(await NativeJournalStore.open(directory), key, context, validate);
  await assert.rejects(restarted.read('note', current.head), /stale/);
});

test('storage failure never acknowledges a pending request and caller mutation cannot alter a commit', async t => {
  const { directory, key, store } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));
  const failed = new EncryptedJournal<State>({ read: key => store.read(key), withLock: (key, action) => store.withLock(key, action), compareAndSwap: async () => { throw new Error('disk full'); } }, key, context, validate);
  await assert.rejects(failed.create('note', pending()), /disk full/);
  assert.equal(await failed.read('note'), null);
  const journal = new EncryptedJournal<State>(store, key, context, validate), value = pending();
  const committed = journal.create('note', value); value.pending!.token = 'caller-changed';
  assert.deepEqual((await committed).value, pending());
});

test('native operation locks serialize workers and release after exceptions', async t => {
  const { directory, store } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));
  const other = await NativeJournalStore.open(directory, { lockTimeoutMs: 30 });
  await store.withLock('note', async () => {
    await assert.rejects(other.withLock('note', async () => assert.fail('overlapping owner')), /locked/);
  });
  await assert.rejects(store.withLock('note', async () => { throw new Error('worker stopped'); }), /worker stopped/);
  assert.equal(await other.withLock('note', async () => 'resumed'), 'resumed');
});

test('GC cannot release a live operation lock; process death releases it and restart loads ciphertext', async t => {
  const { directory, store, journal } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));
  await journal.create('note', pending());
  const moduleUrl = new URL('../src/journal-node.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', `import { NativeJournalStore } from ${JSON.stringify(moduleUrl)}; const store = await NativeJournalStore.open(process.argv[1]); await store.withLock('note', async () => { setTimeout(() => { global.gc(); process.stdout.write('LOCKED\\n'); }, 10); await new Promise(() => setInterval(() => {}, 1000)); });`, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const [ready] = await once(child.stdout!, 'data'); assert.equal(ready.toString(), 'LOCKED\n');
  const competing = await NativeJournalStore.open(directory, { lockTimeoutMs: 30 });
  await assert.rejects(competing.withLock('note', async () => assert.fail('dead process not yet fenced')), /locked/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal(await store.withLock('note', async () => 'recovered'), 'recovered');
  assert.deepEqual((await journal.read('note'))?.value, pending());
});

test('I04 transport adapter retains exact attempts, deduplicates identical signatures and rejects changed bytes', async t => {
  const { directory, key, store } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));
  type Attempt = { schema: 1; signature: string; wireHex: string; blockhash: string };
  const transport = new EncryptedTransportJournal<Attempt>(store, key, context, 'note', 'withdrawal-operation');
  const attempt: Attempt = { schema: 1, signature: 'signature-one', wireHex: 'abcdef01', blockhash: 'hash-one' };
  await transport.save(attempt); await transport.save({ ...attempt });
  await transport.save({ ...attempt, signature: 'signature-two', wireHex: 'abcd01', blockhash: 'hash-two' });
  await assert.rejects(transport.save({ ...attempt, wireHex: '00' }), /changed/);
  const restarted = new EncryptedTransportJournal<Attempt>(await NativeJournalStore.open(directory), key, context, 'note', 'withdrawal-operation');
  assert.equal((await restarted.read()).length, 2);
  assert.deepEqual((await restarted.read())[0], attempt);
});

test('real I04 wallet-signed v0 attempt resumes from encrypted transport journal with identical wire bytes', async t => {
  const { directory, key, store } = await setup(); t.after(() => rm(directory, { recursive: true, force: true }));

  const { buildUploadPlan, vaultAccounts, prepareAttempt, recoverAttempt } = await import('../src/transport.ts');
  const { encodeLayout2Args, fromHex } = await import('../src/layout2.ts');
  const fixture = JSON.parse(await readFile(new URL('../../../tests/fixtures/vault/a.json', import.meta.url), 'utf8'));
  const payer = (await fixtureSigner(new Uint8Array(32).fill(41)));
  const programId = kitAddress(fromHex(fixture.program_id, 32)), pool = kitAddress(fromHex(fixture.pool, 32)), mint = kitAddress(fromHex(fixture.mint, 32));
  const plan = await buildUploadPlan({ programId, pool, uploader: payer.address, rentPayer: payer.address, feePayer: payer.address,
    nonce: new Uint8Array(32).fill(42), expires: 3000003600n, operation: 'deposit', snapshot: { slot: 27, sequence: 3n },
    payload: encodeLayout2Args({ operation: 'deposit', expectedId: 0, expectedRoot: fixture.trees[0].public_inputs[1], expiry: BigInt(fixture.expiry), commitment: '0x' + fixture.commitment, amount: BigInt(fixture.deposit), tree: fixture.trees[0] }),
    financial: (await vaultAccounts({ programId, pool, mint, noteId: 0, payer: payer.address, operation: 'deposit', tokenOwner: payer.address })) });
  const transport = new EncryptedTransportJournal<import('../src/transport.ts').Attempt>(store, key, context, 'note', 'deposit');
  const saved = await prepareAttempt(plan, plan.steps[0], { blockhash: kitAddress(new Uint8Array(32).fill(43)), lastValidBlockHeight: 100 },
    [{ publicKey: payer.address, supportedTransactionVersions: new Set([0]), signTransaction: async transaction => { transaction = await signWith(transaction, [payer]); return transaction; } }], transport);
  const restarted = new EncryptedTransportJournal<import('../src/transport.ts').Attempt>(await NativeJournalStore.open(directory), key, context, 'note', 'deposit');
  const [attempt] = await restarted.read(); assert.deepEqual(attempt, saved);
  let sent = 0;
  assert.deepEqual(await recoverAttempt(attempt, {
    signatureStatus: async () => null, finalizedReceipt: async () => null, finalizedBlockHeight: async () => 50,
    sendRawTransaction: async bytes => { sent++; assert.equal(Buffer.from(bytes).toString('hex'), saved.wireHex); return saved.signature; },
  }, true), { state: 'pending' });
  assert.equal(sent, 1);
});
