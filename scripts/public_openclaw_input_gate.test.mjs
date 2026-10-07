import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startInputGate } from './public_openclaw_input_gate.mjs';
const token = '4'.repeat(64), model = 'openai/gpt-4o-mini';
const body = (text = 'one', extra = {}) => JSON.stringify({ model, stream: true, max_tokens: 128,
  tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  messages: [{ role: 'user', content: text }, ...(text === 'two' ? [{ role: 'tool', tool_call_id: 'call_read', content: 'fixture read result' }] : [])], ...extra });
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
async function fixture(t, handler) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'zkapi-input-gate-'))); await chmod(root, 0o700);
  const tokenFile = join(root, 'token'); await writeFile(tokenFile, token + '\n', { mode: 0o600 });
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { tokenFile, model, listenPort: 0, stateDirectory: join(root, 'gate'), upstreamOrigin: `http://127.0.0.1:${server.address().port}` };
  let gate;
  t.after(async () => { await gate?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, config, start: async () => gate = await startInputGate(config), get gate() { return gate; },
    post: (bytes = body(), moreHeaders = {}, path = '/v1/chat/completions') => fetch(gate.origin + path, { method: 'POST', headers: { ...headers, ...moreHeaders }, body: bytes, redirect: 'manual' }) };
}
test('passes two exact request/stream bodies after durable markers and rejects the third before upstream', async t => {
  const seen = [], stream = 'data: {"choices":[]}\n\ndata: [DONE]\n\n'; let f;
  f = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks); seen.push(bytes);
    const marker = JSON.parse(await readFile(join(f.config.stateDirectory, `forward-${seen.length}.json`)));
    assert.equal(marker.bodySha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(req.headers.authorization, headers.authorization); assert.equal(req.headers['x-zkapi-admission'], undefined);
    assert.equal(req.headers['idempotency-key'], marker.operationId); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(stream.slice(0, 9)); res.end(stream.slice(9));
  });
  await f.start();
  for (const text of ['one', 'two']) { const response = await f.post(body(text), { 'x-zkapi-admission': 'must-not-forward' }); assert.equal(response.status, 200); assert.equal(await response.text(), stream); }
  const third = await f.post(body('three')); assert.equal(third.status, 429); assert.equal(seen.length, 2);
  assert.equal(seen[0].toString(), body('one')); assert.equal(seen[1].toString(), body('two'));
  assert.equal(f.gate.status().forwarded, 2); await assert.rejects(startInputGate(f.config));
});
test('wrong auth, query, method, cap, model, unstreamed body and oversized input never reserve', async t => {
  let sends = 0; const f = await fixture(t, (_q, s) => { sends++; s.end(); }); await f.start();
  assert.equal((await f.post(body(), { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.post(body(), {}, '/v1/chat/completions?x=1')).status, 404);
  assert.equal((await fetch(f.gate.origin + '/v1/chat/completions', { headers })).status, 404);
  for (const invalid of [body('bad', { max_tokens: 129 }), body('bad', { model: 'other' }), body('bad', { stream: false }), body('bad', { tools: [{ type: 'function', function: { name: 'exec' } }] }), body('two'), '{"model":"x","model":"y"}']) assert.equal((await f.post(invalid)).status, 400);
  assert.equal((await f.post(body('x'.repeat(2 * 1024 * 1024)))).status, 413);
  assert.equal(sends, 0); assert.equal(f.gate.status().forwarded, 0);
});
test('serialized inputs and repeat body/operation are refused without a second forward', async t => {
  let release, entered; const seen = new Promise(resolve => entered = resolve); let sends = 0;
  const f = await fixture(t, async (_q, res) => { sends++; entered(); await new Promise(resolve => release = resolve); res.end('done'); }); await f.start();
  const pending = f.post(); await seen; assert.equal((await f.post(body('two'))).status, 409);
  release(); assert.equal(await (await pending).text(), 'done');
  assert.equal((await f.post()).status, 409); assert.equal(sends, 1);
  const marker = JSON.parse(await readFile(join(f.config.stateDirectory, 'forward-1.json')));
  assert.equal((await f.post(body('two'), { 'idempotency-key': marker.operationId })).status, 409); assert.equal(sends, 1);
});
test('redirect and upstream loss retain consumed slots and never retry or follow', async t => {
  let sends = 0; const f = await fixture(t, (req, res) => { sends++; if (sends === 1) { res.writeHead(307, { location: '/forbidden' }); res.end(); } else req.socket.destroy(); }); await f.start();
  assert.equal((await f.post(body('one'))).status, 502); assert.equal((await f.post(body('two'))).status, 502);
  assert.equal((await f.post(body('three'))).status, 429); assert.equal(sends, 2); assert.equal(f.gate.status().forwarded, 2);
});
test('uncertain durable write poisons the gate and forwards nothing', async t => {
  let sends = 0; const f = await fixture(t, (_q, s) => { sends++; s.end(); }); await f.start();
  // A preexisting marker simulates a partial/colliding persistent write.
  await writeFile(join(f.config.stateDirectory, 'forward-1.json'), 'retained uncertain marker\n', { flag: 'wx', mode: 0o600 });
  assert.equal((await f.post()).status, 503); assert.equal((await f.post(body('two'))).status, 503);
  assert.equal(sends, 0); assert.equal(f.gate.status().poisoned, true);
  assert.equal(await readFile(join(f.config.stateDirectory, 'forward-1.json'), 'utf8'), 'retained uncertain marker\n');
});
test('rejects exposed/symlinked token and non-loopback origin before creating state', async t => {
  const f = await fixture(t, (_q, s) => s.end());
  await chmod(f.config.tokenFile, 0o644); await assert.rejects(f.start()); await chmod(f.config.tokenFile, 0o600);
  const alias = join(f.root, 'alias'); await symlink(f.config.tokenFile, alias);
  await assert.rejects(startInputGate({ ...f.config, tokenFile: alias }));
  await assert.rejects(startInputGate({ ...f.config, upstreamOrigin: 'https://example.com' }));
  await assert.rejects(startInputGate({ ...f.config, upstreamOrigin: 'http://127.0.0.1:3/other' }));
});
test('client disconnect cancels upstream stream without releasing its reserved slot', async t => {
  let closed; const closure = new Promise(resolve => closed = resolve); let sends = 0;
  const f = await fixture(t, (_q, s) => { sends++; s.writeHead(200, { 'content-type': 'text/event-stream' }); s.write('data: first\n\n'); s.on('close', closed); }); await f.start();
  const cancel = new AbortController(); const response = await fetch(f.gate.origin + '/v1/chat/completions', { method: 'POST', headers, body: body(), signal: cancel.signal });
  await response.body.getReader().read(); cancel.abort(); await closure;
  assert.equal(sends, 1); assert.equal(f.gate.status().forwarded, 1);
});
test('oversized upstream response terminates the stream and retains the consumed input', async t => {
  let sends = 0; const f = await fixture(t, (_q, response) => { sends++; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(Buffer.alloc(9 * 1024 * 1024, 65)); });
  await f.start(); const response = await f.post(); assert.equal(response.status, 200); await assert.rejects(response.arrayBuffer());
  assert.equal(sends, 1); assert.equal(f.gate.status().forwarded, 1);
});
