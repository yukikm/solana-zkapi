/** Offline loopback boundaries only; no provider, chain or live campaign writes. */
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {generateKeyPairSync, sign} from 'node:crypto';
import {createServer, request} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import bs58 from 'bs58';
import {directControlRelay, localForwarder, loadBrowserChatBudget} from './browser_chat_devnet_host.ts';
import {startUiHost, type HostOptions} from './devnet-browser-relay/host.ts';
import {jcsBytes, sha256Hex, type VerifiedManifest} from '../packages/sdk/src/trust.ts';
import type {Tariff} from '../packages/sdk/src/control.ts';

const id = '12345678-1234-4123-8123-123456789012';
const field = '0x' + '00'.repeat(31) + '01';
async function fixture() {
  const keys = generateKeyPairSync('ed25519'), secret = Buffer.alloc(32, 17);
  const tariff = {tariff_hash:'aa'.repeat(32),provider:'openrouter',model:'*'} as Tariff;
  const manifest = {deployment_id:'offline-browser-chat',pool:'fixture-pool',tariff_hashes:[tariff.tariff_hash],
    control_api_origin:'https://control.invalid',inference_api_origin:'https://inference.invalid',cap_micro_usdc:'1000000',
    quote_public_key:bs58.encode(keys.publicKey.export({format:'der',type:'spki'}).subarray(-32))} as unknown as VerifiedManifest;
  const quoteRequest = {mode:'direct_openrouter',provider:'openrouter',models:['*'],session_ttl_seconds:'60'};
  const q = {quote_id:id,deployment_id:manifest.deployment_id,pool:manifest.pool,...quoteRequest,tariff_hash:tariff.tariff_hash,
    cap_micro_usdc:'1000000',issued_at:'100',expires_at:'220',max_concurrency:'4',
    control_api_origin:manifest.control_api_origin,inference_api_origin:manifest.inference_api_origin};
  const digest = await sha256Hex(jcsBytes(q));
  const auth = {authorization:{version:'1',deployment_id:manifest.deployment_id,pool:manifest.pool,request_id:id,quote_hash:digest,
    mode:'direct_openrouter',control_secret_hash:await sha256Hex(secret),proxy_secret_hash:null},
    quote:{body:q,quote_hash:digest,signature:sign(null,Buffer.from(digest,'hex'),keys.privateKey).toString('base64')},
    public_inputs:Array(12).fill(field),proof:{backend:'groth16_bn254',proof:Buffer.alloc(256).toString('base64')}};
  const authorization = 'Bearer zkc1.' + id + '.' + secret.toString('base64url');
  return {manifest,tariff,quoteRequest,auth,authorization};
}
async function output(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(),'zkapi-chat-host-test-')); t.after(()=>rm(path,{recursive:true,force:true}));
  for(const file of ['index.html','app.js','styles.css','worker.js']) await writeFile(join(path,file),'fixture '+file);
  return path;
}
async function post(origin:string,path:string,data:Buffer,headers:Record<string,string>={}) {
  return new Promise<{status:number;body:string}>((ok,fail)=>{
    const r=request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...headers}},res=>{
      const parts:Buffer[]=[];res.on('data',part=>parts.push(part));res.on('end',()=>ok({status:res.statusCode!,body:Buffer.concat(parts).toString()}));
    });r.on('error',fail);r.end(data);
  });
}

test('direct AUTH reserves exact bytes before one forward; identical recovery uses one cap and changed bytes fail',async()=>{
  const f=await fixture(), events:string[]=[], reservations=new Map<string,string>();let sends=0;
  const relay=directControlRelay({...f,budget:{async reserve(requestId,digest){events.push('reserve');const previous=reservations.get(requestId);if(previous)assert.equal(digest,previous);else reservations.set(requestId,digest);}},
    async forward(path,method,headers,data){events.push('forward');sends++;assert.equal(path,'/zkapi/v1/sessions');assert.equal(headers.authorization,f.authorization);assert.equal(method,'POST');assert.ok(data);return {status:503,bytes:Buffer.from('uncertain fixture')};}});
  const data=Buffer.from(jcsBytes(f.auth));
  const input={path:'/zkapi/v1/sessions',method:'POST' as const,authorization:f.authorization,data};
  assert.equal((await relay(input)).status,503);assert.equal(sends,1,'uncertain forward is never retried by host');
  assert.equal((await relay(input)).status,503);assert.equal(sends,2);assert.equal(reservations.size,1);
  assert.equal(reservations.get(id),await sha256Hex(data));assert.deepEqual(events,['reserve','forward','reserve','forward']);
  await assert.rejects(relay({...input,data:Buffer.from(JSON.stringify(f.auth,null,2))}));assert.equal(sends,2,'same semantic AUTH with different exact bytes is not admitted');
});

