/** Real Chromium IndexedDB/Web Locks verification; no in-memory database substitute. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

const chrome = process.env.ZKAPI_TEST_CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync);

class Cdp {
  socket: WebSocket; next = 1;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = this.pending.get(message.id);
      if (request) { this.pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
    });
    socket.addEventListener('close', () => { for (const request of this.pending.values()) request.reject(new Error('browser target closed')); this.pending.clear(); });
  }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url), cdp = new Cdp(socket);
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return cdp;
  }
  async call(method: string, params: object = {}): Promise<any> {
    const id = this.next++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params })); return response;
  }
  async evaluate(expression: string): Promise<any> {
    const response = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
}

test('real browser journal: atomic cross-tab CAS, encrypted restart, Web Locks and tab crash recovery', { skip: !chrome && 'Set ZKAPI_TEST_CHROME to a Chromium executable', timeout: 25_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-browser-journal-'));
  const source = await readFile(new URL('../src/journal.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 } }).outputText;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/journal.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/journal.js' ? javascript : '<!doctype html><title>zkAPI journal verification</title>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  const child = spawn(chrome!, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-apps', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr!.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  let port: number | undefined;
  for (let i = 0; i < 150; i++) {
    try { port = Number((await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
    catch { if (child.exitCode !== null) throw new Error(`Chromium exited: ${diagnostics}`); await delay(30); }
  }
  assert.ok(port, `Chromium did not start: ${diagnostics}`);
  const debuggerOrigin = `http://127.0.0.1:${port}`;
  t.diagnostic(`Runtime browser: ${(await (await fetch(`${debuggerOrigin}/json/version`)).json() as { Browser: string }).Browser}`);
  const createTab = async () => {
    const target = await (await fetch(`${debuggerOrigin}/json/new?${encodeURIComponent(origin)}`, { method: 'PUT' })).json() as { id: string; webSocketDebuggerUrl: string };
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl); t.after(() => cdp.socket.close());
    await cdp.evaluate(`(async () => {
      globalThis.mod = await import(${JSON.stringify(`${origin}/journal.js`)});
      globalThis.store = await mod.IndexedDbJournalStore.open('zkapi-test-journal');
      globalThis.key = await mod.importJournalKey(new Uint8Array(32).fill(7));
      globalThis.validate = value => { if (!value || typeof value.token !== 'string' || typeof value.bytes !== 'string') throw Error('invalid state'); };
      globalThis.journal = new mod.EncryptedJournal(store, key, { deploymentId: 'local', pool: 'pool' }, validate);
      return true;
    })()`);
    return { ...target, cdp };
  };
  const first = await createTab(), second = await createTab();
  const create = `(async () => { try { return await journal.create('note', { token: 'SECRET_TOKEN', bytes: '7b20227d' }); } catch (e) { return { error: e.name }; } })()`;
  const creates = await Promise.all([first.cdp.evaluate(create), second.cdp.evaluate(create)]);
  assert.equal(creates.filter(r => r.revision === 1).length, 1);
  assert.equal(creates.filter(r => r.error === 'JournalConflictError').length, 1);
  const cas = `(async () => { try { return await journal.compareAndSwap('note', 1, { token: 'SECRET_TOKEN_TWO', bytes: '7b20227d' }); } catch (e) { return { error: e.name }; } })()`;
  const updates = await Promise.all([first.cdp.evaluate(cas), second.cdp.evaluate(cas)]);
  assert.equal(updates.filter(r => r.revision === 2).length, 1);
  assert.equal(updates.filter(r => r.error === 'JournalConflictError').length, 1);
  const raw = await first.cdp.evaluate(`(async () => { const db = await new Promise(r => { const request = indexedDB.open('zkapi-test-journal', 1); request.onsuccess = () => r(request.result); }); const records = await new Promise(r => { const request = db.transaction('records').objectStore('records').getAll(); request.onsuccess = () => r(request.result); }); db.close(); return JSON.stringify(records); })()`);
  assert.equal(raw.includes('SECRET_TOKEN'), false);
  assert.equal(raw.includes('7b20227d'), false);
  await first.cdp.evaluate(`globalThis.locked = journal.withNoteLock('note', async () => { globalThis.entered = true; await new Promise(r => globalThis.release = r); }); 'started'`);
  for (let i = 0; i < 100 && !await first.cdp.evaluate('globalThis.entered === true'); i++) await delay(5);
  assert.equal(await first.cdp.evaluate('globalThis.entered'), true);
  await second.cdp.evaluate(`globalThis.entered = false; globalThis.locked = journal.withNoteLock('note', async () => { globalThis.entered = true; return 'recovered'; }); 'queued'`);
  assert.equal(await second.cdp.evaluate('globalThis.entered'), false);
  // Closing the owning renderer releases the browser-owned lock without a timeout lease.
  await fetch(`${debuggerOrigin}/json/close/${first.id}`);
  assert.equal(await second.cdp.evaluate('globalThis.locked'), 'recovered');
  const restarted = await createTab();
  const state = await restarted.cdp.evaluate(`journal.read('note')`);
  assert.equal(state.revision, 2); assert.deepEqual(state.value, { token: 'SECRET_TOKEN_TWO', bytes: '7b20227d' });
});
