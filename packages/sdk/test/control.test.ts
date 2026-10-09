/** Client state-machine tests use an explicit fixture verifier. They do not establish real-proof,
 * Baby-JubJub, receipt cryptography, provider or release acceptance; native verifier tests are separate. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import bs58 from 'bs58';
import { ControlClient, ResponseNotReplayable, validateNoteJournal, createCredentials, expiryNotice } from '../src/control.ts';
import type { Mode, NoteJournal, PrivateState, PreparedSession, SessionVerifier, VerificationContext, Settlement, Receipt, ClientOptions, Quote, Tariff } from '../src/control.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { jcsBytes, sha256Hex } from '../src/trust.ts';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const requestId = '12345678-1234-4123-8123-123456789012';
const operationId = '12345678-1234-4123-8123-123456789013';
const directBody = new TextEncoder().encode('{"model":"fixture-model","messages":[{"role":"user","content":"private fixture prompt"}]}');
const initial = (): PrivateState => ({ balance_micro_usdc: '100', balance_blinding: field(3), note_leaf: field(4), commitment: { x: field(5), y: field(6) }, anchor: field(7), state_signature: null });
const successor = (): PrivateState => ({ ...initial(), balance_micro_usdc: '99', anchor: field(8), state_signature: { r_x: field(9), r_y: field(10), s: field(11) } });
const settlement = (): Settlement => ({ charge_micro_usdc: '1', next_commitment: successor().commitment, next_anchor: field(8), blind_delta_srv: field(12), next_state_signature: successor().state_signature! });
const context: VerificationContext = { deployment_id: 'fixture', pool: 'pool', vault_binding: field(1), state_key: [field(2), field(3)], cap_micro_usdc: '100', control_api_origin: 'https://control.invalid', inference_api_origin: 'https://inference.invalid', quote_public_key: '00'.repeat(32), receipt_public_key: '00'.repeat(32), request_vk_sha256: '00'.repeat(32), tariff_hashes: ['33'.repeat(32)] };
function prepared(mode: Mode = 'proxy'): PreparedSession {
  return {
    request: { authorization: { version: '1', deployment_id: 'fixture', pool: 'pool', request_id: requestId, quote_hash: '00'.repeat(32), mode, control_secret_hash: '11'.repeat(32), proxy_secret_hash: mode === 'proxy' ? '22'.repeat(32) : null },
      quote: { body: { quote_id: 'quote', deployment_id: 'fixture', pool: 'pool', mode, provider: mode === 'direct_oa' ? 'oa' : 'openrouter', models: ['fixture-model'], tariff_hash: '33'.repeat(32), cap_micro_usdc: '100', issued_at: '100', expires_at: '200', session_ttl_seconds: '60', max_concurrency: '4', control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin }, quote_hash: '00'.repeat(32), signature: 'fixture-signature' },
      public_inputs: Array(12).fill(field(1)), proof: { backend: 'groth16_bn254', proof: 'fixture-not-a-real-proof' } },
    control_token: 'zkc1.fixture-secret', proxy_token: mode === 'proxy' ? 'zkp1.fixture-secret' : null,
    tariff: { tariff_hash: '33'.repeat(32), version: '1', provider: 'openrouter', model: 'fixture-model', pricing_basis: 'fixture', valid_from: '100', valid_until: '200', rates: [], operator_fee_micro_usdc: '0' }, rerandomization: field(13),
  };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const status = (mode: Mode = 'proxy', state = 'ACTIVE') => ({ request_id: requestId, mode, state, cap_micro_usdc: '100' });
interface Call { url: string; init: RequestInit }
const oaPin = { base: 'https://verifier.invalid', stationId: 'pinned-station' };
const oaEvidence = () => ({ verifier_url: oaPin.base, station_id: oaPin.stationId, station_recently_attested: true,
  key_valid_till: 230, station_signature: 'ab'.repeat(64), org_signature: 'CD'.repeat(64) });
const oaStatus = () => ({ ...status('direct_oa'), expires_at: '210', provider_key: 'oa-secret',
  provider_api_origin: context.inference_api_origin, provider_key_verification: oaEvidence() });
async function setup(t: TestContext, schema: 1 | 2 = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-control-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await NativeJournalStore.open(directory), key = await importJournalKey(new Uint8Array(32).fill(15));
  let failStorage = false;
  const journal = new EncryptedJournal<NoteJournal>({ read: key => store.read(key), withLock: (key, action) => store.withLock(key, action), compareAndSwap: async (key, revision, next) => { if (failStorage) throw new Error('fixture disk full'); await store.compareAndSwap(key, revision, next); } }, key, { deploymentId: context.deployment_id, pool: context.pool }, validateNoteJournal);
  await journal.create('note', { schema, state: initial(), pending: null, history: [] });
  const calls: Call[] = [];
  let handler: (call: Call) => Promise<Response> = async () => response(status());
  let prepareFailure = false, settleFailure = false;
  const verified: { prepares: number; settlements: { receipts: Receipt[]; operations: string[] }[] } = { prepares: 0, settlements: [] };
  const verifier: SessionVerifier = {
    async prepare() { verified.prepares++; if (prepareFailure) throw new Error('fixture invalid proof'); },
    async settle(_context, _state, _prepared, _settlement, receipts, operations) { verified.settlements.push({ receipts, operations }); if (settleFailure) throw new Error('fixture invalid successor signature'); return successor(); },
  };
  const options = { context, journal, verifier, directProviderBases: { direct_oa: context.inference_api_origin, direct_openrouter: context.inference_api_origin }, now: () => 150n, fetch: (async (url, init) => { const call = { url: String(url), init: init ?? {} }; calls.push(call); return handler(call); }) as typeof fetch };
  return { journal, calls, verified, client: new ControlClient(options), restart: () => new ControlClient(options), clientWith: (overrides: Partial<ClientOptions>) => new ControlClient({ ...options, ...overrides }), setHandler: (next: typeof handler) => { handler = next; }, failStorage: (value = true) => { failStorage = value; }, failPrepare: () => { prepareFailure = true; }, failSettlement: () => { settleFailure = true; } };
}

test('explicit absent-operation reconciliation requires terminal settlement and original crypto verification', async t => {
  const h=await setup(t);await h.client.prepare('note',prepared(),field(14));await h.client.submit('note');
  await h.client.prepareOperation('note',operationId,'/v1/chat/completions',new TextEncoder().encode('{"model":"fixture-model","store":false}'));
  h.setHandler(async()=>{throw Error('never reached server');});await assert.rejects(h.client.sendOperation('note',operationId));
  h.setHandler(async()=>response(status()));await assert.rejects(h.client.reconcileAbsentOperations('note'),/terminal/);
  h.setHandler(async call=>call.url.includes('/operations/')?response({error:{code:'not_found'}},404):call.url.endsWith('/receipts')?response({receipts:[],next_cursor:null}):response({...status('proxy','SETTLED'),settlement:settlement()}));
  await h.client.reconcileAbsentOperations('note');const r=(await h.journal.read('note'))!;
  assert.equal(r.value.pending,null);assert.equal(r.value.history[0].operations[0].phase,'not_accepted');assert.deepEqual(h.verified.settlements[0].operations,[]);
});

test('absent-operation reconciliation does not persist exclusions when the signed successor fails verification', async t => {
  const h=await setup(t);await h.client.prepare('note',prepared(),field(14));await h.client.submit('note');await h.client.prepareOperation('note',operationId,'/v1/chat/completions',new TextEncoder().encode('{"model":"fixture-model","store":false}'));
  h.setHandler(async()=>{throw Error('not sent');});await assert.rejects(h.client.sendOperation('note',operationId));h.failSettlement();
  h.setHandler(async call=>call.url.includes('/operations/')?response({},404):call.url.endsWith('/receipts')?response({receipts:[],next_cursor:null}):response({...status('proxy','SETTLED'),settlement:settlement()}));
  await assert.rejects(h.client.reconcileAbsentOperations('note'),/signature/);assert.equal((await h.journal.read('note'))!.value.pending!.operations[0].phase,'send_unknown');
});

test('prepare snapshots exact authorization and credentials; send_unknown is durable before the first POST', async t => {
  const h = await setup(t), input = prepared();
  const expected = JSON.stringify(input.request);
  await h.client.prepare('note', input, field(14)); input.request.proof.proof = 'changed'; input.control_token = 'changed';
  h.setHandler(async call => {
    const record = (await h.journal.read('note'))!;
    assert.equal(record.value.pending!.phase, 'send_unknown');
    assert.equal(record.value.pending!.exactRequest, expected);
    assert.equal(call.init.body, expected);
    assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer zkc1.fixture-secret');
    assert.equal(call.init.redirect, 'error'); assert.equal(call.init.credentials, 'omit');
    return response(status());
  });
  await h.client.submit('note'); assert.equal((await h.journal.read('note'))?.value.pending?.phase, 'active');
});

test('two callers cannot prepare two unresolved authorizations for the same note', async t => {
  const h = await setup(t);
  const results = await Promise.allSettled([h.client.prepare('note', prepared(), field(14)), h.restart().prepare('note', prepared(), field(14))]);
  assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal(h.verified.prepares, 1); assert.equal(h.calls.length, 0);
  assert.equal((await h.journal.read('note'))?.value.pending?.prepared.request.authorization.request_id, requestId);
});

test('authorization response loss recovers only identical proof/body/token, even after restart', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14));
  h.setHandler(async () => { throw new Error('response lost'); });
  await assert.rejects(h.client.submit('note'), /response lost/);
  assert.equal((await h.journal.read('note'))?.value.pending?.phase, 'send_unknown');
  h.setHandler(async () => response(status()));
  await h.restart().recover('note');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0].init.body, h.calls[1].init.body);
  assert.deepEqual(h.calls[0].init.headers, h.calls[1].init.headers);
});

test('close of an unknown create preserves exact authorization recovery and durable close intent', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14));
  h.setHandler(async () => { throw new Error('request did not reach server'); });
  await assert.rejects(h.client.submit('note'), /did not reach/);
  await assert.rejects(h.client.close('note'), /did not reach/);
  const unknown = (await h.journal.read('note'))!.value.pending!;
  assert.equal(unknown.phase, 'send_unknown');
  assert.equal(unknown.closeRequested, true);
  const exactBody = unknown.exactRequest;
  const callsBeforeRecovery = h.calls.length;
  h.setHandler(async call => {
    if (call.url.endsWith('/sessions')) {
      assert.equal(call.init.method, 'POST'); assert.equal(call.init.body, exactBody);
      return response(status());
    }
    assert.ok(call.url.endsWith('/close'));
    return response(status('proxy', 'DRAINING'));
  });
  await h.restart().recover('note');
  assert.equal(h.calls.length - callsBeforeRecovery, 2);
  assert.equal((await h.journal.read('note'))?.value.pending?.phase, 'closing');
  await assert.rejects(h.client.prepareOperation('note', operationId, '/v1/responses', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /proxy session required/);
});

test('closing an unknown direct create withholds a newly delivered key and resumes close after response loss', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared('direct_oa'), field(14));
  h.setHandler(async () => { throw new Error('create response lost'); });
  await assert.rejects(h.client.submit('note'), /response lost/);
  h.setHandler(async call => {
    if (call.url.endsWith('/sessions')) return response({ ...status('direct_oa'), provider_key: 'must-not-be-delivered', provider_api_origin: context.inference_api_origin });
    assert.ok(call.url.endsWith('/close')); throw new Error('close response lost');
  });
  await assert.rejects(h.client.close('note'), /close response lost/);
  const closing = (await h.journal.read('note'))!.value.pending!;
  assert.equal(closing.phase, 'closing'); assert.equal(closing.closeRequested, true); assert.equal(closing.providerKey, undefined);
  const before = h.calls.length;
  h.setHandler(async call => response(status('direct_oa', call.url.endsWith('/close') ? 'DRAINING' : 'ACTIVE')));
  const recovered = await h.restart().recover('note');
  assert.equal(recovered.provider_key, undefined);
  assert.equal(h.calls.length - before, 2); assert.equal(h.calls[before].init.method, 'GET');
  assert.ok(h.calls[before + 1].url.endsWith('/close'));
});

test('direct 202 or missing first key persists closing and uses saved control credential, without changing mode', async t => {
  for (const code of [200, 202]) {
    const h = await setup(t); await h.client.prepare('note', prepared('direct_oa'), field(14));
    h.setHandler(async call => {
      if (call.url.endsWith('/close')) {
        assert.equal((await h.journal.read('note'))?.value.pending?.phase, 'closing');
        assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer zkc1.fixture-secret');
        return response(status('direct_oa', 'DRAINING'));
      }
      return response(status('direct_oa'), code);
    });
    await h.client.submit('note');
    assert.equal(h.calls.length, 2); assert.ok(h.calls[1].url.endsWith('/close'));
    const saved = (await h.journal.read('note'))!.value.pending!;
    assert.equal(saved.phase, 'closing'); assert.equal(saved.prepared.request.authorization.mode, 'direct_oa'); assert.equal(saved.providerKey, undefined);
  }
});

test('direct key stays only in the current client and restart closes the same keyless session', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared('direct_openrouter'), field(14));
  h.setHandler(async () => response({ ...status('direct_openrouter'), provider_key: 'provider-secret-once', provider_api_origin: context.inference_api_origin }));
  await h.client.submit('note');
  assert.equal((await h.journal.read('note'))?.value.pending?.providerKey, undefined);
  h.setHandler(async call => {
    if (call.url === context.inference_api_origin + '/chat/completions') {
      assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer provider-secret-once');
      return response({ choices: [] });
    }
    assert.equal(call.init.method, call.url.endsWith('/close') ? 'POST' : 'GET');
    return response(status('direct_openrouter', call.url.endsWith('/close') ? 'DRAINING' : 'ACTIVE'));
  });
  await h.client.recover('note');
  await h.client.sendDirectOperation('note', operationId, '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}'));
  const restarted = h.restart();
  await assert.rejects(restarted.sendDirectOperation('note', crypto.randomUUID(), '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /active direct/);
  await restarted.recover('note');
  assert.equal((await h.journal.read('note'))!.value.pending!.phase, 'closing');
  assert.equal(h.calls.filter(c => c.url.endsWith('/sessions')).length, 1);
  assert.equal(h.calls.filter(c => c.url.endsWith('/close')).length, 1);
  assert.equal(h.calls.filter(c => c.url.endsWith('/chat/completions')).length, 1);
  await assert.rejects(h.client.sendDirectOperation('note', crypto.randomUUID(), '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /active direct/);
});

test('legacy persisted direct keys remain readable but cannot authorize inference after restart', async t => {
  for (const mode of ['direct_oa', 'direct_openrouter'] as const) await t.test(mode, async t => {
    const h = await setup(t); await h.client.prepare('note', prepared(mode), field(14));
    const r = (await h.journal.read('note'))!;
    Object.assign(r.value.pending!, { phase: 'active', serverState: 'ACTIVE', providerKey: 'legacy-secret',
      oaKeyVerification: { evidence: oaEvidence(), expiresAt: '210' } });
    await h.journal.compareAndSwap('note', r.revision, r.value);
    const before = (await h.journal.read('note'))!, restarted = h.clientWith({ oaVerifier: oaPin });
    await assert.rejects(restarted.sendDirectOperation('note', operationId, '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /active direct/);
    assert.deepEqual((await h.journal.read('note'))!.head, before.head, 'read does not migrate the existing encrypted journal');
    assert.equal(h.calls.length, 0);
    h.setHandler(async call => {
      assert.ok(call.url.startsWith(context.control_api_origin));
      return response(status(mode, call.url.endsWith('/close') ? 'DRAINING' : 'ACTIVE'));
    });
    await restarted.recover('note');
    const pending = (await h.journal.read('note'))!.value.pending!;
    assert.equal(pending.providerKey, undefined); assert.equal(pending.phase, 'closing');
    assert.equal(pending.exactRequest, before.value.pending!.exactRequest);
    assert.deepEqual(pending.operations, before.value.pending!.operations);
    assert.deepEqual(h.calls.map(c => c.init.method), ['GET', 'POST']);
    assert.ok(h.calls[1].url.endsWith('/close'));
  });
});

test('failed key-delivery persistence cannot leave a usable volatile key or change saved AUTH', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared('direct_openrouter'), field(14));
  const original = (await h.journal.read('note'))!.value.pending!.exactRequest;
  h.setHandler(async () => {
    h.failStorage();
    return response({ ...status('direct_openrouter'), provider_key: 'uncommitted-secret', provider_api_origin: context.inference_api_origin });
  });
  await assert.rejects(h.client.submit('note'), /disk full/); h.failStorage(false);
  const pending = (await h.journal.read('note'))!.value.pending!;
  assert.equal(pending.providerKey, undefined); assert.equal(pending.phase, 'send_unknown');
  assert.equal(pending.exactRequest, original); assert.equal(pending.operations.length, 0);
  await assert.rejects(h.client.sendDirectOperation('note', operationId, '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /active direct/);
  assert.equal(h.calls.length, 1);
});

test('a volatile direct key cannot hydrate a changed authorization or be replaced by a persisted key field', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared('direct_openrouter'), field(14));
  h.setHandler(async () => response({ ...status('direct_openrouter'), provider_key: 'original-key', provider_api_origin: context.inference_api_origin }));
  await h.client.submit('note');
  let r = (await h.journal.read('note'))!; r.value.pending!.providerKey = 'injected-disk-key';
  await h.journal.compareAndSwap('note', r.revision, r.value);
  h.setHandler(async call => {
    assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer original-key');
    return response({ choices: [] });
  });
  await h.client.sendDirectOperation('note', operationId, '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}'));
  r = (await h.journal.read('note'))!;
  assert.equal(r.value.pending!.providerKey, undefined);
  r.value.pending!.prepared.request.authorization.request_id = crypto.randomUUID();
  r.value.pending!.exactRequest = JSON.stringify(r.value.pending!.prepared.request);
  await h.journal.compareAndSwap('note', r.revision, r.value);
  await assert.rejects(h.client.sendDirectOperation('note', crypto.randomUUID(), '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /active direct/);
  assert.equal(h.calls.length, 2);
});

test('forgetting volatile keys does not alter custody and same-session recovery settles without another key', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared('direct_openrouter'), field(14));
  h.setHandler(async () => response({ ...status('direct_openrouter'), provider_key: 'volatile-only', provider_api_origin: context.inference_api_origin }));
  await h.client.submit('note'); const before = (await h.journal.read('note'))!;
  h.client.clearEphemeralKeys(); assert.deepEqual((await h.journal.read('note'))!.head, before.head);
  await assert.rejects(h.client.sendDirectOperation('note', operationId, '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /active direct/);
  h.setHandler(async call => response(call.url.endsWith('/receipts') ? { receipts: [], next_cursor: null }
    : { ...status('direct_openrouter', 'SETTLED'), settlement: settlement() }));
  await h.client.recover('note');
  const saved = (await h.journal.read('note'))!.value;
  assert.equal(saved.pending, null); assert.equal(saved.history.length, 1);
  assert.equal(JSON.stringify(saved).includes('volatile-only'), false);
  assert.equal(h.calls.filter(c => c.url.endsWith('/sessions')).length, 1);
  assert.equal(h.calls.filter(c => c.url.includes('chat/completions')).length, 0);
});

test('OA key without independently verifiable evidence is withheld and the same session closes', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared('direct_oa'), field(14));
  h.setHandler(async call => response(call.url.endsWith('/close') ? status('direct_oa', 'DRAINING') : {
    ...status('direct_oa'), expires_at: '210', provider_key: 'unattested-key', provider_api_origin: context.inference_api_origin,
  }));
  const result = await h.client.submit('note');
  assert.equal(result.provider_key, undefined);
  const pending = (await h.journal.read('note'))!.value.pending!;
  assert.equal(pending.providerKey, undefined); assert.equal(pending.phase, 'closing');
  assert.equal(h.calls.length, 2); assert.ok(h.calls[1].url.endsWith(`/sessions/${requestId}/close`));
  await assert.rejects(h.client.sendDirectOperation('note', operationId, '/v1/responses', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /active direct/);
});

test('OA evidence is checked before volatile key delivery and a restarted SDK cannot revive the key', async t => {
  const h = await setup(t), client = h.clientWith({ oaVerifier: oaPin });
  let verifications = 0, inference = 0;
  h.setHandler(async call => {
    if (call.url.endsWith('/sessions')) return response(oaStatus());
    if (call.url === oaPin.base + '/submit_key') {
      verifications++;
      const pending = (await h.journal.read('note'))!.value.pending!;
      if (verifications === 1) { assert.equal(pending.providerKey, undefined); assert.equal(pending.phase, 'send_unknown'); }
      assert.deepEqual(JSON.parse(call.init.body as string), { station_id: oaPin.stationId, api_key: 'oa-secret',
        key_valid_till: 230, station_signature: 'ab'.repeat(64), org_signature: 'CD'.repeat(64) });
      assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json' });
      assert.equal(call.init.redirect, 'error'); assert.equal(call.init.credentials, 'omit'); assert.equal(call.init.cache, 'no-store');
      assert.ok(call.init.signal instanceof AbortSignal);
      return response({ status: 'verified' });
    }
    assert.equal(call.url, context.inference_api_origin + '/responses');
    assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer oa-secret');
    assert.equal((await h.journal.read('note'))!.value.pending!.operations.at(-1)!.phase, 'send_unknown');
    inference++; return response({ output: 'fixture' });
  });
  await client.prepare('note', prepared('direct_oa'), field(14));
  assert.equal((await client.submit('note')).provider_key, 'oa-secret');
  const saved = (await h.journal.read('note'))!.value.pending!;
  assert.equal(saved.providerKey, undefined);
  assert.deepEqual(saved.oaKeyVerification, { evidence: oaEvidence(), expiresAt: '210' });
  await client.sendDirectOperation('note', operationId, '/v1/responses', new TextEncoder().encode('{"model":"fixture-model","store":false}'));
  assert.equal(verifications, 1);
  const restarted = h.clientWith({ oaVerifier: oaPin });
  await assert.rejects(restarted.sendDirectOperation('note', crypto.randomUUID(), '/v1/responses', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /active direct/);
  await assert.rejects(client.sendDirectOperation('note', operationId, '/v1/responses', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /cannot be replayed/);
  assert.equal(verifications, 1); assert.equal(inference, 1);
});

test('untrusted OA evidence and verifier failures close without exposing or persisting a usable key', async t => {
  const cases: { name: string; change?: (s: any) => void; noPin?: boolean; reply?: () => Response; crossesExpiry?: boolean }[] = [
    { name: 'missing independent pin', noPin: true },
    { name: 'missing evidence', change: s => delete s.provider_key_verification },
    { name: 'null evidence', change: s => s.provider_key_verification = null },
    { name: 'injected verifier URL', change: s => s.provider_key_verification.verifier_url = 'https://attacker.invalid' },
    { name: 'wrong station', change: s => s.provider_key_verification.station_id = 'other-station' },
    { name: 'malformed signature', change: s => s.provider_key_verification.org_signature = 'zz'.repeat(64) },
    { name: 'unknown evidence field', change: s => s.provider_key_verification.api_key = 'different-key' },
    { name: 'wrong attestation flag type', change: s => s.provider_key_verification.station_recently_attested = 'true' },
    { name: 'string evidence expiry', change: s => s.provider_key_verification.key_valid_till = '230' },
    { name: 'unsafe evidence expiry', change: s => s.provider_key_verification.key_valid_till = 2 ** 53 },
    { name: 'fractional evidence expiry', change: s => s.provider_key_verification.key_valid_till = 230.5 },
    { name: 'numeric lease expiry', change: s => s.expires_at = 210 },
    { name: 'noncanonical lease expiry', change: s => s.expires_at = '0210' },
    { name: 'missing lease expiry', change: s => delete s.expires_at },
    { name: 'expired lease', change: s => { s.expires_at = '150'; s.provider_key_verification.key_valid_till = 150; } },
    { name: 'evidence expires before lease', change: s => s.provider_key_verification.key_valid_till = 209 },
    { name: 'excessive expiry skew', change: s => s.provider_key_verification.key_valid_till = 276 },
    { name: 'verifier rejects substituted key', change: s => s.provider_key = 'substituted-key', reply: () => response({ status: 'rejected' }) },
    { name: 'HTTP failure with verified body', reply: () => response({ status: 'verified' }, 503) },
    { name: 'network timeout', reply: () => { throw new Error('fixture timeout'); } },
    { name: 'duplicate JSON status', reply: () => new Response('{"status":"rejected","status":"verified"}') },
    { name: 'wrong verifier status type', reply: () => response({ status: true }) },
    { name: 'expiry crossed during verification', crossesExpiry: true },
  ];
  for (const c of cases) await t.test(c.name, async t => {
    const h = await setup(t); let now = 150n;
    const client = h.clientWith({ oaVerifier: c.noPin ? undefined : oaPin, now: () => now });
    const value = oaStatus(); c.change?.(value);
    h.setHandler(async call => {
      if (call.url.endsWith('/sessions')) return response(value);
      if (call.url === oaPin.base + '/submit_key') { if (c.crossesExpiry) now = 210n; return c.reply?.() ?? response({ status: 'verified' }); }
      assert.ok(call.url.endsWith(`/sessions/${requestId}/close`));
      const pending = (await h.journal.read('note'))!.value.pending!;
      assert.equal(pending.phase, 'closing'); assert.equal(pending.providerKey, undefined); assert.equal(pending.oaKeyVerification, undefined);
      assert.equal(pending.closeRequested, true);
      return response(status('direct_oa', 'DRAINING'));
    });
    await client.prepare('note', prepared('direct_oa'), field(14));
    const result = await client.submit('note');
    assert.equal(result.provider_key, undefined); assert.equal(result.provider_key_verification, undefined);
    assert.equal(h.calls.filter(c => c.url.endsWith('/sessions')).length, 1);
    assert.equal(h.calls.filter(c => c.url.endsWith('/close')).length, 1);
    assert.ok(h.calls.every(c => c.url.startsWith(context.control_api_origin) || c.url === oaPin.base + '/submit_key'));
  });
});

test('OA verifier pins are detached from mutable caller options and the existing 65-second issuer skew is accepted', async t => {
  const h = await setup(t), pins = { ...oaPin }, client = h.clientWith({ oaVerifier: pins });
  pins.base = 'https://attacker.invalid'; pins.stationId = 'attacker';
  h.setHandler(async call => {
    if (call.url.endsWith('/sessions')) { const s = oaStatus(); s.provider_key_verification.key_valid_till = 275; return response(s); }
    assert.equal(call.url, oaPin.base + '/submit_key'); return response({ status: 'verified' });
  });
  await client.prepare('note', prepared('direct_oa'), field(14));
  assert.equal((await client.submit('note')).provider_key, 'oa-secret');
});

test('OA failed close retains keyless closing state and can settle without verifier access', async t => {
  const h = await setup(t), client = h.clientWith({ oaVerifier: oaPin });
  h.setHandler(async call => {
    if (call.url.endsWith('/sessions')) return response(oaStatus());
    if (call.url.endsWith('/submit_key')) return response({ status: 'rejected' });
    assert.ok(call.url.endsWith('/close')); throw Error('close ACK lost');
  });
  await client.prepare('note', prepared('direct_oa'), field(14));
  await assert.rejects(client.submit('note'), /close ACK lost/);
  const p = (await h.journal.read('note'))!.value.pending!;
  assert.equal(p.phase, 'closing'); assert.equal(p.providerKey, undefined); assert.equal(p.oaKeyVerification, undefined);
  h.setHandler(async call => {
    assert.ok(call.url.startsWith(context.control_api_origin));
    return response(call.url.endsWith('/receipts') ? { receipts: [], next_cursor: null }
      : { ...status('direct_oa', 'SETTLED'), settlement: settlement() });
  });
  await h.restart().recover('note'); assert.equal((await h.journal.read('note'))!.value.pending, null);
  assert.equal(h.verified.settlements.length, 1);
});

test('changed saved OA evidence is independently rechecked against the current in-memory key', async t => {
  for (const change of ['legacy', 'evidence', 'expiry'] as const) await t.test(change, async t => {
    const h = await setup(t), client = h.clientWith({ oaVerifier: oaPin });
    h.setHandler(async call => response(call.url.endsWith('/submit_key') ? { status: 'verified' } : oaStatus()));
    await client.prepare('note', prepared('direct_oa'), field(14)); await client.submit('note');
    const record = (await h.journal.read('note'))!, p = record.value.pending!;
    if (change === 'legacy') delete p.oaKeyVerification;
    if (change === 'evidence') p.oaKeyVerification!.evidence.station_signature = 'ef'.repeat(64);
    if (change === 'expiry') p.oaKeyVerification!.expiresAt = '209';
    await h.journal.compareAndSwap('note', record.revision, record.value);
    let verifications = 0;
    h.setHandler(async call => {
      if (call.url.endsWith('/submit_key')) { verifications++; return response({ status: 'rejected' }); }
      assert.ok(call.url.endsWith('/close')); return response(status('direct_oa', 'DRAINING'));
    });
    await assert.rejects(client.sendDirectOperation('note', operationId, '/v1/responses', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /OA key verification failed/);
    const pending = (await h.journal.read('note'))!.value.pending!;
    assert.equal(pending.providerKey, undefined); assert.equal(pending.phase, 'closing'); assert.equal(pending.operations.length, 0);
    assert.equal(verifications, ['evidence', 'expiry'].includes(change) ? 1 : 0);
  });
});

test('SETTLED text with failed successor verification preserves old note and unresolved authorization', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14)); await h.client.submit('note'); h.failSettlement();
  h.setHandler(async call => response(call.url.endsWith('/receipts') ? { receipts: [], next_cursor: null } : { ...status('proxy', 'SETTLED'), settlement: settlement() }));
  await assert.rejects(h.client.recover('note'), /invalid successor/);
  const saved = (await h.journal.read('note'))!.value;
  assert.deepEqual(saved.state, initial()); assert.equal(saved.history.length, 0); assert.ok(saved.pending);
  await assert.rejects(h.client.prepare('note', prepared(), field(14)), /unresolved/);
});

test('verified successor is committed with old state and transcript before a note becomes available', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14)); await h.client.submit('note');
  h.setHandler(async call => response(call.url.endsWith('/receipts') ? { receipts: [], next_cursor: null } : { ...status('proxy', 'SETTLED'), settlement: settlement() }));
  await h.client.recover('note');
  const saved = (await h.journal.read('note'))!.value;
  assert.deepEqual(saved.state, successor()); assert.equal(saved.pending, null); assert.equal(saved.history.length, 1);
  assert.deepEqual(saved.history[0].previous, initial()); assert.deepEqual(saved.history[0].prepared, prepared());
  await assert.rejects(h.client.prepare('note', prepared(), field(14)), /already settled/);
});

test('server session identity substitution cannot change the note', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14));
  h.setHandler(async () => response({ ...status(), request_id: operationId }));
  await assert.rejects(h.client.submit('note'), /identity/);
  assert.deepEqual((await h.journal.read('note'))?.value.state, initial());
});

test('duplicate receipt and nonadvancing cursor both block settlement before the verifier', async t => {
  for (const duplicate of [true, false]) {
    const h = await setup(t); await h.client.prepare('note', prepared(), field(14)); await h.client.submit('note');
    let page = 0;
    h.setHandler(async call => {
      if (!call.url.includes('/receipts')) return response({ ...status('proxy', 'SETTLED'), settlement: settlement() });
      page++;
      return response({ receipts: [{ body: { receipt_id: 'id', operation_id: null, billing_effect: 'charge' }, receipt_hash: duplicate ? 'same' : `hash-${page}`, signature: 'fixture' }], next_cursor: duplicate ? String(page) : '1' });
    });
    await assert.rejects(h.client.recover('note'), duplicate ? /duplicate receipt/ : /cursor/);
    assert.equal(h.verified.settlements.length, 0); assert.ok((await h.journal.read('note'))?.value.pending);
  }
});

test('inference redacts persisted bytes before send; response loss and restart cannot auto replay', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14)); await h.client.submit('note');
  const body = new TextEncoder().encode('{ "model" : "fixture-model", "messages": [] }');
  await h.client.prepareOperation('note', operationId, '/v1/chat/completions', body);
  await assert.rejects(h.client.prepareOperation('note', operationId, '/v1/chat/completions', new TextEncoder().encode('{"model":"fixture-model","store":false}')), /idempotency conflict/);
  h.setHandler(async call => {
    const operation = (await h.journal.read('note'))!.value.pending!.operations[0];
    assert.equal(operation.phase, 'send_unknown'); assert.equal(operation.bodyBase64,''); assert.equal(operation.bodyRedacted,true); assert.equal(operation.bodySha256,await sha256Hex(body)); assert.deepEqual(call.init.body, body);
    assert.equal((call.init.headers as Record<string, string>)['Idempotency-Key'], operationId);
    assert.equal((call.init.headers as Record<string, string>).Authorization, 'Bearer zkp1.fixture-secret');
    throw new Error('stream lost');
  });
  await assert.rejects(h.client.sendOperation('note', operationId), /stream lost/);
  const count = h.calls.length;
  await assert.rejects(h.restart().sendOperation('note', operationId), ResponseNotReplayable); assert.equal(h.calls.length, count);
});

test('concurrent senders dispatch one inference and 409 points at status without retrying', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14)); await h.client.submit('note');
  await h.client.prepareOperation('note', operationId, '/v1/responses', new TextEncoder().encode('{"model":"fixture-model","store":false}'));
  h.setHandler(async () => response({ code: 'OPERATION_EXISTS' }, 409));
  const results = await Promise.allSettled([h.client.sendOperation('note', operationId), h.restart().sendOperation('note', operationId)]);
  assert.equal(results.filter(v => v.status === 'rejected' && v.reason instanceof ResponseNotReplayable).length, 2);
  assert.equal(h.calls.filter(c => c.url.endsWith('/v1/responses')).length, 1);
  h.setHandler(async () => response({ request_id: requestId, operation_id: operationId, response_replayable: false }));
  assert.deepEqual({ ...await h.client.operationStatus('note', operationId) as object }, { request_id: requestId, operation_id: operationId, response_replayable: false });
});

test('failed durable save stops authorization dispatch and failed RP verification never creates pending state', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14)); h.failStorage();
  await assert.rejects(h.client.submit('note'), /disk full/); assert.equal(h.calls.length, 0);
  const invalid = await setup(t); invalid.failPrepare();
  await assert.rejects(invalid.client.prepare('note', prepared(), field(14)), /invalid proof/);
  assert.equal((await invalid.journal.read('note'))?.value.pending, null); assert.equal(invalid.calls.length, 0);
});

test('duplicate JSON fields in status fail closed without advancing state', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14));
  h.setHandler(async () => new Response(`{"request_id":"${requestId}","mode":"proxy","state":"ACTIVE","state":"SETTLED","cap_micro_usdc":"100"}`));
  await assert.rejects(h.client.submit('note'), /duplicate/);
  assert.deepEqual((await h.journal.read('note'))?.value.state, initial());
});

test('browser-compatible credential encoding is byte-identical to Node base64url including both substituted alphabet characters and padding', async t => {
  let fill = 0;
  t.mock.method(crypto, 'getRandomValues', (target: Uint8Array) => { target.fill(fill); return target; });
  for (const value of [0, 0xfb, 0xff, 0x3e]) {
    fill = value;
    for (const mode of ['proxy', 'direct_oa', 'direct_openrouter'] as const) {
      const credentials = await createCredentials(mode), bytes = Buffer.alloc(32, value), expected = bytes.toString('base64url');
      assert.equal(credentials.controlToken, `zkc1.${credentials.requestId}.${expected}`);
      assert.equal(credentials.proxyToken, mode === 'proxy' ? `zkp1.${credentials.requestId}.${expected}` : null);
      assert.match(expected, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(credentials.controlHash, await sha256Hex(bytes));
      assert.equal(credentials.proxyHash, mode === 'proxy' ? await sha256Hex(bytes) : null);
    }
  }
});

test('credential mode is explicit and expiry warning includes the Active principal treasury consequence', async () => {
  const direct = await createCredentials('direct_oa'), proxy = await createCredentials('proxy');
  assert.equal(direct.proxyToken, null); assert.equal(direct.proxyHash, null);
  assert.ok(proxy.proxyToken?.startsWith(`zkp1.${proxy.requestId}.`)); assert.ok(proxy.controlToken.startsWith(`zkc1.${proxy.requestId}.`));
  assert.notEqual(proxy.controlHash, proxy.proxyHash);
  assert.equal(expiryNotice(604801n, 0n).severity, 'normal');
  assert.equal(expiryNotice(604800n, 0n).severity, 'seven_days');
  assert.equal(expiryNotice(86400n, 0n).severity, 'one_day');
  assert.equal(expiryNotice(10n, 10n).severity, 'expired');
  assert.match(expiryNotice(10n, 10n).message, /entire principal.*Active.*treasury/);
});

/** Quote tests below use real Ed25519 signatures and real JCS/SHA256 tariff binding. */
async function signedQuoteSetup(t: TestContext) {
  const h = await setup(t);
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKey = bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const tariffBody: Omit<Tariff, 'tariff_hash'> = { version: '1', provider: 'openrouter', model: 'fixture-model', pricing_basis: 'fixed_usage_rates',
    valid_from: '90', valid_until: '1000', rates: [{ unit: 'input_tokens', nano_usdc_numerator: '3', unit_denominator: '2' }, { unit: 'output_tokens', nano_usdc_numerator: '5', unit_denominator: '2' }], operator_fee_micro_usdc: '0' };
  const tariff: Tariff = { ...tariffBody, tariff_hash: await sha256Hex(jcsBytes(tariffBody)) };
  const request = { mode: 'proxy' as const, provider: 'openrouter' as const, models: ['fixture-model'] };
  const quoteContext = { ...context, quote_public_key: publicKey, tariff_hashes: [tariff.tariff_hash] };
  const body: Quote['body'] = { ...prepared().request.quote.body, quote_id: requestId, issued_at: '100', expires_at: '220', tariff_hash: tariff.tariff_hash };
  const sign = async (body: Quote['body']): Promise<Quote> => {
    const quote_hash = await sha256Hex(jcsBytes(body));
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new Uint8Array(Buffer.from(quote_hash, 'hex')))).toString('base64');
    return { body, quote_hash, signature };
  };
  const client = h.clientWith({ context: quoteContext });
  return { ...h, client, body, sign, tariff, request, quoteContext };
}