test('direct AUTH rejects schema, mode, key, proof, quote signature and cap tampering before budget admission',async()=>{
  const f=await fixture();let reserves=0,forwards=0;
  const relay=directControlRelay({...f,budget:{async reserve(){reserves++;}},async forward(){forwards++;return{status:200,bytes:Buffer.from('{}')};}});
  const mutations:Array<(v:any)=>void>=[v=>v.extra=true,v=>v.authorization.extra=true,v=>v.authorization.mode='proxy',v=>v.authorization.request_id='not-uuid',
    v=>v.authorization.control_secret_hash='00'.repeat(32),v=>v.authorization.proxy_secret_hash='00'.repeat(32),v=>v.quote.body.cap_micro_usdc='1000001',
    v=>v.quote.body.session_ttl_seconds='300',v=>v.quote.body.models=['another-model'],v=>v.quote.body.control_api_origin='https://attacker.invalid',
    v=>v.quote.signature=Buffer.alloc(64).toString('base64'),v=>v.quote.quote_hash='00'.repeat(32),v=>v.public_inputs.pop(),v=>v.public_inputs[0]='0x'+'ff'.repeat(32),
    v=>v.proof.proof='AA==',v=>v.proof.extra=true];
  for(const mutate of mutations){const value=structuredClone(f.auth);mutate(value);await assert.rejects(relay({path:'/zkapi/v1/sessions',method:'POST',authorization:f.authorization,data:Buffer.from(jcsBytes(value))}));}
  for(const authorization of [undefined,f.authorization.replace(id,'22345678-1234-4123-8123-123456789012'),f.authorization+'=',f.authorization.replace('zkc1','zkp1')])
    await assert.rejects(relay({path:'/zkapi/v1/sessions',method:'POST',authorization,data:Buffer.from(jcsBytes(f.auth))}));
  assert.equal(reserves,0);assert.equal(forwards,0);
});

test('budget exhaustion blocks AUTH but permits exact control reads, close and withdrawal clearance',async()=>{
  const f=await fixture(), calls:string[]=[];let reserves=0;
  const relay=directControlRelay({...f,budget:{async reserve(){reserves++;throw Error('budget exhausted');}},async forward(path){calls.push(path);return{status:200,bytes:Buffer.from('{}')};}});
  await assert.rejects(relay({path:'/zkapi/v1/sessions',method:'POST',authorization:f.authorization,data:Buffer.from(jcsBytes(f.auth))}));
  for(const path of ['/zkapi/v1/config','/zkapi/v1/catalog','/zkapi/v1/attestation','/zkapi/v1/tariffs/'+f.tariff.tariff_hash])
    await relay({path,method:'GET',data:Buffer.alloc(0)});
  for(const suffix of ['', '/receipts','/receipts?cursor=1','/operations/'+id])await relay({path:'/zkapi/v1/sessions/'+id+suffix,method:'GET',authorization:f.authorization,data:Buffer.alloc(0)});
  await relay({path:'/zkapi/v1/sessions/'+id+'/close',method:'POST',authorization:f.authorization,data:Buffer.alloc(0)});
  await relay({path:'/zkapi/v1/withdraw/clearance',method:'POST',data:Buffer.from(jcsBytes({nullifier:field}))});
  await relay({path:'/zkapi/v1/quotes',method:'POST',data:Buffer.from(jcsBytes(f.quoteRequest))});
  assert.equal(reserves,1);assert.equal(calls.length,11);
  for(const path of ['/v1/chat/completions','/zkapi/v1/sessions/'+id+'/close?x=1','/zkapi/v1/config?url=https://attacker.invalid',
    '/zkapi/v1/tariffs/'+'00'.repeat(32),'/zkapi/v1/sessions/'+id+'/receipts?cursor=9223372036854775808','/zkapi/v1/sessions/'+id+'/receipts?cursor=01',
    '/zkapi/v1/sessions/'+id+'/receipts?cursor=1&url=x','/zkapi/v1/sessions/'+id+'%2fclose','/zkapi/v1/nullifiers/'+field])
    await assert.rejects(relay({path,method:'GET',authorization:f.authorization,data:Buffer.alloc(0)}));
  assert.equal(calls.length,11);
});

