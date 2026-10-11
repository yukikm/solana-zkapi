/** Response branch integration: real facade, ControlClient, ClientDaemon,
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
  const dir = await mkdtemp(join(tmpdir(), 'zkapi-response-branches-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await NativeJournalStore.open(dir);
  const key = await importJournalKey(new Uint8Array(32).fill(17));
  const journal = new EncryptedJournal<NoteJournal>(store, key, { deploymentId: 'response-branches-fixture', pool: 'pool' }, validateNoteJournal);
  const signer = generateKeyPairSync('ed25519');
  const tariff = { version: '1', provider: 'openrouter', model: '*', pricing_basis: 'provider_reported_usd',
    valid_from: '0', valid_until: '9999999999', rates: [], operator_fee_micro_usdc: '0' };
  const models: ModelConfiguration[] = [{ id: 'first', provider: 'openrouter', apis: ['chat'],
    tariff: { ...tariff, tariff_hash: await sha256Hex(jcsBytes(tariff)) } }];
  const context = { deployment_id: 'response-branches-fixture', pool: 'pool', vault_binding: field(1), state_key: [field(2), field(3)] as [string, string],
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
  const behavior = { body: content + terminal, noBody: false, contentType: 'text/event-stream', eof: false,
    settlementReady: false, statusFailures: 0, closeFailures: 0, badSignature: false, ignoreAbort: false,
    beforeClose: undefined as (() => Promise<void>) | undefined,
    beforeCancel: undefined as (() => Promise<void>) | undefined };
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
    if (behavior.noBody) return new Response(null, { headers: { 'Content-Type': behavior.contentType } });
    let active = true;
    let detach = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const end = () => { if (active) { active = false; detach(); controller.close(); } };
        const fail = () => { if (active) { active = false; detach(); controller.error(new Error('synthetic transport interruption')); } };
        streams.push({ end, fail });
        const signal = behavior.ignoreAbort ? undefined : init?.signal;
        signal?.addEventListener('abort', fail, { once: true });
        detach = () => signal?.removeEventListener('abort', fail);
        controller.enqueue(new TextEncoder().encode(behavior.body));
        if (behavior.eof) end();
      },
      async cancel() { counts.cancels++; active = false; detach(); await behavior.beforeCancel?.(); },
    });
    return new Response(body, { headers: { 'Content-Type': behavior.contentType } });
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

type Fixture = Awaited<ReturnType<typeof setup>>;
type Branching = 'clone' | 'tee';
function branches(response: Response, branching: Branching): [Response, Response] {
  if (branching === 'clone') return [response, response.clone()];
  const [left, right] = response.body!.tee();
  const init = { status: response.status, statusText: response.statusText, headers: response.headers };
  return [new Response(left, init), new Response(right, init)];
}
async function assertReusable(f: Fixture, operationId: string): Promise<void> {
  const status = await f.client.status();
  assert.equal(status.busy, false); assert.equal(status.canRequest, true);
  assert.equal(status.session?.phase, 'active');
  assert.equal(status.settledBalanceMicroUsdc, '200');
  assert.equal(f.counts.auth, 1); assert.equal(f.counts.inference, 1);
  assert.equal(f.counts.closes, 0); assert.equal(f.counts.verifies, 0);
  assert.equal(f.counts.cancels, 0);
  assert.deepEqual(f.sentIds, [operationId]);
  const pending = (await f.journal.read('note'))!.value.pending!;
  assert.deepEqual(pending.operations.map(operation => operation.id), [operationId]);
  await assert.rejects(f.client.chat({ ...chat(), operationId }));
  assert.deepEqual(f.sentIds, [operationId], 'reading multiple branches never sends inference again');
}
async function assertUnresolved(f: Fixture, operationId: string): Promise<void> {
  const status = await f.client.status();
  assert.equal(status.busy, false); assert.equal(status.canRequest, false);
  assert.equal(status.settledBalanceMicroUsdc, '200'); assert.equal(f.counts.verifies, 0);
  const pending = (await f.journal.read('note'))!.value.pending!;
  assert.deepEqual(pending.operations.map(operation => ({ id: operation.id, phase: operation.phase })),
    [{ id: operationId, phase: 'send_unknown' }]);
  await assert.rejects(f.client.chat(chat()), /recover/);
  await assert.rejects(f.client.chat({ ...chat(), operationId }), /recover/);
  assert.deepEqual(f.sentIds, [operationId]);
  assert.equal(f.counts.auth, 1); assert.equal(f.counts.inference, 1);
}

for (const branching of ['clone', 'tee'] as const) {
  for (const slowIndex of [0, 1] as const) {
    test(`direct SSE ${branching}: delayed iterator on branch ${slowIndex} survives the other branch reaching EOF`, async t => {
      const f = await setup(t), request = chat();
      f.behavior.body = content + content.replace('Hello', 'World') + terminal;
      f.behavior.eof = true;
      const responses = branches(await f.client.chat(request), branching);
      const slow = readChatDeltas(responses[slowIndex]);
      t.after(async () => { await slow.return(undefined); });
      assert.deepEqual(await slow.next(), { value: 'Hello', done: false });
      const fast = responses[1 - slowIndex].text();
      assert.equal(await fast, f.behavior.body);
      await pause(25);
      assert.equal((await f.client.status()).canRequest, true,
        'the completed network response releases admission even while another branch has buffered text');
      assert.deepEqual(await slow.next(), { value: 'World', done: false });
      assert.deepEqual(await slow.next(), { value: undefined, done: true });
      await assertReusable(f, request.operationId);
    });
  }

  test(`direct SSE ${branching}: simultaneous SDK readers preserve bytes and share one conversation lease`, async t => {
    const f = await setup(t), first = chat();
    f.behavior.body = content + content.replace('Hello', 'World') + terminal;
    const responses = branches(await f.client.chat(first), branching);
    const results = responses.map(response => collect(response));
    await pause(20);
    assert.equal((await f.client.status()).busy, true);
    assert.equal(f.counts.cancels, 0, 'terminal SSE alone does not cancel the network body');
    await assert.rejects(f.client.chat(chat()), /Consume or cancel/);
    f.streams[0].end();
    assert.deepEqual(await Promise.all(results), ['HelloWorld', 'HelloWorld']);
    await assertReusable(f, first.operationId);
    f.behavior.eof = true;
    const second = chat();
    assert.equal(await collect(await f.client.chat(second)), 'HelloWorld');
    assert.deepEqual(f.sentIds, [first.operationId, second.operationId]);
    assert.equal(f.counts.auth, 1); assert.equal(f.counts.proofs, 1); assert.equal(f.counts.quotes, 1);
  });

  for (const canceledIndex of [0, 1] as const) {
    test(`direct SSE ${branching}: cancelling iterator branch ${canceledIndex} preserves the completing branch`, async t => {
      const f = await setup(t), request = chat();
      f.behavior.body = content + content.replace('Hello', 'World') + terminal;
      const responses = branches(await f.client.chat(request), branching);
      const canceled = readChatDeltas(responses[canceledIndex]);
      assert.deepEqual(await canceled.next(), { value: 'Hello', done: false });
      // Native tee cancellation may wait for the surviving branch; drive both
      // concurrently instead of changing that promise's platform semantics.
      const cancellation = canceled.return(undefined);
      const completing = collect(responses[1 - canceledIndex]);
      await pause(20);
      assert.equal((await f.client.status()).busy, true);
      assert.equal(f.counts.cancels, 0, 'one consumer cannot cancel the underlying provider response');
      f.streams[0].end();
      assert.equal(await completing, 'HelloWorld');
      assert.deepEqual(await cancellation, { value: undefined, done: true });
      await assertReusable(f, request.operationId);
    });
  }

  for (const hasTerminal of [false, true]) {
    test(`direct SSE ${branching}: cancelling both branches ${hasTerminal ? 'after DONE' : 'without DONE'} retires the incomplete response`, async t => {
      const f = await setup(t), request = chat(); f.behavior.body = content + (hasTerminal ? terminal : '');
      const responses = branches(await f.client.chat(request), branching);
      const readers = responses.map(response => response.body!.getReader());
      assert.deepEqual(await Promise.all(readers.map(reader => reader.read())),
        readers.map(() => ({ value: new TextEncoder().encode(f.behavior.body), done: false })));
      const firstCancellation = readers[0].cancel();
      await pause(20);
      assert.equal(f.counts.cancels, 0); assert.equal((await f.client.status()).busy, true);
      await Promise.all([firstCancellation, readers[1].cancel()]);
      readers.forEach(reader => reader.releaseLock());
      assert.equal(f.counts.cancels, 1);
      await assertUnresolved(f, request.operationId);
    });
  }

  for (const interruption of ['abort', 'abort after DONE', 'disconnect'] as const) {
    test(`direct SSE ${branching}: ${interruption} rejects both readers and retains the unresolved operation`, async t => {
      const f = await setup(t), request = chat(), abort = new AbortController();
      f.behavior.body = content + (interruption === 'abort after DONE' ? terminal : '');
      const responses = branches(await f.client.chat({ ...request, signal: abort.signal }), branching);
      const readers = responses.map(response => readChatDeltas(response));
      assert.deepEqual(await Promise.all(readers.map(reader => reader.next())),
        readers.map(() => ({ value: 'Hello', done: false })));
      const results = Promise.allSettled(readers.map(reader => reader.next()));
      await pause(20);
      if (interruption.startsWith('abort')) abort.abort(); else f.streams[0].fail();
      for (const result of await results) {
        assert.equal(result.status, 'rejected');
        if (result.status === 'rejected') assert.ok(result.reason instanceof ChatResponseError);
      }
      await assertUnresolved(f, request.operationId);
    });
  }

  test(`direct SSE ${branching}: a buffered iterator remains readable after 600 seconds and verified settlement`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const f = await setup(t), request = chat();
    f.behavior.body = content + content.replace('Hello', 'World') + terminal;
    f.behavior.eof = true; f.behavior.settlementReady = true;
    const [response, copy] = branches(await f.client.chat(request), branching);
    const slow = readChatDeltas(response);
    t.after(async () => { await slow.return(undefined); });
    assert.deepEqual(await slow.next(), { value: 'Hello', done: false });
    assert.equal(await copy.text(), f.behavior.body);
    await pause(20);
    t.mock.timers.tick(600_001);
    await until(async () => {
      const status = await f.client.status();
      return status.session === null && !status.busy;
    }, 'normal maintenance must apply the already-completed lease settlement and release its application lock');
    assert.deepEqual(await slow.next(), { value: 'World', done: false });
    assert.deepEqual(await slow.next(), { value: undefined, done: true });
    const status = await f.client.status();
    assert.equal(status.busy, false); assert.equal(status.canRequest, true);
    assert.equal(status.settledBalanceMicroUsdc, '199'); assert.equal(f.counts.verifies, 1);
    assert.deepEqual(status.lastSettlement?.operationIds, [request.operationId]);
    assert.equal(f.counts.cancels, 0); assert.equal(f.counts.auth, 1);
    assert.deepEqual(f.sentIds, [request.operationId]);
    await assert.rejects(f.client.chat(request));
    assert.deepEqual(f.sentIds, [request.operationId]);
  });

  test(`direct SSE ${branching}: EOF at the transport deadline edge stays valid while settlement crosses it`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const f = await setup(t), request = chat();
    let releaseClose!: () => void;
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
    f.behavior.beforeClose = () => closeGate;
    t.after(releaseClose);
    const [response, copy] = branches(await f.client.chat(request), branching);
    const slow = readChatDeltas(response);
    t.after(async () => { await slow.return(undefined); });
    assert.deepEqual(await slow.next(), { value: 'Hello', done: false });
    let resolved = false;
    const completion = copy.text().then(text => { resolved = true; return text; });
    await pause(20);
    t.mock.timers.tick(599_999); f.streams[0].end();
    await until(() => f.counts.closes === 1, 'validated EOF must reach settlement before advancing the clock');
    t.mock.timers.tick(2_000); await pause(20);
    assert.equal(resolved, false); assert.equal((await f.client.status()).busy, true);
    assert.equal(f.counts.cancels, 0);
    f.behavior.settlementReady = true; releaseClose();
    assert.equal(await completion, f.behavior.body);
    assert.deepEqual(await slow.next(), { value: undefined, done: true });
    const status = await f.client.status();
    assert.equal(status.busy, false); assert.equal(status.canRequest, true); assert.equal(status.session, null);
    assert.equal(status.settledBalanceMicroUsdc, '199'); assert.equal(f.counts.verifies, 1);
    assert.equal(f.counts.cancels, 0); assert.deepEqual(f.sentIds, [request.operationId]);
  });

  for (const [label, choices, requestFields] of [
    ['tool calls', [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'synthetic-call', type: 'function',
      function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
      { tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }] }],
    ['legacy function calls', [{ index: 0, delta: { function_call: { name: 'lookup', arguments: '{}' } }, finish_reason: 'function_call' }],
      { functions: [{ name: 'lookup', parameters: { type: 'object', properties: {} } }] }],
    ['multiple choices', [{ index: 0, delta: { content: 'First' }, finish_reason: 'stop' },
      { index: 1, delta: { content: 'Second' }, finish_reason: 'length' }], { n: 2 }],
    ['default null choice count', [{ index: 0, delta: { content: 'Only' }, finish_reason: 'stop' }], { n: null }],
  ] as const) {
    test(`direct SSE ${branching}: raw ${label} responses retain the advanced API contract`, async t => {
      const f = await setup(t), request = chat();
      f.behavior.body = `data: ${JSON.stringify({ choices })}\n\ndata: [DONE]\n\n`;
      f.behavior.eof = true;
      const response = await f.client.request({ operationId: request.operationId, sessionId: request.sessionId,
        model: request.model, api: 'chat', body: { stream: true, messages: request.messages, ...requestFields } });
      assert.deepEqual(await Promise.all(branches(response, branching).map(branch => branch.text())),
        [f.behavior.body, f.behavior.body]);
      await assertReusable(f, request.operationId);
    });
  }

  for (const [label, body] of [
    ['missing DONE', content + terminal.split('data: [DONE]')[0]],
    ['malformed JSON', content + 'data: {broken}\n\n'],
    ['data after DONE', content + terminal + 'data: {"choices":[]}\n\n'],
  ] as const) {
    test(`direct SSE ${branching}: ${label} cannot qualify for reuse through raw Response readers`, async t => {
      const f = await setup(t), request = chat(); f.behavior.body = body; f.behavior.eof = true;
      const responses = branches(await f.client.chat(request), branching);
      // Neither branch registers an SDK parser. Validation belongs to the
      // original network bytes, even when applications use native body readers.
      for (const result of await Promise.allSettled(responses.map(response => response.text()))) {
        assert.equal(result.status, 'rejected');
      }
      await assertUnresolved(f, request.operationId);
    });
  }

  test(`direct SSE ${branching}: a wrong content type fails through native raw readers`, async t => {
    const f = await setup(t), request = chat();
    f.behavior.contentType = 'application/json'; f.behavior.eof = true;
    const responses = branches(await f.client.chat(request), branching);
    for (const result of await Promise.allSettled(responses.map(response => response.text()))) {
      assert.equal(result.status, 'rejected');
    }
    await assertUnresolved(f, request.operationId);
  });

  test(`direct SSE ${branching}: DONE without HTTP EOF times out both branches without replay`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const f = await setup(t), request = chat();
    const responses = branches(await f.client.chat(request), branching);
    const results = Promise.allSettled(responses.map(response => response.text()));
    await pause(20);
    assert.equal((await f.client.status()).busy, true); assert.equal(f.counts.cancels, 0);
    t.mock.timers.tick(600_000);
    for (const result of await results) assert.equal(result.status, 'rejected');
    assert.equal(f.counts.cancels, 1);
    await assertUnresolved(f, request.operationId);
  });

  for (const interruption of ['abort', 'timeout'] as const) {
    test(`direct SSE ${branching}: ${interruption} holds admission until underlying cancellation resolves`, async t => {
      if (interruption === 'timeout') t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
      const f = await setup(t), request = chat(), abort = new AbortController();
      let releaseCancellation!: () => void;
      const cancellationGate = new Promise<void>(resolve => { releaseCancellation = resolve; });
      t.after(releaseCancellation);
      f.behavior.beforeCancel = () => cancellationGate;
      // Model a custom fetch implementation that needs explicit body
      // cancellation rather than immediately erroring on the request signal.
      f.behavior.ignoreAbort = true;
      const responses = branches(await f.client.chat({ ...request, signal: abort.signal }), branching);
      let completed = false;
      const results = Promise.allSettled(responses.map(response => response.text()))
        .then(value => { completed = true; return value; });
      await pause(20);
      if (interruption === 'abort') abort.abort(); else t.mock.timers.tick(600_000);
      await until(() => f.counts.cancels === 1, 'the interruption must cancel the original provider body');
      await pause(20);
      const pending = await f.client.status();
      assert.equal(completed, false, 'readers must await the pending underlying cancellation');
      assert.equal(pending.busy, true); assert.equal(pending.canRequest, false);
      assert.equal(f.counts.closes, 0, 'lease retirement must wait for underlying cancellation');
      assert.equal(f.counts.verifies, 0); assert.equal(pending.settledBalanceMicroUsdc, '200');
      await assert.rejects(f.client.chat(chat()), /Consume or cancel/);
      assert.deepEqual(f.sentIds, [request.operationId]); assert.equal(f.counts.auth, 1);
      releaseCancellation();
      for (const result of await results) assert.equal(result.status, 'rejected');
      assert.equal(f.counts.cancels, 1);
      await assertUnresolved(f, request.operationId);
    });
  }
}

test('direct SSE without a response body fails before exposing a Response that could be cloned', async t => {
  const f = await setup(t), request = chat(); f.behavior.noBody = true;
  await assert.rejects(f.client.chat(request));
  await assertUnresolved(f, request.operationId);
});

test('direct streaming Chat rejects invalid choice counts before AUTH and preserves the journal', async t => {
  const f = await setup(t), original = (await f.journal.read('note'))!.value;
  for (const n of [0, -1, 1.5, '2', false, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    const request = chat();
    await assert.rejects(f.client.request({ operationId: request.operationId, sessionId: request.sessionId,
      model: request.model, api: 'chat', body: { stream: true, messages: request.messages, n } }));
    assert.deepEqual((await f.journal.read('note'))!.value, original);
    assert.deepEqual(f.sentIds, []);
    assert.ok(Object.values(f.counts).every(count => count === 0), 'invalid n must not authorize, prove, or send');
    const status = await f.client.status();
    assert.equal(status.busy, false); assert.equal(status.canRequest, true);
  }
});