test('quote verifies real Ed25519 and signed tariff binding while preserving request/price snapshots', async t => {
  const h = await signedQuoteSetup(t), quote = await h.sign(h.body);
  const request = structuredClone(h.request), tariff = structuredClone(h.tariff);
  const expectedRequest = JSON.stringify(request);
  h.setHandler(async call => { assert.equal(call.url, context.control_api_origin + '/zkapi/v1/quotes'); assert.equal(call.init.body, expectedRequest); return response(quote); });
  const pending = h.client.quote(request, tariff);
  request.models[0] = 'changed-after-call'; tariff.rates[0].nano_usdc_numerator = '999';
  const accepted = await pending;
  assert.equal(accepted.quote_hash, quote.quote_hash); assert.equal(accepted.body.tariff_hash, h.tariff.tariff_hash);
  assert.equal(accepted.body.models[0], 'fixture-model');
});

test('quote rejects altered signature, body digest, tariff bytes and unpinned tariff', async t => {
  const h = await signedQuoteSetup(t), quote = await h.sign(h.body);
  const invalidSignature = Buffer.from(quote.signature, 'base64'); invalidSignature[0] ^= 1;
  h.setHandler(async () => response({ ...quote, signature: invalidSignature.toString('base64') }));
  await assert.rejects(h.client.quote(h.request, h.tariff), /signature/);
  h.setHandler(async () => response({ ...quote, body: { ...quote.body, cap_micro_usdc: '101' } }));
  await assert.rejects(h.client.quote(h.request, h.tariff), /quote hash/);
  h.setHandler(async () => response(quote));
  await assert.rejects(h.client.quote(h.request, { ...h.tariff, operator_fee_micro_usdc: '1' }), /untrusted tariff/);
  const unpinned = h.clientWith({ context: { ...h.quoteContext, tariff_hashes: [] } });
  await assert.rejects(unpinned.quote(h.request, h.tariff), /untrusted tariff/);
});

