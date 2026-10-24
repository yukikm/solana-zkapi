import { createServer } from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { RecoveryStore, RecoveryServiceError, MAX_BODY_BYTES } from './store.mjs';

function validOrigin(value, localTestOnly) {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password
      && (url.protocol === 'https:' || localTestOnly && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}
async function body(request) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new RecoveryServiceError(415, 'json_required');
  if (request.headers['content-encoding']) throw new RecoveryServiceError(415, 'encoding_unsupported');
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new RecoveryServiceError(413, 'request_too_large');
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new RecoveryServiceError(413, 'request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RecoveryServiceError(400, 'invalid_request'); }
}

/** Loopback service behind the operator's TLS proxy. No request or token logging. */
export async function startRecoveryServer(options) {
  const { directory, port = 4176, host = '127.0.0.1', allowedOrigins, localTestOnly = false, maxVaults, maxTotalBytes } = options;
  if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port < (localTestOnly ? 0 : 1) || port > 65535
    || !Array.isArray(allowedOrigins) || !allowedOrigins.length || allowedOrigins.length > 32
    || allowedOrigins.some(origin => !validOrigin(origin, localTestOnly))) throw new Error('invalid recovery service configuration');
  const store = new RecoveryStore(directory, { maxVaults, maxTotalBytes });
  const origins = new Set(allowedOrigins);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 5000 }, async (request, response) => {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store, max-age=0', pragma: 'no-cache', 'x-content-type-options': 'nosniff', vary: 'Origin' };
    function send(status, value) {
      if (!response.writableEnded) { response.writeHead(status, headers); response.end(value === undefined ? '' : JSON.stringify(value)); }
    }
    try {
      const origin = request.headers.origin;
      if (origin !== undefined && !origins.has(origin)) throw new RecoveryServiceError(403, 'origin_forbidden');
      if (origin) headers['access-control-allow-origin'] = origin;
      const route = /^\/recovery\/v1\/vaults\/([0-9a-f]{64})(?:\/(takeover)|\/(records|locks)\/([0-9a-f]{64}))?$/.exec(request.url ?? '');
      if (request.method === 'GET' && request.url === '/recovery/v1/health') return send(200, { ready: true });
      if (!route) throw new RecoveryServiceError(404, 'not_found');
      if (request.method === 'OPTIONS') {
        if (!origin || !['GET', 'POST', 'PUT', 'DELETE'].includes(request.headers['access-control-request-method'])
          || (request.headers['access-control-request-headers'] ?? '').split(',').filter(Boolean).some(item => !['authorization', 'content-type'].includes(item.trim().toLowerCase()))) throw new RecoveryServiceError(403, 'preflight_forbidden');
        headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        headers['access-control-allow-headers'] = 'Authorization, Content-Type';
        return send(204);
      }
      const match = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.authorization ?? '');
      if (!match) throw new RecoveryServiceError(401, 'unauthorized');
      const [, id, takeover, kind, key] = route, token = match[1];
      if (request.method === 'POST' && !takeover && !kind) {
        const result = store.create(id, token, await body(request));
        return send(result.created ? 201 : 200, { context: result.context, epoch: result.epoch });
      }
      if (request.method === 'POST' && takeover) return send(200, store.takeover(id, token, await body(request)));
      if (request.method === 'GET' && !takeover && !kind) return send(200, store.status(id, token));
      if (request.method === 'GET' && kind === 'records') return send(200, store.read(id, token, key));
      if (request.method === 'PUT' && kind === 'records') return send(200, store.compareAndSwap(id, token, key, await body(request)));
      if (request.method === 'POST' && kind === 'locks') return send(200, store.acquire(id, token, key, await body(request)));
      if (request.method === 'DELETE' && kind === 'locks') return send(200, store.release(id, token, key, await body(request)));
      throw new RecoveryServiceError(405, 'method_not_allowed');
    } catch (error) {
      const known = error instanceof RecoveryServiceError;
      send(known ? error.status : 503, { error: known ? error.code : 'service_unavailable' });
    }
  });
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
  catch (error) { store.close(); throw error; }
  return { server, address: { host, port: server.address().port }, close: async () => {
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    store.close();
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('config_required');
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    const allowed = ['directory', 'port', 'host', 'allowedOrigins', 'localTestOnly', 'maxVaults', 'maxTotalBytes'];
    if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !allowed.includes(key)) || config.localTestOnly === true) throw new Error('invalid_config');
    const service = await startRecoveryServer(config);
    process.stdout.write('recovery service ready\n');
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!stopping) { stopping = true; service.close().then(() => process.exit(0), () => process.exit(1)); } });
  } catch { process.stderr.write('recovery service failed to start\n'); process.exitCode = 1; }
}
