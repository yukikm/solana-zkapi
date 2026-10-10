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

test('suspended direct admission passes exact recovery policy and preserves close/clearance routes',async t=>{
  const f=await fixture(), path=await output(t), allowed:boolean[]=[], forwarded:string[]=[];
  const relay=directControlRelay({...f,budget:{async reserve(_request,_digest,allowNew){allowed.push(allowNew!);}},
    async forward(path){forwarded.push(path);return{status:200,bytes:Buffer.from('{}')};}});
  const host=await startUiHost({port:0,output:path,application:'browser-chat',allowTransactions:true,allowNewAdmissions:false,controlRelay:relay});t.after(()=>host.close());
  assert.equal((await post(host.origin,'/control/zkapi/v1/sessions',Buffer.from(jcsBytes(f.auth)),{authorization:f.authorization})).status,200);
  assert.deepEqual(allowed,[false]);
  assert.equal((await post(host.origin,'/control/zkapi/v1/sessions/'+id+'/close',Buffer.alloc(0),{authorization:f.authorization})).status,200);
  assert.equal((await post(host.origin,'/control/zkapi/v1/withdraw/clearance',Buffer.from(jcsBytes({nullifier:field})))).status,200);
  assert.equal(forwarded.length,3);
  const status=await(await fetch(host.origin+'/relay-status')).json() as any;
  assert.equal(status.admission,'suspended');assert.equal(status.recovery,'enabled');assert.equal(status.readiness,'not_checked');
  assert.equal(status.routes.rpc,'missing');assert.equal(status.routes.control,'configured');
  assert.equal(status.signer,'not_checked');assert.equal(status.provider_credit,'not_checked');
});

test('public AUTH requires invitation for a new reservation and preserves exact recovery without it',async t=>{
  const f=await fixture(), invitation=Buffer.alloc(32,61).toString('base64url'), wrong=Buffer.alloc(32,62).toString('base64url');
  const admissionTokenSha256=await sha256Hex(Buffer.from(invitation)), reservations=new Map<string,string>();
  const forwarded:Array<{path:string;headers:Record<string,string>}>=[], allowNewValues:boolean[]=[];
  const relay=directControlRelay({...f,budget:{async reserve(requestId,digest,allowNew){
    allowNewValues.push(allowNew!);const previous=reservations.get(requestId);
    if(previous!==undefined)assert.equal(previous,digest);else{assert.equal(allowNew,true,'new admission requires invitation');reservations.set(requestId,digest);}
  }},async forward(path,_method,headers){forwarded.push({path,headers});return{status:200,bytes:Buffer.from('{}')};}});
  const publicOrigin='https://operator.example.com', browserOrigin='https://chat.example.com';
  const host=await startUiHost({port:0,application:'public-api',publicOrigin,allowedBrowserOrigins:[browserOrigin],allowNativeRequests:true,
    allowTransactions:true,allowNewAdmissions:true,admissionTokenSha256,controlRelay:relay});t.after(()=>host.close());
  const address=host.server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
  const headers={host:new URL(publicOrigin).host,origin:browserOrigin,authorization:f.authorization};const data=Buffer.from(jcsBytes(f.auth));
  for(const token of [undefined,wrong,'invalid']){
    const result=await post(base,'/zkapi/v1/sessions',data,{...headers,...(token?{'x-zkapi-admission':token}:{})});
    assert.equal(result.status,400);assert.equal(reservations.size,0);assert.equal(forwarded.length,0);assert.ok(!result.body.includes(token??invitation));
  }
  assert.equal((await post(base,'/zkapi/v1/sessions',data,{...headers,'x-zkapi-admission':invitation})).status,200);
  assert.equal(reservations.size,1);assert.equal(forwarded.length,1);assert.deepEqual(forwarded[0].headers,{authorization:f.authorization});
  for(const token of [undefined,wrong])assert.equal((await post(base,'/zkapi/v1/sessions',data,{...headers,...(token?{'x-zkapi-admission':token}:{})})).status,200);
  assert.deepEqual(allowNewValues,[false,false,false,true,false,false]);assert.equal(reservations.size,1);assert.equal(forwarded.length,3);
  assert.equal((await post(base,'/zkapi/v1/sessions',Buffer.from(JSON.stringify(f.auth,null,2)),headers)).status,400);assert.equal(forwarded.length,3);
  assert.equal((await post(base,'/zkapi/v1/sessions/'+id+'/close',Buffer.alloc(0),{...headers,'x-zkapi-admission':invitation})).status,400);
  assert.equal((await post(base,'/zkapi/v1/sessions/'+id+'/close',Buffer.alloc(0),headers)).status,200);
  assert.ok(!JSON.stringify(forwarded).includes(invitation));assert.ok(!JSON.stringify(forwarded).includes(admissionTokenSha256));
  await assert.rejects(startUiHost({port:0,application:'public-api',publicOrigin,allowedBrowserOrigins:[browserOrigin],allowNativeRequests:true,
    allowTransactions:true,allowNewAdmissions:true,controlRelay:relay}),/invitation digest/);
});