test('validly signed quotes cannot substitute deployment, pool, mode, provider, model, tariff or API origins', async t => {
  const h = await signedQuoteSetup(t);
  const substitutions: Partial<Quote['body']>[] = [
    { deployment_id: 'another-deployment' }, { pool: 'another-pool' }, { mode: 'direct_openrouter' }, { provider: 'openai' },
    { models: ['another-model'] }, { tariff_hash: 'ff'.repeat(32) }, { cap_micro_usdc: '99' },
    { control_api_origin: 'https://other-control.invalid' }, { inference_api_origin: 'https://other-provider.invalid' },
  ];
  for (const substitution of substitutions) {
    const quote = await h.sign({ ...h.body, ...substitution }); h.setHandler(async () => response(quote));
    await assert.rejects(h.client.quote(h.request, h.tariff), /quote binding/, JSON.stringify(substitution));
  }
});

test('quote admission accepts issued_at and rejects expires_at equality, future quotes, bad TTL and concurrency', async t => {
  const h = await signedQuoteSetup(t), quote = await h.sign(h.body);
  h.setHandler(async () => response(quote));
  assert.equal((await h.clientWith({ context: h.quoteContext, now: () => 100n }).quote(h.request, h.tariff)).quote_hash, quote.quote_hash);
  assert.equal((await h.clientWith({ context: h.quoteContext, now: () => 219n }).quote(h.request, h.tariff)).quote_hash, quote.quote_hash);
  await assert.rejects(h.clientWith({ context: h.quoteContext, now: () => 220n }).quote(h.request, h.tariff), /quote limits/);
  await assert.rejects(h.clientWith({ context: h.quoteContext, now: () => 99n }).quote(h.request, h.tariff), /quote limits/);
  for (const change of [{ expires_at: '221' }, { session_ttl_seconds: '0' }, { session_ttl_seconds: '301' }, { max_concurrency: '5' }, { issued_at: '0100' }]) {
    const malformed = await h.sign({ ...h.body, ...change }); h.setHandler(async () => response(malformed));
    await assert.rejects(h.client.quote(h.request, h.tariff), /quote (limits|time)/);
  }
});

