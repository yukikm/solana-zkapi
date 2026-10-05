/** Offline observations and real SDK control-journal tests with synthetic HTTP/crypto fixtures; no public RPC, prover or daemon runs. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {challengeRestored, type EscapeReady} from './i10_devnet_challenge.ts';
import type {WalletSnapshot} from '../packages/sdk/src/wallet-chain.ts';

const ready: EscapeReady = {schema: 1, pool: 'test-pool', note_id: 7,
  request_id: 'test-request', nullifier: 'old-nullifier', escape_signature: 'test-signature',
  escape_slot: 110, deadline: '1600', escaped_root: 'removed-root', escaped_sequence: '8',
  historical_request_root: 'restored-root', stale_sdk_pending_escape: true, external_challenger_may_start: true};
const active: WalletSnapshot = {slot: 113, root: 'restored-root', sequence: '9', siblings: [],
  nextNoteId: 8, clock: '1010', paused: false, treasuryOwner: 'test-owner',
  note: {note_id: 7, registration_commitment: 'commitment', deposit_micro_usdc: '1000000', expiry: '2000', status: 'active'}};

test('restoration requires the exact next tree transition and finalized note state', () => {
  assert.equal(challengeRestored(active, ready), true);
  for (const changed of [
    {...active, slot: 109}, {...active, root: 'different-root'},
    {...active, sequence: '8'}, {...active, sequence: '11'},
    {...active, note: undefined}, {...active, note: {...active.note!, note_id: 8}},
    {...active, note: {...active.note!, status: 'closed' as const}},
    {...active, note: {...active.note!, status: 'pending_escape' as const}},
    {...active, pending: {nullifier: 'old-nullifier', balance_micro_usdc: '1000000', destinationOwner: 'test-owner', deadline: '1600'}},
  ]) assert.equal(challengeRestored(changed, ready), false);
});

test('advancing finalized slot is permitted without accepting an ABA tree sequence', () => {
  assert.equal(challengeRestored({...active, slot: 250}, ready), true);
  assert.equal(challengeRestored({...active, slot: 250, sequence: '13'}, ready), false);
  assert.equal(challengeRestored({...active, slot: 110}, ready), true);
});

// The following exercises the real SDK durable control state machine with a
// synthetic HTTP adapter and explicit fixture verifier. It proves retry wiring,
// not RP/signature validity or provider/public-chain acceptance.
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ControlClient, ControlHttpError, validateNoteJournal,
  type NoteJournal, type PreparedSession, type PrivateState, type VerificationContext} from '../packages/sdk/src/control.ts';
import {EncryptedJournal, importJournalKey} from '../packages/sdk/src/journal.ts';
import {NativeJournalStore} from '../packages/sdk/src/journal-node.ts';
import {retrySavedControl} from './i10_devnet_challenge.ts';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const requestId = '12345678-1234-4123-8123-123456789012';
const initial: PrivateState = {balance_micro_usdc: '100', balance_blinding: field(3), note_leaf: field(4),
  commitment: {x: field(5), y: field(6)}, anchor: field(7), state_signature: null};
const successor: PrivateState = {...initial, anchor: field(8), state_signature: {r_x: field(9), r_y: field(10), s: field(11)}};
const context: VerificationContext = {deployment_id: 'retry-fixture', pool: 'fixture-pool', vault_binding: field(1),
  state_key: [field(2), field(3)], cap_micro_usdc: '100', control_api_origin: 'https://control.invalid',
  inference_api_origin: 'https://inference.invalid', quote_public_key: '00'.repeat(32), receipt_public_key: '00'.repeat(32),
  request_vk_sha256: '00'.repeat(32), tariff_hashes: ['33'.repeat(32)]};
const prepared: PreparedSession = {request: {authorization: {version: '1', deployment_id: context.deployment_id,
  pool: context.pool, request_id: requestId, quote_hash: '00'.repeat(32), mode: 'proxy',
  control_secret_hash: '11'.repeat(32), proxy_secret_hash: '22'.repeat(32)},
  quote: {body: {quote_id: requestId, deployment_id: context.deployment_id, pool: context.pool,
    mode: 'proxy', provider: 'openai', models: ['i05-local-only'], tariff_hash: '33'.repeat(32),
    cap_micro_usdc: '100', issued_at: '100', expires_at: '220', session_ttl_seconds: '60', max_concurrency: '4',
    control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin},
    quote_hash: '00'.repeat(32), signature: 'synthetic-quote'},
  public_inputs: Array(12).fill(field(1)), proof: {backend: 'groth16_bn254', proof: 'synthetic-proof'}},
  control_token: 'zkc1.synthetic-token', proxy_token: 'zkp1.synthetic-token',
  tariff: {tariff_hash: '33'.repeat(32), version: '1', provider: 'openai', model: 'i05-local-only', pricing_basis: 'fixed_usage_rates',
    valid_from: '100', valid_until: '1000', rates: [], operator_fee_micro_usdc: '0'}, rerandomization: field(13)};

async function controlFixture(t: {after(fn: () => Promise<void>): unknown}, fetcher: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'i10-control-retry-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const key = await importJournalKey(new Uint8Array(32).fill(91));
  const journal = new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(directory), key,
    {deploymentId: context.deployment_id, pool: context.pool}, validateNoteJournal);
  await journal.create('note', {schema: 1, state: initial, pending: null, history: []});
  let prepareCount = 0, settleCount = 0;
  const client = (signal?: AbortSignal) => new ControlClient({context, journal, now: () => 150n,
    fetch: (url, init) => fetcher(url, {...init, signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal}),
    verifier: {async prepare() {prepareCount++;}, async settle(_context, previous, saved, _settlement, receipts, operations) {
      assert.deepEqual(previous, initial); assert.deepEqual(saved, prepared); assert.deepEqual(receipts, []); assert.deepEqual(operations, []);
      settleCount++; return successor;
    }}});
  await client().prepare('note', prepared, field(14));
  return {journal, client, counts: () => ({prepareCount, settleCount})};
}
const status = (state: string) => ({request_id: requestId, mode: 'proxy', state, cap_micro_usdc: '100'});

test('transient create and close failures reuse exact durable AUTH and settle once without inference', async t => {
  const requests: {url: string; method?: string; body: RequestInit['body']; authorization: string | null}[] = [];
  let create = 0, close = 0;
  const h = await controlFixture(t, async (url, init) => {
    const path = new URL(String(url)).pathname;
    requests.push({url: String(url), method: init?.method, body: init?.body, authorization: new Headers(init?.headers).get('Authorization')});
    assert.ok(init?.signal, 'deadline must reach the control HTTP request');
    if (path === '/zkapi/v1/sessions') {
      const saved = (await h.journal.read('note'))!.value.pending!;
      assert.equal(saved.phase, 'send_unknown'); assert.equal(saved.exactRequest, JSON.stringify(prepared.request));
      assert.equal(init?.body, saved.exactRequest); assert.equal(saved.operations.length, 0);
      if (++create === 1) return Response.json({}, {status: 503});
      return Response.json(status('ACTIVE'));
    }
    if (path.endsWith('/close')) {
      assert.equal((await h.journal.read('note'))!.value.pending!.phase, 'closing');
      if (++close === 1) throw Error('pinned service transport');
      return Response.json({...status('SETTLED'), settlement: {charge_micro_usdc: '0', next_commitment: successor.commitment,
        next_anchor: successor.anchor, blind_delta_srv: field(12), next_state_signature: successor.state_signature}});
    }
    assert.equal(path, `/zkapi/v1/sessions/${requestId}/receipts`);
    return Response.json({receipts: [], next_cursor: null});
  });
  // Each retry constructs a new SDK client and rereads the encrypted record.
  await retrySavedControl(signal => h.client(signal).submit('note'), Date.now() + 5000);
  await retrySavedControl(signal => h.client(signal).close('note'), Date.now() + 5000);
  const final = (await h.journal.read('note'))!.value;
  assert.equal(create, 2); assert.equal(close, 2); assert.equal(final.pending, null); assert.equal(final.history.length, 1);
  assert.deepEqual(final.state, successor); assert.deepEqual(h.counts(), {prepareCount: 1, settleCount: 1});
  assert.deepEqual(requests[0], requests[1]); assert.deepEqual(requests[2], requests[3]);
  assert.ok(requests.every(row => !row.url.includes('/inference') && !row.url.includes('/quotes')));
});

test('permanent HTTP and integrity errors stop immediately, and expired unknown AUTH is retained', async t => {
  for (const error of [...[400, 401, 403, 404, 409, 422, 500].map(n => new ControlHttpError(n)),
    Error('native verification rejected'), Error('journal integrity failure'), TypeError('invalid control origin'),
  ]) {
    let calls = 0;
    await assert.rejects(retrySavedControl(async () => {calls++; throw error;}, Date.now() + 5000), e => e === error);
    assert.equal(calls, 1);
  }
  let calls = 0;
  const h = await controlFixture(t, async () => {calls++; return Response.json({error: {code: 'quote_expired'}}, {status: 409});});
  await assert.rejects(retrySavedControl(signal => h.client(signal).submit('note'), Date.now() + 5000), ControlHttpError);
  const saved = (await h.journal.read('note'))!.value;
  assert.equal(saved.pending!.phase, 'send_unknown'); assert.equal(saved.pending!.exactRequest, JSON.stringify(prepared.request));
  await assert.rejects(h.client().cancelUnsent('note'), /possibly sent/);
  assert.deepEqual((await h.journal.read('note'))!.value, saved); assert.equal(calls, 1); assert.equal(saved.history.length, 0);
});

test('retry policy handles only named transient failures and ends at the original deadline', async () => {
  for (const error of [...[429, 502, 503, 504].map(n => new ControlHttpError(n)),
    Error('pinned service transport'), new TypeError('fetch failed'), new DOMException('fixture timeout', 'TimeoutError')]) {
    let calls = 0;
    await assert.rejects(retrySavedControl(async () => {calls++; throw error;}, Date.now() + 15), /settlement deadline/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(retrySavedControl(async () => {calls++;}, Date.now() - 1), /settlement deadline/);
  assert.equal(calls, 0);
});

test('remaining deadline aborts in-flight SDK control HTTP and retains its unknown AUTH', async t => {
  let calls = 0, aborted = false;
  const h = await controlFixture(t, async (_url, init) => {
    calls++;
    return await new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture request did not abort')), 2000);
      const stop = () => {aborted = true; clearTimeout(timer); reject(new DOMException('fixture deadline', 'AbortError'));};
      if (init?.signal?.aborted) stop(); else init?.signal?.addEventListener('abort', stop, {once: true});
    });
  });
  await assert.rejects(retrySavedControl(signal => h.client(signal).submit('note'), Date.now() + 50), /settlement deadline/);
  assert.equal(calls, 1); assert.equal(aborted, true);
  const saved = (await h.journal.read('note'))!.value;
  assert.equal(saved.pending!.phase, 'send_unknown'); assert.equal(saved.pending!.exactRequest, JSON.stringify(prepared.request));
  assert.equal(saved.history.length, 0); assert.deepEqual(h.counts(), {prepareCount: 1, settleCount: 0});
});

test('explicit recovery retries the previously unknown AUTH without a new prepare', async t => {
  const requests: {body: RequestInit['body']; authorization: string | null}[] = [];
  const h = await controlFixture(t, async (url, init) => {
    assert.equal(String(url), context.control_api_origin + '/zkapi/v1/sessions');
    assert.equal((await h.journal.read('note'))!.value.pending!.phase, 'send_unknown');
    requests.push({body: init?.body, authorization: new Headers(init?.headers).get('Authorization')});
    if (requests.length === 1) throw Error('pinned service transport');
    if (requests.length === 2) return Response.json({}, {status: 502});
    return Response.json(status('ACTIVE'));
  });
  await assert.rejects(h.client().submit('note'), /pinned service transport/);
  const original = (await h.journal.read('note'))!.value.pending!;
  await retrySavedControl(signal => h.client(signal).recover('note'), Date.now() + 5000);
  const recovered = (await h.journal.read('note'))!.value;
  assert.equal(requests.length, 3); assert.deepEqual(requests[0], requests[1]); assert.deepEqual(requests[1], requests[2]);
  assert.equal(recovered.pending!.phase, 'active'); assert.equal(recovered.pending!.exactRequest, original.exactRequest);
  assert.deepEqual(recovered.pending!.prepared, original.prepared); assert.deepEqual(recovered.pending!.operations, []);
  assert.deepEqual(h.counts(), {prepareCount: 1, settleCount: 0}); assert.equal(recovered.history.length, 0);
});
