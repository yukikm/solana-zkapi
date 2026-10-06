/** Application integration fixtures: real journal/locks, quote signatures and
 * ControlClient/ClientDaemon; synthetic prover/provider/chain, no live acceptance. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ZkApiClient, type ClientComponents, type ModelConfiguration, type ClientStatus } from '../src/client.ts';
import { readChatText, readChatDeltas } from '../src/chat.ts';
import { ControlClient, validateNoteJournal, type NoteJournal, type Mode, type PreparedSession, type Quote, type SessionVerifier } from '../src/control.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { jcsBytes, sha256Hex, type VerifiedManifest } from '../src/trust.ts';
import type { NoteProver } from '../src/prover.ts';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const chat = (model = 'first') => ({ operationId: crypto.randomUUID(), model, messages: [{ role: 'user' as const, content: 'Hello' }], maxOutputTokens: 32 });
async function setup(t: TestContext, mode: Mode = 'proxy') {
  const dir = await mkdtemp(join(tmpdir(), 'zkapi-app-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await NativeJournalStore.open(dir), key = await importJournalKey(new Uint8Array(32).fill(17));
  const makeJournal = () => new EncryptedJournal<NoteJournal>(store, key, { deploymentId: 'app-fixture', pool: 'pool' }, validateNoteJournal);
  const journal = makeJournal(), signer = generateKeyPairSync('ed25519');
  const provider = mode === 'direct_oa' ? 'oa' : 'openrouter';
  const models: ModelConfiguration[] = [];
  for (const id of ['first', 'second']) {
    const tariff = { version: '1', provider, model: mode === 'proxy' ? id : '*', pricing_basis: mode === 'proxy' ? 'fixed_usage_rates' : 'provider_reported_usd',
      valid_from: '0', valid_until: '9999999999', rates: [], operator_fee_micro_usdc: '0' };
    models.push({ id, provider, apis: ['chat'], tariff: { ...tariff, tariff_hash: await sha256Hex(jcsBytes(tariff)) } });
  }
  const context = { deployment_id: 'app-fixture', pool: 'pool', vault_binding: field(1), state_key: [field(2), field(3)] as [string, string], cap_micro_usdc: '100',
    control_api_origin: 'https://control.invalid', inference_api_origin: 'https://proxy.invalid', quote_public_key: bs58.encode(signer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
    receipt_public_key: bs58.encode(new Uint8Array(32).fill(9)), request_vk_sha256: '22'.repeat(32), tariff_hashes: models.map(m => m.tariff.tariff_hash) };
  const state = { balance_micro_usdc: '200', balance_blinding: field(3), note_leaf: field(4), commitment: { x: field(5), y: field(6) }, anchor: field(7), state_signature: null };
  await journal.create('note', { schema: 1, state, witness: { secret: field(2), note_id: 1, deposit_micro_usdc: '200', expiry: '9999999999' },
    wallet: { status: 'active', history: [] }, pending: null, history: [] });
  const counts = { quote: 0, proof: 0, auth: 0, sends: 0, closes: 0, settles: 0, wallet: 0 };
  const behavior = { lose: false, closeUnavailable: false, failVerifier: false, authUnknown: false, stream: false, rejectQuote: false,
    streamFailure: false, streamWaiting: false, beforeClose: undefined as (() => Promise<void>) | undefined };
  const order: string[] = [], bodies: unknown[] = [];
  const status = async (settled = false) => {
    const p = (await journal.read('note'))!.value.pending!;
    return { request_id: p.prepared.request.authorization.request_id, mode, state: settled ? 'SETTLED' : 'ACTIVE', cap_micro_usdc: '100',
      ...(settled ? { settlement: { charge_micro_usdc: '1', next_commitment: state.commitment, next_anchor: field(8), blind_delta_srv: field(9), next_state_signature: { r_x: field(2), r_y: field(3), s: field(4) } } } : {}) };
  };
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/quotes')) {
      counts.quote++; order.push('quote'); if (behavior.rejectQuote) return new Response(null, { status: 503 });
      const wanted = JSON.parse(String(init!.body)), now = BigInt(Math.floor(Date.now() / 1000));
      const selected = models.find(m => mode === 'proxy' ? m.id === wanted.models[0] : true)!;
      const body: Quote['body'] = { quote_id: crypto.randomUUID(), deployment_id: context.deployment_id, pool: context.pool, mode, provider,
        models: wanted.models, tariff_hash: selected.tariff.tariff_hash, cap_micro_usdc: '100', issued_at: String(now), expires_at: String(now + 120n), session_ttl_seconds: '60',
        max_concurrency: '4', control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin };
      const hash = await sha256Hex(jcsBytes(body));
      return Response.json({ body, quote_hash: hash, signature: sign(null, Buffer.from(hash, 'hex'), signer.privateKey).toString('base64') });
    }
    if (url.pathname === '/zkapi/v1/sessions') {
      counts.auth++; order.push('AUTH');
      if (behavior.authUnknown) throw Error('AUTH reply lost');
      return Response.json({ ...await status(), ...(mode === 'proxy' ? {} : { provider_key: 'SECRET_PROVIDER_KEY', provider_api_origin: 'https://direct.invalid/v1' }) });
    }
    if (url.pathname.endsWith('/close')) { counts.closes++; await behavior.beforeClose?.(); if (behavior.closeUnavailable) return new Response(null, { status: 503 }); return Response.json(await status(true)); }
    if (url.pathname.endsWith('/receipts')) return Response.json({ receipts: [], next_cursor: null });
    if (url.pathname.startsWith('/zkapi/v1/sessions/')) return Response.json(await status());
    counts.sends++; order.push('inference');
    const saved = (await journal.read('note'))!.value.pending!;
    assert.equal(saved.operations.at(-1)!.phase, 'send_unknown');
    assert.equal(url.origin, mode === 'proxy' ? context.inference_api_origin : 'https://direct.invalid');
    bodies.push(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)));
    if (behavior.lose) throw Error('response lost');
    if (behavior.streamWaiting) return new Response(new ReadableStream<Uint8Array>(), { headers: { 'Content-Type': 'text/event-stream' } });
    if (behavior.streamFailure) return new Response(new ReadableStream({ start(c) { c.error(new Error('private upstream error')); } }), { headers: { 'Content-Type': 'application/json' } });
    if (behavior.stream) return new Response('data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    return Response.json({ choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] });
  };
  const verifier: SessionVerifier = { async prepare() {}, async settle(_c, previous) {
    counts.settles++; if (behavior.failVerifier) throw Error('invalid signed successor');
    return { ...previous, balance_micro_usdc: String(BigInt(previous.balance_micro_usdc) - 1n), anchor: field(8) };
  } };
  const prover = { async prepareSession(_w: unknown, _s: unknown, _root: string, _siblings: string[], quote: Quote, tariff: ModelConfiguration['tariff'], c: any): Promise<PreparedSession> {
    counts.proof++; order.push('proof');
    return { request: { authorization: { version: '1', deployment_id: context.deployment_id, pool: context.pool, request_id: c.requestId, quote_hash: quote.quote_hash, mode,
      control_secret_hash: c.controlHash, proxy_secret_hash: c.proxyHash }, quote, public_inputs: Array(12).fill(field(1)), proof: { backend: 'groth16_bn254', proof: 'synthetic' } },
      control_token: c.controlToken, proxy_token: c.proxyToken, tariff, rerandomization: field(2) };
  } } as unknown as NoteProver;
  const make = () => {
    const journal = makeJournal();
    const components: ClientComponents = { store, noteId: 'note', mode, models,
      control: new ControlClient({ context, journal, verifier, fetch: http, directProviderBases: { direct_openrouter: 'https://direct.invalid/v1' } }),
      wallet: { manifest: { deployment_id: context.deployment_id, pool: context.pool, cap_micro_usdc: '100' } as VerifiedManifest, journal, prover,
        chain: { async snapshot() { return { root: field(1), siblings: Array(32).fill(field(0)), slot: 1, sequence: '1', nextNoteId: 2, clock: '100', paused: false, treasuryOwner: '' }; },
          async blockhash() { throw Error('unexpected wallet work'); }, async buffer() { return null; } },
        rpc: {} as any, wallets: [{ publicKey: Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey, supportedTransactionVersions: new Set([0]), async signTransaction() { counts.wallet++; throw Error('unexpected wallet signature'); } }] } };
    return new ZkApiClient(components);
  };
  return { client: make(), restart: make, counts, behavior, journal, order, bodies, models };
}

test('one chat call quotes, proves, authorizes, sends once and verifies settlement; model switch uses its tariff', async t => {
  const f = await setup(t), first = chat();
  assert.equal((await f.client.status()).canRequest, true);
  const response = await f.client.chat(first); assert.equal(response.headers.get('X-Zkapi-Operation-Id'), first.operationId);
  assert.equal(await readChatText(response), 'Hello');
  assert.deepEqual(f.order, ['quote', 'proof', 'AUTH', 'inference']);
  assert.equal((await f.client.status()).settledBalanceMicroUsdc, '199'); assert.equal((await f.client.status()).canRequest, true);
  await readChatText(await f.client.chat(chat('second')));
  const saved = (await f.journal.read('note'))!.value;
  assert.deepEqual(saved.history.map(h => h.prepared.tariff.model), ['first', 'second']);
  assert.equal(f.counts.wallet, 0); assert.equal(f.counts.sends, 2);
  await assert.rejects(f.client.chat(first)); assert.equal(f.counts.sends, 2);
});
test('lists and notifications are detached and omit secrets, prompt bodies and provider keys', async t => {
  const f = await setup(t), seen: ClientStatus[] = [];
  f.client.subscribe(s => { seen.push(s); s.settledBalanceMicroUsdc = '0'; throw Error('UI observer'); });
  f.client.subscribe(async () => { throw Error('asynchronous UI observer'); });
  const list = f.client.listModels(); (list[0].apis as string[]).length = 0;
  f.models[0].label = 'mutated';
  assert.equal(f.client.listModels()[0].id, 'first');
  await readChatText(await f.client.chat(chat()));
  const text = JSON.stringify(seen);
  for (const secret of ['balance_blinding', 'control_token', 'proxy_token', 'bodyBase64', 'SECRET_PROVIDER_KEY', 'Hello']) assert.equal(text.includes(secret), false);
  assert.equal((await f.client.status()).settledBalanceMicroUsdc, '199');
});
test('quote rejection never reaches proof, AUTH or inference', async t => {
  const f = await setup(t); f.behavior.rejectQuote = true;
  await assert.rejects(f.client.chat(chat())); assert.deepEqual(f.order, ['quote']);
  assert.equal((await f.journal.read('note'))!.value.pending, null);
});
test('reopening pending AUTH is read-only; new sends are blocked and recovery sends only saved AUTH', async t => {
  const f = await setup(t); f.behavior.authUnknown = true;
  await assert.rejects(f.client.chat(chat())); const before = { ...f.counts };
  const next = f.restart(); assert.equal((await next.status()).session?.phase, 'send_unknown'); assert.deepEqual(f.counts, before);
  await assert.rejects(next.chat(chat()), /recover/); assert.deepEqual(f.counts, before);
  f.behavior.authUnknown = false; await next.recover(); assert.equal(f.counts.sends, 0);
  assert.equal((await next.status()).session, null);
});
test('response loss and failed settlement retain operation; restarting never replays it', async t => {
  for (const mode of ['proxy', 'direct_openrouter'] as const) {
    const f = await setup(t, mode), request = chat(); f.behavior.lose = true; f.behavior.closeUnavailable = true;
    await assert.rejects(f.client.chat(request)); const next = f.restart();
    await assert.rejects(next.chat(chat()), /recover/); assert.equal(f.counts.sends, 1);
    f.behavior.closeUnavailable = false; await next.recover();
    await assert.rejects(next.chat(request)); assert.equal(f.counts.sends, 1);
    assert.equal((await next.status()).session, null);
  }
});
test('an unverified successor never becomes available balance', async t => {
  const f = await setup(t); f.behavior.failVerifier = true;
  assert.equal(await readChatText(await f.client.chat(chat())), 'Hello');
  const status = await f.client.status(); assert.equal(status.canRequest, false); assert.equal(status.settledBalanceMicroUsdc, '200');
  await assert.rejects(f.client.settle());
  f.behavior.failVerifier = false; await f.client.recover(); assert.equal((await f.client.status()).settledBalanceMicroUsdc, '199');
});
test('stream holds action lock; cancellation closes shared lifecycle and releases the client', async t => {
  const f = await setup(t); f.behavior.stream = true;
  const response = await f.client.chat({ ...chat(), stream: true });
  await assert.rejects(f.client.chat(chat()), /Consume or cancel/);
  await assert.rejects(f.client.prepareWithdrawal(Keypair.generate().publicKey.toBase58()), /Consume or cancel/);
  const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
  assert.equal(f.counts.closes, 1); assert.equal((await f.client.status()).canRequest, true);
});
test('stream helpers finish settlement before returning to the next send', async t => {
  const f = await setup(t); f.behavior.stream = true;
  for (let i = 0; i < 3; i++) {
    let text = ''; for await (const delta of readChatDeltas(await f.client.chat({ ...chat(), stream: true }))) text += delta;
    assert.equal(text, 'Hello'); assert.equal((await f.client.status()).canRequest, true);
  }
  assert.equal(f.counts.sends, 3); assert.equal(f.counts.closes, 3);
});
test('stream errors await the existing close finalizer before releasing the application lock', async t => {
  const f = await setup(t); f.behavior.streamFailure = true;
  let release!: () => void;
  f.behavior.beforeClose = () => new Promise<void>(resolve => { release = resolve; });
  const response = await f.client.chat(chat()); let failed = false;
  const read = readChatText(response).catch(() => { failed = true; });
  for (let i = 0; !release && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof release, 'function'); assert.equal(failed, false); assert.equal((await f.client.status()).busy, true);
  release(); await read; assert.equal(failed, true); assert.equal((await f.client.status()).canRequest, true); assert.equal(f.counts.sends, 1);
});
test('cancelling a pending read retains the application lock through settlement', async t => {
  const f = await setup(t); f.behavior.streamWaiting = true;
  let release!: () => void;
  const closing = new Promise<void>(resolve => {
    f.behavior.beforeClose = () => new Promise<void>(done => { release = done; resolve(); });
  });
  const response = await f.client.chat({ ...chat(), stream: true });
  const reader = response.body!.getReader();
  const read = reader.read();
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = reader.cancel();
  await closing;
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.client.status()).busy, true);
    assert.throws(() => f.client.dispose(), /Consume or cancel/);
    await assert.rejects(f.client.settle(), /Consume or cancel/);
  } finally { release(); await cancelled; await read; reader.releaseLock(); }
  assert.equal((await f.client.status()).canRequest, true);
  assert.equal(f.counts.sends, 1); assert.equal(f.counts.closes, 1);
});
test('separate instances share a note lock through body consumption', async t => {
  const f = await setup(t), next = f.restart();
  const first = await f.client.chat(chat()); let returned = false;
  const second = next.chat(chat()).then(r => { returned = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(returned, false); assert.equal(f.counts.sends, 1);
  await readChatText(first); await readChatText(await second); assert.equal(f.counts.sends, 2);
});
test('invalid model, API, ID and body cannot start an authorization; abort-before-send is side-effect free', async t => {
  const f = await setup(t);
  await assert.rejects(f.client.chat(chat('unknown')));
  await assert.rejects(f.client.chat({ ...chat(), maxOutputTokens: 1.5 }));
  await assert.rejects(f.client.chat({ ...chat(), operationId: 'not-a-uuid' }));
  await assert.rejects(f.client.request({ ...chat(), api: 'responses', body: { input: 'hello' } }));
  await assert.rejects(f.client.request({ ...chat(), api: 'chat', body: { model: 'other' } }));
  await assert.rejects(f.client.chat({ ...chat(), signal: AbortSignal.abort() }));
  assert.equal(f.counts.quote, 0); assert.equal(f.counts.sends, 0);
});
test('expired, cleared, closed and insufficient notes cannot start chat', async t => {
  for (const variant of ['expired', 'cleared', 'closed', 'insufficient']) {
    const f = await setup(t), r = (await f.journal.read('note'))!;
    if (variant === 'expired') r.value.witness!.expiry = '1';
    if (variant === 'cleared') r.value.wallet!.clearance = { nullifier: field(1), phase: 'requested' };
    if (variant === 'closed') r.value.wallet!.status = 'closed';
    if (variant === 'insufficient') r.value.state.balance_micro_usdc = '99';
    await f.journal.compareAndSwap('note', r.revision, r.value);
    assert.equal((await f.client.status()).canRequest, false); await assert.rejects(f.client.chat(chat())); assert.equal(f.counts.quote, 0);
  }
});
test('dispose does not settle or erase storage and refuses later actions', async t => {
  const f = await setup(t), before = await f.journal.read('note'); f.client.dispose();
  await assert.rejects(f.client.chat(chat()), /disposed/); assert.deepEqual(await f.journal.read('note'), before); assert.equal(f.counts.auth, 0);
});