test('tariff validity is bound to quote issue time including the exclusive valid_until boundary', async t => {
  const h = await signedQuoteSetup(t);
  const { tariff_hash: _hash, ...body } = h.tariff;
  for (const valid_until of ['100', '101']) {
    const priced = { ...body, valid_until }, tariff = { ...priced, tariff_hash: await sha256Hex(jcsBytes(priced)) };
    const quote = await h.sign({ ...h.body, tariff_hash: tariff.tariff_hash }); h.setHandler(async () => response(quote));
    const client = h.clientWith({ context: { ...h.quoteContext, tariff_hashes: [tariff.tariff_hash] } });
    if (valid_until === '100') await assert.rejects(client.quote(h.request, tariff), /quote limits/);
    else assert.equal((await client.quote(h.request, tariff)).body.tariff_hash, tariff.tariff_hash);
  }
});

test('quote rejects extra prompt/secret fields, implicit mode and invalid selection before any request leaves the client', async t => {
  const h = await signedQuoteSetup(t);
  const invalid = [
    { ...h.request, prompt: 'secret prompt' }, { ...h.request, control_token: 'secret token' },
    { ...h.request, mode: 'auto' }, { ...h.request, provider: 'oa' }, { ...h.request, models: ['*'] },
    { ...h.request, models: [] }, { ...h.request, models: ['one', 'two'] },
    { mode: 'direct_oa', provider: 'oa', models: ['specific-model'] },
    ...['0', '301', '060', '1.0'].map(session_ttl_seconds => ({ ...h.request, session_ttl_seconds })),
  ];
  for (const request of invalid) await assert.rejects(h.client.quote(request as Parameters<ControlClient['quote']>[0], h.tariff));
  assert.equal(h.calls.length, 0);
});

