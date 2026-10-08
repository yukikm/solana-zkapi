/** Explicit OpenClaw scheduling adapter for the two-call preview.
 * Stock clientd owns public egress, custody, AUTH and verified settlement.
 * The second input waits for authenticated status before its ONE native POST.
 * This is consumer-adapter behavior, not a change to the released clientd wait. */
import assert from 'node:assert/strict';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, realpath, mkdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { isAbsolute, resolve, dirname, basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { parseStrictJson } from '../packages/sdk/dist/trust.js';

const BODY_LIMIT = 2 * 1024 * 1024, RESPONSE_LIMIT = 8 * 1024 * 1024, ERROR_RESPONSE_LIMIT = 64 * 1024;
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

export function validateNativeStatus(status) {
  assert(status && status.mode === 'direct_openrouter' && status.key_reuse_seconds === 0);
  assert.equal(status.recovery_required, false);
  assert.equal(status.in_flight, 0);
  assert.equal(status.wallet_status, 'active');
  assert.equal(status.wallet_operation, null); assert.equal(status.wallet_emergency_escape, null);
  assert(['ready', 'closing'].includes(status.phase));
  assert.match(status.balance_micro_usdc, /^(0|[1-9][0-9]{0,19})$/);
  assert(Array.isArray(status.unresolved_operations) && status.unresolved_operations.length <= 1);
  const head = status.journal_head;
  assert(head && Number.isSafeInteger(head.revision) && head.revision > 0);
  assert.match(head.digest, /^[a-f0-9]{64}$/);
}
export function assertHeadAdvance(before, after, strict = true) {
  assert(after.revision >= before.revision + (strict ? 1 : 0));
  if (after.revision === before.revision) assert.equal(after.digest, before.digest);
  else assert.notEqual(after.digest, before.digest);
}
export function assertReady(status) {
  validateNativeStatus(status); assert.equal(status.phase, 'ready');
  assert.deepEqual(status.unresolved_operations, []);
}
export function assertPending(status, operationId, initial) {
  validateNativeStatus(status); assert.equal(status.phase, 'closing');
  assert.equal(status.unresolved_operations.length, 1);
  const operation = status.unresolved_operations[0];
  assert(operation && typeof operation === 'object' && !Array.isArray(operation));
  assert.deepEqual(Object.keys(operation).sort(), ['id', 'response_replayable']);
  assert.equal(operation.id, operationId); assert.equal(operation.response_replayable, false);
  assert.equal(status.balance_micro_usdc, initial.balance_micro_usdc);
  assertHeadAdvance(initial.journal_head, status.journal_head);
}
export function assertSettled(initial, pending, status) {
  assertReady(status); assertHeadAdvance(pending.journal_head, status.journal_head);
  const charge = BigInt(initial.balance_micro_usdc) - BigInt(status.balance_micro_usdc);
  assert(charge >= 0n && charge <= 1_000_000n);
}

// Preserve raw SSE bytes. CRLF is one line ending, including at chunk edges.
export function sseFrameEnd(bytes, eof = false) {
  let lineStart = 0;
  for (let i = 0; i < bytes.length;) {
    if (bytes[i] !== 10 && bytes[i] !== 13) { i++; continue; }
    if (bytes[i] === 13 && i + 1 === bytes.length && !eof) return undefined;
    const next = i + (bytes[i] === 13 && bytes[i + 1] === 10 ? 2 : 1);
    if (i === lineStart) return next;
    lineStart = next; i = next;
  }
}
function terminalFrame(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const data = text.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
  return data.trim() === '[DONE]';
}

export async function startSettlementInputGate(config) {
  assert.deepEqual(Object.keys(config).sort(), ['listenPort', 'managementTokenFile', 'model', 'stateDirectory', 'tokenFile', 'upstreamOrigin'].sort());
  assert(Number.isInteger(config.listenPort) && config.listenPort >= 0 && config.listenPort < 65536);
  assert.match(config.model, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/);
  const upstream = new URL(config.upstreamOrigin);
  assert.equal(upstream.origin, config.upstreamOrigin); assert.equal(upstream.protocol, 'http:');
  assert.equal(upstream.hostname, '127.0.0.1'); assert(upstream.port && !upstream.username && !upstream.password);
  const tokenBytes = await privateFile(config.tokenFile, 65);
  const token = tokenBytes.toString('utf8').replace(/\n$/, ''); assert.match(token, /^[a-f0-9]{64}$/);
  const authorization = Buffer.from('Bearer ' + token);
  const managementBytes = await privateFile(config.managementTokenFile, 65);
  const managementToken = managementBytes.toString('utf8').replace(/\n$/, '');
  assert.match(managementToken, /^[a-f0-9]{64}$/); assert.notEqual(managementToken, token);
  const statusAuthorization = 'Bearer ' + managementToken;
  let firstInitial, firstPending, firstOperation, firstComplete = false, lastHead;
  const readStatus = async signal => {
    signal.throwIfAborted();
    const bytes = await new Promise((accept, reject) => {
      const request = httpRequest(new URL('/admin/status', upstream), { method: 'GET', agent: false,
        headers: { authorization: statusAuthorization, accept: 'application/json', connection: 'close' } }, response => {
        if (response.statusCode !== 200) { response.destroy(); reject(Error('native status refused')); return; }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.length;
          if (size > 65_536) { response.destroy(); request.destroy(Error('native status size')); }
          else chunks.push(chunk);
        });
        response.on('end', () => accept(Buffer.concat(chunks)));
        response.on('error', reject);
      });
      const timeout = setTimeout(() => request.destroy(Error('native status deadline')), 3_000);
      const abort = () => request.destroy(Error('native status canceled'));
      request.once('close', () => { clearTimeout(timeout); signal.removeEventListener('abort', abort); });
      request.once('error', reject); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else request.end();
    });
    const status = parseStrictJson(bytes, 65_536);
    validateNativeStatus(status);
    if (lastHead) assertHeadAdvance(lastHead, status.journal_head, false);
    lastHead = structuredClone(status.journal_head);
    return status;
  };
  const directory = config.stateDirectory;
  assert(isAbsolute(directory) && resolve(directory) === directory && join(await realpath(dirname(directory)), basename(directory)) === directory);
  await mkdir(directory, { mode: 0o700 }); // Existing or partial gate state never reopens.
  await syncDirectory(dirname(directory));
  await durable(join(directory, 'gate.json'), { schema: 1, kind: 'openclaw_settlement_scheduling_adapter', maxForwarded: 2,
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
    let adapterWaitStarted = false;
    const canceled = new AbortController();
    const abort = () => { if (reserved || adapterWaitStarted) poisoned = true; canceled.abort(); upstreamRequest?.destroy(); upstreamResponse?.destroy(); };
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
      assert.match(operationId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      if (operationIds.has(operationId) || bodyDigests.has(bodySha256)) { error(response, 409, 'input_replay_refused'); return; }
      validation = 'tool_result_count';
      assert(parsed.messages.filter(message => message?.role === 'tool').length === (forwarded === 0 ? 0 : 1));
      if (request.aborted || response.destroyed) return;
      // A single private scheduler owns this profile during the run. The status
      // endpoint authenticates SDK-verified journal state, not raw server claims.
      validation = 'native_settlement';
      if (forwarded === 0) {
        firstInitial = await readStatus(canceled.signal); assertReady(firstInitial);
        firstOperation = operationId;
      } else {
        assert(firstComplete && firstPending && firstOperation);
        adapterWaitStarted = true;
        // Never replay/adopt this input after cancellation, timeout or a failed
        // status check. It has not reached native AUTH/inference at this point.
        await durable(join(directory, 'held-second.json'), { schema: 1, operationId,
          bodySha256, bytes: body.length, firstOperationId: firstOperation,
          initialHead: firstInitial.journal_head, pendingHead: firstPending.journal_head,
          state: 'held_before_native_forward', createdAt: new Date().toISOString() });
        const signal = AbortSignal.any([canceled.signal, AbortSignal.timeout(600_000)]);
        let status;
        for (;;) {
          signal.throwIfAborted(); status = await readStatus(signal);
          if (status.phase === 'ready') {
            assertSettled(firstInitial, firstPending, status); break;
          }
          assertPending(status, firstOperation, firstInitial);
          await new Promise((resolve, reject) => {
            const id = setTimeout(done, 1_000);
            function done() { signal.removeEventListener('abort', abortWait); resolve(); }
            function abortWait() { clearTimeout(id); signal.removeEventListener('abort', abortWait); reject(signal.reason); }
            signal.addEventListener('abort', abortWait, { once: true });
            if (signal.aborted) abortWait();
          });
        }
        await durable(join(directory, 'first-settled.json'), { schema: 1,
          firstOperationId: firstOperation, initialHead: firstInitial.journal_head,
          pendingHead: firstPending.journal_head, settledHead: status.journal_head,
          balanceBefore: firstInitial.balance_micro_usdc, balanceAfter: status.balance_micro_usdc,
          scope: 'authenticated_native_sdk_status', independent_receipt_verification: false,
          observedAt: new Date().toISOString() });
      }
      canceled.signal.throwIfAborted();
      // Permanent marker is durable before opening any upstream connection.
      // Its presence consumes this input slot even when send/response is unknown.
      try { await durable(join(directory, `forward-${sequence}.json`), { schema: 1, sequence,
        operationId, bodySha256, bytes: body.length, state: 'reserved_before_forward', createdAt: new Date().toISOString() }); }
      catch { poisoned = true; throw Error('durability uncertain'); }
      forwarded = sequence; reserved = true; bodyDigests.add(bodySha256); operationIds.add(operationId);
      if (request.aborted || response.destroyed) { poisoned = true; return; }
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
      if (upstreamResponse.statusCode !== 200) {
        // A failed native POST consumes this slot permanently. Preserve its
        // bounded response verbatim without SSE parsing or later status reads.
        poisoned = true;
        const chunks = []; let bytes = 0;
        for await (const chunk of upstreamResponse) {
          bytes += chunk.length; assert(bytes <= ERROR_RESPONSE_LIMIT);
          canceled.signal.throwIfAborted(); chunks.push(chunk);
        }
        const body = Buffer.concat(chunks), type = headers['content-type'].split(';', 1)[0].trim().toLowerCase();
        await durable(join(directory, `response-${sequence}.json`), { schema: 1,
          status: upstreamResponse.statusCode, contentTypeCategory: ['application/json', 'text/plain', 'text/event-stream'].includes(type) ? type : 'other',
          bodyBytes: body.length, bodySha256: sha(body) });
        canceled.signal.throwIfAborted();
        response.writeHead(upstreamResponse.statusCode, headers); response.end(body); return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers); response.flushHeaders();
      let responseSize = 0, pendingFrame = Buffer.alloc(0), terminal = false;
      const drainFrames = async eof => {
        while (!terminal) {
          const end = sseFrameEnd(pendingFrame, eof); if (end === undefined) break;
          const frame = pendingFrame.subarray(0, end);
          if (terminalFrame(frame)) { terminal = true; break; }
          if (!response.write(frame)) await once(response, 'drain', { signal: canceled.signal });
          pendingFrame = pendingFrame.subarray(end);
        }
      };
      for await (const chunk of upstreamResponse) {
        responseSize += chunk.length; assert(responseSize <= RESPONSE_LIMIT);
        if (response.destroyed) { poisoned = true; abort(); return; }
        if (sequence !== 1) {
          if (!response.write(chunk)) await once(response, 'drain', { signal: canceled.signal });
          continue;
        }
        pendingFrame = Buffer.concat([pendingFrame, chunk]);
        await drainFrames(false);
      }
      if (sequence === 1) {
        await drainFrames(true);
        assert(terminal, 'first SSE must contain its terminal event');
        // Bind this exact operation while still pending. Fast settlement that
        // escaped this observation is deliberately not inferred or adopted.
        assert.equal(upstreamResponse.statusCode, 200);
        firstPending = await readStatus(canceled.signal);
        assertPending(firstPending, firstOperation, firstInitial);
        firstComplete = true;
        // Consumers may return/cancel at [DONE], before HTTP EOF. Release that
        // exact terminal tail only after native EOF and pending identity are
        // established. No await after clearing active: a second handler cannot
        // interleave before this handler's finally block completes.
        active = false; response.end(pendingFrame); return;
      }
      response.end();
    } catch { if (reserved || adapterWaitStarted) poisoned = true; if (!reserved && !poisoned) lastRejection = validation; abort(); error(response, poisoned ? 503 : reserved ? 502 : 400, poisoned ? 'gate_uncertain' : reserved ? 'upstream_unavailable_no_retry' : 'request_refused'); }
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
    const gate = await startSettlementInputGate(parseStrictJson(await privateFile(resolve(process.argv[2]), 64 * 1024), 64 * 1024));
    console.log(JSON.stringify({ kind: 'openclaw_settlement_scheduling_adapter', origin: gate.origin, maximumForwarded: 2, automaticReplay: false }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { gate.close().then(() => process.exit(0)); });
  } catch { console.error('OpenClaw scheduling adapter refused startup; inspect retained private state.'); process.exitCode = 1; }
}
