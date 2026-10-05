/** Local acceptance transport only. Fixed destinations, pinned loopback TLS,
 * no proxy environment, redirects, automatic retries, logging or signing. */
import {createServer, request as httpsRequest, type Server} from 'node:https';
import {request as httpRequest, type IncomingMessage} from 'node:http';
import {once} from 'node:events';

type Kind = 'indexer' | 'control' | 'inference';
const REQUEST_LIMIT = 2_000_000, INFERENCE_LIMIT = 8_388_608;
const requestHeaders = ['content-type', 'authorization', 'idempotency-key', 'anthropic-version', 'x-api-key'];
const responseHeaders = ['content-type', 'x-zkapi-error-code', 'x-zkapi-operation-id', 'x-zkapi-status-url', 'retry-after'];
const fail = (): never => { throw Error('pinned service transport'); };
function origin(input: string, protocol: 'http:' | 'https:', loopback = true): URL {
  let url: URL; try { url = new URL(input); } catch { return fail(); }
  if (url.protocol !== protocol || url.origin !== input || url.username || url.password || url.search || url.hash || loopback && url.hostname !== '127.0.0.1') fail();
  return url;
}
function pathAllowed(kind: Kind, path: string, method: string): boolean {
  // SDK receipt pagination is the only accepted query. The cursor is a positive
  // signed-BIGINT receipt ID; no arbitrary query or forwarding target is accepted.
  const cursor = kind === 'control' && method === 'GET'
    ? path.match(/^\/zkapi\/v1\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/receipts\?cursor=([1-9][0-9]{0,18})$/)?.[1] : undefined;
  if (cursor !== undefined) return BigInt(cursor) <= 9_223_372_036_854_775_807n;
  if (path.includes('?') || path.includes('#') || path.includes('%') || path.includes('\\')) return false;
  if (kind === 'inference') return method === 'POST' && ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens'].includes(path);
  if (kind === 'indexer') return method === 'GET' && /^\/zkapi\/v1\/tree\/(root|notes\/\d+\/(path|zero-path))$/.test(path);
  return ['GET', 'POST'].includes(method) && path.startsWith('/zkapi/v1/') && !path.split('/').includes('..');
}
function requestBody(value: BodyInit | null | undefined): Buffer | undefined {
  if (value === undefined || value === null) return undefined;
  let result: Buffer;
  if (typeof value === 'string') result = Buffer.from(value);
  else if (value instanceof ArrayBuffer) result = Buffer.from(value);
  else if (ArrayBuffer.isView(value)) result = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else return fail();
  if (result.length > REQUEST_LIMIT) fail();
  return result;
}
function selectedHeaders(input: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const name of responseHeaders) if (typeof input[name] === 'string') headers.set(name, input[name]);
  return headers;
}
/** One native HTTP request: agents/proxies/redirects/retries are never selected. */
function requestOnce(url: URL, options: {method: string; headers: Record<string,string>; body?: Buffer; signal?: AbortSignal; ca?: Buffer; maximum: number}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {method: options.method, headers: options.headers,
      agent: false, ...(options.ca ? {ca: options.ca} : {}), signal: options.signal}, response => {
      const status = response.statusCode ?? 503;
      if (status < 200 || status > 599) { response.destroy(); request.destroy(); reject(Error('pinned service response')); return; }
      if (status >= 300 && status < 400) { response.destroy(); request.destroy(); reject(Error('pinned service redirect refused')); return; }
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, {status, headers: selectedHeaders(response.headers)})); return; }
      let size = 0, ended = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const error = (message: string) => { if (!ended) { ended = true; controller.error(Error(message)); } };
          response.on('data', chunk => {
            if (ended) return; size += chunk.length;
            if (size > options.maximum) { error('pinned service body bound'); response.destroy(); request.destroy(); return; }
            controller.enqueue(new Uint8Array(chunk)); if ((controller.desiredSize ?? 0) <= 0) response.pause();
          });
          response.on('end', () => { if (!ended) { ended = true; controller.close(); } });
          response.on('aborted', () => error('pinned service transport'));
          response.on('error', () => error('pinned service transport'));
        },
        pull() { response.resume(); },
        cancel() { ended = true; response.destroy(); request.destroy(); },
      });
      resolve(new Response(stream, {status, headers: selectedHeaders(response.headers)}));
    });
    request.on('error', () => reject(Error('pinned service transport')));
    request.end(options.body);
  });
}
export interface DevnetFrontendOptions {
  port: number; upstreamOrigin: string; kind: Kind; certificate: Buffer; key: Buffer;
  /** Authenticated manifest origin. Never derived from a caller Host header. */
  inferenceApiOrigin?: string;
}
export async function startDevnetFrontend(options: DevnetFrontendOptions): Promise<Server> {
  origin(options.upstreamOrigin, 'http:');
  const inferenceAuthority = options.kind === 'inference' ? origin(options.inferenceApiOrigin ?? '', 'https:').host : undefined;
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) fail();
  const server = createServer({key: options.key, cert: options.certificate});
  server.on('request', async (request, response) => {
    let upstream: Response | undefined;
    const abort = new AbortController(); response.once('close', () => abort.abort());
    try {
      const path = request.url ?? '', method = request.method ?? '';
      if (!pathAllowed(options.kind, path, method)) fail();
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > REQUEST_LIMIT) fail(); chunks.push(Buffer.from(chunk)); }
      const headers: Record<string,string> = {};
      for (const name of requestHeaders) if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
      if (inferenceAuthority) headers.host = inferenceAuthority;
      upstream = await requestOnce(new URL(options.upstreamOrigin + path), {method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(options.kind === 'inference' ? 600_000 : 60_000)]), maximum: INFERENCE_LIMIT});
      const returned: Record<string,string> = {}; upstream.headers.forEach((value, key) => { returned[key] = value; });
      response.writeHead(upstream.status, returned); response.flushHeaders();
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try { for (;;) { const next = await reader.read(); if (next.done) break; if (!response.write(next.value)) await once(response, 'drain', {signal: abort.signal}); } }
        finally { reader.releaseLock(); }
      }
      response.end();
    } catch {
      await upstream?.body?.cancel().catch(() => {});
      if (response.headersSent) response.destroy(); else { response.writeHead(503, {'content-type': 'application/json'}); response.end('{}'); }
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  return server;
}
export interface DevnetPinnedFetchOptions {
  ca: Buffer; indexerOrigin: string; controlOrigin?: string; inferenceOrigin?: string;
  directChatEndpoints?: readonly string[];
  oaVerifierEndpoints?: readonly string[];
  onClearanceStatus?(status: number): void;
}
export function createDevnetPinnedFetch(options: DevnetPinnedFetchOptions): typeof fetch {
  const services = new Map<string, Kind>([[origin(options.indexerOrigin, 'https:').origin, 'indexer']]);
  if (options.controlOrigin) services.set(origin(options.controlOrigin, 'https:').origin, 'control');
  if (options.inferenceOrigin) services.set(origin(options.inferenceOrigin, 'https:').origin, 'inference');
  const direct = new Set<string>();
  for (const endpoint of options.directChatEndpoints ?? []) {
    let url: URL; try { url = new URL(endpoint); } catch { return fail(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/chat/completions')) fail();
    direct.add(url.href);
  }
  const oaVerifiers = new Set<string>();
  for (const endpoint of options.oaVerifierEndpoints ?? []) {
    let url: URL; try { url = new URL(endpoint); } catch { return fail(); }
    if (url.protocol !== 'https:' || url.username || url.password || endpoint.includes('?') || endpoint.includes('#')
      || url.href !== endpoint || !url.pathname.endsWith('/submit_key')) fail();
    oaVerifiers.add(url.href);
  }
  return async (input, init) => {
    let target: URL; try { target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); } catch { return fail(); }
    if (target.username || target.password || target.hash) fail();
    const source = input instanceof Request ? input : undefined, method = init?.method ?? source?.method ?? 'GET';
    const isDirect = direct.has(target.href), isOaVerifier = oaVerifiers.has(target.href), kind = services.get(target.origin);
    const external = isDirect || isOaVerifier;
    if (external ? method !== 'POST' : !kind || !pathAllowed(kind, target.pathname + target.search, method)) fail();
    const headers: Record<string,string> = {};
    new Headers(init?.headers ?? source?.headers).forEach((value, name) => { if (isOaVerifier ? name === 'content-type' : requestHeaders.includes(name)) headers[name] = value; });
    const body = requestBody(init?.body ?? (source && !['GET','HEAD'].includes(method) ? await source.arrayBuffer() : undefined));
    const result = await requestOnce(target, {method, headers, body, signal: init?.signal ?? source?.signal,
      ...(!external ? {ca: options.ca} : {}), maximum: !isOaVerifier && (isDirect || kind === 'inference') ? INFERENCE_LIMIT : 65536});
    if (kind === 'control' && target.pathname === '/zkapi/v1/withdraw/clearance') options.onClearanceStatus?.(result.status);
    return result;
  };
}