test('standalone loopback extension retains origin, method, body, header and write guards and exposes no inference proxy',async t=>{
  const f=await fixture(), path=await output(t);let reserves=0,forwards=0,rpc=0;
  const relay=directControlRelay({...f,budget:{async reserve(){reserves++;}},async forward(){forwards++;return{status:503,bytes:Buffer.from('PRIVATE-UPSTREAM-SECRET')};}});
  const options:HostOptions={port:0,output:path,application:'browser-chat',directProviderOrigin:'https://openrouter.ai',allowTransactions:true,controlRelay:relay,
    rpc:async()=>{rpc++;throw Error('no financial send expected');}};
  const host=await startUiHost(options);t.after(()=>host.close());
  options.controlRelay=async()=>{throw Error('must use captured relay');};options.directProviderOrigin='https://attacker.invalid' as never;
  const root=await fetch(host.origin);assert.equal(root.status,200);assert.ok(root.headers.get('content-security-policy')?.includes("connect-src 'self' https://openrouter.ai;"));
  assert.equal((await fetch(host.origin+'/styles.css')).status,200);assert.equal((await fetch(host.origin+'/style.css')).status,400);
  const body=Buffer.from(jcsBytes(f.auth)), auth={authorization:f.authorization};
  const valid=await post(host.origin,'/control/zkapi/v1/sessions',body,auth);assert.equal(valid.status,503);assert.ok(!valid.body.includes('PRIVATE'));assert.equal(reserves,1);assert.equal(forwards,1);
  for(const extra of [{origin:'https://attacker.invalid'},{host:'attacker.invalid'},{'sec-fetch-site':'cross-site'},{cookie:'private=1'},
    {'x-api-key':'private'},{'proxy-authorization':'private'},{'anthropic-version':'private'},{'idempotency-key':id},{'content-type':'text/plain'}] as Record<string,string>[])
    assert.equal((await post(host.origin,'/control/zkapi/v1/sessions',body,{...auth,...extra})).status,400);
  for(const route of ['/inference/v1/chat/completions','/control/v1/chat/completions','/control/zkapi/v1/config?url=https://attacker.invalid','/provider'])
    assert.equal((await post(host.origin,route,body,auth)).status,400);
  assert.equal((await post(host.origin,'/control/zkapi/v1/sessions',Buffer.alloc(65537),auth)).status,400);
  assert.equal((await post(host.origin,'/rpc',Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'sendTransaction',params:['AA==',{encoding:'base64'}]})))).status,400);
  assert.equal(reserves,1);assert.equal(forwards,1);assert.equal(rpc,0);
  const readOnly=await startUiHost({port:0,output:path,application:'browser-chat',controlRelay:relay});t.after(()=>readOnly.close());
  assert.equal((await post(readOnly.origin,'/control/zkapi/v1/sessions',body,auth)).status,400);assert.equal(reserves,1);
  assert.equal((await fetch(readOnly.origin+'/control/zkapi/v1/config')).status,503);assert.equal(forwards,2);
  await assert.rejects(startUiHost({port:0,output:path,controlRelay:relay}));
  await assert.rejects(startUiHost({port:0,output:path,application:'browser-chat',directProviderOrigin:'https://attacker.invalid' as never}));
});

test('pinned standalone assets are served from authenticated bytes without rereading changed build files',async t=>{
  const path=await output(t), verified=Buffer.from('PINNED APP');
  await writeFile(join(path,'demo.html'),'UNREVIEWED LEGACY PRESENTATION');
  const host=await startUiHost({port:0,output:path,application:'browser-chat',assets:new Map([['/app.js',{bytes:verified,mime:'text/javascript'}]])});t.after(()=>host.close());
  await writeFile(join(path,'app.js'),'CHANGED APP');assert.equal(await(await fetch(host.origin+'/app.js')).text(),'PINNED APP');
  assert.equal((await fetch(host.origin+'/demo')).status,400,'standalone output serves only the pinned application, even with stray legacy files');
});

test('native forwarding pins logical Host, keeps exact body, bounds response bytes and follows no redirect',async t=>{
  const calls:Array<{path:string;host:string|undefined;body:Buffer}>=[];
  const server=createServer(async(req,res)=>{const parts:Buffer[]=[];for await(const part of req)parts.push(Buffer.from(part));calls.push({path:req.url!,host:req.headers.host,body:Buffer.concat(parts)});
    if(req.url==='/large'){res.end(Buffer.alloc(1025));return;}if(req.url==='/redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/never'});res.end('redirect');return;}res.end('{}');});
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>new Promise<void>((ok,fail)=>server.close(e=>e?fail(e):ok())));
  const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port, forward=localForwarder(), body=Buffer.from('{"exact": true}');
  assert.equal((await forward(base+'/auth','POST',body,{host:'127.0.0.1:19685'})).status,200);assert.deepEqual(calls[0],{path:'/auth',host:'127.0.0.1:19685',body});
  await assert.rejects(forward(base+'/large','GET',undefined,{},1024),/configured upstream/);
  assert.equal((await forward(base+'/redirect','GET')).status,302);assert.equal(calls.length,3);
  for(const url of ['http://remote.invalid/','https://user:password@example.invalid/','https://example.invalid/#private'])await assert.rejects(forward(url,'GET'));
  assert.equal(calls.length,3);
});

