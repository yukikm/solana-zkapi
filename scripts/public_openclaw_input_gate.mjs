/** Acceptance-only local incoming HTTP gate. Stock clientd owns all public
 * egress, custody, AUTH and recovery. No automatic replay or restart adoption. */
import assert from 'node:assert/strict';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { isAbsolute, resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { parseStrictJson } from '../packages/sdk/dist/trust.js';

const BODY_LIMIT = 2 * 1024 * 1024, RESPONSE_LIMIT = 8 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
async function privateFile(path, maximum) {
  assert(isAbsolute(path) && resolve(path) === path && await realpath(path) === path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    assert(s.isFile() && s.uid === process.getuid() && (s.mode & 0o077) === 0 && s.size > 0 && s.size <= maximum);
    const bytes = await handle.readFile(); assert(bytes.length <= maximum); return bytes;
  } finally { await handle.close(); }
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durable(path, value) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(dirname(path));
}
function error(response, status, message) {
  if (response.headersSent) response.destroy();
  else { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' }); response.end(JSON.stringify({ error: message })); }
}
function singleHeader(request, name) {
  const values = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) values.push(request.rawHeaders[i + 1]);
  return values.length === 1 ? values[0] : undefined;
}

export async function startInputGate(config) {
  assert.deepEqual(Object.keys(config).sort(), ['listenPort', 'model', 'stateDirectory', 'tokenFile', 'upstreamOrigin'].sort());
  assert(Number.isInteger(config.listenPort) && config.listenPort >= 0 && config.listenPort < 65536);
  assert.match(config.model, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
  const upstream = new URL(config.upstreamOrigin);
  assert.equal(upstream.origin, config.upstreamOrigin); assert.equal(upstream.protocol, 'http:');
  assert.equal(upstream.hostname, '127.0.0.1'); assert(upstream.port && !upstream.username && !upstream.password);
  const tokenBytes = await privateFile(config.tokenFile, 65);
  const token = tokenBytes.toString('utf8').replace(/\n$/, ''); assert.match(token, /^[a-f0-9]{64}$/);
  const authorization = Buffer.from('Bearer ' + token);
  const directory = config.stateDirectory;
  assert(isAbsolute(directory) && resolve(directory) === directory && join(await realpath(dirname(directory)), basename(directory)) === directory);
  await mkdir(directory, { mode: 0o700 }); // Existing or partial gate state never reopens.
  await syncDirectory(dirname(directory));
  await durable(join(directory, 'gate.json'), { schema: 1, kind: 'acceptance_only_local_input_gate', maxForwarded: 2,
    upstreamOrigin: config.upstreamOrigin, model: config.model, createdAt: new Date().toISOString(), automaticReplay: false });
  let forwarded = 0, active = false, poisoned = false, lastRejection = null;
  const sockets = new Set(), requests = new Set(), bodyDigests = new Set(), operationIds = new Set();
  const server = createServer(async (request, response) => {
    if (poisoned) { error(response, 503, 'gate_uncertain'); return; }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { error(response, 404, 'route_refused'); return; }
    const supplied = Buffer.from(singleHeader(request, 'authorization') ?? '');
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) { error(response, 401, 'token_refused'); return; }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(singleHeader(request, 'content-type') ?? '') || request.headers['content-encoding'] !== undefined) { error(response, 415, 'body_refused'); return; }
    if (forwarded >= 2) { error(response, 429, 'acceptance_two_call_limit'); return; }
    if (active) { error(response, 409, 'acceptance_request_active'); return; }
    active = true; let upstreamRequest, upstreamResponse, timer, reserved = false, validation = 'json';
    const canceled = new AbortController();
    const abort = () => { canceled.abort(); upstreamRequest?.destroy(); upstreamResponse?.destroy(); };
    request.on('aborted', abort); response.on('close', () => { if (!response.writableEnded) abort(); });
    try {
      request.setTimeout(15_000, () => request.destroy());
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > BODY_LIMIT) { error(response, 413, 'body_too_large'); return; } chunks.push(chunk); }
      request.setTimeout(0); // Native proving/settlement may take longer than body admission.
      const body = Buffer.concat(chunks), parsed = parseStrictJson(body, BODY_LIMIT);
      validation = 'model_stream_output_limit';
      assert(parsed && parsed.model === config.model && parsed.stream === true && Number.isInteger(parsed.max_tokens) && parsed.max_tokens > 0 && parsed.max_tokens <= 128);
      validation = 'messages';
      assert(Array.isArray(parsed.messages) && parsed.messages.length > 0);
      validation = 'read_tool_only';
      assert(Array.isArray(parsed.tools) && parsed.tools.length === 1 && parsed.tools[0]?.type === 'function' && parsed.tools[0]?.function?.name === 'read');
      validation = 'operation_id';
      const callerId = request.headers['idempotency-key'];
      assert(callerId === undefined || (typeof callerId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(callerId)));
      const operationId = callerId ?? randomUUID(), sequence = forwarded + 1, bodySha256 = sha(body);
      if (operationIds.has(operationId) || bodyDigests.has(bodySha256)) { error(response, 409, 'input_replay_refused'); return; }
      validation = 'tool_result_count';
      assert(parsed.messages.filter(message => message?.role === 'tool').length === (forwarded === 0 ? 0 : 1));
      if (request.aborted || response.destroyed) return;
      // Permanent marker is durable before opening any upstream connection.
      // Its presence consumes this input slot even when send/response is unknown.
      try { await durable(join(directory, `forward-${sequence}.json`), { schema: 1, sequence,
        operationId, bodySha256, bytes: body.length, state: 'reserved_before_forward', createdAt: new Date().toISOString() }); }
      catch { poisoned = true; throw Error('durability uncertain'); }
      forwarded = sequence; reserved = true; bodyDigests.add(bodySha256); operationIds.add(operationId);
      if (request.aborted || response.destroyed) return;
      const received = new Promise((accept, reject) => {
        upstreamRequest = httpRequest(new URL('/v1/chat/completions', upstream), {
          method: 'POST', agent: false, headers: { authorization: authorization.toString(), 'content-type': singleHeader(request, 'content-type'),
            accept: 'text/event-stream', 'content-length': body.length, 'idempotency-key': operationId, connection: 'close' }
        }, accept);
        requests.add(upstreamRequest); upstreamRequest.once('close', () => requests.delete(upstreamRequest));
        upstreamRequest.once('error', reject); upstreamRequest.end(body);
      });
      timer = setTimeout(abort, 10 * 60_000); timer.unref();
      upstreamResponse = await received;
      if (upstreamResponse.statusCode >= 300 && upstreamResponse.statusCode < 400) { abort(); error(response, 502, 'upstream_redirect_refused'); return; }
      const headers = { 'content-type': upstreamResponse.headers['content-type'] ?? 'application/octet-stream', 'cache-control': 'no-store', connection: 'close' };
      if (upstreamResponse.headers['content-encoding']) headers['content-encoding'] = upstreamResponse.headers['content-encoding'];
      response.writeHead(upstreamResponse.statusCode ?? 502, headers); response.flushHeaders();
      let responseSize = 0;
      for await (const chunk of upstreamResponse) {
        responseSize += chunk.length; assert(responseSize <= RESPONSE_LIMIT);
        if (response.destroyed) { abort(); return; }
        if (!response.write(chunk)) await once(response, 'drain', { signal: canceled.signal });
      }
      response.end();
    } catch { if (!reserved && !poisoned) lastRejection = validation; abort(); error(response, poisoned ? 503 : reserved ? 502 : 400, poisoned ? 'gate_uncertain' : reserved ? 'upstream_unavailable_no_retry' : 'request_refused'); }
    finally { clearTimeout(timer); active = false; }
  });
  server.headersTimeout = 15_000; server.requestTimeout = 20_000; server.maxHeadersCount = 32;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(config.listenPort, '127.0.0.1', accept); });
  return { origin: `http://127.0.0.1:${server.address().port}`, status: () => ({ forwarded, active, poisoned, maximum: 2, lastRejection }),
    close: async () => { for (const request of requests) request.destroy(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 3);
    const gate = await startInputGate(parseStrictJson(await privateFile(resolve(process.argv[2]), 64 * 1024), 64 * 1024));
    console.log(JSON.stringify({ kind: 'acceptance_only_local_input_gate', origin: gate.origin, maximumForwarded: 2, automaticReplay: false }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { gate.close().then(() => process.exit(0)); });
  } catch { console.error('Acceptance input gate refused startup; inspect retained private state.'); process.exitCode = 1; }
}
