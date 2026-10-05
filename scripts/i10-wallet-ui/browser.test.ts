/** Real Chrome/IndexedDB, synthetic Wallet Standard signer/prover/RPC. No extension/public acceptance. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {buildUi} from './build.ts';
import {startUiHost} from './host.ts';
const chrome = process.env.ZKAPI_TEST_CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
class Cdp {
  pending = new Map<number, {resolve(v: any): void; reject(e: unknown): void}>(); next = 1;
  readonly socket: WebSocket;
  constructor(socket: WebSocket) { this.socket = socket;
    socket.addEventListener('message', e => { const m = JSON.parse(String(e.data)), p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } });
    socket.addEventListener('close', () => { for (const p of this.pending.values()) p.reject(Error('closed')); this.pending.clear(); });
  }
  static async connect(url: string) { const s = new WebSocket(url), c = new Cdp(s); await new Promise<void>((resolve, reject) => { s.addEventListener('open', () => resolve(), {once: true}); s.addEventListener('error', reject, {once: true}); }); return c; }
  call(method: string, params = {}): Promise<any> { const id = this.next++; return new Promise((resolve, reject) => { this.pending.set(id, {resolve, reject}); this.socket.send(JSON.stringify({id, method, params})); }); }
  async evaluate(expression: string) { const r = await this.call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
  async wait(expression: string) { for (let i = 0; i < 300; i++) { if (await this.evaluate(expression)) return; await delay(20); } throw Error('browser condition timed out: ' + expression + '\n' + await this.evaluate('document.body.innerText')); }
}
test('production demo runs from the presentation bundle without API/wallet calls or changing stored live data', {skip: !chrome && 'Chromium required', timeout: 30_000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zkapi-ui-demo-browser-'));
  t.after(() => rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}));
  const output = join(dir, 'site'); await buildUi(output);
  let backendCalls = 0;
  const denied = async () => { backendCalls++; throw Error('presentation requested a backend'); };
  const host = await startUiHost({port: 0, output, rpc: denied, clearance: denied, indexer: denied}); t.after(() => host.close());
  const profile = join(dir, 'chrome'), child = spawn(chrome!, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-apps', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let diagnostic = ''; child.stderr!.on('data', b => { diagnostic = (diagnostic + b).slice(-3000); });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } });
  let port: number | undefined;
  for (let i = 0; i < 150; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { assert.equal(child.exitCode, null, diagnostic); await delay(30); } }
  assert.ok(port, diagnostic);
  const debuggerOrigin = 'http://127.0.0.1:' + port;
  const target = await (await fetch(debuggerOrigin + '/json/new?about:blank', {method: 'PUT'})).json() as any;
  const c = await Cdp.connect(target.webSocketDebuggerUrl); t.after(() => c.socket.close());
  await c.call('Page.enable');
  const requested: string[] = [], forbidden: string[] = [], interceptionErrors: unknown[] = [];
  const staticUrls = new Set(['/demo', '/demo.js', '/demo.css', '/favicon.ico'].map(path => host.origin + path));
  c.socket.addEventListener('message', event => {
    const value = JSON.parse(String(event.data));
    if (value.method !== 'Fetch.requestPaused') return;
    const {requestId, request: {url, method}} = value.params; requested.push(url);
    const permitted = method === 'GET' && staticUrls.has(url);
    if (!permitted) forbidden.push(url);
    void c.call(permitted ? 'Fetch.continueRequest' : 'Fetch.failRequest', permitted ? {requestId} : {requestId, errorReason: 'BlockedByClient'}).catch(error => interceptionErrors.push(error));
  });
  await c.call('Fetch.enable', {patterns: [{urlPattern: '*'}]});
  await c.call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}]});
  await c.call('Page.addScriptToEvaluateOnNewDocument', {source: `
    globalThis.demoEffects = {network: 0, wallet: 0};
    globalThis.fetch = () => { demoEffects.network++; throw Error('demo fetch forbidden'); };
    XMLHttpRequest.prototype.open = () => { demoEffects.network++; throw Error('demo XHR forbidden'); };
    globalThis.WebSocket = class { constructor() { demoEffects.network++; throw Error('demo socket forbidden'); } };
    globalThis.solana = {connect() { demoEffects.wallet++; throw Error('demo wallet forbidden'); }, signTransaction() { demoEffects.wallet++; throw Error('demo sign forbidden'); }};
  `});
  await c.call('Page.navigate', {url: host.origin + '/demo'});
  await c.wait(`document.querySelector('#demo-workspace')?.dataset.phase === 'ready' && document.querySelector('#demo-balance')?.textContent === '0.000000'`);
  assert.deepEqual(await c.evaluate('globalThis.demoEffects'), {network: 0, wallet: 0});
  assert.equal(await c.evaluate(`document.body.dataset.fixture`), undefined);
  assert.equal(await c.evaluate(`document.querySelector('script[type=module]').getAttribute('src')`), '/demo.js');
  assert.equal(await c.evaluate(`document.querySelector('.live-link').href`), host.origin + '/live');
  // This synthetic sentinel stands for same-origin data. The presentation must
  // neither open live journals nor remove them when advancing or resetting.
  await c.evaluate(`(async () => {
    localStorage.setItem('demo-live-sentinel', 'keep');
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open('zkapi-demo-live-sentinel', 1); q.onupgradeneeded = () => q.result.createObjectStore('records'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put('keep', 'unchanged'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
  })()`);
  for (const phase of ['deposited', 'responded', 'settled', 'withdrawn']) {
    await c.evaluate(`document.querySelector('#demo-next').click()`);
    await c.wait(`document.querySelector('#demo-workspace').dataset.phase === '${phase}' && document.querySelector('#demo-workspace').dataset.busy === 'false'`);
  }
  assert.deepEqual(await c.evaluate(`['demo-balance','demo-paid','demo-returned'].map(id => document.getElementById(id).textContent)`), ['0.000000', '0.000018', '0.999982']);
  assert.equal(await c.evaluate(`document.querySelector('#demo-next').disabled`), true);
  assert.match(await c.evaluate(`document.querySelector('#demo-response').textContent`), /USDC/);
  await c.evaluate(`document.querySelector('#demo-reset').click()`);
  await c.wait(`document.querySelector('#demo-workspace').dataset.phase === 'ready'`);
  assert.deepEqual(await c.evaluate('globalThis.demoEffects'), {network: 0, wallet: 0});
  await c.evaluate(`document.querySelector('#demo-workspace').dataset.phase = 'reload-pending'`);
  await c.call('Page.reload');
  await c.wait(`document.querySelector('#demo-workspace')?.dataset.phase === 'ready' && document.querySelector('#demo-balance')?.textContent === '0.000000'`);
  assert.deepEqual(await c.evaluate(`(async () => {
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open('zkapi-demo-live-sentinel'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    const saved = await new Promise((resolve, reject) => { const q = db.transaction('records').objectStore('records').get('unchanged'); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); }); db.close();
    return {saved, local: localStorage.getItem('demo-live-sentinel'), effects: demoEffects};
  })()`), {saved: 'keep', local: 'keep', effects: {network: 0, wallet: 0}});
  assert.ok(requested.includes(host.origin + '/demo.js')); assert.ok(requested.includes(host.origin + '/demo.css'));
  assert.deepEqual(forbidden, []); assert.deepEqual(interceptionErrors, []); assert.equal(backendCalls, 0);
});
test('Chrome fixtures: wallet rejection/reload and provider one-send/reload/verified-settlement UI share existing SDK journals', {skip: !chrome && 'Chromium required', timeout: 60_000}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zkapi-ui-browser-')); t.after(() => rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}));
  const output = join(dir, 'site'); await buildUi(output, true);
  const host = await startUiHost({port: 0, output}); t.after(() => host.close());
  const profile = join(dir, 'chrome'), child = spawn(chrome!, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-apps', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let diagnostic = ''; child.stderr!.on('data', b => { diagnostic = (diagnostic + b).slice(-3000); });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } });
  let port: number | undefined;
  for (let i = 0; i < 150; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { assert.equal(child.exitCode, null, diagnostic); await delay(30); } }
  assert.ok(port, diagnostic);
  const debuggerOrigin = 'http://127.0.0.1:' + port;
  t.diagnostic('Runtime browser: ' + (await (await fetch(debuggerOrigin + '/json/version')).json() as any).Browser);
  const target = await (await fetch(debuggerOrigin + '/json/new?' + encodeURIComponent(host.origin), {method: 'PUT'})).json() as any;
  const c = await Cdp.connect(target.webSocketDebuggerUrl); t.after(() => c.socket.close());
  const connect = async () => {
    await c.wait(`document.querySelector('#wallet')?.options.length === 2`);
    assert.equal(await c.evaluate(`document.body.dataset.fixture`), 'true');
    await c.evaluate(`document.querySelector('#wallet').value='0'; document.querySelector('#wallet').dispatchEvent(new Event('change'));`);
    await c.wait(`!document.querySelector('#connect').disabled`); await c.evaluate(`document.querySelector('#connect').click()`);
    await c.wait(`document.querySelector('#account').options.length === 3`);
    assert.equal(await c.evaluate(`document.querySelector('#account').value`), '');
    assert.equal(await c.evaluate(`document.querySelector('#deposit').disabled`), true);
    await c.evaluate(`document.querySelector('#wallet-version').value='fixture-only-1'; const a=document.querySelector('#account'); a.selectedIndex=2; a.dispatchEvent(new Event('change'));`);
    await c.wait(`!document.querySelector('#select').disabled`); await c.evaluate(`document.querySelector('#select').click()`);
    await c.wait(`document.querySelector('#identity').innerText.includes('Fixture Wallet /')`);
  };
  await connect(); await c.wait(`!document.querySelector('#deposit').disabled`); await c.evaluate(`document.querySelector('#deposit').click()`);
  // Public observations live inside a collapsed <details>; innerText may be
  // empty while the DOM contains a complete snapshot. Read its stored text.
  await c.wait(`JSON.parse(document.querySelector('#state').textContent).operation?.phase === 'ready' && !document.querySelector('#advance').disabled`);
  const state = () => c.evaluate(`JSON.parse(document.querySelector('#state').textContent)`);
  const before = await state(); assert.equal(before.operation.attempts, 0);
  await c.evaluate(`document.querySelector('#advance').click()`);
  await c.wait(`document.querySelector('#status').innerText.startsWith('Operation stopped') && !document.querySelector('#advance').disabled`);
  const rejected = await state(); assert.deepEqual(rejected.operation, before.operation); assert.equal(rejected.journal_revision, before.journal_revision);
  assert.deepEqual(await c.evaluate(`fixtureObservation()`), {requests: 1, sends: 0, persistedBeforeSend: false});
  // The saved encrypted financial operation, not UI state, survives a real page reload.
  await c.call('Page.reload'); await delay(100); await connect(); await c.wait(`!document.querySelector('#advance').disabled`);
  assert.deepEqual((await state()).operation, before.operation);
  assert.deepEqual(await c.evaluate(`fixtureObservation()`), {requests: 0, sends: 0, persistedBeforeSend: false});
  await c.evaluate(`fixtureApprove(); document.querySelector('#advance').click()`);
  await c.wait(`fixtureObservation().sends === 1 && !document.querySelector('#advance').disabled`);
  const approved = await state(); assert.equal(approved.operation.id, before.operation.id); assert.equal(approved.operation.attempts, 1); assert.ok(approved.operation.unresolved_signature);
  assert.deepEqual(await c.evaluate(`fixtureObservation()`), {requests: 1, sends: 1, persistedBeforeSend: true});
  // No automatic replay after another renderer restart; only an explicit action could recover/send.
  await c.call('Page.reload'); await delay(100); await connect(); await c.wait(`!document.querySelector('#advance').disabled`);
  assert.deepEqual((await state()).operation, approved.operation);
  assert.equal((await c.evaluate(`fixtureObservation()`)).sends, 0);
  const raw = await c.evaluate(`(async()=>{ const name=(await indexedDB.databases()).find(x=>x.name.startsWith('zkapi-i10-ui:')).name; const db=await new Promise(r=>{const q=indexedDB.open(name);q.onsuccess=()=>r(q.result)}); const rows=await new Promise(r=>{const q=db.transaction('records').objectStore('records').getAll();q.onsuccess=()=>r(q.result)});db.close();return JSON.stringify(rows)})()`);
  assert.equal(raw.includes('0x' + (12345).toString(16).padStart(64, '0')), false);
  assert.equal(raw.includes(approved.operation.unresolved_signature), false);
  assert.equal(approved.wallet_UI_verified, false); assert.equal(approved.fixture_only, true);
  // Separate fixture run imports a synthetic finalized note through WalletClient;
  // this is UI/control integration, not an on-chain deposit or live provider claim.
  await c.evaluate(`location.hash = 'provider-fixture'`); await c.wait(`location.hash === '#provider-fixture'`);
  await c.call('Page.reload'); await c.wait(`document.querySelector('#pins')?.textContent.includes('Run fixture-provider')`); await connect();
  await c.wait(`!document.querySelector('#provider-prepare').disabled`);
  assert.equal((await state()).wallet_status, 'active');
  await c.evaluate(`document.querySelector('#provider-prepare').click()`);
  await c.wait(`JSON.parse(document.querySelector('#state').textContent).session?.phase === 'prepared' && !document.querySelector('#provider-send').disabled`);
  assert.equal(await c.evaluate(`document.querySelector('#withdraw').disabled`), true);
  await c.evaluate(`fixtureProviderBehavior.loseAuth = true; document.querySelector('#provider-send').click()`);
  await c.wait(`document.querySelector('#status').textContent.includes('Authorization could not be confirmed') && !document.querySelector('#provider-send').disabled`);
  assert.equal((await state()).session.phase, 'send_unknown'); assert.deepEqual((await state()).session.operations, []);
  assert.equal((await c.evaluate(`fixtureProviderObservation()`)).inference, 0);
  await c.evaluate(`fixtureProviderBehavior.loseAuth = false; fixtureProviderBehavior.htmlText = true; document.querySelector('#provider-send').click()`);
  await c.wait(`document.querySelector('#provider-response').textContent.startsWith('<img') && !document.querySelector('#provider-close').disabled`);
  assert.equal(await c.evaluate(`document.querySelector('#provider-response').children.length`), 0);
  assert.equal(await c.evaluate(`globalThis.fixtureXss === undefined`), true);
  assert.equal(await c.evaluate(`document.querySelector('#provider-send').disabled`), true);
  assert.equal((await c.evaluate(`fixtureProviderObservation()`)).inference, 1);
  const savedSession = (await state()).session;
  await c.call('Page.reload'); await delay(100); await connect();
  await c.wait(`!document.querySelector('#provider-close').disabled`);
  assert.deepEqual((await state()).session, savedSession);
  assert.equal((await c.evaluate(`fixtureProviderObservation()`)).inference, 0);
  assert.equal(await c.evaluate(`document.querySelector('#provider-send').disabled`), true);
  assert.match(await c.evaluate(`document.querySelector('#provider-response').textContent`), /not retained/);
  await c.evaluate(`fixtureProviderBehavior.rejectSettlement = true; document.querySelector('#provider-close').click()`);
  await c.wait(`document.querySelector('#status').textContent.includes('The AI request was sent, or its outcome is unknown') && !document.querySelector('#provider-close').disabled`);
  assert.match(await c.evaluate(`document.querySelector('#status').textContent`), /cannot be sent again/);
  assert.equal((await state()).balance_micro_usdc, '1000000'); assert.equal((await state()).verified_settlements.length, 0);
  assert.equal(await c.evaluate(`document.querySelector('#withdraw').disabled`), true);
  await c.evaluate(`fixtureProviderBehavior.rejectSettlement = false; document.querySelector('#provider-close').click()`);
  await c.wait(`JSON.parse(document.querySelector('#state').textContent).verified_settlements.length === 1 && !document.querySelector('#withdraw').disabled`);
  const settled = await state(); assert.equal(settled.balance_micro_usdc, '999999'); assert.equal(settled.session, null);
  assert.equal(settled.verified_settlements[0].charge_micro_usdc, '1'); assert.deepEqual(settled.verified_settlements[0].receipt_ids, ['1']);
  assert.equal(await c.evaluate(`document.querySelector('#provider-prepare').disabled`), true);
  assert.equal((await c.evaluate(`fixtureProviderObservation()`)).inference, 0);
  assert.equal(settled.live_provider_verified, false); assert.equal(settled.wallet_UI_verified, false);
});
