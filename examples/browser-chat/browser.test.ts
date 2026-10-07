/** Actual Chrome UI exercise; SDK/provider/wallet ports are explicit local fixtures.
 * This does not establish cryptographic, provider, Phantom or public-chain acceptance. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from '../../scripts/i10-wallet-ui/node_modules/esbuild/lib/main.js';

const chrome = process.env.ZKAPI_TEST_CHROME ?? ['/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
class Cdp {
  socket: WebSocket; next = 1;
  pending = new Map<number, { resolve(value: any): void; reject(error: unknown): void }>();
  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)), request = this.pending.get(message.id);
      if (request) { this.pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
    });
    socket.addEventListener('close', () => { for (const request of this.pending.values()) request.reject(new Error('Chrome target closed')); this.pending.clear(); });
  }
  static async connect(url: string) {
    const socket = new WebSocket(url), cdp = new Cdp(socket);
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return cdp;
  }
  call(method: string, params: object = {}): Promise<any> {
    const id = this.next++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression: string) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  async wait(expression: string) {
    for (let i = 0; i < 250; i++) { if (await this.evaluate(expression)) return; await delay(20); }
    throw new Error(`Browser condition timed out: ${expression}\n${await this.evaluate('document.body.innerText')}`);
  }
}

test('actual Chrome: unconfigured build has no effects; explicit setup, chat/native history, cancellation and recovery', {
  skip: !chrome && 'Set ZKAPI_TEST_CHROME to a Chromium executable', timeout: 45_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-chat-browser-'));
  const production = await readFile(new URL('../../target/app-sdk-example/app.js', import.meta.url));
  const fixture = await build({ entryPoints: [new URL('./app.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome120' });
  const html = await readFile(new URL('./index.html', import.meta.url)), css = await readFile(new URL('./styles.css', import.meta.url));
  const server = createServer((request, response) => {
    const routes: Record<string, [string, string | Uint8Array]> = {
      '/': ['text/html', html], '/index.html': ['text/html', html], '/styles.css': ['text/css', css],
      '/app.js': ['text/javascript', production], '/fixture-app.js': ['text/javascript', fixture.outputFiles![0].contents],
      '/fixture': ['text/html', '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main id="app"></main></body></html>'],
      '/favicon.ico': ['image/x-icon', ''],
    };
    const route = routes[request.url ?? '']; if (!route) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', route[0]); response.end(route[1]);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = join(directory, 'chrome');
  const child = spawn(chrome!, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-apps', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = ''; child.stderr!.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-3000); });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  let port: number | undefined;
  for (let i = 0; i < 160; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; } catch { assert.equal(child.exitCode, null, diagnostic); await delay(30); } }
  assert.ok(port, diagnostic);
  const debuggerOrigin = `http://127.0.0.1:${port}`;
  t.diagnostic(`Runtime browser: ${(await (await fetch(`${debuggerOrigin}/json/version`)).json() as { Browser: string }).Browser}`);
  const target = await (await fetch(`${debuggerOrigin}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string };
  const c = await Cdp.connect(target.webSocketDebuggerUrl); t.after(() => c.socket.close());
  await c.call('Page.enable');
  await c.call('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.networkCalls=0; globalThis.fetch=()=>{networkCalls++; throw Error('test forbids network effects')};` });
  await c.call('Page.navigate', { url: origin });
  await c.wait(`document.querySelector('#profile-state')?.textContent.includes('No reviewed deployment')`);
  assert.equal(await c.evaluate('networkCalls'), 0);
  assert.deepEqual(await c.evaluate(`['open-note','create-note','scan-wallets','send'].map(id=>document.getElementById(id).disabled)`), [true, true, true, true]);
  assert.equal(await c.evaluate(`document.querySelector('#profile').options.length`), 1);
  if (process.env.ZKAPI_CHAT_SCREENSHOT_DIR) {
    await c.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false });
    const screenshot = await c.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(process.env.ZKAPI_CHAT_SCREENSHOT_DIR, 'browser-chat-unconfigured.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await c.call('Page.navigate', { url: `${origin}/fixture` });
  await c.wait(`document.querySelector('#app') && !document.querySelector('#profile')`);
  await c.evaluate(`(async()=>{
    const {mountChat}=await import('/fixture-app.js');
    globalThis.calls={connect:[],chat:[],native:[],wallet:0,recover:0,clearance:0,emergency:[],challenge:0,deposit:[],withdraw:[]};
    globalThis.snapshot={noteId:'note-1',mode:'proxy',wallet:'empty',settledBalanceMicroUsdc:'0',authorizationCapMicroUsdc:'1000000',canRequest:false,canReconcileUnacceptedAuthorization:false,canPrepareEmergencyEscape:false,canReconcileChallengedEscape:false,emergencyEscape:null,busy:false,session:null,walletOperation:null,expiry:null,lastSettlement:null,privacyNotice:'fixture'};
    globalThis.behavior='normal';globalThis.cleanupStarted=false;let observer;
    const publish=()=>observer?.(structuredClone(snapshot)); globalThis.publish=publish;
    const complete=()=>{snapshot.busy=false;snapshot.session=null;snapshot.canRequest=true;snapshot.lastSettlement={chargeMicroUsdc:'4',operationIds:[calls.chat.at(-1)?.operationId??calls.native.at(-1)?.operationId]};snapshot.settledBalanceMicroUsdc=(BigInt(snapshot.settledBalanceMicroUsdc)-4n).toString();publish()};
    const jsonBody=value=>{let sent=false;return new Response(new ReadableStream({pull(controller){if(!sent){sent=true;controller.enqueue(new TextEncoder().encode(JSON.stringify(value)))}else{complete();controller.close()}}},{highWaterMark:0}),{headers:{'content-type':'application/json'}})};
    const wallet={name:'Fixture Wallet',accounts:[],features:{'standard:connect':{async connect(){wallet.accounts=[{address:'11111111111111111111111111111111',publicKey:new Uint8Array(32),chains:['solana:devnet'],features:['solana:signTransaction']},{address:'22222222222222222222222222222222',publicKey:new Uint8Array(32),chains:['solana:devnet'],features:['solana:signTransaction']}] }},'solana:signTransaction':{supportedTransactionVersions:[0]}}};
    const client={status:async()=>structuredClone(snapshot),subscribe(fn){observer=fn;publish();return()=>{observer=undefined}},listModels:()=>snapshot.mode==='direct_openrouter'?[{id:'direct-model',label:'Fixture direct',provider:'openrouter',apis:['chat']}]:[{id:'chat-model',label:'Fixture chat',provider:'openai',apis:['chat','responses']},{id:'messages-model',label:'Fixture Messages',provider:'anthropic',apis:['messages']}],
      async chat(request){calls.chat.push(request);snapshot.busy=true;snapshot.canRequest=false;snapshot.session={id:'saved-session',phase:'active',operations:[{id:request.operationId,phase:'send_unknown'}]};publish();
        if(behavior==='unknown'){snapshot.busy=false;snapshot.session.phase='send_unknown';publish();throw Error('SECRET_PROVIDER_ERROR')}
        if(behavior==='cancel'){let controller;request.signal.addEventListener('abort',()=>controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"late"}}]}\\n\\n')));return new Response(new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial answer"}}]}\\n\\n'))},async cancel(){cleanupStarted=true;await new Promise(resolve=>globalThis.releaseCleanup=resolve);snapshot.busy=false;snapshot.session.phase='closing';publish()}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}})}
        return jsonBody({choices:[{message:{content:'<img src=x onerror=globalThis.xss=true> reply '+calls.chat.length},finish_reason:'stop'}]})},
      async request(request){calls.native.push(request);snapshot.busy=true;snapshot.canRequest=false;publish();return jsonBody(request.api==='responses'?{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Responses reply'}]}]}:{type:'message',role:'assistant',content:[{type:'text',text:'Messages reply'}],stop_reason:'end_turn'})},
      async prepareDeposit(amount){calls.deposit.push(amount);snapshot.wallet='unfunded';snapshot.walletOperation={kind:'deposit',phase:'ready',signature:null};publish()},
      async advanceWallet(){calls.wallet++;const kind=snapshot.walletOperation.kind;snapshot.walletOperation=null;snapshot.wallet=kind==='deposit'?'active':kind==='initiate_escape'?'pending_escape':'closed';snapshot.canRequest=snapshot.wallet==='active';if(kind==='initiate_escape'&&snapshot.emergencyEscape?.phase==='escaping')snapshot.canReconcileChallengedEscape=true;if(kind==='deposit'){snapshot.settledBalanceMicroUsdc=calls.deposit.at(-1);snapshot.expiry={severity:'normal',message:'Note expiry: fixture future date. After expiry, the entire principal of an Active note can be transferred to the treasury.'}}publish();return {state:'complete'}},
      async recover(){calls.recover++;if(behavior==='unaccepted'||behavior==='session-outage')throw Error('fixture session unavailable');snapshot.session=null;if(snapshot.emergencyEscape?.phase==='challenged')snapshot.emergencyEscape.phase='settled';snapshot.canRequest=snapshot.expiry?.severity!=='expired';publish()},async settle(){return this.recover()},
      async reconcileUnacceptedAuthorization(){calls.clearance++;if(!snapshot.canReconcileUnacceptedAuthorization||behavior==='clearance-unavailable')throw Error('fixture clearance unavailable');snapshot.session=null;snapshot.canReconcileUnacceptedAuthorization=false;snapshot.canRequest=false;publish()},
      async prepareEmergencyEscape(destination){if(!snapshot.canPrepareEmergencyEscape)throw Error('fixture emergency unavailable');calls.emergency.push(destination);globalThis.emergencyArchive=structuredClone(snapshot.session);snapshot.session=null;snapshot.canPrepareEmergencyEscape=false;snapshot.emergencyEscape={phase:'escaping'};snapshot.walletOperation={kind:'initiate_escape',phase:'ready',signature:null,destinationOwner:destination};snapshot.canRequest=false;publish()},
      async reconcileChallengedEscape(){calls.challenge++;if(!snapshot.canReconcileChallengedEscape||behavior!=='challenge-finalized'||globalThis.finalizationUnknown)throw Error('fixture finalized challenge not established or signed finalization unresolved');snapshot.walletOperation=null;snapshot.emergencyEscape.phase='challenged';snapshot.canReconcileChallengedEscape=false;snapshot.wallet='active';snapshot.session={...structuredClone(emergencyArchive),phase:'closing'};publish()},
      async prepareWithdrawal(destination,mode){calls.withdraw.push({destination,mode});snapshot.walletOperation={kind:mode,phase:'ready',signature:null,destinationOwner:destination};snapshot.canRequest=false;publish()},
      async fallbackToEscape(){snapshot.walletOperation={kind:'initiate_escape',phase:'ready',signature:null};publish()},async prepareFinalizeEscape(){if(snapshot.emergencyEscape?.phase==='escaping'&&behavior!=='deadline-passed')throw Error('fixture escape cannot finalize before chain deadline or after challenge');snapshot.walletOperation={kind:'finalize_escape',phase:'ready',signature:null};publish()},
      async resumeWalletProof(){},async retryRejectedWalletOperation(){},async recoverExpiredWalletSetup(){},async cancelUnsentAuthorization(){},async reconcileAbsentOperations(){}
    };
    globalThis.admissionFailure=false;globalThis.budget={schema:1,allowTransactions:true,budget_micro_usdc:'10000000',reserved_micro_usdc:'1000000',remaining_micro_usdc:'9000000',reserved_requests:1,max_requests:18,remaining_requests:17,request_max_cost_micro_usdc:'1000000',available_requests:9};
    globalThis.app=mountChat(document.getElementById('app'),{profiles:[{id:'proxy-fixture',label:'Fixture',mode:'proxy',chain:'solana:devnet'},{id:'direct-fixture',label:'Fixture direct',mode:'direct_openrouter',chain:'solana:devnet'}],wallets:()=>[wallet],async connect(options){calls.connect.push({mode:options.mode,initialize:options.initializeStorage,account:options.account.address,noteId:options.noteId,storageName:options.storageName});snapshot.mode=options.mode;return {client,persistence:'best_effort',...(options.mode==='direct_openrouter'?{async admission(){if(admissionFailure)throw Error('PRIVATE_BUDGET_FAILURE');return structuredClone(budget)}}:{}),dispose(){}}}});
    globalThis.choose=(id,value)=>{const element=document.getElementById(id);element.value=value;element.dispatchEvent(new Event('change'))};
    return true;
  })()`);
  await c.evaluate(`choose('profile','proxy-fixture'); document.querySelector('#privacy-ack').checked=true; document.querySelector('#privacy-ack').dispatchEvent(new Event('input')); document.querySelector('#scan-wallets').click(); choose('wallet','0'); document.querySelector('#connect-wallet').click()`);
  await c.wait(`document.querySelector('#account').options.length===3 && !document.querySelector('#connect-wallet').disabled`);
  assert.equal(await c.evaluate(`document.querySelector('#create-note').disabled`), true);
  await c.evaluate(`choose('account','1'); document.querySelector('#create-note').click()`);
  await c.wait(`!document.querySelector('#deposit').disabled`);
  assert.deepEqual(await c.evaluate('calls.connect'), [{ mode: 'proxy', initialize: true, account: '22222222222222222222222222222222', noteId: 'note-1', storageName: 'zkapi-browser-chat' }]);
  assert.match(await c.evaluate(`document.querySelector('#storage-status').textContent`), /may be evicted/);
  assert.equal(await c.evaluate(`document.querySelector('#deposit-amount').value`), '2.000000');
  assert.equal(await c.evaluate('calls.chat.length+calls.native.length+calls.wallet'), 0);
  await c.evaluate(`document.querySelector('#deposit').click()`); await c.wait(`!document.querySelector('#advance').disabled`);
  assert.deepEqual(await c.evaluate('calls.deposit'), ['2000000']);
  await c.evaluate(`document.querySelector('#advance').click()`); await c.wait(`document.querySelector('#wallet-state').textContent==='active' && !document.querySelector('#model').disabled`);
  await c.evaluate(`choose('model','chat-model'); choose('api','chat'); document.querySelector('#stream').checked=false; document.querySelector('#message').value='arbitrary first prompt'; document.querySelector('#chat-form').requestSubmit()`);
  await c.wait(`document.querySelector('#transcript').textContent.includes('reply 1') && !document.querySelector('#send').disabled`);
  assert.equal(await c.evaluate(`document.querySelector('#transcript img')`), null); assert.equal(await c.evaluate('globalThis.xss'), undefined);
  assert.equal(await c.evaluate(`document.querySelector('#charge').textContent`), '0.000004 USDC');
  await c.evaluate(`document.querySelector('#message').value='follow-up'; document.querySelector('#chat-form').requestSubmit()`);
  await c.wait(`calls.chat.length===2 && !document.querySelector('#send').disabled`);
  assert.equal(await c.evaluate('calls.chat[1].messages.length'), 3);
  assert.notEqual(await c.evaluate('calls.chat[0].operationId'), await c.evaluate('calls.chat[1].operationId'));
  await c.evaluate(`choose('api','responses'); document.querySelector('#message').value='native response'; document.querySelector('#chat-form').requestSubmit()`);
  await c.wait(`calls.native.length===1 && !document.querySelector('#send').disabled`);
  assert.equal(await c.evaluate('calls.native[0].body.store'), false);
  assert.equal(await c.evaluate('calls.native[0].body.input.length'), 5);
  await c.evaluate(`choose('model','messages-model'); choose('api','messages'); document.querySelector('#message').value='native messages'; document.querySelector('#chat-form').requestSubmit()`);
  await c.wait(`calls.native.length===2 && !document.querySelector('#send').disabled`);
  assert.equal(await c.evaluate('calls.native[1].anthropicVersion'), '2023-06-01');
  assert.match(await c.evaluate(`document.querySelector('#transcript').textContent`), /Messages reply/);
  if (process.env.ZKAPI_CHAT_SCREENSHOT_DIR) {
    await c.evaluate(`document.querySelector('#notice').textContent='LOCAL FIXTURE — Synthetic wallet, SDK and provider. No real funds or provider acceptance.'`);
    for (const [name, width, height, mobile] of [['desktop', 1280, 1500, false], ['mobile', 390, 844, true]] as const) {
      await c.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      assert.equal(await c.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, `${name} has horizontal overflow`);
      const screenshot = await c.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await writeFile(join(process.env.ZKAPI_CHAT_SCREENSHOT_DIR, `browser-chat-fixture-${name}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await c.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false });
  }
  await c.evaluate(`choose('model','chat-model'); choose('api','chat'); behavior='cancel'; document.querySelector('#stream').checked=true; document.querySelector('#message').value='cancel me'; document.querySelector('#chat-form').requestSubmit()`);
  await c.wait(`document.querySelector('#transcript').textContent.includes('partial answer') && !document.querySelector('#cancel').disabled`);
  await c.evaluate(`document.querySelector('#cancel').click()`); await c.wait('cleanupStarted');
  await c.evaluate(`snapshot.canPrepareEmergencyEscape=true;snapshot.canReconcileChallengedEscape=true;publish()`);
  assert.equal(await c.evaluate(`document.querySelector('#send').disabled && document.querySelector('#withdraw').disabled && document.querySelector('#recover').disabled && document.querySelector('#clear-unaccepted').disabled && document.querySelector('#emergency-escape').disabled && document.querySelector('#reconcile-escape').disabled`), true);
  assert.equal(await c.evaluate('calls.chat.length'), 3);
  await c.evaluate('snapshot.canPrepareEmergencyEscape=false;snapshot.canReconcileChallengedEscape=false;releaseCleanup()'); await c.wait(`!document.querySelector('#recover').disabled`);
  assert.equal(await c.evaluate(`document.querySelector('#send').disabled`), true);
  assert.match(await c.evaluate(`document.querySelector('#transcript').textContent`), /interrupted/);
  await c.evaluate(`document.querySelector('#recover').click()`); await c.wait(`!document.querySelector('#send').disabled`);
  assert.equal(await c.evaluate('calls.chat.length'), 3); assert.equal(await c.evaluate('calls.recover'), 1);
  // An accepted inference can remain unresolved while the operator is unavailable.
  // The explicit escape archives that work; a chain challenge restores it for settlement.
  await c.evaluate(`snapshot.session={id:'accepted-outage',phase:'closing',operations:[{id:calls.chat.at(-1).operationId,phase:'send_unknown'}]};snapshot.canRequest=false;snapshot.canPrepareEmergencyEscape=true;behavior='session-outage';globalThis.originalPending=JSON.stringify(snapshot.session);publish();document.querySelector('#recover').click()`);
  await c.wait(`document.querySelector('#notice').classList.contains('error') && !document.querySelector('#emergency-escape').disabled`);
  assert.equal(await c.evaluate(`document.querySelector('#withdraw').disabled && document.querySelector('#escape').disabled && !document.querySelector('#destination').disabled && document.querySelector('#clear-unaccepted').disabled`), true);
  await c.evaluate(`document.querySelector('#destination').value='';document.querySelector('#emergency-escape').click()`);
  assert.match(await c.evaluate(`document.querySelector('#notice').textContent`), /destination Solana wallet owner/);
  assert.equal(await c.evaluate('calls.emergency.length'), 0);
  await c.evaluate(`document.querySelector('#destination').value='33333333333333333333333333333333';document.querySelector('#emergency-escape').click()`);
  await c.wait(`!document.querySelector('#advance').disabled`);
  assert.equal(await c.evaluate('JSON.stringify(emergencyArchive)===originalPending'), true);
  assert.equal(await c.evaluate('calls.emergency[0]'), '33333333333333333333333333333333');
  assert.match(await c.evaluate(`document.querySelector('#pending').textContent`), /Emergency escape archive: escaping/);
  assert.equal(await c.evaluate(`document.querySelector('#send').disabled && document.querySelector('#recover').disabled && document.querySelector('#emergency-escape').disabled && document.querySelector('#close-note').disabled`), true);
  await c.evaluate(`document.querySelector('#advance').click()`); await c.wait(`!document.querySelector('#finalize').disabled && !document.querySelector('#reconcile-escape').disabled`);
  await c.evaluate(`document.querySelector('#finalize').click()`); await c.wait(`document.querySelector('#notice').classList.contains('error') && !document.querySelector('#reconcile-escape').disabled`);
  assert.equal(await c.evaluate('calls.wallet'), 2);
  await c.evaluate(`document.querySelector('#reconcile-escape').click()`); await c.wait(`calls.challenge===1 && !document.querySelector('#reconcile-escape').disabled`);
  assert.equal(await c.evaluate(`snapshot.emergencyEscape.phase==='escaping' && snapshot.session===null && snapshot.wallet==='pending_escape' && JSON.stringify(emergencyArchive)===originalPending`), true);
  assert.match(await c.evaluate(`document.querySelector('#pending').textContent`), /Emergency escape remains unresolved/);
  await c.evaluate(`snapshot.wallet='active';publish()`);
  assert.equal(await c.evaluate(`document.querySelector('#withdraw').disabled && document.querySelector('#escape').disabled`), true);
  await c.evaluate(`snapshot.wallet='pending_escape';publish()`);
  // A chain challenge can arrive after finalization has already been prepared.
  // The recovery check stays reachable, but an unknown signed attempt cannot be discarded.
  await c.evaluate(`behavior='deadline-passed';document.querySelector('#finalize').click()`);
  await c.wait(`snapshot.walletOperation?.kind==='finalize_escape' && !document.querySelector('#reconcile-escape').disabled`);
  assert.equal(await c.evaluate(`document.querySelector('#finalize').disabled && document.querySelector('#send').disabled && document.querySelector('#withdraw').disabled`), true);
  await c.evaluate(`snapshot.walletOperation.signature='fixture-unknown-finalization';globalThis.finalizationUnknown=true;behavior='challenge-finalized';publish();document.querySelector('#reconcile-escape').click()`);
  await c.wait(`calls.challenge===2 && document.querySelector('#notice').classList.contains('error') && !document.querySelector('#reconcile-escape').disabled`);
  assert.equal(await c.evaluate(`snapshot.walletOperation.signature==='fixture-unknown-finalization' && snapshot.emergencyEscape.phase==='escaping' && snapshot.session===null`), true);
  await c.evaluate(`globalThis.finalizationUnknown=false`); // Synthetic definitive rejection from the SDK port.
  await c.evaluate(`behavior='challenge-finalized';document.querySelector('#reconcile-escape').click()`); await c.wait(`!document.querySelector('#recover').disabled`);
  assert.match(await c.evaluate(`document.querySelector('#notice').textContent`), /original session is restored for settlement/);
  assert.equal(await c.evaluate(`snapshot.session.id==='accepted-outage' && snapshot.session.operations[0].id===calls.chat.at(-1).operationId && document.querySelector('#send').disabled && document.querySelector('#withdraw').disabled && document.querySelector('#finalize').disabled`), true);
  await c.evaluate(`behavior='normal';document.querySelector('#settle').click()`); await c.wait(`!document.querySelector('#withdraw').disabled`);
  assert.equal(await c.evaluate(`snapshot.emergencyEscape.phase==='settled' && document.querySelector('#reconcile-escape').disabled`), true);
  assert.equal(await c.evaluate('calls.chat.length+calls.native.length'), 5);
  assert.equal(await c.evaluate(`document.querySelector('#profile').value`), 'proxy-fixture');
  // A stale visible button must still consult fresh SDK status immediately before dispatch.
  await c.evaluate(`snapshot.canRequest=false;snapshot.expiry={severity:'expired',message:'Expired. Entire principal can be transferred to treasury.'};snapshot.session={id:'saved-expired',phase:'closing',operations:[]};document.querySelector('#message').value='must not send';document.querySelector('#chat-form').requestSubmit()`);
  await c.wait(`!document.querySelector('#recover').disabled`);
  assert.equal(await c.evaluate('calls.chat.length'), 3);
  assert.match(await c.evaluate(`document.querySelector('#expiry').textContent`), /Expired/);
  assert.equal(await c.evaluate(`document.querySelector('#send').disabled && document.querySelector('#close-note').disabled`), true);
  assert.equal(await c.evaluate(`document.querySelector('#clear-unaccepted').disabled`), true);
  // A possibly sent AUTH can expire before acceptance, with no inference to reconcile.
  // Ordinary recovery can remain pending; only explicit signed-clearance recovery releases it.
  await c.evaluate(`snapshot.session={id:'unaccepted-auth',phase:'send_unknown',operations:[]};snapshot.canReconcileUnacceptedAuthorization=true;behavior='unaccepted';publish();document.querySelector('#recover').click()`);
  await c.wait(`document.querySelector('#notice').classList.contains('error') && !document.querySelector('#clear-unaccepted').disabled`);
  assert.equal(await c.evaluate(`document.querySelector('#withdraw').disabled && document.querySelector('#escape').disabled`), true);
  await c.evaluate(`behavior='clearance-unavailable';document.querySelector('#clear-unaccepted').click()`);
  await c.wait(`calls.clearance===1 && document.querySelector('#notice').classList.contains('error') && !document.querySelector('#clear-unaccepted').disabled`);
  assert.equal(await c.evaluate(`snapshot.session.id==='unaccepted-auth' && document.querySelector('#escape').disabled`), true);
  await c.evaluate(`behavior='normal';document.querySelector('#clear-unaccepted').click()`);
  await c.wait(`!document.querySelector('#escape').disabled`);
  assert.match(await c.evaluate(`document.querySelector('#notice').textContent`), /Signed permanent clearance verified/);
  assert.equal(await c.evaluate(`document.querySelector('#clear-unaccepted').disabled && document.querySelector('#send').disabled`), true);
  assert.equal(await c.evaluate('calls.clearance'), 2); assert.equal(await c.evaluate('calls.chat.length+calls.native.length'), 5);
  await c.evaluate(`document.querySelector('#destination').value='33333333333333333333333333333333';document.querySelector('#escape').click()`); await c.wait(`!document.querySelector('#advance').disabled`);
  assert.equal(await c.evaluate('calls.withdraw.at(-1).mode'), 'initiate_escape');
  await c.evaluate(`document.querySelector('#destination').value='11111111111111111111111111111111';publish()`);
  assert.match(await c.evaluate(`document.querySelector('#pending').textContent`), /Saved destination owner: 33333333333333333333333333333333/);
  await c.evaluate(`document.querySelector('#advance').click()`); await c.wait(`!document.querySelector('#finalize').disabled`);
  await c.evaluate(`document.querySelector('#finalize').click()`); await c.wait(`!document.querySelector('#advance').disabled`);
  await c.evaluate(`document.querySelector('#advance').click()`); await c.wait(`!document.querySelector('#close-note').disabled`);
  assert.equal(await c.evaluate('calls.wallet'), 4);
  await c.evaluate(`document.querySelector('#close-note').click()`); await c.wait(`!document.querySelector('#profile').disabled`);
  await c.evaluate(`choose('profile','direct-fixture')`);
  assert.match(await c.evaluate(`document.querySelector('#privacy').textContent`), /provider-reported usage/);
  assert.equal(await c.evaluate(`document.querySelector('#privacy-ack').checked`), false);
  await c.evaluate(`snapshot.wallet='active';snapshot.canRequest=true;snapshot.expiry.severity='normal';snapshot.settledBalanceMicroUsdc='2000000';document.querySelector('#privacy-ack').checked=true;document.querySelector('#privacy-ack').dispatchEvent(new Event('input'));document.querySelector('#scan-wallets').click();choose('wallet','0');document.querySelector('#connect-wallet').click()`);
  await c.wait(`document.querySelector('#account').options.length===3 && !document.querySelector('#connect-wallet').disabled`);
  await c.evaluate(`choose('account','1');document.querySelector('#open-note').click()`);
  await c.wait(`!document.querySelector('#model').disabled`);
  assert.equal(await c.evaluate('calls.connect.at(-1).initialize'), false);
  assert.equal(await c.evaluate('calls.connect.at(-1).mode'), 'direct_openrouter');
  await c.evaluate(`choose('model','direct-model');choose('api','chat');globalThis.availableBudget=structuredClone(budget);globalThis.fundedSnapshot=structuredClone(snapshot);budget.available_requests=0;budget.reserved_micro_usdc='10000000';budget.remaining_micro_usdc='0';document.querySelector('#refresh').click()`);
  await c.wait(`document.querySelector('#admission').textContent.includes('Capacity: 0')`);
  assert.equal(await c.evaluate(`document.querySelector('#send').disabled && !document.querySelector('#withdraw').disabled && !document.querySelector('#refresh').disabled`), true);
  assert.match(await c.evaluate(`document.querySelector('#admission').textContent`), /Reservations are not actual charges/);
  await c.evaluate(`snapshot.session={id:'budget-exhausted-saved-work',phase:'closing',operations:[]};snapshot.canRequest=false;publish()`);
  assert.equal(await c.evaluate(`document.querySelector('#recover').disabled || document.querySelector('#settle').disabled`), false);
  await c.evaluate(`snapshot=structuredClone(fundedSnapshot);budget=structuredClone(availableBudget);budget.allowTransactions=false;budget.available_requests=0;publish();document.querySelector('#refresh').click()`);
  await c.wait(`document.querySelector('#admission').textContent.includes('Host is read-only')`);
  assert.equal(await c.evaluate(`document.querySelector('#send').disabled && !document.querySelector('#withdraw').disabled`), true);
  await c.evaluate(`budget=structuredClone(availableBudget);document.querySelector('#refresh').click()`); await c.wait(`!document.querySelector('#send').disabled`);
  // Capacity can disappear after rendering: the next explicit send rechecks it.
  await c.evaluate(`admissionFailure=true;document.querySelector('#message').value='must remain unsent';document.querySelector('#chat-form').requestSubmit()`);
  await c.wait(`document.querySelector('#admission').textContent.includes('availability is unavailable') && !document.querySelector('#refresh').disabled`);
  assert.equal(await c.evaluate('calls.chat.length+calls.native.length'), 5);
  assert.equal(await c.evaluate(`document.querySelector('#message').value`), 'must remain unsent');
  assert.equal(await c.evaluate(`!document.querySelector('#withdraw').disabled && document.querySelector('#send').disabled`), true);
  // The same new-work guard applies before preparing a deposit, without changing recovery.
  await c.evaluate(`snapshot.wallet='empty';snapshot.canRequest=false;snapshot.settledBalanceMicroUsdc='0';admissionFailure=false;publish();document.querySelector('#refresh').click()`);
  await c.wait(`!document.querySelector('#deposit').disabled`);
  await c.evaluate(`admissionFailure=true;document.querySelector('#deposit').click()`);
  await c.wait(`document.querySelector('#deposit').disabled && !document.querySelector('#refresh').disabled && document.querySelector('#notice').classList.contains('error')`);
  assert.deepEqual(await c.evaluate('calls.deposit'), ['2000000']);
  assert.equal(await c.evaluate(`document.body.textContent.includes('PRIVATE_BUDGET_FAILURE')`), false);
  await c.evaluate(`snapshot=structuredClone(fundedSnapshot);admissionFailure=false;budget=structuredClone(availableBudget);publish();document.querySelector('#refresh').click()`);
  await c.wait(`!document.querySelector('#send').disabled`);
  await c.evaluate(`choose('model','direct-model');choose('api','chat');behavior='unknown';document.querySelector('#stream').checked=false;document.querySelector('#message').value='uncertain direct request';document.querySelector('#chat-form').requestSubmit()`);
  await c.wait(`!document.querySelector('#recover').disabled`);
  assert.equal(await c.evaluate('calls.chat.length'), 4);
  assert.equal(await c.evaluate(`document.querySelector('#profile').value`), 'direct-fixture');
  assert.equal(await c.evaluate(`document.querySelector('#send').disabled`), true);
  assert.equal(await c.evaluate(`document.querySelector('#clear-unaccepted').disabled`), true);
  assert.equal(await c.evaluate(`document.body.textContent.includes('SECRET_PROVIDER_ERROR')`), false);
  assert.equal(await c.evaluate('calls.connect.length'), 2);
  await c.evaluate(`document.querySelector('#recover').click()`); await c.wait(`!document.querySelector('#send').disabled`);
  assert.equal(await c.evaluate('calls.chat.length'), 4);
  assert.equal(await c.evaluate(`document.querySelector('#profile').value`), 'direct-fixture');
  assert.equal(await c.evaluate('networkCalls'), 0);
  assert.equal(await c.evaluate('calls.chat.length+calls.native.length'), 6);
  const saved = await c.evaluate('JSON.stringify(snapshot)');
  await c.evaluate(`document.querySelector('#clear-chat').click()`);
  assert.match(await c.evaluate(`document.querySelector('#notice').textContent`), /Saved request bodies, including prompts and prior turns, remain in the encrypted financial journal/);
  assert.equal(await c.evaluate('JSON.stringify(snapshot)'), saved);
  assert.equal(await c.evaluate('calls.chat.length+calls.native.length'), 6);
  assert.match(await c.evaluate(`document.querySelector('#transcript').textContent`), /Your conversation will appear here/);
});
