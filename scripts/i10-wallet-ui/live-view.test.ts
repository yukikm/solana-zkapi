/** Synthetic journal snapshots test presentation boundaries, not live acceptance. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {NoteJournal, PendingSession, PreparedSession} from '../../packages/sdk/src/control.ts';
import type {WalletOperation} from '../../packages/sdk/src/wallet.ts';
import type {Attempt} from '../../packages/sdk/src/transport.ts';
import {liveView, canRefreshExpiredSetup, canRetryRejected, providerPrepareHint} from './live-view.ts';

const field = '0x' + '01'.padStart(64, '0');
const signature = {r_x: field, r_y: field, s: field};
const roles = {uploader: 'fixture', rentPayer: 'fixture', feePayer: 'fixture', payer: 'fixture'};
const prepared: PreparedSession = {
  request: {
    authorization: {version: '1', deployment_id: 'fixture', pool: 'fixture', request_id: 'fixture', quote_hash: 'fixture', mode: 'proxy', control_secret_hash: 'fixture', proxy_secret_hash: 'fixture'},
    quote: {body: {quote_id: 'fixture', deployment_id: 'fixture', pool: 'fixture', mode: 'proxy', provider: 'openrouter', models: ['fixture'], tariff_hash: 'fixture', cap_micro_usdc: '1000000', issued_at: '0', expires_at: '1', session_ttl_seconds: '1', max_concurrency: '1', control_api_origin: 'https://control.invalid', inference_api_origin: 'https://inference.invalid'}, quote_hash: 'fixture', signature: 'fixture'},
    public_inputs: [], proof: {backend: 'groth16_bn254', proof: 'fixture'},
  }, control_token: 'fixture', proxy_token: 'fixture', rerandomization: field,
  tariff: {tariff_hash: 'fixture', version: '1', provider: 'openrouter', model: 'fixture', pricing_basis: 'fixture', valid_from: '0', valid_until: '1', rates: [], operator_fee_micro_usdc: '0'},
};
function journal(): NoteJournal {
  return {schema: 1, state: {balance_micro_usdc: '1000000', balance_blinding: field, note_leaf: field, commitment: {x: field, y: field}, anchor: field, state_signature: null},
    pending: null, history: [], wallet: {status: 'active', history: []}};
}
function pending(phase: PendingSession['phase'], operationPhase?: PendingSession['operations'][number]['phase']): PendingSession {
  return {prepared: structuredClone(prepared), exactRequest: JSON.stringify(prepared.request), phase,
    operations: operationPhase ? [{id: 'fixture', path: '/v1/chat/completions', anthropicVersion: '', bodyBase64: 'e30=', phase: operationPhase}] : []};
}
function operation(kind: WalletOperation['kind'] = 'deposit', phase: WalletOperation['phase'] = 'ready'): Extract<WalletOperation, {transport?: 'v0_buffer'}> {
  return {id: 'fixture', kind, phase, roles, step: 0, attempts: [], finalized: []};
}
function attempt(kind: Attempt['kind'], id = kind): Attempt {
  return {schema: 1, kind, signature: id, wireHex: '00', blockhash: 'fixture', lastValidBlockHeight: 1, planDigest: 'fixture', buffer: 'fixture',
    plan: {programId: 'fixture', pool: 'fixture', operation: 'mutual_close', payloadHex: '00', nonceHex: '00', expires: '1', uploader: 'fixture', rentPayer: 'fixture', feePayer: 'fixture', snapshotSlot: 1, snapshotSequence: '1', expectedRoot: field, expectedNoteId: 0, financial: {} as Attempt['plan']['financial']}};
}
function settle(j: NoteJournal, charge = '18', evidence = 'PROXY_USAGE'): void {
  j.history.push({previous: structuredClone(j.state), prepared: structuredClone(prepared),
    settlement: {charge_micro_usdc: charge, next_commitment: {x: field, y: field}, next_anchor: field, blind_delta_srv: field, next_state_signature: signature},
    receipts: [{body: {receipt_id: 'fixture', operation_id: 'fixture', billing_effect: 'charge', evidence_kind: evidence}, receipt_hash: 'fixture', signature: 'fixture'}], operations: []});
  j.state.balance_micro_usdc = (BigInt(j.state.balance_micro_usdc) - BigInt(charge)).toString();
  j.state.state_signature = signature;
}
const view = (j: NoteJournal | null, extra = {}) => liveView({journal: j, connected: true, providerConfigured: true, ...extra});

test('compact deposit offers one signature and explicit rejection recovery, never expired-setup recovery', () => {
  const j = journal(); j.schema = 2; j.wallet!.status = 'unfunded';
  const op: Extract<WalletOperation, {transport: 'v0_inline_deposit_v1'}> = {
    id: 'fixture', kind: 'deposit', phase: 'ready', roles, step: 0, attempts: [], finalized: [], transport: 'v0_inline_deposit_v1',
    inlineContext: {deploymentId:'fixture',manifestHash:'00'.repeat(32),programId:'fixture',pool:'fixture',mint:'fixture',vaultBinding:field} };
  j.wallet!.operation = op;
  assert.match(view(j).nextAction, /Sign the deposit once/);
  assert.equal(canRetryRejected(j), false);
  assert.equal(canRefreshExpiredSetup(j), false);
  op.attempts = [{...attempt('execute'),schema:2,kind:'deposit_inline'} as unknown as typeof op.attempts[number]];
  op.current = 'execute';
  assert.match(view(j).nextAction, /No new signature/);
  assert.equal(canRetryRejected(j), false);
  for (const phase of ['stale', 'failed'] as const) {
    op.phase = phase;
    assert.equal(canRetryRejected(j), false, 'a current signature stays unresolved');
    delete op.current;
    assert.equal(canRetryRejected(j), true);
    assert.match(view(j).nextAction, /Retry confirmed rejection/);
    assert.equal(canRefreshExpiredSetup(j), false);
    op.current = 'execute';
  }
  delete op.current; op.phase = 'ready';
  assert.equal(canRetryRejected(j), false, 'expiry/absence alone does not authorize retry');
});

test('expired setup recovery is offered only for unresolved create-only deposits', () => {
  const j = journal(), a = attempt('create');
  a.plan.operation = 'deposit'; j.wallet!.status = 'unfunded';
  j.wallet!.operation = {...operation(), plan: a.plan, attempts: [a], current: a.signature};
  assert.equal(canRefreshExpiredSetup(j), true);
  const cases: Array<(copy: NoteJournal) => void> = [
    c => { c.wallet!.status = 'active'; },
    c => { c.wallet!.operation!.kind = 'mutual_close'; },
    c => { c.wallet!.operation!.step = 1; },
    c => { c.wallet!.operation!.attempts.unshift(attempt('append')); },
    c => { c.wallet!.operation!.attempts[0].kind = 'seal'; },
    c => { c.wallet!.operation!.attempts.push(attempt('execute')); },
    c => { c.wallet!.operation!.finalized.push({signature: a.signature, slot: 5}); },
    c => { c.wallet!.operation!.phase = 'proving'; },
    c => { c.pending = pending('send_unknown'); },
  ];
  for (const change of cases) { const copy = structuredClone(j); change(copy); assert.equal(canRefreshExpiredSetup(copy), false); }
  assert.equal(canRefreshExpiredSetup(null), false);
});

test('expired mutual-close setup is offered only with verified clearance and create-only saved attempts', () => {
  const j = journal(), a = attempt('create');
  j.wallet!.clearance = {nullifier: field, phase: 'verified', signature};
  j.wallet!.operation = {...operation('mutual_close'), destinationOwner: 'saved-destination', plan: a.plan, attempts: [a], current: a.signature};
  assert.equal(canRefreshExpiredSetup(j), true);
  const before = JSON.stringify(j);
  const cases: Array<(copy: NoteJournal) => void> = [
    c => { c.wallet!.status = 'unfunded'; },
    c => { c.wallet!.clearance!.phase = 'requested'; },
    c => { delete c.wallet!.clearance!.signature; },
    c => { delete c.wallet!.clearance; },
    c => { delete c.wallet!.operation!.destinationOwner; },
    c => { c.pending = pending('prepared'); },
    c => { c.pending = pending('send_unknown'); },
    c => { c.wallet!.operation!.kind = 'initiate_escape'; },
    c => { c.wallet!.operation!.plan!.operation = 'deposit'; },
    c => { c.wallet!.operation!.step = 1; },
    c => { c.wallet!.operation!.attempts.unshift(attempt('append')); },
    c => { c.wallet!.operation!.attempts.unshift(attempt('execute')); },
    c => { c.wallet!.operation!.attempts.unshift(attempt('close')); },
    c => { c.wallet!.operation!.finalized.push({signature: a.signature, slot: 5}); },
    c => { c.wallet!.operation!.phase = 'proving'; },
    c => { c.wallet!.operation!.current = 'different-signature'; },
  ];
  for (const change of cases) { const copy = structuredClone(j); change(copy); assert.equal(canRefreshExpiredSetup(copy), false); }
  assert.equal(JSON.stringify(j), before);
});

test('unfunded or disconnected state never presents candidate deposit as usable money', () => {
  const j = journal(); j.wallet!.status = 'unfunded';
  j.wallet!.operation = operation('deposit', 'proving');
  assert.equal(view(j).balance, '—'); assert.equal(view(j).stepIndex, 0);
  assert.match(view(j).proofStatus, /pending/);
  assert.equal(view(null).balance, '—');
  assert.equal(view(null).paid, '—'); assert.equal(view(j).paid, '0.000000');
  assert.equal(view(j, {connected: false}).title, 'Reconnect your wallet');
  assert.equal(view(null, {connected: false}).title, 'Connect your wallet');
  assert.match(view(null, {connected: false}).description, /select your Devnet account/);
});

test('active deposit is available only without unresolved session or wallet operation', () => {
  const j = journal(); assert.equal(view(j).balance, '1.000000'); assert.equal(view(j).stepIndex, 1);
  j.wallet!.operation = operation('mutual_close'); assert.equal(view(j).balance, '—');
  assert.equal(view(j).returned, '—');
  delete j.wallet!.operation;
  j.pending = pending('prepared'); assert.equal(view(j).balance, '—');
});

test('unknown AUTH remains distinguishable from an accepted session and successful API response', () => {
  const j = journal(); j.pending = pending('send_unknown');
  const v = view(j);
  assert.equal(v.title, 'Authorization outcome unknown'); assert.equal(v.stepIndex, 1);
  assert.match(v.proofStatus, /unconfirmed/); assert.match(v.receiptStatus, /no verified settlement/);
  assert.equal(v.paid, '0.000000'); assert.equal(v.balance, '—');
  j.pending.phase = 'active'; assert.equal(view(j).title, 'Authorization accepted');
  assert.match(view(j).description, /still need to be verified/);
});

test('unknown inference prevents replay instructions even when session is active or closing', () => {
  const j = journal();
  for (const phase of ['active', 'closing'] as const) {
    j.pending = pending(phase, 'send_unknown');
    const v = view(j);
    assert.equal(v.title, 'API outcome unknown'); assert.equal(v.stepIndex, 2);
    assert.match(v.description, /must not be replayed/);
    assert.doesNotMatch(v.nextAction, /Send the saved request/);
    assert.equal(v.balance, '—'); assert.match(v.receiptStatus, /unverified/);
  }
});

test('current-page response observation explains a saved unknown operation without advancing financial state', () => {
  const j = journal(); j.pending = pending('active', 'send_unknown');
  const before = JSON.stringify(j), unobserved = view(j), observed = view(j, {responseObserved: true});
  assert.equal(unobserved.title, 'API outcome unknown');
  assert.equal(observed.title, 'API response received');
  assert.match(observed.description, /charge and remaining balance still await signed settlement/);
  assert.match(observed.receiptStatus, /unverified/);
  assert.match(observed.nextAction, /Recover or close/);
  assert.match(observed.nextAction, /do not send another API request/);
  assert.equal(observed.balance, '—'); assert.equal(observed.paid, '0.000000'); assert.equal(observed.returned, '—');
  assert.equal(JSON.stringify(j), before);
  // A reload has no current-page observation and must keep recovery conservative.
  assert.deepEqual(view(structuredClone(j)), unobserved);
  j.pending.phase = 'closing';
  assert.equal(view(j, {responseObserved: true}).title, 'Settlement pending');
  assert.equal(view(j).title, 'API outcome unknown');
  assert.match(view(j, {responseObserved: true}).receiptStatus, /unverified/);
  j.pending.operations.push({...j.pending.operations[0], id: 'another-operation'});
  assert.equal(view(j, {responseObserved: true}).title, 'API outcome unknown');
});

test('a received answer is not a signed settlement or a paid charge', () => {
  const j = journal(); j.pending = pending('active', 'response_received');
  const v = view(j);
  assert.equal(v.title, 'API response received'); assert.equal(v.stepIndex, 2);
  assert.match(v.description, /does not yet establish a verified charge/);
  assert.equal(v.paid, '0.000000'); assert.equal(v.returned, '—');
  j.pending.phase = 'closing'; assert.equal(view(j).title, 'Settlement pending');
  assert.match(view(j).proofStatus, /verification pending/);
});

test('terminal absence and close intent do not encourage an API send', () => {
  const j = journal(); j.pending = pending('active', 'not_accepted');
  assert.equal(view(j).title, 'API request not accepted');
  assert.doesNotMatch(view(j).nextAction, /Send the saved request/);
  j.pending = {...pending('send_unknown'), closeRequested: true};
  assert.equal(view(j).title, 'Settlement pending');
  assert.match(view(j).nextAction, /Recover or close/);
});

test('only verified settlement history contributes to paid; latest pending session stays unverified', () => {
  const j = journal(); settle(j); settle(j, '11');
  assert.equal(view(j).paid, '0.000029'); assert.equal(view(j).balance, '0.999971');
  assert.equal(view(j).stepIndex, 3); assert.equal(view(j).title, 'Signed settlement verified');
  assert.match(view(j).receiptStatus, /2 signed settlements/);
  j.pending = pending('active', 'response_received');
  assert.equal(view(j).paid, '0.000029'); assert.match(view(j).receiptStatus, /^Current session has no verified settlement/);
  assert.equal(view(j).balance, '—');
});

test('zero-charge and operator-loss waiver do not establish successful API use', () => {
  const j = journal(); settle(j, '0', 'UNKNOWN_OPERATOR_LOSS');
  const v = view(j);
  assert.equal(v.title, 'Session closed with no charge'); assert.equal(v.paid, '0.000000');
  assert.match(v.description, /does not establish successful API usage/);
  assert.match(v.receiptStatus, /Operator-loss waiver/); assert.match(v.receiptStatus, /UNKNOWN_OPERATOR_LOSS/);
  j.wallet!.status = 'closed';
  assert.equal(view(j).title, 'Withdrawal complete'); assert.doesNotMatch(view(j).title, /API|demo/);
  assert.match(view(j).receiptStatus, /Operator-loss waiver/);
});

test('mutual-close return amount requires closed note and exact finalized execute signature', () => {
  const j = journal(); settle(j);
  const close = operation('mutual_close');
  close.attempts = [attempt('append'), attempt('execute')];
  close.finalized = [{signature: 'append', slot: 1}]; j.wallet!.history.push(close);
  assert.equal(view(j).returned, '—');
  j.wallet!.status = 'closed';
  assert.equal(view(j).balance, '0.000000'); assert.equal(view(j).returned, '—');
  close.finalized.push({signature: 'different-execute-signature', slot: 2});
  assert.equal(view(j).returned, '—');
  close.finalized.push({signature: 'execute', slot: 3});
  assert.equal(view(j).returned, '0.999982');
  assert.equal(view(j).title, 'Withdrawal complete');
  close.phase = 'cancelled'; assert.equal(view(j).returned, '—');
});

test('escape status, current signature and failed operation retain recovery presentation', () => {
  const j = journal(); j.wallet!.status = 'pending_escape';
  assert.equal(view(j).stepIndex, 3); assert.equal(view(j).returned, '—'); assert.equal(view(j).balance, '—');
  assert.equal(view(j).title, 'Escape withdrawal pending');
  j.wallet!.status = 'active'; j.wallet!.operation = operation('mutual_close');
  j.wallet!.operation.current = 'saved-signature';
  assert.equal(view(j).title, 'Withdrawal confirmation pending');
  assert.match(view(j).description, /exact transaction/);
  j.wallet!.operation.phase = 'failed'; assert.equal(view(j).title, 'Withdrawal needs review');
  j.wallet!.operation.phase = 'stale'; assert.equal(view(j).title, 'Withdrawal proof needs recovery');
});

test('signed clearance and missing provider never offer another API authorization', () => {
  const j = journal();
  const missing = view(j, {providerConfigured: false});
  assert.equal(missing.title, 'Provider unavailable'); assert.match(missing.nextAction, /withdraw/);
  j.wallet!.clearance = {nullifier: field, phase: 'verified', signature};
  assert.equal(view(j).stepIndex, 3); assert.equal(view(j).title, 'Withdrawal clearance verified');
  assert.match(view(j).nextAction, /withdrawal recovery/);
});

test('integer formatting preserves micro-USDC beyond JavaScript safe integer precision', () => {
  const j = journal(); j.state.balance_micro_usdc = '18446744073709551615';
  assert.equal(view(j).balance, '18446744073709.551615');
  settle(j, '9007199254740993');
  assert.equal(view(j).paid, '9007199254.740993');
  assert.equal(view(j).balance, '18437736874454.810622');
});

test('busy/disconnected headlines take precedence, and projection leaves journal byte-equivalent', () => {
  const j = journal(); settle(j); const before = JSON.stringify(j);
  const v = view(j, {connected: false});
  assert.equal(v.title, 'Reconnect your wallet'); assert.equal(v.balance, '—');
  assert.equal(view(j, {busy: true}).title, 'Working on the current step');
  assert.match(view(j, {busy: true}).nextAction, /Wait/);
  assert.equal(JSON.stringify(j), before);
  assert.deepEqual(view(j), view(structuredClone(j)));
});

test('repeat demo explains the exact authorization reserve without enabling an underfunded request', () => {
  const j = journal(); settle(j, '4');
  const input = {journal: j, connected: true, providerConfigured: true, authorizationCapMicroUsdc: '1000000'};
  const hint = providerPrepareHint(input), v = view(j, {authorizationCapMicroUsdc: '1000000'});
  assert.match(hint, /0\.999996 USDC/); assert.match(hint, /1\.000000 USDC authorization reserve/);
  assert.match(hint, /reserve is not an API fee/); assert.match(v.nextAction, /Withdraw.*new 2 USDC deposit/);
  const before = JSON.stringify(j); providerPrepareHint(input); assert.equal(JSON.stringify(j), before);
  j.state.balance_micro_usdc = '1999996';
  assert.match(providerPrepareHint(input), /fresh authorization/);
  assert.match(view(j, {newRequestAvailable: true, authorizationCapMicroUsdc: '1000000'}).nextAction, /Prepare a new AI request/);
});

test('disabled-request hints distinguish reconnect, saved recovery, clearance and completed run', () => {
  const j = journal(), input = {journal: j, connected: true, providerConfigured: true};
  assert.match(providerPrepareHint({...input, connected: false}), /Connect Phantom.*original Devnet account/);
  assert.match(providerPrepareHint({...input, busy: true}), /Wait/);
  assert.match(providerPrepareHint({...input, providerConfigured: false}), /unavailable.*recovery and withdrawal/);
  j.pending = pending('send_unknown'); assert.match(providerPrepareHint(input), /uncertain API request is never replayed/);
  j.pending = null; j.wallet!.clearance = {nullifier: field, phase: 'verified', signature};
  assert.match(providerPrepareHint(input), /reserved for withdrawal/);
  delete j.wallet!.clearance; j.wallet!.status = 'closed';
  assert.match(providerPrepareHint(input), /Start another demo.*previous records are retained/);
  assert.match(view(j).nextAction, /Start another demo.*completed demo remains saved/);
});
