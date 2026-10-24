/** Isolated Chromium harness for recovery tests. It never opens a user browser profile. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import ts from 'typescript';

export const recoveryChrome = process.env.ZKAPI_TEST_CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync);

function running(child: ChildProcess): boolean { return child.pid !== undefined && child.exitCode === null && child.signalCode === null; }
async function stopChrome(child: ChildProcess): Promise<void> {
  try {
    if (!running(child)) return;
    const exited = once(child, 'exit').then(() => true);
    child.kill('SIGTERM');
    if (await Promise.race([exited, delay(1500, false, { ref: false })])) return;
    child.kill('SIGKILL');
    if (!await Promise.race([exited, delay(1500, false, { ref: false })])) {
      child.unref(); throw new Error('Chromium did not exit after bounded cleanup');
    }
  } finally { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); }
}

export class RecoveryCdp {
  private next = 1;
  private readonly socket: WebSocket;
  private pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)), request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    });
    socket.addEventListener('close', () => this.rejectPending());
  }
  private rejectPending(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('browser target closed')); }
    this.pending.clear();
  }
  close(): void { this.rejectPending(); this.socket.close(); }
  static async connect(url: string): Promise<RecoveryCdp> {
    const socket = new WebSocket(url), cdp = new RecoveryCdp(socket);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('browser debugger connection timed out')), 5000);
        socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', reject, { once: true });
      });
    } catch (error) { socket.close(); throw error; }
    finally { clearTimeout(timer); }
    return cdp;
  }
  async call(method: string, params: object = {}): Promise<any> {
    const id = this.next++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`browser debugger timed out: ${method}`)); }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    try { this.socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { const request = this.pending.get(id)!; this.pending.delete(id); clearTimeout(request.timer); request.reject(error); }
    return result;
  }
  async evaluate(expression: string): Promise<any> {
    const response = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
}

export async function recoveryBrowser(t: TestContext, proxyOrigin: string) {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-recovery-browser-'));
  const modules = new Map<string, string>(), debuggers: RecoveryCdp[] = [];
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url!, 'http://localhost').pathname;
      if (path.startsWith('/recovery/v1/')) {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const name of ['authorization', 'content-type']) if (request.headers[name]) headers.set(name, String(request.headers[name]));
        const upstream = await fetch(proxyOrigin + path, { method: request.method, headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: AbortSignal.timeout(15_000) });
        response.statusCode = upstream.status; response.setHeader('Content-Type', 'application/json');
        response.end(Buffer.from(await upstream.arrayBuffer())); return;
      }
      if (/^\/modules\/[a-z0-9-]+\.js$/.test(path)) {
        if (!modules.has(path)) {
          const filename = path.slice('/modules/'.length).replace(/\.js$/, '.ts');
          const source = (await readFile(new URL('../src/' + filename, import.meta.url), 'utf8'))
            .replace(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2');
          modules.set(path, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 } }).outputText);
        }
        response.setHeader('Content-Type', 'text/javascript'); response.end(modules.get(path)); return;
      }
      response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Recovery test fixture</title>');
    } catch { response.statusCode = 500; response.end('fixture request failed'); }
  });
  let child: ChildProcess | undefined;
  t.after(async () => {
    for (const cdp of debuggers) cdp.close();
    try { if (child) await stopChrome(child); }
    finally {
      if (server.listening) { const closed = new Promise<void>(resolve => server.close(() => resolve())); server.closeAllConnections(); await closed; }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  child = spawn(recoveryChrome!, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-apps', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr!.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
  child.on('error', error => { diagnostics = error.message; });
  let port: number | undefined;
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) {
    try {
      const match = /^([1-9][0-9]{0,4})\r?\n/.exec(await readFile(join(directory, 'DevToolsActivePort'), 'utf8'));
      if (match && Number(match[1]) <= 65535) { port = Number(match[1]); break; }
    } catch { /* Isolated browser not ready. */ }
    if (!running(child)) throw new Error(`Chromium exited: ${diagnostics}`);
    await delay(30);
  }
  assert.ok(port, `Chromium did not start: ${diagnostics}`);
  const debuggerOrigin = `http://127.0.0.1:${port}`;
  const browserFetch = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  t.diagnostic(`Runtime browser: ${(await (await browserFetch(debuggerOrigin + '/json/version')).json() as { Browser: string }).Browser}`);
  const createTab = async () => {
    const target = await (await browserFetch(debuggerOrigin + '/json/new?about:blank', { method: 'PUT' })).json() as { id: string; webSocketDebuggerUrl: string };
    const cdp = await RecoveryCdp.connect(target.webSocketDebuggerUrl); debuggers.push(cdp);
    await cdp.call('Page.enable'); await cdp.call('Page.navigate', { url: origin });
    const readyUntil = Date.now() + 5000;
    for (;;) {
      try { if (await cdp.evaluate(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`)) break; }
      catch (error) { if (!(error instanceof Error) || error.message !== 'Execution context was destroyed.') throw error; }
      if (Date.now() >= readyUntil) throw new Error('browser document did not become ready');
      await delay(10);
    }
    await cdp.evaluate(`globalThis.fixtureFetch = (input, init) => fetch(new URL(new URL(typeof input === 'string' ? input : input.url).pathname, location.origin), init); true`);
    return { id: target.id, cdp, close: () => browserFetch(debuggerOrigin + '/json/close/' + target.id) };
  };
  return { origin, createTab };
}