test('expired never-sent authorization remains cancellable and can be replaced without changing the note state', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14));
  const expired = h.clientWith({ now: () => 200n });
  await assert.rejects(expired.submit('note'), /unsent quote expired/);
  assert.equal(h.calls.length, 0); assert.equal((await h.journal.read('note'))?.value.pending?.phase, 'prepared');
  await expired.cancelUnsent('note');
  const cancelled = (await h.journal.read('note'))!.value;
  assert.equal(cancelled.pending, null); assert.deepEqual(cancelled.state, initial()); assert.equal(cancelled.history.length, 0);
  const replacement = prepared(); replacement.request.authorization.request_id = operationId;
  replacement.request.quote.body.issued_at = '200'; replacement.request.quote.body.expires_at = '320';
  await expired.prepare('note', replacement, field(14));
  h.setHandler(async () => response({ ...status(), request_id: operationId }));
  await expired.submit('note'); assert.equal(h.calls.length, 1);
  assert.equal((await h.journal.read('note'))?.value.pending?.prepared.request.authorization.request_id, operationId);
});

test('possibly-sent authorization cannot be cancelled and recovers identical bytes after quote expiry', async t => {
  const h = await setup(t); await h.client.prepare('note', prepared(), field(14));
  h.setHandler(async () => { throw new Error('response lost'); });
  await assert.rejects(h.client.submit('note'), /response lost/);
  const expired = h.clientWith({ now: () => 300n });
  await assert.rejects(expired.cancelUnsent('note'), /possibly sent/);
  h.setHandler(async () => response(status()));
  await expired.recover('note');
  assert.equal(h.calls.length, 2); assert.equal(h.calls[0].init.body, h.calls[1].init.body);
  assert.deepEqual(h.calls[0].init.headers, h.calls[1].init.headers);
  await assert.rejects(expired.cancelUnsent('note'), /possibly sent/);
});


