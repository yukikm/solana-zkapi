/** Kit PDA checks await Web Crypto; persistence must await validation and retain
 * the exact detached input across that boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedJournal, importJournalKey, JournalIntegrityError } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';

interface State { value: string }
const context = {deploymentId:'kit-async-validation-fixture',pool:'pool'};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => {resolve=done;}); return {promise,resolve}; };

test('async journal validation is awaited and cannot observe caller mutation during commit', async t => {
  const directory = await mkdtemp(join(tmpdir(),'zkapi-kit-journal-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const store = await NativeJournalStore.open(directory), key = await importJournalKey(new Uint8Array(32).fill(73));
  const entered = deferred(), release = deferred(); let delay = false;
  const validate = async (input: unknown) => {
    if (delay) {delay=false; entered.resolve(); await release.promise;}
    assert.equal(typeof (input as State).value,'string');
    assert.notEqual((input as State).value,'mutated');
  };
  const journal = new EncryptedJournal<State>(store,key,context,validate);
  await journal.create('note',{value:'initial'});
  delay=true;
  const value={value:'approved'}, saving=journal.compareAndSwap('note',1,value);
  await entered.promise; value.value='mutated';
  assert.equal((await journal.read('note'))!.revision,1,'no commit before async validation completes');
  release.resolve(); await saving;
  assert.deepEqual((await journal.read('note'))!.value,{value:'approved'});
});

test('async validator rejection fences create, read and backup restore without writing', async t => {
  const directory=await mkdtemp(join(tmpdir(),'zkapi-kit-reject-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const key=await importJournalKey(new Uint8Array(32).fill(74));
  const source=await NativeJournalStore.open(join(directory,'source')), destination=await NativeJournalStore.open(join(directory,'destination'));
  const good=new EncryptedJournal<State>(source,key,context,async()=>{});
  await good.create('note',{value:'approved'}); const backup=await good.exportBackup('note');
  const reject=async()=>{await Promise.resolve();throw Error('rejected validation');};
  const badRead=new EncryptedJournal<State>(source,key,context,reject), badWrite=new EncryptedJournal<State>(destination,key,context,reject);
  await assert.rejects(badRead.read('note'),JournalIntegrityError);
  await assert.rejects(badWrite.create('note',{value:'rejected'}),/rejected validation/);
  await assert.rejects(badWrite.restoreBackup('note',backup.backup,backup.head),JournalIntegrityError);
  assert.equal(await new EncryptedJournal<State>(destination,key,context,async()=>{}).read('note'),null);
});
