/** Real encrypted storage/locks, synthetic wallet records; no live-chain claim. */
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EncryptedJournal, importJournalKey} from '../../packages/sdk/src/journal.ts';
import {NativeJournalStore} from '../../packages/sdk/src/journal-node.ts';
import {validateNoteJournal, type NoteJournal, type PendingSession} from '../../packages/sdk/src/control.ts';
import {fixtureState, providerFixture} from './provider.fixture.ts';
import {beginNextDemoDeposit, canStartDemo, checkedProviderBudget, demoNoteId, latestDemoNote, legacyDemoNoteId, type UiProviderBudget} from './demo-notes.ts';

const roles = {uploader: 'fixture', rentPayer: 'fixture', feePayer: 'fixture', payer: 'fixture', tokenOwner: 'fixture'};
function note(status: NonNullable<NoteJournal['wallet']>['status'] = 'closed'): NoteJournal {
  return {schema: 1, state: fixtureState(), witness: {secret: '0x' + '01'.padStart(64, '0'), note_id: 0, deposit_micro_usdc: '1000000', expiry: '86400'},
    wallet: {status, history: []}, pending: null, history: []};
}
function deposit(): NoteJournal {
  const j = note('unfunded'); j.state.balance_micro_usdc = '2000000'; j.witness!.deposit_micro_usdc = '2000000';
  j.wallet!.operation = {id: crypto.randomUUID(), kind: 'deposit', phase: 'proving', roles, step: 0, attempts: [], finalized: []};
  return j;
}
async function fixture(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'zkapi-demo-runs-')); t.after(() => rm(path, {recursive: true, force: true}));
  const key = await importJournalKey(new Uint8Array(32).fill(56));
  const open = async () => new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(path), key, {deploymentId: 'fixture', pool: 'fixture'}, validateNoteJournal);
  return {open, journal: await open()};
}
test('initial deposit retains legacy ID and uses two USDC; reopened SDK operation blocks replacement', async t => {
  const h = await fixture(t), calls: string[] = [];
  assert.equal((await latestDemoNote(h.journal)).id, legacyDemoNoteId);
  await beginNextDemoDeposit(h.journal, {async beginDeposit(id, amount, actualRoles) {
    calls.push(id); assert.equal(amount, '2000000'); assert.deepEqual(actualRoles, roles); await h.journal.create(id, deposit());
  }}, roles);
  const reopened = await h.open(), selected = await latestDemoNote(reopened);
  assert.equal(selected.runNumber, 1); assert.equal(selected.record!.value.wallet!.operation!.phase, 'proving');
  await assert.rejects(beginNextDemoDeposit(reopened, {async beginDeposit() { calls.push('unexpected'); }}, roles));
  assert.deepEqual(calls, [legacyDemoNoteId]);
});
test('closed-note rotation preserves prior ciphertext and history; reload selects the new note', async t => {
  const h = await fixture(t), old = note(); await h.journal.create(legacyDemoNoteId, old);
  const before = await h.journal.exportBackup(legacyDemoNoteId);
  await beginNextDemoDeposit(h.journal, {async beginDeposit(id) { assert.equal(id, demoNoteId(2)); await h.journal.create(id, deposit()); }}, roles);
  assert.deepEqual(await h.journal.exportBackup(legacyDemoNoteId), before);
  const latest = await latestDemoNote(await h.open());
  assert.equal(latest.runNumber, 2); assert.equal(latest.id, demoNoteId(2)); assert.equal(latest.record!.value.wallet!.status, 'unfunded');
  assert.deepEqual((await h.journal.read(legacyDemoNoteId))!.value, old);
});
test('two independent journal clients cannot allocate two new active deposits', async t => {
  const h = await fixture(t); await h.journal.create(legacyDemoNoteId, note());
  const second = await h.open(), calls: string[] = [];
  const start = (journal: typeof h.journal) => beginNextDemoDeposit(journal, {async beginDeposit(id) { calls.push(id); await journal.create(id, deposit()); }}, roles);
  const results = await Promise.allSettled([start(h.journal), start(second)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.deepEqual(calls, [demoNoteId(2)]); assert.equal(await h.journal.read(demoNoteId(3)), null);
});
test('failure after SDK creation reopens that saved operation; failure before creation reuses the same absent ID', async t => {
  const h = await fixture(t);
  await assert.rejects(beginNextDemoDeposit(h.journal, {async beginDeposit() { throw Error('snapshot unavailable'); }}, roles));
  assert.equal((await latestDemoNote(await h.open())).record, null);
  await assert.rejects(beginNextDemoDeposit(h.journal, {async beginDeposit(id) { await h.journal.create(id, deposit()); throw Error('proof interrupted'); }}, roles));
  const restarted = await h.open(), latest = await latestDemoNote(restarted);
  assert.equal(latest.id, legacyDemoNoteId); assert.equal(latest.record!.value.wallet!.operation!.phase, 'proving');
  await assert.rejects(beginNextDemoDeposit(restarted, {async beginDeposit() { assert.fail('must resume proof'); }}, roles));
  assert.equal(await restarted.read(demoNoteId(2)), null);
});
test('paid active legacy balance, uncertain sessions, and incomplete withdrawals never allow a new deposit', async t => {
  const h = await fixture(t), paid = note('active'); paid.state.balance_micro_usdc = '999996';
  await h.journal.create(legacyDemoNoteId, paid);
  await assert.rejects(beginNextDemoDeposit(h.journal, {async beginDeposit() { assert.fail('existing funds retained'); }}, roles));
  for (const status of ['active', 'unfunded', 'pending_escape'] as const) assert.equal(canStartDemo(note(status)), false);
  for (const phase of ['prepared', 'send_unknown', 'active', 'closing'] as const) {
    const j = note(); j.pending = {phase} as PendingSession; assert.equal(canStartDemo(j), false);
  }
  const unresolved = note(); unresolved.wallet!.operation = deposit().wallet!.operation;
  assert.equal(canStartDemo(unresolved), false); assert.equal(canStartDemo(note()), true); assert.equal(canStartDemo(null), true);
});
test('discovery refuses a later run while an earlier note remains unresolved', async t => {
  const h = await fixture(t); await h.journal.create(legacyDemoNoteId, note('active')); await h.journal.create(demoNoteId(2), deposit());
  await assert.rejects(latestDemoNote(h.journal), /earlier demo note still unresolved/);
  assert.throws(() => demoNoteId(0)); assert.throws(() => demoNoteId(Number.MAX_SAFE_INTEGER + 1));
});
test('read-only budget snapshot validates identity and exact integer accounting; zero availability is valid', async t => {
  const h = await fixture(t), f = await providerFixture(h.journal, 'not-created');
  const configuration = {...f.options.configuration, requestPolicy: 'explicit_demo' as const};
  const b: UiProviderBudget = {schema: 1, plan_sha256: configuration.planSha256,
    budget_micro_usdc: '10000000', reserved_micro_usdc: '96385', remaining_micro_usdc: '9903615',
    max_requests: 18, reserved_requests: 5, remaining_requests: 13, request_max_cost_micro_usdc: configuration.testCase.max_cost_micro_usdc,
    available_requests: 13, request_policy: 'explicit_demo'};
  assert.deepEqual(checkedProviderBudget(b, configuration), b);
  for (const patch of [{plan_sha256: '00'.repeat(32)}, {request_policy: 'single_acceptance_case'}, {request_max_cost_micro_usdc: '1'},
    {remaining_micro_usdc: '09903615'}, {reserved_requests: 4}, {available_requests: 14}, {reserved_micro_usdc: '1'}, {available_requests: -1}])
    assert.throws(() => checkedProviderBudget({...b, ...patch}, configuration));
  assert.equal(checkedProviderBudget({...b, available_requests: 0}, configuration).available_requests, 0);
});