test('schema 2 survives every ControlClient authorization, inference, recovery and settlement writer', async t => {
  const h=await setup(t,2),check=async()=>assert.equal((await h.journal.read('note'))!.value.schema,2);
  await h.client.prepare('note',prepared(),field(14));await check();
  await h.client.submit('note');await check();
  await h.client.prepareOperation('note',operationId,'/v1/chat/completions',new TextEncoder().encode('{"model":"fixture-model","store":false}'));await check();
  h.setHandler(async()=>response({result:'fixture'}));await h.client.sendOperation('note',operationId);await check();
  h.setHandler(async call=>response(call.url.endsWith('/receipts')?{receipts:[],next_cursor:null}:{...status('proxy','SETTLED'),settlement:settlement()}));
  await h.restart().close('note');await check();
  const saved=(await h.journal.read('note'))!.value;assert.equal(saved.pending,null);assert.equal(saved.history.length,1);assert.deepEqual(saved.state,successor());
});

/** Deterministic scheduling only: signed quote validation and the clock remain real APIs. */
function quoteWaitTimer(t: TestContext) {
  let fire: (() => void) | undefined, announce!: () => void;
  const scheduled = new Promise<void>(resolve => { announce = resolve; });
  const delays: number[] = [], cleared: unknown[] = [], handle = {} as ReturnType<typeof setTimeout>;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, milliseconds: number) => {
    assert.equal(fire, undefined, 'at most one wait'); delays.push(milliseconds); fire = callback; announce(); return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', (value: unknown) => { cleared.push(value); });
  return { scheduled, delays, cleared, handle, fire: () => { assert.ok(fire); fire(); } };
}