test('invitation-free public AUTH retains exact recovery, budget exhaustion, suspension and credential checks',async t=>{
  const f=await fixture(), reservations=new Map<string,string>(), forwarded:string[]=[], permissions:boolean[]=[];
  const relay=directControlRelay({...f,budget:{async reserve(requestId,digest,allowNew){
    permissions.push(allowNew!);
    const previous=reservations.get(requestId);
    if(previous!==undefined)assert.equal(previous,digest);
    else {assert.equal(allowNew,true);assert.equal(reservations.size,0,'fixture budget exhausted');reservations.set(requestId,digest);}
  }},async forward(path){forwarded.push(path);return{status:200,bytes:Buffer.from('{}')};}});
  const publicOrigin='https://operator.example.com',browserOrigin='https://chat.example.com';
  const headers={host:new URL(publicOrigin).host,origin:browserOrigin,authorization:f.authorization};
  const data=Buffer.from(jcsBytes(f.auth)),nextId='12345678-1234-4123-8123-123456789013';
  const next=structuredClone(f.auth);next.authorization.request_id=nextId;
  const nextHeaders={...headers,authorization:f.authorization.replace(id,nextId)};
  for(const [allowTransactions,allowNewAdmissions] of [[true,true],[true,false],[false,false]]){
    const host=await startUiHost({port:0,application:'public-api',publicOrigin,allowedBrowserOrigins:[browserOrigin],allowNativeRequests:true,
      allowTransactions,allowNewAdmissions,requireInvitation:false,admissionTokenSha256:'dd'.repeat(32),controlRelay:relay});t.after(()=>host.close());
    const address=host.server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port;
    const before=forwarded.length;
    const permissionsBefore=permissions.length;
    assert.equal((await post(base,'/zkapi/v1/sessions',data,{...headers,authorization:'Bearer invalid'})).status,400);
    assert.equal(forwarded.length,before);
    assert.equal((await post(base,'/zkapi/v1/sessions',data,headers)).status,allowTransactions?200:400);
    assert.equal((await post(base,'/zkapi/v1/sessions',data,{...headers,'x-zkapi-admission':'obsolete-token'})).status,allowTransactions?200:400);
    assert.equal(reservations.size,1);
    const afterRecovery=forwarded.length;
    assert.equal((await post(base,'/zkapi/v1/sessions',Buffer.from(jcsBytes(next)),nextHeaders)).status,400);
    assert.equal((await post(base,'/zkapi/v1/sessions',Buffer.from(JSON.stringify(f.auth,null,2)),headers)).status,400);
    assert.equal(forwarded.length,afterRecovery);assert.equal(reservations.size,1);
    assert.deepEqual(permissions.slice(permissionsBefore),allowTransactions?[allowNewAdmissions,allowNewAdmissions,allowNewAdmissions,allowNewAdmissions]:[]);
    assert.equal((await post(base,'/zkapi/v1/sessions/'+id+'/close',Buffer.alloc(0),headers)).status,allowTransactions?200:400);
  }
  assert.equal(forwarded.length,6);
});

