/** Real Chromium IndexedDB/Web Locks verification; no in-memory database substitute. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

const chrome = process.env.ZKAPI_TEST_CHROME ?? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
].find(existsSync);

function debuggerPort(contents: string): number | undefined {
  // Chrome creates the file before filling it. Require the complete first line.
  const match = /^([1-9][0-9]{0,4})\r?\n/.exec(contents);
  const port = match ? Number(match[1]) : 0;
  return port > 0 && port <= 65535 ? port : undefined;
}
/** A signal-terminated process has exitCode === null even after its exit event. */
function running(child: ChildProcess): boolean { return child.pid !== undefined && child.exitCode === null && child.signalCode === null; }
async function stopChrome(child: ChildProcess): Promise<void> {
  try {
    if (!running(child)) return;
    const exited = once(child, 'exit').then(() => true);
    child.kill('SIGTERM');
    if (await Promise.race([exited, delay(1500, false, { ref: false })])) return;
    child.kill('SIGKILL');
    if (!await Promise.race([exited, delay(1500, false, { ref: false })])) {
      child.unref(); throw new Error('Chromium did not exit after bounded TERM/KILL cleanup');
    }
  } finally {
    // A crashed browser's descendants can retain inherited pipe descriptors.
    child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  }
}

class Cdp {
  socket: WebSocket; next = 1;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = this.pending.get(message.id);
      if (request) { this.pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
    });
    socket.addEventListener('close', () => this.rejectPending());
  }
  private rejectPending(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('browser target closed')); }
    this.pending.clear();
  }
  close(): void { this.rejectPending(); this.socket.close(); }
  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url), cdp = new Cdp(socket);
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
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`browser debugger timed out: ${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    try { this.socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { const request = this.pending.get(id)!; this.pending.delete(id); clearTimeout(request.timer); request.reject(error); }
    return response;
  }
  async evaluate(expression: string): Promise<any> {
    const response = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
}

test('browser readiness ignores empty or partially written DevTools port files', () => {
  for (const value of ['', '12345', '0\n', '65536\n', 'not-a-port\n']) assert.equal(debuggerPort(value), undefined);
  assert.equal(debuggerPort('12345\n/devtools/browser/fixture'), 12345);
  assert.equal(debuggerPort('12345\r\n/devtools/browser/fixture'), 12345);
});
test('browser cleanup does not await an already observed signal exit', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child, 'exit');
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, 'SIGTERM');
  await stopChrome(child);
  assert.equal(child.stdout!.destroyed, true); assert.equal(child.stderr!.destroyed, true);
});
test('browser cleanup escalates when a process ignores TERM', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => { if (running(child)) child.kill('SIGKILL'); });
  await once(child.stdout!, 'data'); await stopChrome(child);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('real browser journal: atomic cross-tab CAS, encrypted restart, Web Locks and tab crash recovery', { skip: !chrome && 'Set ZKAPI_TEST_CHROME to a Chromium executable', timeout: 25_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-browser-journal-'));
  const source = await readFile(new URL('../src/journal.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 } }).outputText;
  const custodySource = (await readFile(new URL('../src/browser-storage.ts', import.meta.url), 'utf8')).replace("'./journal.ts'", "'./journal.js'");
  const custodyJs = ts.transpileModule(custodySource, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022 } }).outputText;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url?.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.end(request.url === '/journal.js' ? javascript : request.url === '/custody.js' ? custodyJs : '<!doctype html><title>zkAPI journal verification</title>');
  });
  let child: ChildProcess | undefined;
  const debuggers: Cdp[] = [];
  // One ordered hook closes debugger sockets/browser before the HTTP listener.
  // A startup failure is cleaned up too, including a previously observed signal exit.
  t.after(async () => {
    for (const cdp of debuggers) cdp.close();
    try { if (child) await stopChrome(child); }
    finally {
      if (server.listening) {
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        server.closeAllConnections(); await closed;
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  child = spawn(chrome!, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-apps', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr!.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000); });
  child.on('error', error => { diagnostics = error.message; });
  let port: number | undefined;
  for (let i = 0; i < 150; i++) {
    try { port = debuggerPort(await readFile(join(directory, 'DevToolsActivePort'), 'utf8')); if (port) break; }
    catch { /* Not yet created; a partial/empty file is also not ready. */ }
    if (!running(child)) throw new Error(`Chromium exited: ${diagnostics}`);
    await delay(30);
  }
  assert.ok(port, `Chromium did not start: ${diagnostics}`);
  const debuggerOrigin = `http://127.0.0.1:${port}`;
  const browserFetch = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  t.diagnostic(`Runtime browser: ${(await (await browserFetch(`${debuggerOrigin}/json/version`)).json() as { Browser: string }).Browser}`);
  const createTab = async () => {
    const target = await (await browserFetch(`${debuggerOrigin}/json/new?${encodeURIComponent(origin)}`, { method: 'PUT' })).json() as { id: string; webSocketDebuggerUrl: string };
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl); debuggers.push(cdp);
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
  await browserFetch(`${debuggerOrigin}/json/close/${first.id}`);
  assert.equal(await second.cdp.evaluate('globalThis.locked'), 'recovered');
  const restarted = await createTab();
  const state = await restarted.cdp.evaluate(`journal.read('note')`);
  assert.equal(state.revision, 2); assert.deepEqual(state.value, { token: 'SECRET_TOKEN_TWO', bytes: '7b20227d' });
  const custodyResult = await restarted.cdp.evaluate(`(async () => {
    const {openBrowserStorage} = await import('/custody.js');
    let missing=false;try{await openBrowserStorage('app-custody');}catch(e){missing=e.name==='BrowserStorageMissing';}
    const [a,b]=await Promise.all([openBrowserStorage('app-custody',{initialize:true}),openBrowserStorage('app-custody',{initialize:true})]);
    const persistence=a.persistence;
    const ja=new mod.EncryptedJournal(a.store,a.key,{deploymentId:'app',pool:'pool'},validate);
    await ja.create('note',{token:'PRIVATE_APP_TOKEN',bytes:'a'});
    const jb=new mod.EncryptedJournal(b.store,b.key,{deploymentId:'app',pool:'pool'},validate);
    const same=(await jb.read('note')).value.token==='PRIVATE_APP_TOKEN';const extractable=a.key.extractable;a.close();b.close();
    const reopened=await openBrowserStorage('app-custody');
    const jr=new mod.EncryptedJournal(reopened.store,reopened.key,{deploymentId:'app',pool:'pool'},validate);
    const restored=(await jr.read('note')).value.token==='PRIVATE_APP_TOKEN';reopened.close();
    const db=await new Promise(r=>{const q=indexedDB.open('zkapi-browser-custody-v1',1);q.onsuccess=()=>r(q.result);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('keys','readwrite');tx.objectStore('keys').delete('app-custody');tx.oncomplete=resolve;tx.onerror=reject;});db.close();
    let refused=false;try{await openBrowserStorage('app-custody',{initialize:true});}catch(e){refused=e.message.includes('without its key');}
    return {missing,same,extractable,restored,refused,persistence};
  })()`);
  const { persistence, ...custodyChecks } = custodyResult;
  assert.deepEqual(custodyChecks,{missing:true,same:true,extractable:false,restored:true,refused:true});
  assert.ok(['persistent','best_effort','unknown'].includes(persistence));
  t.diagnostic(`Actual isolated browser storage retention: ${persistence}`);
  const persistenceChecks = await restarted.cdp.evaluate(`(async () => {
    const {openBrowserStorage} = await import('/custody.js');
    const storage=navigator.storage, originalPersist=Object.getOwnPropertyDescriptor(storage,'persist'), originalPersisted=Object.getOwnPropertyDescriptor(storage,'persisted');
    let requests=0, granted=false;
    const set=(name,value)=>Object.defineProperty(storage,name,{configurable:true,value});
    try {
      set('persisted',async()=>granted);set('persist',async()=>{requests++;return granted;});
      let missing=false;try{await openBrowserStorage('persistence-denied');}catch(e){missing=e.name==='BrowserStorageMissing';}
      const beforeInitialization=requests;
      const [a,b]=await Promise.all([openBrowserStorage('persistence-denied',{initialize:true}),openBrowserStorage('persistence-denied',{initialize:true})]);
      const denied=[a.persistence,b.persistence];a.close();b.close();const afterInitialization=requests;
      const reopened=await openBrowserStorage('persistence-denied');const reopenStatus=reopened.persistence;reopened.close();
      const explicitExisting=await openBrowserStorage('persistence-denied',{initialize:true});explicitExisting.close();
      const afterReopens=requests;
      set('persist',async()=>{requests++;granted=true;return true;});
      const allowed=await openBrowserStorage('persistence-granted',{initialize:true});const allowedStatus=allowed.persistence;allowed.close();
      const afterGrant=requests;
      const existing=await openBrowserStorage('persistence-granted');const existingStatus=existing.persistence;existing.close();
      const alreadyPersistent=await openBrowserStorage('persistence-already-granted',{initialize:true});alreadyPersistent.close();
      const afterPersistent=requests;
      set('persisted',async()=>{throw Error('browser policy');});set('persist',async()=>{requests++;throw Error('browser policy');});
      const failed=await openBrowserStorage('persistence-query-failed',{initialize:true});const failedStatus=failed.persistence;failed.close();
      set('persisted',undefined);set('persist',undefined);
      const unavailable=await openBrowserStorage('persistence-unavailable',{initialize:true});const unavailableStatus=unavailable.persistence;unavailable.close();
      return {missing,beforeInitialization,denied,afterInitialization,reopenStatus,afterReopens,allowedStatus,afterGrant,existingStatus,afterPersistent,failedStatus,unavailableStatus};
    } finally {
      if(originalPersist)Object.defineProperty(storage,'persist',originalPersist);else delete storage.persist;
      if(originalPersisted)Object.defineProperty(storage,'persisted',originalPersisted);else delete storage.persisted;
    }
  })()`);
  assert.deepEqual(persistenceChecks,{
    missing:true,beforeInitialization:0,denied:['best_effort','best_effort'],afterInitialization:1,
    reopenStatus:'best_effort',afterReopens:1,allowedStatus:'persistent',afterGrant:2,
    existingStatus:'persistent',afterPersistent:2,failedStatus:'unknown',unavailableStatus:'unknown',
  });
});
