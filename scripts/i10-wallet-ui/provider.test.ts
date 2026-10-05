/** Actual encrypted journal + ControlClient, synthetic proof/provider; no live acceptance claim. */
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EncryptedJournal, importJournalKey} from '../../packages/sdk/src/journal.ts';
import {NativeJournalStore} from '../../packages/sdk/src/journal-node.ts';
import {validateNoteJournal, type NoteJournal} from '../../packages/sdk/src/control.ts';
import {UiProvider, uiProviderBody} from './provider.ts';
import {providerFixture, fixtureState} from './provider.fixture.ts';
import {providerAcceptanceBody} from '../provider_acceptance_client.ts';
import type {ProviderAcceptanceCase} from '../provider_acceptance_client.ts';
async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'zkapi-provider-ui-')); t.after(() => rm(path, {recursive: true, force: true}));
  const key = await importJournalKey(new Uint8Array(32).fill(55));
  const open = async () => new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(path), key, {deploymentId: 'fixture', pool: 'fixture'}, validateNoteJournal);
  const journal = await open();
  await journal.create('note', {schema: 1, state: fixtureState(), witness: {secret: '0x' + '01'.padStart(64, '0'), note_id: 0, deposit_micro_usdc: '1000000', expiry: '86400'}, wallet: {status: 'active', history: []}, pending: null, history: []});
  const h = await providerFixture(journal, 'note');
  return {...h, journal, open, ui: new UiProvider(h.options)};
}
test('fixed browser body equals parent budget template; prepares after snapshot and verifies charge through SDK before withdrawal is available', async t => {
  const h = await fixture(t);
  assert.deepEqual(uiProviderBody(h.options.configuration), providerAcceptanceBody(h.options.configuration.testCase as ProviderAcceptanceCase));
  await h.ui.prepare('note'); assert.equal(h.counts.inference, 0); assert.equal(h.counts.auth, 0);
  assert.equal((await h.journal.read('note'))!.value.pending!.phase, 'prepared');
  assert.equal((await h.ui.sendOnce('note')).text, 'ok');
  await assert.rejects(h.ui.sendOnce('note')); assert.equal(h.counts.inference, 1);
  await h.ui.recoverClose('note'); const after = (await h.journal.read('note'))!.value;
  assert.equal(after.pending, null); assert.equal(after.history.length, 1); assert.equal(after.state.balance_micro_usdc, '999999');
  assert.equal(after.history[0].receipts.length, 1); assert.equal(h.counts.verification, 1);
  await assert.rejects(h.ui.prepare('note')); assert.equal(h.counts.quotes, 1);
});
test('lost AUTH can only resend its exact bytes; lost inference stays one send after encrypted journal reopen', async t => {
  const h = await fixture(t); await h.ui.prepare('note'); h.behavior.loseAuth = true;
  await assert.rejects(h.ui.sendOnce('note')); const auth = (await h.journal.read('note'))!.value.pending!;
  assert.equal(auth.phase, 'send_unknown'); assert.equal(h.counts.inference, 0);
  h.behavior.loseAuth = false; h.behavior.loseResponse = true;
  await assert.rejects(h.ui.sendOnce('note')); assert.deepEqual(h.authBodies, [auth.exactRequest, auth.exactRequest]);
  const reopened = await h.open(), next = new UiProvider({...h.options, journal: reopened});
  await assert.rejects(next.sendOnce('note')); assert.equal(h.counts.inference, 1);
  await next.recoverClose('note'); assert.equal((await reopened.read('note'))!.value.pending, null);
  assert.equal(h.counts.inference, 1); assert.equal(h.counts.quotes, 1);
});
test('invalid successor retains old balance and pending operation; explicit recovery succeeds without another inference', async t => {
  const h = await fixture(t); await h.ui.prepare('note'); await h.ui.sendOnce('note'); h.behavior.rejectSettlement = true;
  await assert.rejects(h.ui.recoverClose('note'));
  const r = (await h.journal.read('note'))!.value; assert.equal(r.state.balance_micro_usdc, '1000000'); assert.equal(r.history.length, 0); assert.equal(r.pending!.phase, 'closing');
  h.behavior.rejectSettlement = false; await h.ui.recoverClose('note'); assert.equal(h.counts.inference, 1);
});
test('never-sent cancellation uses SDK cancellation; unknown inference absence requires terminal SDK reconciliation', async t => {
  const h = await fixture(t); await h.ui.prepare('note'); await h.ui.recoverClose('note');
  assert.equal((await h.journal.read('note'))!.value.pending, null); assert.equal(h.counts.auth, 0);
  await h.ui.prepare('note'); h.behavior.loseResponse = true; h.behavior.absentOperation = true;
  await assert.rejects(h.ui.sendOnce('note')); await assert.rejects(h.ui.reconcileAbsent('note'));
  await assert.rejects(h.ui.recoverClose('note')); await h.ui.reconcileAbsent('note');
  const r = (await h.journal.read('note'))!.value; assert.equal(r.pending, null); assert.equal(r.history[0].operations[0].phase, 'not_accepted');
  assert.equal(r.state.balance_micro_usdc, '1000000'); assert.equal(h.counts.inference, 1);
});
test('two UI intents cannot create two operations; different body or case is rejected before control/inference', async t => {
  const h = await fixture(t); await h.ui.prepare('note');
  const result = await Promise.allSettled([h.ui.sendOnce('note'), new UiProvider(h.options).sendOnce('note')]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1); assert.equal(h.counts.inference, 1);
  for (const change of [{id: 'other'}, {stream: true}, {max_output_tokens: 129}, {provider: 'anthropic'}]) assert.throws(() => new UiProvider({...h.options, configuration: {...h.options.configuration, testCase: {...h.options.configuration.testCase, ...change}}}));
  const r = (await h.journal.read('note'))!; r.value.pending!.operations[0].bodyBase64 = Buffer.from('{}').toString('base64');
  await h.journal.compareAndSwap('note', r.revision, r.value); await assert.rejects(h.ui.recoverClose('note')); assert.equal(h.counts.close, 0);
});