test('public HTTPS origin is explicit and same-origin only behind the loopback listener',async t=>{
  const path=await output(t), publicOrigin='https://chat.example';let calls=0;
  const host=await startUiHost({port:0,output:path,application:'browser-chat',publicOrigin,allowTransactions:true,allowNewAdmissions:false,
    controlRelay:async()=>{calls++;return{status:200,bytes:Buffer.from('{}')};}});t.after(()=>host.close());
  assert.equal(host.origin,publicOrigin);
  const address=host.server.address();assert.ok(address&&typeof address==='object');
  const transport='http://127.0.0.1:'+address.port;
  const headers={host:'chat.example',origin:publicOrigin};
  assert.equal((await post(transport,'/control/zkapi/v1/quotes',Buffer.from('{}'),headers)).status,200);assert.equal(calls,1);
  for(const extra of [{host:'attacker.example'},{origin:'https://attacker.example'},{'sec-fetch-site':'cross-site'},{'x-forwarded-host':'chat.example',host:'attacker.example'}])
    assert.equal((await post(transport,'/control/zkapi/v1/quotes',Buffer.from('{}'),{...headers,...extra})).status,400);
  assert.equal(calls,1);
  // Native fetch can replace a caller-supplied Host with the URL authority.
  // Model the TLS proxy's actual HTTP forwarding with an exact native Host.
  const status=await new Promise<{status:number;cors:string|undefined}>((ok,fail)=>{
    const r=request(transport+'/relay-status',{headers:{host:'chat.example'}},res=>{
      res.resume();res.on('end',()=>ok({status:res.statusCode!,cors:res.headers['access-control-allow-origin'] as string|undefined}));
    });r.on('error',fail);r.end();
  });assert.equal(status.status,200);assert.equal(status.cors,undefined);
  for(const url of ['http://chat.example','https://chat.example/path','https://user:secret@chat.example','https://chat.example?token=secret'])
    await assert.rejects(startUiHost({port:0,output:path,application:'browser-chat',publicOrigin:url,allowNewAdmissions:false}));
  await assert.rejects(startUiHost({port:0,output:path,application:'browser-chat',publicOrigin}));
  await assert.rejects(startUiHost({port:0,output:path,publicOrigin,allowNewAdmissions:false}));
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
  const suspended=await loadBrowserChatBudget(config,manifest,tariff,'openai/gpt-4o-mini',true,false);
  assert.equal((await suspended.status()).available_requests,0);assert.equal((await suspended.status()).allowTransactions,true);
  await suspended.reserve(id,digest);
  const beforeSuspended=await readFile(join(stateDir,'budget-state.json'));
  await assert.rejects(suspended.reserve('12345678-1234-4123-8123-999999999998',digest));
  assert.deepEqual(await readFile(join(stateDir,'budget-state.json')),beforeSuspended);
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

test('operator-funded AUTH has no lifetime trial quota and retains one-forward and suspension boundaries',async()=>{
  const f=await fixture(),data=Buffer.from(jcsBytes(f.auth));
  const calls:Array<{path:string;method:string;data?:Buffer}>=[];
  let existingStatus=404;
  const relay=directControlRelay({...f,budget:{kind:'operator-funded'},async forward(path,method,headers,body){
    assert.equal(headers.authorization,f.authorization);calls.push({path,method,data:body});
    return {status:method==='GET'?existingStatus:503,bytes:Buffer.from('{}')};
  }});
  const input={path:'/zkapi/v1/sessions',method:'POST' as const,authorization:f.authorization,data};
  // Explicit calls, not automatic retries: no gateway exhaustion after seven.
  for(let n=0;n<10;n++)assert.equal((await relay(input)).status,503);
  assert.equal(calls.length,10);assert.ok(calls.every(c=>c.method==='POST'&&c.data===data));
  for(const existing of [404,401,503]){
    existingStatus=existing;const before=calls.length;
    await assert.rejects(relay({...input,allowNewAdmissions:false}),/new provider admission suspended/);
    assert.equal(calls.length,before+1);assert.equal(calls.at(-1)!.method,'GET');
  }
  existingStatus=200;
  assert.equal((await relay({...input,allowNewAdmissions:false})).status,503);
  assert.deepEqual(calls.slice(-2).map(c=>c.method),['GET','POST']);
  assert.equal(calls.at(-2)!.path,'/zkapi/v1/sessions/'+id);
  assert.equal(calls.at(-1)!.data,data,'saved AUTH bytes reach the existing ledger unchanged');
  existingStatus=404;
  await assert.rejects(relay({...input,newAdmissionAuthorized:false}),/new provider admission suspended/);
  const changed=structuredClone(f.auth);changed.quote.body.cap_micro_usdc='1000001';
  const before=calls.length;
  await assert.rejects(relay({...input,data:Buffer.from(jcsBytes(changed))}));
  assert.equal(calls.length,before,'per-session cap and signed quote checks still precede forwarding');
});