test('verified quote waits once for two seconds of skew and returns the same signed quote with one fetch', async t => {
  const h = await signedQuoteSetup(t), quote = await h.sign(h.body), before = (await h.journal.read('note'))!.head;
  h.setHandler(async () => response(quote)); const timer = quoteWaitTimer(t); let now = 98n, settled = false;
  const pending = h.clientWith({ context: h.quoteContext, now: () => now }).quote(h.request,h.tariff).then(q => { settled = true; return q; });
  await timer.scheduled; assert.equal(settled,false); assert.deepEqual(timer.delays,[2000]); assert.equal(h.calls.length,1);
  now = 100n; timer.fire(); const accepted = await pending;
  assert.equal(JSON.stringify(accepted),JSON.stringify(quote)); assert.deepEqual(timer.cleared,[timer.handle]);
  assert.equal(h.calls.length,1); assert.deepEqual((await h.journal.read('note'))!.head,before); assert.equal(h.verified.prepares,0);
});

test('verified quote permits only the five-second boundary and still requires the local clock to catch up', async t => {
  const h = await signedQuoteSetup(t), quote = await h.sign(h.body); h.setHandler(async () => response(quote));
  const timer = quoteWaitTimer(t); let now = 95n;
  const pending = h.clientWith({context:h.quoteContext,now:()=>now}).quote(h.request,h.tariff);
  await timer.scheduled; assert.deepEqual(timer.delays,[5000]); now=100n; timer.fire();
  assert.equal((await pending).quote_hash,quote.quote_hash); assert.equal(h.calls.length,1);
});

test('excessive future quote is rejected without scheduling a wait or a second request', async t => {
  const h = await signedQuoteSetup(t), quote = await h.sign(h.body); h.setHandler(async () => response(quote));
  const timer=quoteWaitTimer(t);
  await assert.rejects(h.clientWith({context:h.quoteContext,now:()=>94n}).quote(h.request,h.tariff),/quote limits/);
  assert.deepEqual(timer.delays,[]); assert.equal(h.calls.length,1);
});

test('invalid signatures and static quote limits fail before any clock wait', async t => {
  const h=await signedQuoteSetup(t), timer=quoteWaitTimer(t), client=h.clientWith({context:h.quoteContext,now:()=>98n});
  for(const change of [{expires_at:'221'},{session_ttl_seconds:'0'},{session_ttl_seconds:'301'},{session_ttl_seconds:'61'},{max_concurrency:'5'},{issued_at:'0100'}]) {
    const quote=await h.sign({...h.body,...change}); h.setHandler(async()=>response(quote));
    await assert.rejects(client.quote(h.request,h.tariff),/quote (limits|time)/);
  }
  const quote=await h.sign(h.body),bad=Buffer.from(quote.signature,'base64');bad[0]^=1;
  h.setHandler(async()=>response({...quote,signature:bad.toString('base64')}));await assert.rejects(client.quote(h.request,h.tariff),/signature/);
  const {tariff_hash:_hash,...body}=h.tariff,expiredBody={...body,valid_until:'100'},tariff={...expiredBody,tariff_hash:await sha256Hex(jcsBytes(expiredBody))};
  const outside=await h.sign({...h.body,tariff_hash:tariff.tariff_hash});h.setHandler(async()=>response(outside));
  await assert.rejects(h.clientWith({context:{...h.quoteContext,tariff_hashes:[tariff.tariff_hash]},now:()=>98n}).quote(h.request,tariff),/quote limits/);
  assert.deepEqual(timer.delays,[]);assert.equal(h.calls.length,8);
});

test('quote clock wait cancellation rejects and removes its timer and abort listener without another fetch', async t => {
  const h=await signedQuoteSetup(t),quote=await h.sign(h.body);h.setHandler(async()=>response(quote));
  const timer=quoteWaitTimer(t),controller=new AbortController(),reason=Error('fixture cancel');
  const removed=t.mock.method(controller.signal,'removeEventListener');
  const pending=h.clientWith({context:h.quoteContext,now:()=>98n}).quote(h.request,h.tariff,controller.signal);
  const rejected=assert.rejects(pending,e=>e===reason);await timer.scheduled;controller.abort(reason);await rejected;
  assert.deepEqual(timer.cleared,[timer.handle]);assert(removed.mock.calls.some(c=>c.arguments[0]==='abort'));assert.equal(h.calls.length,1);
});

for(const [label,after] of [['frozen',98n],['backwards',97n],['expired after waiting',220n]] as const) {
  test(`quote clock remains fail-closed when ${label}`,async t=>{
    const h=await signedQuoteSetup(t),quote=await h.sign(h.body);h.setHandler(async()=>response(quote));
    const timer=quoteWaitTimer(t);let now=98n;
    const pending=h.clientWith({context:h.quoteContext,now:()=>now}).quote(h.request,h.tariff);
    const rejected=assert.rejects(pending,/quote limits/);await timer.scheduled;now=after;timer.fire();await rejected;
    assert.deepEqual(timer.delays,[2000]);assert.deepEqual(timer.cleared,[timer.handle]);assert.equal(h.calls.length,1);
  });
}

