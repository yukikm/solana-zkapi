/** Synthetic daemon scheduling tests. Control persistence/cryptography and
 * real proof acceptance are tested independently. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ClientDaemon } from '../src/clientd-bridge.ts';
import type { ControlClient, NoteJournal, PreparedSession } from '../src/control.ts';
import type { EncryptedJournal } from '../src/journal.ts';
import type { GatewayConfiguration, TariffV3 } from '../src/gateway.ts';
import { jcsBytes, sha256Hex } from '../src/trust.ts';

const {tariff}=JSON.parse(await readFile(new URL('../../../docs/contracts/universal-api-gateway-vectors.json',import.meta.url),'utf8')) as {tariff:TariffV3};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function fixture(stage:'proof'|'auth'|'send',selectedTariff=tariff,gateway?:GatewayConfiguration){
  const tariff=selectedTariff;
  const entered=deferred(),late=deferred();
  const counts={prepared:0,auth:0,operations:0,sends:0};
  const value={pending:null,history:[]} as unknown as NoteJournal;
  const prepared={request:{authorization:{mode:'proxy',request_id:'12345678-1234-4123-8123-123456789012'},quote:{body:{issued_at:'100',session_ttl_seconds:'60',api:tariff.api}}},tariff} as PreparedSession;
  let authSignal:AbortSignal|undefined,sendSignal:AbortSignal|undefined;
  const client={
    async prepare(_note:string,input:PreparedSession,_root:string,signal?:AbortSignal){signal!.throwIfAborted();counts.prepared++;value.pending={prepared:input,exactRequest:JSON.stringify(input.request),phase:'prepared',operations:[]};},
    async submit(_note:string,signal?:AbortSignal){counts.auth++;authSignal=signal;value.pending!.phase='send_unknown';if(stage==='auth'){entered.resolve();await new Promise<void>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));}value.pending!.phase='active';value.pending!.serverState='ACTIVE';return{expires_at:'160'};},
    async prepareGatewayOperation(){counts.operations++;},
    async sendOperation(_note:string,_id:string,signal?:AbortSignal){counts.sends++;sendSignal=signal;entered.resolve();await late.promise;throw Error('synthetic carrier ended');},
    async close(){},
  } as unknown as ControlClient;
  const journal={async read(){return{revision:1,value};}} as unknown as EncryptedJournal<NoteJournal>;
  const daemon=new ClientDaemon({client,journal,noteId:'note',mode:'proxy',models:[],services:[{tariff}],gateway,now:()=>100n,
    async prepare(){throw Error('unexpected legacy preparation');},async prepareApi(){if(stage==='proof'){entered.resolve();await late.promise;}return{prepared,root:'synthetic-root'};}});
  return{daemon,value,counts,entered,late,prepared,signals:()=>({authSignal,sendSignal}),request:(signal?:AbortSignal,body:Uint8Array=new Uint8Array())=>daemon.requestGateway(tariff.api.service,tariff.api.operation,{version:'2',method:'POST',target:tariff.api.routes.find(route=>route.method==='POST')!.path,headers:[],body},undefined,signal)};
}

test('stored OpenAI prompt references are rejected before proof, AUTH or dispatch under either cost policy',async()=>{
  for(const extra_cost_policy of ['reject_unclassified','operator_absorbs_unpriced']){
    const selected=structuredClone(tariff),api=selected.api;
    api.routes=[{method:'POST',path:'/v1/responses'}];
    api.meter={adapter:{id:'openai_responses',version:'1',artifact_sha256:'22'.repeat(32)},resource:{provider:'openai',model:'fixture-model'},config:{provider_contract_sha256:'33'.repeat(32),context_max_tokens:'8192',output_max_tokens:'4096',service_tier:'default',extra_cost_policy},config_hash:''};
    api.meter.config_hash=await sha256Hex(jcsBytes(api.meter.config));api.completion.kind='provider_terminal_usage';
    selected.pricing_basis='fixed_usage_rates';
    selected.rates=['cache_read_tokens','input_tokens','output_tokens'].map(unit=>({unit,nano_usdc_numerator:'1',unit_denominator:'1',reservation_max_count:unit==='output_tokens'?'4096':'8192'}));
    const f=fixture('send',selected);f.late.resolve();await f.daemon.start();
    await assert.rejects(f.request(undefined,jcsBytes({model:'fixture-model',store:false,service_tier:'default',prompt:{id:'pmpt_private',version:'1'}})),/stored prompt/);
    assert.equal(f.value.pending,null);
    assert.deepEqual(f.counts,{prepared:0,auth:0,operations:0,sends:0});
  }
});

test('native gateway rejects non-ASCII operation identity bytes before AUTH instead of masking their high bits',async()=>{
  const binding_hash=await sha256Hex(jcsBytes(tariff.api));
  const f=fixture('send',tariff,{capabilities:['finite_http_v1'],mounts:[{prefix:'',service:tariff.api.service,operation:tariff.api.operation,binding_hash}]});
  f.late.resolve();await f.daemon.start();
  const malformed=Buffer.from('12345678-1234-4123-8123-123456789012');malformed[0]|=0x80;
  await assert.rejects(f.daemon.handleGateway('POST','/v1/lookup',new Uint8Array(),[['idempotency-key',malformed.toString('base64')]]),/registered gateway operation required/);
  assert.equal(f.value.pending,null);
  assert.deepEqual(f.counts,{prepared:0,auth:0,operations:0,sends:0});
});

test('gateway admission stops at 180 seconds and discards a late pure proof result',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture('proof');await f.daemon.start();
  const request=f.request();await f.entered.promise;t.mock.timers.tick(180_000);
  await assert.rejects(request,{name:'TimeoutError'});assert.equal(f.value.pending,null);
  f.late.resolve();await Promise.resolve();await f.daemon.maintenance();
  assert.deepEqual(f.counts,{prepared:0,auth:0,operations:0,sends:0});
});

test('gateway admission passes its deadline to AUTH and preserves uncertain authorization',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture('auth');await f.daemon.start();
  const request=f.request();await f.entered.promise;t.mock.timers.tick(180_000);
  await assert.rejects(request,{name:'TimeoutError'});assert.equal(f.signals().authSignal!.aborted,true);
  assert.equal(f.value.pending!.phase,'send_unknown');assert.deepEqual(f.counts,{prepared:1,auth:1,operations:0,sends:0});
});

test('completed gateway admission does not shorten the separately bounded carrier',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture('send'),caller=new AbortController();await f.daemon.start();
  const request=f.request(caller.signal);await f.entered.promise;t.mock.timers.tick(180_000);
  assert.equal(f.signals().authSignal!.aborted,false);assert.equal(f.signals().sendSignal,caller.signal);
  f.late.resolve();await assert.rejects(request,/synthetic carrier ended/);
  assert.deepEqual(f.counts,{prepared:1,auth:1,operations:1,sends:1});
});

async function waitUntilQueued(daemon:ClientDaemon,previous:Promise<void>){
  for(let i=0;i<30&&(daemon as any).serial===previous;i++)await Promise.resolve();
  assert.notEqual((daemon as any).serial,previous,'the guarded task must enter the serial queue');
}

test('gateway admission timeout includes queued maintenance and cannot authorize after the observer leaves',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture('auth');await f.daemon.start();
  const maintenance=deferred();(f.daemon as any).serial=maintenance.promise;
  const request=f.request();await waitUntilQueued(f.daemon,maintenance.promise);t.mock.timers.tick(180_000);
  await assert.rejects(request,{name:'TimeoutError'});assert.equal(f.value.pending,null);
  let followingEntered=false;const following=(f.daemon as any).exclusive(async()=>{followingEntered=true;});
  await Promise.resolve();assert.equal(followingEntered,false,'observer cancellation must not release the actual serial lock');
  maintenance.resolve();await following;
  assert.deepEqual(f.counts,{prepared:0,auth:0,operations:0,sends:0});
});

test('gateway delivery wait includes queued maintenance and leaves its durable marker intact at 45 seconds',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture('auth');await f.daemon.start();
  const hold={request_id:'12345678-1234-4123-8123-123456789012',operation_id:'12345678-1234-4123-8123-123456789013',delivered:true};f.value.gatewayRecoveryHold=hold;
  f.value.pending={prepared:f.prepared,exactRequest:JSON.stringify(f.prepared.request),phase:'active',serverState:'ACTIVE',operations:[]};
  let closes=0;(f.daemon as any).o.client.close=async()=>{closes++;};
  const maintenance=deferred();(f.daemon as any).serial=maintenance.promise;
  const waiting=f.daemon.waitGatewayDelivery();await waitUntilQueued(f.daemon,maintenance.promise);t.mock.timers.tick(45_000);
  await assert.rejects(waiting,{name:'TimeoutError'});assert.deepEqual(f.value.gatewayRecoveryHold,hold);
  let followingEntered=false;const following=(f.daemon as any).exclusive(async()=>{followingEntered=true;});
  await Promise.resolve();assert.equal(followingEntered,false);
  maintenance.resolve();await following;assert.deepEqual(f.value.gatewayRecoveryHold,hold);assert.equal(closes,0);
  assert.deepEqual(f.counts,{prepared:0,auth:0,operations:0,sends:0});
});
