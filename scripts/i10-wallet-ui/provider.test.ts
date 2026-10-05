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
import {failureCode} from './diagnostics.ts';
async function fixture(t: TestContext, balance = '1000000') {
  const path = await mkdtemp(join(tmpdir(), 'zkapi-provider-ui-')); t.after(() => rm(path, {recursive: true, force: true}));
  const key = await importJournalKey(new Uint8Array(32).fill(55));
  const open = async () => new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(path), key, {deploymentId: 'fixture', pool: 'fixture'}, validateNoteJournal);
  const journal = await open();
  await journal.create('note', {schema: 1, state: {...fixtureState(), balance_micro_usdc: balance}, witness: {secret: '0x' + '01'.padStart(64, '0'), note_id: 0, deposit_micro_usdc: balance, expiry: '86400'}, wallet: {status: 'active', history: []}, pending: null, history: []});
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

test('explicit demo uses a new AUTH and operation only after SDK verified the prior zero-charge successor', async t => {
  const h = await fixture(t), ui = new UiProvider({...h.options, configuration: {...h.options.configuration, requestPolicy:'explicit_demo'}});
  await ui.prepare('note'); h.behavior.httpStatus=503; h.behavior.zeroCharge=true;
  await assert.rejects(ui.sendOnce('note'), e => failureCode(e) === 'api_http_503_operation_unavailable');
  const previous = structuredClone((await h.journal.read('note'))!.value.pending!);
  await assert.rejects(ui.prepare('note')); await assert.rejects(ui.sendOnce('note'));
  assert.equal(h.counts.inference, 1);
  h.behavior.rejectSettlement=true; await assert.rejects(ui.recoverClose('note')); await assert.rejects(ui.prepare('note'));
  h.behavior.rejectSettlement=false; await ui.recoverClose('note');
  const settled = structuredClone((await h.journal.read('note'))!.value.history[0]);
  const reopened = new UiProvider({...h.options, journal: await h.open(), configuration:{...h.options.configuration, requestPolicy:'explicit_demo'}});
  await reopened.prepare('note');
  const next = (await h.journal.read('note'))!.value.pending!;
  assert.notEqual(next.prepared.request.authorization.request_id, previous.prepared.request.authorization.request_id);
  h.behavior.httpStatus=200; h.behavior.zeroCharge=false;
  const response = await reopened.sendOnce('note'); assert.equal(response.text,'ok');
  assert.notEqual(response.operationId, previous.operations[0].id);
  await assert.rejects(reopened.sendOnce('note')); await reopened.recoverClose('note');
  const after=(await h.journal.read('note'))!.value;
  assert.equal(after.history.length,2); assert.deepEqual(after.history[0],settled); assert.equal(after.state.balance_micro_usdc,'999999');
  await assert.rejects(reopened.prepare('note')); assert.equal(h.counts.inference,2);
});

test('a funded repeat demo preserves paid settlements and uses fresh request IDs across journal reopen', async t => {
  const h = await fixture(t, '2000000');
  const requestIds = new Set<string>(), operationIds = new Set<string>();
  let history: NoteJournal['history'] = [];
  for (let run = 0; run < 3; run++) {
    const journal = await h.open();
    const ui = new UiProvider({...h.options, journal, configuration: {...h.options.configuration, requestPolicy: 'explicit_demo'}});
    await ui.prepare('note');
    const prepared = (await journal.read('note'))!.value.pending!;
    const requestId = prepared.prepared.request.authorization.request_id;
    assert.equal(requestIds.has(requestId), false); requestIds.add(requestId);
    const response = await ui.sendOnce('note');
    assert.equal(operationIds.has(response.operationId), false); operationIds.add(response.operationId);
    assert.equal(response.text, 'ok');
    await assert.rejects(ui.sendOnce('note'));
    await assert.rejects(ui.prepare('note'));
    await ui.recoverClose('note');
    const saved = (await journal.read('note'))!.value;
    assert.equal(saved.pending, null);
    assert.equal(saved.state.balance_micro_usdc, (2_000_000n - BigInt(run + 1)).toString());
    assert.deepEqual(saved.history.slice(0, run), history);
    assert.equal(saved.history[run].settlement.charge_micro_usdc, '1');
    history = structuredClone(saved.history);
  }
  assert.deepEqual([h.counts.inference, h.counts.auth, h.counts.quotes, h.counts.verification], [3, 3, 3, 3]);
});
