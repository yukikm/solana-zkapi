/** Direct Chat Completions integration: real facade, ControlClient, ClientDaemon,
 * encrypted journal and native locks; synthetic provider, proof and chain. These
 * fixtures exercise no funded wallet, public Devnet or real proof acceptance. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { fixtureSigner } from './kit-helpers.ts';
import { ZkApiClient, type ClientComponents, type ModelConfiguration } from '../src/client.ts';
import { ChatResponseError, readChatDeltas } from '../src/chat.ts';
import { ControlClient, validateNoteJournal, type NoteJournal, type PreparedSession, type Quote, type SessionVerifier } from '../src/control.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import type { NoteProver } from '../src/prover.ts';
import { jcsBytes, sha256Hex, type VerifiedManifest } from '../src/trust.ts';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const realSetTimeout = globalThis.setTimeout;
const pause = (ms = 5) => new Promise<void>(resolve => realSetTimeout(resolve, ms));
const content = 'data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n';
const terminal = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const chat = () => ({ operationId: crypto.randomUUID(), sessionId: 'one-conversation', model: 'first',
  messages: [{ role: 'user' as const, content: 'Hello' }], maxOutputTokens: 32, stream: true });
async function collect(response: Response): Promise<string> {
  let text = ''; for await (const delta of readChatDeltas(response)) text += delta; return text;
}
async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (await check()) return; await pause(); }
  assert.fail(message);
}

async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'zkapi-direct-sse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await NativeJournalStore.open(dir);
  const key = await importJournalKey(new Uint8Array(32).fill(17));
  const journal = new EncryptedJournal<NoteJournal>(store, key, { deploymentId: 'direct-sse-fixture', pool: 'pool' }, validateNoteJournal);
  const signer = generateKeyPairSync('ed25519');
  const tariff = { version: '1', provider: 'openrouter', model: '*', pricing_basis: 'provider_reported_usd',
    valid_from: '0', valid_until: '9999999999', rates: [], operator_fee_micro_usdc: '0' };
  const models: ModelConfiguration[] = [{ id: 'first', provider: 'openrouter', apis: ['chat'],
    tariff: { ...tariff, tariff_hash: await sha256Hex(jcsBytes(tariff)) } }];
  const context = { deployment_id: 'direct-sse-fixture', pool: 'pool', vault_binding: field(1), state_key: [field(2), field(3)] as [string, string],
    cap_micro_usdc: '100', control_api_origin: 'https://control.invalid', inference_api_origin: 'https://proxy.invalid',
    quote_public_key: bs58.encode(signer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
    receipt_public_key: bs58.encode(signer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)),
    request_vk_sha256: '22'.repeat(32), tariff_hashes: models.map(m => m.tariff.tariff_hash) };
  const state = { balance_micro_usdc: '200', balance_blinding: field(3), note_leaf: field(4),
    commitment: { x: field(5), y: field(6) }, anchor: field(7), state_signature: null };
  const signature = { r_x: field(2), r_y: field(3), s: field(4) };
  await journal.create('note', { schema: 1, state,
    witness: { secret: field(2), note_id: 1, deposit_micro_usdc: '200', expiry: '9999999999' },
    wallet: { status: 'active', history: [] }, pending: null, history: [] });
  const counts = { quotes: 0, proofs: 0, auth: 0, inference: 0, closes: 0, status: 0, receipts: 0, verifies: 0, cancels: 0 };
  const behavior = { body: content + terminal, eof: false, settlementReady: false, statusFailures: 0, closeFailures: 0, badSignature: false,
    beforeClose: undefined as (() => Promise<void>) | undefined };
  const streams: { end(): void; fail(): void }[] = [];
  const sentIds: string[] = [];
  const sessionStatus = async (settled = false, closing = false) => {
    const p = (await journal.read('note'))!.value.pending!;
    return { request_id: p.prepared.request.authorization.request_id, mode: 'direct_openrouter',
      state: settled ? 'SETTLED' : closing ? 'DRAINING' : 'ACTIVE', cap_micro_usdc: '100',
      issued_at: p.prepared.request.quote.body.issued_at,
      expires_at: String(BigInt(p.prepared.request.quote.body.issued_at) + 60n),
      ...(settled ? { settlement: { charge_micro_usdc: '1', next_commitment: state.commitment, next_anchor: field(8),
        blind_delta_srv: field(9), next_state_signature: { ...signature, ...(behavior.badSignature ? { s: field(10) } : {}) } } } : {}) };
  };
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/quotes')) {
      counts.quotes++;
      const wanted = JSON.parse(String(init!.body)), now = BigInt(Math.floor(Date.now() / 1000));
      assert.equal(wanted.session_ttl_seconds, '60');
      const body: Quote['body'] = { quote_id: crypto.randomUUID(), deployment_id: context.deployment_id, pool: context.pool,
        mode: 'direct_openrouter', provider: 'openrouter', models: wanted.models, tariff_hash: models[0].tariff.tariff_hash,
        cap_micro_usdc: '100', issued_at: String(now), expires_at: String(now + 120n), session_ttl_seconds: '60', max_concurrency: '4',
        control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin };
      const hash = await sha256Hex(jcsBytes(body));
      return Response.json({ body, quote_hash: hash, signature: sign(null, Buffer.from(hash, 'hex'), signer.privateKey).toString('base64') });
    }
    if (url.pathname === '/zkapi/v1/sessions') {
      counts.auth++;
      return Response.json({ ...await sessionStatus(), provider_key: 'PUBLIC_SYNTHETIC_KEY', provider_api_origin: 'https://direct.invalid/v1' });
    }
    if (url.pathname.endsWith('/close')) {
      counts.closes++;
      await behavior.beforeClose?.();
      if (behavior.closeFailures-- > 0) return new Response(null, { status: 503 });
      return Response.json(await sessionStatus(behavior.settlementReady, true));
    }
    if (url.pathname.endsWith('/receipts')) { counts.receipts++; return Response.json({ receipts: [], next_cursor: null }); }
    if (url.pathname.startsWith('/zkapi/v1/sessions/')) {
      counts.status++;
      if (behavior.statusFailures-- > 0) return new Response(null, { status: 503 });
      return Response.json(await sessionStatus(behavior.settlementReady, true));
    }
    assert.equal(url.href, 'https://direct.invalid/v1/chat/completions');
    assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer PUBLIC_SYNTHETIC_KEY');
    assert.equal(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)).stream, true);
    const operation = (await journal.read('note'))!.value.pending!.operations.at(-1)!;
    assert.equal(operation.phase, 'send_unknown');
    sentIds.push(operation.id); counts.inference++;
    let active = true;
    let detach = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const end = () => { if (active) { active = false; detach(); controller.close(); } };
        const fail = () => { if (active) { active = false; detach(); controller.error(new Error('synthetic transport interruption')); } };
        streams.push({ end, fail });
        const signal = init?.signal;
        signal?.addEventListener('abort', fail, { once: true });
        detach = () => signal?.removeEventListener('abort', fail);
        controller.enqueue(new TextEncoder().encode(behavior.body));
        if (behavior.eof) end();
      },
      cancel() { counts.cancels++; active = false; detach(); },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const verifier: SessionVerifier = { async prepare() {}, async settle(_config, previous, _prepared, settlement) {
    counts.verifies++;
    assert.deepEqual({ ...settlement.next_state_signature }, signature, 'synthetic signed successor validation');
    return { ...previous, balance_micro_usdc: String(BigInt(previous.balance_micro_usdc) - 1n), anchor: field(8) };
  } };
  const prover = { async prepareSession(_w: unknown, _s: unknown, _root: string, _siblings: string[], quote: Quote,
    selected: ModelConfiguration['tariff'], credentials: any): Promise<PreparedSession> {
    counts.proofs++;
    return { request: { authorization: { version: '1', deployment_id: context.deployment_id, pool: context.pool,
      request_id: credentials.requestId, quote_hash: quote.quote_hash, mode: 'direct_openrouter',
      control_secret_hash: credentials.controlHash, proxy_secret_hash: credentials.proxyHash }, quote,
      public_inputs: Array(12).fill(field(1)), proof: { backend: 'groth16_bn254', proof: 'synthetic' } },
      control_token: credentials.controlToken, proxy_token: credentials.proxyToken, tariff: selected, rerandomization: field(2) };
  } } as unknown as NoteProver;
  const walletAddress = (await fixtureSigner(new Uint8Array(32).fill(1))).address;
  const components: ClientComponents = { store, noteId: 'note', mode: 'direct_openrouter', models, keyReuseSeconds: 60,
    control: new ControlClient({ context, journal, verifier, fetch: http, directProviderBases: { direct_openrouter: 'https://direct.invalid/v1' } }),
    wallet: { manifest: { deployment_id: context.deployment_id, pool: context.pool, cap_micro_usdc: '100',
      control_api_origin: context.control_api_origin, inference_api_origin: context.inference_api_origin } as unknown as VerifiedManifest,
      journal, prover, fetch: http, chain: {
        async snapshot() { throw Error('unexpected note account selection'); },
        async sessionSnapshot() { return { root: field(1), siblings: Array(32).fill(field(0)), slot: 1, sequence: '1', nextNoteId: 2, clock: '100', paused: false }; },
        async blockhash() { throw Error('unexpected wallet work'); }, async buffer() { return null; },
      }, rpc: {} as any, wallets: [{ publicKey: walletAddress, supportedTransactionVersions: new Set([0]),
        async signTransaction() { throw Error('unexpected wallet signature'); } }] } };
  const client = new ZkApiClient(components);
  t.after(() => { client.dispose(); for (const stream of streams) stream.end(); });
  return { client, journal, counts, behavior, streams, sentIds };
}

test('direct SSE terminal markers with delayed HTTP EOF retain the lock, then reuse the same conversation lease', async t => {
  const f = await setup(t), first = chat();
  const deltas = readChatDeltas(await f.client.chat(first));
  assert.deepEqual(await deltas.next(), { value: 'Hello', done: false });
  let completed = false;
  const completion = deltas.next().then(result => { completed = true; return result; });
  await pause(30);
  assert.equal(completed, false, 'valid terminal SSE must not cancel before the transport confirms EOF');
  assert.equal(f.counts.cancels, 0);
  assert.equal((await f.client.status()).busy, true);
  await assert.rejects(f.client.chat(chat()), /Consume or cancel/);
  f.streams[0].end();
  assert.deepEqual(await completion, { value: undefined, done: true });
  assert.equal((await f.client.status()).canRequest, true);
  const next = chat(); f.behavior.eof = true;
  assert.equal(await collect(await f.client.chat(next)), 'Hello');
  assert.equal((await f.client.status()).canRequest, true);
  assert.equal(f.counts.auth, 1); assert.equal(f.counts.closes, 0); assert.equal(f.counts.cancels, 0);
  assert.deepEqual(f.sentIds, [first.operationId, next.operationId]);
  await assert.rejects(f.client.chat(first)); assert.equal(f.counts.inference, 2);
});

for (const transient of ['none', 'status', 'close'] as const) {
  test(`direct SSE expiry during response automatically applies delayed settlement (${transient} transient error)`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const f = await setup(t), first = chat();
    const consumed = collect(await f.client.chat(first));
    t.mock.timers.tick(61_000);
    if (transient === 'status') f.behavior.statusFailures = 1;
    if (transient === 'close') f.behavior.closeFailures = 1;
    f.streams[0].end();
    await until(() => f.counts.closes >= 1, 'completion must retire the expired lease');
    assert.equal(await consumed, 'Hello');
    assert.equal(f.counts.inference, 1); assert.equal(f.counts.auth, 1);
    assert.equal((await f.client.status()).settledBalanceMicroUsdc, '200');
    assert.notEqual((await f.client.status()).session, null);
    t.mock.timers.tick(1_000);
    await until(() => f.counts.status >= 1, 'completed response must automatically observe the closing session');
    await pause(40);
    assert.equal(f.counts.verifies, 0, 'a pending or unavailable settlement is not payment');
    f.behavior.settlementReady = true;
    for (let i = 0; i < 10 && (await f.client.status()).session; i++) { t.mock.timers.tick(1_000); await pause(40); }
    await until(async () => {
      const status = await f.client.status();
      return status.session === null && !status.busy;
    }, `settled successor must apply and release the application lock without manual recover: ${JSON.stringify({ counts: f.counts, status: await f.client.status() })}`);
    const status = await f.client.status();
    assert.equal(status.canRequest, true); assert.equal(status.settledBalanceMicroUsdc, '199');
    assert.deepEqual(status.lastSettlement?.operationIds, [first.operationId]);
    assert.equal(f.counts.verifies, 1); assert.equal(f.counts.receipts, 1);
    f.behavior.eof = true;
    const second = chat(); assert.equal(await collect(await f.client.chat(second)), 'Hello');
    assert.deepEqual(f.sentIds, [first.operationId, second.operationId]); assert.equal(f.counts.auth, 2);
  });
}

for (const interruption of ['abort', 'abort after DONE', 'iteration break', 'disconnect'] as const) {
  test(`direct SSE ${interruption} never counts as successful completion or repeats inference`, async t => {
    const f = await setup(t), abort = new AbortController(), request = chat();
    f.behavior.body = interruption === 'abort after DONE' ? content + terminal : content;
    const deltas = readChatDeltas(await f.client.chat({ ...request, signal: abort.signal }));
    assert.deepEqual(await deltas.next(), { value: 'Hello', done: false });
    if (interruption === 'iteration break') await deltas.return(undefined);
    else {
      const next = deltas.next();
      if (interruption.startsWith('abort')) {
        if (interruption === 'abort after DONE') await pause(20);
        abort.abort();
      } else f.streams[0].fail();
      await assert.rejects(next, ChatResponseError);
    }
    const status = await f.client.status();
    assert.equal(status.busy, false); assert.equal(status.canRequest, false);
    assert.equal(status.settledBalanceMicroUsdc, '200'); assert.equal(f.counts.verifies, 0);
    await assert.rejects(f.client.chat(chat()), /recover/);
    assert.deepEqual(f.sentIds, [request.operationId]); assert.equal(f.counts.auth, 1);
  });
}

for (const [label, body] of [
  ['missing finish_reason', content + 'data: [DONE]\n\n'],
  ['missing DONE', content + terminal.split('data: [DONE]')[0]],
  ['malformed JSON', content + 'data: {broken}\n\n'],
  ['unsupported finish_reason', content + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'],
  ['data after DONE', content + terminal + 'data: {"choices":[]}\n\n'],
] as const) {
  test(`direct SSE ${label} at HTTP EOF preserves unresolved payment and prevents key reuse`, async t => {
    const f = await setup(t), request = chat(); f.behavior.body = body; f.behavior.eof = true;
    await assert.rejects(collect(await f.client.chat(request)), ChatResponseError);
    const status = await f.client.status();
    assert.equal(status.busy, false); assert.equal(status.canRequest, false);
    assert.equal(status.settledBalanceMicroUsdc, '200'); assert.equal(f.counts.verifies, 0);
    await assert.rejects(f.client.chat(chat()), /recover/);
    assert.deepEqual(f.sentIds, [request.operationId]); assert.equal(f.counts.auth, 1);
  });
}

test('direct SSE terminal markers without HTTP EOF time out, release the lock and never permit key reuse', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await setup(t), request = chat();
  const deltas = readChatDeltas(await f.client.chat(request));
  assert.deepEqual(await deltas.next(), { value: 'Hello', done: false });
  const completion = deltas.next();
  // Terminal SSE is available, but the transport deliberately never closes.
  await pause(20);
  assert.equal(f.counts.cancels, 0); assert.equal((await f.client.status()).busy, true);
  t.mock.timers.tick(600_000);
  await assert.rejects(completion, error => error instanceof ChatResponseError && error.code === 'incomplete_stream');
  const status = await f.client.status();
  assert.equal(status.busy, false); assert.equal(status.canRequest, false);
  assert.equal(status.settledBalanceMicroUsdc, '200'); assert.equal(f.counts.verifies, 0);
  assert.equal(f.counts.cancels, 1);
  await assert.rejects(f.client.chat(chat()), /recover/);
  assert.deepEqual(f.sentIds, [request.operationId]); assert.equal(f.counts.auth, 1);
});

test('direct SSE verified EOF before its deadline remains complete while settlement finalization crosses that deadline', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await setup(t), request = chat();
  let releaseClose!: () => void;
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  f.behavior.beforeClose = () => closeGate;
  t.after(releaseClose);
  const deltas = readChatDeltas(await f.client.chat(request));
  assert.deepEqual(await deltas.next(), { value: 'Hello', done: false });
  let resolved = false;
  const completion = deltas.next().then(value => { resolved = true; return value; });
  t.mock.timers.tick(599_999);
  f.streams[0].end();
  await until(() => f.counts.closes === 1, 'genuine EOF must reach the existing settlement finalizer');
  t.mock.timers.tick(2_000);
  await pause(20);
  assert.equal(resolved, false); assert.equal((await f.client.status()).busy, true);
  assert.equal(f.counts.cancels, 0, 'verified HTTP EOF must clear the parser deadline before settlement finishes');
  f.behavior.settlementReady = true; releaseClose();
  assert.deepEqual(await completion, { value: undefined, done: true });
  const status = await f.client.status();
  assert.equal(status.busy, false); assert.equal(status.canRequest, true); assert.equal(status.session, null);
  assert.equal(status.settledBalanceMicroUsdc, '199'); assert.equal(f.counts.verifies, 1);
  assert.equal(f.counts.cancels, 0); assert.deepEqual(f.sentIds, [request.operationId]); assert.equal(f.counts.auth, 1);
});

test('direct SSE settlement waiting stops at its deadline without accepting payment or repeating inference', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await setup(t), request = chat();
  const consumed = collect(await f.client.chat(request));
  t.mock.timers.tick(61_000); f.streams[0].end();
  await until(() => f.counts.closes > 0, 'expired completed response must attempt close');
  assert.equal(await consumed, 'Hello');
  // Wait for the original response's crypto/storage finalization before
  // advancing the background timer. The first GET proves its 45s deadline is
  // registered, independent of concurrent test or filesystem load.
  t.mock.timers.tick(1_000);
  await until(() => f.counts.status > 0, 'automatic settlement wait must begin before advancing its deadline');
  t.mock.timers.tick(45_000);
  await until(async () => !(await f.client.status()).busy, 'bounded settlement wait must release the application lock');
  const status = await f.client.status();
  assert.equal(status.canRequest, false); assert.equal(status.settledBalanceMicroUsdc, '200');
  assert.notEqual(status.session, null); assert.equal(f.counts.verifies, 0);
  const requests = f.counts.status + f.counts.closes;
  t.mock.timers.tick(60_000); await pause(40);
  assert.equal(f.counts.status + f.counts.closes, requests, 'deadline must stop automatic settlement checks');
  const network = { ...f.counts };
  // Neither a later server result nor repeated new send intent can revive the
  // exhausted automatic wait. Only explicit recovery can resolve this state.
  f.behavior.settlementReady = true;
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.client.chat(chat()), /recover/);
    assert.equal((await f.client.status()).canRequest, false);
  }
  assert.deepEqual(f.counts, network, 'blocked explicit sends and local status must not touch the network');
  assert.deepEqual(f.sentIds, [request.operationId]); assert.equal(f.counts.auth, 1);
});

test('direct SSE completion cannot accept an invalid signed settlement', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await setup(t), request = chat();
  f.behavior.settlementReady = true; f.behavior.badSignature = true;
  const consumed = collect(await f.client.chat(request));
  t.mock.timers.tick(61_000); f.streams[0].end();
  assert.equal(await consumed, 'Hello');
  const status = await f.client.status();
  assert.equal(status.canRequest, false); assert.equal(status.settledBalanceMicroUsdc, '200');
  assert.notEqual(status.session, null); assert.equal(f.counts.verifies, 1);
  await assert.rejects(f.client.chat(chat()), /recover/);
  assert.deepEqual(f.sentIds, [request.operationId]); assert.equal(f.counts.auth, 1);
});
