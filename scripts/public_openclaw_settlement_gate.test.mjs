import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, realpath, writeFile, readFile, rm, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startSettlementInputGate, validateNativeStatus, assertHeadAdvance, assertReady, assertPending, assertSettled, sseFrameEnd } from './public_openclaw_settlement_gate.mjs';
import { parseStrictJson } from '../packages/sdk/dist/trust.js';

const inference = '4'.repeat(64), management = '5'.repeat(64);
const op = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const model = 'openai/gpt-4o-mini';
const status = (phase = 'ready', revision = 1, operation = op) => ({ mode: 'direct_openrouter', key_reuse_seconds: 0,
  recovery_required: false, in_flight: 0, wallet_status: 'active', wallet_operation: null, wallet_emergency_escape: null,
  phase, balance_micro_usdc: '5000000', journal_head: { revision, digest: String(revision).padStart(64, '0') },
  unresolved_operations: phase === 'closing' ? [{ id: operation, response_replayable: false }] : [] });
const body = second => JSON.stringify({ model, stream: true, max_tokens: 128,
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  messages: [{ role: 'user', content: 'Use the read tool once.' }, ...(second ? [{ role: 'tool', tool_call_id: 'read_1', content: 'fixture' }] : [])] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('status boundary requires exact operation, monotonic journal heads and settled balance', () => {
  const initial = status(), pending = status('closing', 2), settled = { ...status('ready', 3), balance_micro_usdc: '4999994' };
  assertReady(initial); assertPending(pending, op, initial); assertSettled(initial, pending, settled);
  // Production strict parsing deliberately creates null-prototype objects.
  assertPending(parseStrictJson(Buffer.from(JSON.stringify(pending))), op, initial);
  assertHeadAdvance(pending.journal_head, pending.journal_head, false);
  for (const patch of [{ recovery_required: true }, { in_flight: 1 }, { wallet_status: 'closed' }, { wallet_operation: {} },
    { wallet_emergency_escape: {} }, { mode: 'proxy' }, { key_reuse_seconds: 60 }, { phase: 'active' },
    { journal_head: { revision: 1, digest: 'bad' } }, { balance_micro_usdc: '-1' }]) assert.throws(() => validateNativeStatus({ ...initial, ...patch }));
  assert.throws(() => assertPending(status('closing', 2, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), op, initial));
  assert.throws(() => assertPending({ ...pending, balance_micro_usdc: '4999994' }, op, initial));
  assert.throws(() => assertSettled(initial, pending, { ...settled, balance_micro_usdc: '5000001' }));
  assert.throws(() => assertSettled(initial, pending, { ...settled, balance_micro_usdc: '3999999' }));
  assert.throws(() => assertSettled(initial, pending, { ...settled, journal_head: pending.journal_head }));
  assert.throws(() => assertHeadAdvance(pending.journal_head, { ...pending.journal_head, digest: 'a'.repeat(64) }, false));
});
test('SSE framing preserves LF/CRLF/CR boundaries without treating one CRLF as an empty line', () => {
  for (const ending of ['\n\n', '\r\n\r\n', '\r\r']) {
    const bytes = Buffer.from('data: [DONE]' + ending);
    assert.equal(sseFrameEnd(bytes, true), bytes.length);
  }
  assert.equal(sseFrameEnd(Buffer.from('data: [DONE]\r\n')), undefined);
  assert.equal(sseFrameEnd(Buffer.from('data: [DONE]\r\n\r')), undefined);
});

async function fixture(t, modify = () => {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zkapi-settlement-adapter-'))); await chmod(root, 0o700);
  const tokenFile = join(root, 'inference'), managementTokenFile = join(root, 'management');
  await writeFile(tokenFile, inference + '\n', { mode: 0o600 }); await writeFile(managementTokenFile, management + '\n', { mode: 0o600 });
  const seen = []; let current = status(), statusReads = 0, statusCode = 200, statusHook = async () => {};
  let chatResponse = { status: 200, type: 'text/event-stream', body: 'data: {"choices":[]}\n\ndata: [DONE]\n\n' };
  const server = createServer(async (req, res) => {
    if (req.url === '/admin/status') {
      assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Bearer ' + management); statusReads++;
      await statusHook(statusReads);
      res.writeHead(statusCode, { 'content-type': 'application/json', ...(statusCode === 307 ? { location: '/forbidden' } : {}) }); res.end(JSON.stringify(current)); return;
    }
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer ' + inference);
    assert.equal(req.headers['x-zkapi-admission'], undefined);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ bytes: Buffer.concat(chunks), operationId: req.headers['idempotency-key'] });
    current = status('closing', seen.length * 2, req.headers['idempotency-key']); modify(current);
    res.writeHead(chatResponse.status, { 'content-type': chatResponse.type }); res.end(chatResponse.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { listenPort: 0, model, tokenFile, managementTokenFile, stateDirectory: join(root, 'state'), upstreamOrigin: `http://127.0.0.1:${server.address().port}` };
  let gate;
  t.after(async () => { await gate?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, config, seen, start: async () => gate = await startSettlementInputGate(config), get gate() { return gate; }, get reads() { return statusReads; },
    set status(v) { current = v; }, set statusCode(v) { statusCode = v; },
    set statusHook(v) { statusHook = v; },
    set chatResponse(v) { chatResponse = v; },
    post: (second = false, signal) => fetch(gate.origin + '/v1/chat/completions', { method: 'POST', body: body(second), signal,
      headers: { authorization: 'Bearer ' + inference, 'content-type': 'application/json', 'idempotency-key': second ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : op } }) };
}

test('holds the exact second input until SDK verified ready, then forwards once with separate credentials', async t => {
  const f = await fixture(t); await f.start(); const one = await f.post(); assert.equal(one.status, 200); await one.text();
  const two = f.post(true);
  for (let i = 0; i < 100 && f.reads < 3; i++) await sleep(10);
  assert.equal(f.seen.length, 1); assert.equal(f.gate.status().forwarded, 1);
  const held = JSON.parse(await readFile(join(f.config.stateDirectory, 'held-second.json'))); assert.equal(held.firstOperationId, op);
  await assert.rejects(access(join(f.config.stateDirectory, 'forward-2.json')));
  f.status = { ...status('ready', 3), balance_micro_usdc: '4999994' };
  const result = await two; assert.equal(result.status, 200); await result.text();
  assert.equal(f.seen.length, 2); assert.equal(f.seen[1].bytes.toString(), body(true)); assert.equal(f.seen[1].operationId, held.operationId);
  const settled = JSON.parse(await readFile(join(f.config.stateDirectory, 'first-settled.json')));
  assert.equal(settled.settledHead.revision, 3); assert.equal(settled.independent_receipt_verification, false);
  assert.equal((await f.post(true)).status, 429); assert.equal(f.seen.length, 2);
  await assert.rejects(startSettlementInputGate(f.config));
});

test('canceling a held second input leaves a permanent private marker and sends no second POST', async t => {
  const f = await fixture(t); await f.start(); await (await f.post()).text();
  const controller = new AbortController(), pending = f.post(true, controller.signal);
  for (let i = 0; i < 100 && f.reads < 3; i++) await sleep(10);
  controller.abort(); await assert.rejects(pending);
  for (let i = 0; i < 100 && !f.gate.status().poisoned; i++) await sleep(10);
  assert.equal(f.gate.status().poisoned, true); assert.equal(f.seen.length, 1);
  assert.equal((await f.post(true)).status, 503); await access(join(f.config.stateDirectory, 'held-second.json'));
  await assert.rejects(access(join(f.config.stateDirectory, 'forward-2.json')));
});

test('status redirect is a hard refusal with no retry, second native POST or restart adoption', async t => {
  const f = await fixture(t); await f.start(); await (await f.post()).text(); f.statusCode = 307;
  const before = f.reads; assert.equal((await f.post(true)).status, 503); assert.equal(f.reads, before + 1);
  assert.equal(f.seen.length, 1); assert.equal(f.gate.status().poisoned, true);
});

test('missing or different first pending operation cannot be inferred as successful settlement', async t => {
  const f = await fixture(t, current => { current.unresolved_operations[0].id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; });
  await f.start(); const response = await f.post(); await assert.rejects(response.text());
  assert.equal(f.gate.status().poisoned, true); assert.equal(f.seen.length, 1); assert.equal((await f.post(true)).status, 503);
});

test('management credentials must remain private and distinct before adapter startup', async t => {
  const f = await fixture(t); await writeFile(f.config.managementTokenFile, inference, { mode: 0o600 }); await assert.rejects(f.start());
  await writeFile(f.config.managementTokenFile, management); await chmod(f.config.managementTokenFile, 0o644); await assert.rejects(f.start());
});

for (const cancelAtDone of [false, true]) test(`immediate second POST after DONE is scheduled even before EOF (cancel=${cancelAtDone})`, async t => {
  const f = await fixture(t); let entered, release;
  const statusEntered = new Promise(resolve => entered = resolve), delayed = new Promise(resolve => release = resolve);
  f.statusHook = async count => { if (count === 2) { entered(); await delayed; } };
  await f.start(); const first = await f.post(), reader = first.body.getReader();
  const part = await reader.read(); assert.equal(part.done, false); assert(!Buffer.from(part.value).toString().includes('[DONE]'));
  await statusEntered; const terminalRead = reader.read(); let delivered = false; terminalRead.then(() => delivered = true);
  await sleep(25); assert.equal(delivered, false); release();
  const terminal = await terminalRead; assert(Buffer.from(terminal.value).toString().includes('[DONE]'));
  // The caller deliberately has not read HTTP EOF before sending continuation.
  if (cancelAtDone) await reader.cancel();
  f.status = { ...status('ready', 3), balance_micro_usdc: '4999994' };
  const second = await f.post(true); assert.equal(second.status, 200); await second.text();
  if (!cancelAtDone) assert.equal((await reader.read()).done, true);
  assert.equal(f.seen.length, 2); assert.equal(f.gate.status().poisoned, false);
});

test('canceling the first stream before the withheld terminal event poisons the adapter', async t => {
  const f = await fixture(t); let entered, release;
  const statusEntered = new Promise(resolve => entered = resolve), delayed = new Promise(resolve => release = resolve);
  f.statusHook = async count => { if (count === 2) { entered(); await delayed; } };
  await f.start(); const first = await f.post(), reader = first.body.getReader(); await reader.read(); await statusEntered;
  t.after(release);
  // Reader cancellation resolves locally before TCP close reaches the adapter.
  // Keep pending status blocked until the server observes that transport close.
  await reader.cancel();
  for (let i = 0; i < 100 && !f.gate.status().poisoned; i++) await sleep(10);
  assert.equal(f.gate.status().poisoned, true); release();
  assert.equal(f.seen.length, 1); assert.equal((await f.post(true)).status, 503);
});

test('first native JSON error is forwarded exactly and permanently fences the adapter without a post-response status read', async t => {
  const f = await fixture(t), bytes = Buffer.from('{"error":"fixture rejection — no SSE"}\n');
  f.chatResponse = { status: 400, type: 'application/json; charset=utf-8', body: bytes };
  await f.start(); const response = await f.post();
  assert.equal(response.status, 400); assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(f.reads, 1); assert.equal(f.seen.length, 1); assert.equal(f.gate.status().poisoned, true);
  const record = JSON.parse(await readFile(join(f.config.stateDirectory, 'response-1.json')));
  assert.deepEqual(record, { schema: 1, status: 400, contentTypeCategory: 'application/json', bodyBytes: bytes.length,
    bodySha256: createHash('sha256').update(bytes).digest('hex') });
  assert(!JSON.stringify(record).includes('fixture rejection'));
  assert.equal((await f.post(true)).status, 503); assert.equal(f.reads, 1); assert.equal(f.seen.length, 1);
  await assert.rejects(access(join(f.config.stateDirectory, 'held-second.json')));
  await assert.rejects(access(join(f.config.stateDirectory, 'forward-2.json')));
});

test('second native non-200 bytes bypass SSE and no further native status or POST is sent', async t => {
  const f = await fixture(t); await f.start(); await (await f.post()).text();
  f.status = { ...status('ready', 3), balance_micro_usdc: '4999994' };
  const bytes = Buffer.from([0, 255, 13, 10, 1]);
  f.chatResponse = { status: 502, type: 'application/octet-stream', body: bytes };
  const response = await f.post(true); assert.equal(response.status, 502);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(f.reads, 3); assert.equal(f.seen.length, 2); assert.equal(f.gate.status().poisoned, true);
  const record = JSON.parse(await readFile(join(f.config.stateDirectory, 'response-2.json')));
  assert.deepEqual(record, { schema: 1, status: 502, contentTypeCategory: 'other', bodyBytes: bytes.length,
    bodySha256: createHash('sha256').update(bytes).digest('hex') });
  assert.equal((await f.post(true)).status, 503); assert.equal(f.reads, 3); assert.equal(f.seen.length, 2);
});

test('oversized native error body is refused before forwarding and never retried or marked complete', async t => {
  const f = await fixture(t); f.chatResponse = { status: 400, type: 'application/json', body: Buffer.alloc(65_537, 65) };
  await f.start(); const response = await f.post(); assert.equal(response.status, 503); await response.text();
  assert.equal(f.gate.status().poisoned, true); assert.equal(f.reads, 1); assert.equal(f.seen.length, 1);
  await assert.rejects(access(join(f.config.stateDirectory, 'response-1.json')));
  assert.equal((await f.post(true)).status, 503); assert.equal(f.seen.length, 1);
});