test('direct budget status exposes totals only, counts all legacy rows, and exact AUTH retry survives exhausted capacity',async t=>{
  const path=await output(t), planPath=resolve('config/provider-acceptance.i10.json'), plan=JSON.parse(await readFile(planPath,'utf8'));
  const stateDir=join(path,'budget'), run=promisify(execFile);
  const command=async(script:string,args:string[])=>run('python3',[script,...args,'--plan',planPath,'--state-dir',stateDir],{env:{PATH:process.env.PATH,ZKAPI_PROVIDER_BUDGET_MICRO_USDC:'10000000'}});
  await command('scripts/provider_acceptance.py',['budget-init']);
  await command('scripts/provider_demo_budget.py',['reserve','--case','openai-chat-plain']);
  const tariff=plan.models.find((m:any)=>m.tariff.provider==='openrouter'&&m.tariff.model==='*').tariff;
  const config={planPath,stateDir,caseId:'openrouter-direct-plain' as const}, manifest={cap_micro_usdc:'1000000'} as VerifiedManifest;
  const budget=await loadBrowserChatBudget(config,manifest,tariff,'openai/gpt-4o-mini',true), digest='ab'.repeat(32);
  const before=await readFile(join(stateDir,'budget-state.json')), initial=await budget.status();
  assert.deepEqual(await readFile(join(stateDir,'budget-state.json')),before);assert.equal(initial.reserved_requests,1);assert.equal(initial.available_requests,9);
  await budget.reserve(id,digest);await budget.reserve(id,digest);
  await assert.rejects(budget.reserve(id,'cd'.repeat(32)));assert.equal((await budget.status()).reserved_requests,2);
  for(let i=0;i<8;i++)await budget.reserve('12345678-1234-4123-8123-'+String(i).padStart(12,'0'),digest);
  assert.equal((await budget.status()).available_requests,0);await budget.reserve(id,digest);
  await assert.rejects(budget.reserve('12345678-1234-4123-8123-999999999999',digest));
  // The old proxy coordinator still counts direct rows and admits only a new
  // bounded proxy reservation, with no reset of direct history.
  await command('scripts/provider_demo_budget.py',['reserve-demo','--case','openai-chat-plain','--request-id','22345678-1234-4123-8123-123456789012','--operation-id','32345678-1234-4123-8123-123456789012']);
  const readOnly=await loadBrowserChatBudget(config,manifest,tariff,'openai/gpt-4o-mini',false);assert.equal((await readOnly.status()).allowTransactions,false);
  let fail=false;const host=await startUiHost({port:0,output:path,application:'browser-chat',controlRelay:async()=>({status:200,bytes:Buffer.from('{}')}),
    directBudget:async()=>{if(fail)throw Error('PRIVATE_BUDGET_CANARY');return budget.status();}});t.after(()=>host.close());
  const response=await fetch(host.origin+'/provider-budget');assert.equal(response.status,200);const value=await response.json() as any;
  assert.deepEqual(Object.keys(value).sort(),['schema','allowTransactions','budget_micro_usdc','reserved_micro_usdc','remaining_micro_usdc','max_requests','reserved_requests','remaining_requests','request_max_cost_micro_usdc','available_requests'].sort());
  assert.equal(value.reserved_requests,11);assert.equal(value.available_requests,0);assert.ok(!JSON.stringify(value).includes(id));
  for(const suffix of ['?state=private','/'])assert.equal((await fetch(host.origin+'/provider-budget'+suffix)).status,400);
  for(const headers of [{origin:'https://foreign.invalid'},{authorization:'private'},{cookie:'private'}, {'sec-fetch-site':'cross-site'}] as Record<string,string>[])assert.equal((await fetch(host.origin+'/provider-budget',{headers})).status,400);
  fail=true;const unavailable=await fetch(host.origin+'/provider-budget');assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{error:'provider campaign unavailable'});
});