test('low-level direct sink rejects metadata and policy bypasses without changing the journal',async t=>{
  const h=await setup(t);await h.client.prepare('note',prepared('direct_openrouter'),field(14));
  h.setHandler(async()=>response({...status('direct_openrouter'),provider_key:'fixture-key',provider_api_origin:context.inference_api_origin}));
  await h.client.submit('note');const before=await h.journal.read('note'),calls=h.calls.length;
  for(const extra of [
    {model:'openai/gpt-5.2:online'},{model:'@preset/private-search'},{model:'openai/gpt-5.2@preset/private-search'},
    {user:'identity'},{client_metadata:{thread_id:'identity'}},{custom_tracking_id:'identity'},
    {provider:{zdr:false}},{provider:{zdr:true,data_collection:'allow'}},{provider:{zdr:true,order:['tracker']}},
    {messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://private.invalid'}}]}]},
  ])await assert.rejects(h.client.sendDirectOperation('note',crypto.randomUUID(),'/v1/chat/completions',
    new TextEncoder().encode(JSON.stringify({...JSON.parse(new TextDecoder().decode(directBody)),...extra}))));
  for(const raw of ['{"model":"fixture-model","model":"other"}','{"model":"fixture-model","\\u0075ser":"identity"}'])
    await assert.rejects(h.client.sendDirectOperation('note',crypto.randomUUID(),'/v1/chat/completions',new TextEncoder().encode(raw)));
  assert.equal(h.calls.length,calls);assert.deepEqual(await h.journal.read('note'),before);
});
test('direct fixed ZDR, input snapshot, no retained body and no retry after provider rejection',async t=>{
  const h=await setup(t);await h.client.prepare('note',prepared('direct_openrouter'),field(14));
  h.setHandler(async()=>response({...status('direct_openrouter'),provider_key:'fixture-key',provider_api_origin:context.inference_api_origin}));
  await h.client.submit('note');const before=h.calls.length;
  h.setHandler(async call=>{
    const op=(await h.journal.read('note'))!.value.pending!.operations[0];
    assert.equal(op.bodyBase64,'');assert.equal(op.bodyRedacted,true);assert.equal(op.phase,'send_unknown');
    assert.equal(op.bodySha256,await sha256Hex(call.init.body as Uint8Array));
    assert.deepEqual(JSON.parse(new TextDecoder().decode(call.init.body as Uint8Array)),
      {...JSON.parse(new TextDecoder().decode(directBody)),provider:{zdr:true,data_collection:'deny'}});
    return response({error:'no qualifying endpoint'},503);
  });
  const input=new Uint8Array(directBody),sent=h.client.sendDirectOperation('note',operationId,'/v1/chat/completions',input);
  input.fill(0);assert.equal((await sent).status,503);assert.equal(h.calls.length,before+1);
  await assert.rejects(h.client.sendDirectOperation('note',operationId,'/v1/chat/completions',directBody),/cannot be replayed/);
  assert.equal(h.calls.length,before+1);
});
test('failed redaction save causes zero direct or proxy sends and preserves the original journal',async t=>{
  for(const mode of ['proxy','direct_openrouter'] as const){
    const h=await setup(t);await h.client.prepare('note',prepared(mode),field(14));
    h.setHandler(async()=>response({...status(mode),...(mode==='proxy'?{}:{provider_key:'fixture-key',provider_api_origin:context.inference_api_origin})}));
    await h.client.submit('note');
    if(mode==='proxy')await h.client.prepareOperation('note',operationId,'/v1/chat/completions',directBody);
    const before=await h.journal.read('note'),calls=h.calls.length;h.failStorage();
    await assert.rejects(mode==='proxy'?h.client.sendOperation('note',operationId):h.client.sendDirectOperation('note',operationId,'/v1/chat/completions',directBody),/disk full/);
    assert.equal(h.calls.length,calls);assert.deepEqual(await h.journal.read('note'),before);
  }
});
test('legacy prepared body survives reopen, is sent exactly once and is then redacted',async t=>{
  const h=await setup(t);await h.client.prepare('note',prepared(),field(14));await h.client.submit('note');
  await h.client.prepareOperation('note',operationId,'/v1/chat/completions',directBody);
  const before=await h.journal.read('note');assert.equal(before!.value.pending!.operations[0].bodyBase64,Buffer.from(directBody).toString('base64'));
  const restarted=h.restart();assert.deepEqual(await h.journal.read('note'),before);
  h.setHandler(async call=>{assert.deepEqual(call.init.body,directBody);return response({ok:true});});
  await restarted.sendOperation('note',operationId);
  const count=h.calls.length;await assert.rejects(restarted.sendOperation('note',operationId),ResponseNotReplayable);
  await assert.rejects(restarted.prepareOperation('note',operationId,'/v1/chat/completions',directBody),ResponseNotReplayable);
  assert.equal(h.calls.length,count);
});
test('explicit settled erasure preserves active recovery and every financial field; is atomic and idempotent',async t=>{
  const h=await setup(t);await h.client.prepare('note',prepared(),field(14));await h.client.submit('note');
  await h.client.prepareOperation('note',operationId,'/v1/chat/completions',directBody);
  h.setHandler(async call=>response(call.url.endsWith('/receipts')?{receipts:[],next_cursor:null}:{...status('proxy','SETTLED'),settlement:settlement()}));
  await h.client.close('note');
  let record=(await h.journal.read('note'))!;
  // A complete legacy settled record, including an unsent prepared operation.
  const archived=record.value.history[0].operations[0];delete archived.bodyRedacted;archived.bodyBase64=Buffer.from(directBody).toString('base64');
  const active=prepared();active.request.authorization.request_id=crypto.randomUUID();
  record.value.pending={prepared:active,exactRequest:JSON.stringify(active.request),phase:'send_unknown',operations:[
    {id:crypto.randomUUID(),path:'/v1/chat/completions',anthropicVersion:'',phase:'send_unknown',bodyBase64:archived.bodyBase64}]};
  await h.journal.compareAndSwap('note',record.revision,record.value);
  const before=(await h.journal.read('note'))!;assert.deepEqual(await h.journal.read('note'),before);
  h.failStorage();await assert.rejects(h.client.purgeSettledRequestBodies('note'),/disk full/);assert.deepEqual(await h.journal.read('note'),before);h.failStorage(false);
  assert.deepEqual(await h.client.purgeSettledRequestBodies('note'),{historyOperations:1,emergencyOperations:0});
  const expected=structuredClone(before.value);expected.history[0].operations[0].bodyBase64='';expected.history[0].operations[0].bodyRedacted=true;delete expected.history[0].operations[0].bodySha256;
  assert.deepEqual((await h.journal.read('note'))!.value,expected);
  const after=await h.journal.read('note');assert.deepEqual(await h.client.purgeSettledRequestBodies('note'),{historyOperations:0,emergencyOperations:0});assert.deepEqual(await h.journal.read('note'),after);
});
test('redaction marker shape is checked in active and historical records',async t=>{
  const h=await setup(t);await h.client.prepare('note',prepared(),field(14));await h.client.submit('note');
  await h.client.prepareOperation('note',operationId,'/v1/chat/completions',directBody);
  const note=(await h.journal.read('note'))!.value;
  for(const marker of [false,null,'true',true])for(const historical of [false,true]){
    const altered=structuredClone(note),op=altered.pending!.operations[0];(op as any).bodyRedacted=marker;
    if(historical){altered.history.push({previous:initial(),prepared:prepared(),settlement:settlement(),receipts:[],operations:[op]});altered.pending=null;}
    await assert.rejects(validateNoteJournal(altered),/redaction/);
  }
  const redacted=structuredClone(note);redacted.pending!.operations[0].bodyBase64='';redacted.pending!.operations[0].bodyRedacted=true;
  await validateNoteJournal(redacted);
});
