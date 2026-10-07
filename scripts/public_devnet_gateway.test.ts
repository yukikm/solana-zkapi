/** Temporary local fixtures only. No real provider, chain, wallet or campaign. */
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request,createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {publicProfileFixture} from '../packages/sdk/test/public-profile-fixture.ts';
import {jcsBytes,sha256Hex,manifestDigest} from '../packages/sdk/src/trust.ts';
import {loadGatewayPublicProfile,validateGatewayProfile,loadSupplementalGatewayBudget,type PublicDevnetGatewayConfig,type SupplementalGatewayBudget,type DetachedGatewayBudget} from './public_devnet_gateway.ts';
import {startUiHost,type HostOptions} from './devnet-browser-relay/host.ts';
import {localForwarder} from './browser_chat_devnet_host.ts';
import {preflightPublicDeployment} from '../packages/sdk/src/public-profile.ts';

const publicOrigin='https://control.example.com', browserOrigin='https://independent-chat.example.com';
async function call(base:string,path:string,method='GET',headers:Record<string,string>={},body?:string){
  return new Promise<{status:number;headers:Record<string,unknown>;body:string}>((ok,fail)=>{
    const r=request(base+path,{method,headers:{host:new URL(publicOrigin).host,...headers}},response=>{
      const chunks:Buffer[]=[];response.on('data',v=>chunks.push(Buffer.from(v)));response.on('end',()=>ok({status:response.statusCode!,headers:response.headers,body:Buffer.concat(chunks).toString()}));
    });r.on('error',fail);r.end(body);
  });
}
async function host(t:TestContext,options:Partial<HostOptions>={}){
  const h=await startUiHost({port:0,application:'public-api',publicOrigin,allowedBrowserOrigins:[browserOrigin],allowNativeRequests:true,
    allowTransactions:true,allowNewAdmissions:false,...options});t.after(()=>h.close());
  const a=h.server.address();assert.ok(a&&typeof a==='object');return{...h,base:'http://127.0.0.1:'+a.port};
}
async function installedFixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'zkapi-public-gateway-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const f=await publicProfileFixture();f.profile.rpcUrl=publicOrigin+'/rpc';f.profile.indexerOrigin=publicOrigin;
  f.profile.directProviderBases={direct_openrouter:'https://openrouter.ai/api/v1'};
  f.manifest.cap_micro_usdc='1000000';f.manifest.manifest_hash=await manifestDigest(f.manifest);f.trust.anchor.sha256=f.manifest.manifest_hash;
  f.files.set('https://assets.example.com/manifest.json',jcsBytes(f.manifest));
  const manifest=f.files.get('https://assets.example.com/manifest.json')!;
  f.descriptor.files['manifest.json']={sha256:await sha256Hex(manifest),bytes:manifest.length};
  const descriptor=jcsBytes(f.descriptor);f.files.set(f.profile.bundle.url,descriptor);f.profile.bundle.sha256=await sha256Hex(descriptor);
  for(const[url,bytes]of f.files)await writeFile(join(directory,new URL(url).pathname.slice(1)),bytes);
  const profilePath=join(directory,'profile.json');await writeFile(profilePath,jcsBytes(f.profile));
  const config:PublicDevnetGatewayConfig={port:0,publicOrigin,allowedBrowserOrigins:[browserOrigin],allowNativeRequests:true,
    allowTransactions:true,allowNewAdmissions:false,profileUrl:f.profileUrl,profilePath,profileSha256:await f.profileSha256(),
    bundleDescriptorPath:join(directory,'bundle.json'),rpcUrl:'https://rpc.operator.example.com/?key=PRIVATE_RPC',indexerUrl:'http://127.0.0.1:8080',controlUrl:'http://127.0.0.1:8788',
    budget:{planPath:join(directory,'unopened-plan.json'),stateDir:join(directory,'unopened-budget'),caseId:'openrouter-direct-plain'}};
  return{directory,f,config};
}

test('public gateway loads pinned profile and bundle offline without UI, budget, network or .invalid defaults',async t=>{
  const{config}=await installedFixture(t);const loaded=await loadGatewayPublicProfile(config);const selected=validateGatewayProfile(config,loaded);
  assert.equal(selected.manifest.control_api_origin,publicOrigin);assert.equal(selected.profile.rpcUrl,publicOrigin+'/rpc');
  assert.equal(selected.model.provider,'openrouter');assert.equal(loaded.profileSha256,config.profileSha256);
  await assert.rejects(loadGatewayPublicProfile({...config,profileSha256:'00'.repeat(32)}));
  assert.throws(()=>validateGatewayProfile({...config,publicOrigin:'https://wrong.example.com'},loaded));
  assert.throws(()=>validateGatewayProfile(config,{...loaded}));
  await assert.rejects(loadGatewayPublicProfile({...config,rpcUrl:'http://rpc.example.com/'}));
});

test('gateway refuses altered bundle and origin/model modes before opening budget or listener',async t=>{
  const{config}=await installedFixture(t);await writeFile(config.bundleDescriptorPath,'{}');
  await assert.rejects(loadGatewayPublicProfile(config));
  await assert.rejects(loadGatewayPublicProfile({...config,allowedBrowserOrigins:['*']}));
  await assert.rejects(loadGatewayPublicProfile({...config,allowNewAdmissions:true}),/invitation digest/);
});

test('independent SDK preflight completes through canonical gateway with only read-only upstream fixture calls',async t=>{
  const {config,f}=await installedFixture(t),loaded=await loadGatewayPublicProfile(config);
  const upstream=async(url:string,method='GET',body?:string)=>{
    const response=await f.fetcher(url,{method,body,credentials:'omit',redirect:'error'});
    return{status:response.status,bytes:Buffer.from(await response.arrayBuffer())};
  };
  const h=await host(t,{manifest:loaded.assets.verifiedManifest,
    controlRelay:async v=>{assert.equal(v.method,'GET');return upstream(publicOrigin+v.path);},
    indexer:async path=>upstream(publicOrigin+path),rpc:async bytes=>upstream(publicOrigin+'/rpc','POST',bytes.toString())});
  const browserFetch:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,publicOrigin);
    const r=await call(h.base,url.pathname+url.search,init?.method??'GET',
      {origin:browserOrigin,'sec-fetch-site':'cross-site',...(init?.body?{'content-type':'application/json'}:{})},init?.body?String(init.body):undefined);
    assert.equal(r.headers['access-control-allow-origin'],browserOrigin);return new Response(r.body,{status:r.status});
  };
  const result=await preflightPublicDeployment(loaded,{fetch:browserFetch,nowSeconds:2600n});
  assert.equal(result.chainAllowsNewOperations,true);assert.equal(result.operatorAdmission,'unverified');
  assert.ok(f.calls.every(c=>c.method==='GET'||['getGenesisHash','getAccountInfo','getMultipleAccounts','getBlock'].includes(c.rpc??'')));
  assert.ok(!f.calls.some(c=>/quotes|sessions|notes|completions/.test(c.url)));
});

test('canonical public routes work without UI output and retain no arbitrary prefix forwarding',async t=>{
  const control:string[]=[],indexer:string[]=[],rpc:string[]=[];
  const h=await host(t,{controlRelay:async v=>{control.push(v.path);assert.equal(v.allowNewAdmissions,false);return{status:200,bytes:Buffer.from('{}')};},
    indexer:async path=>{indexer.push(path);return{status:200,bytes:Buffer.from('{}')};},
    rpc:async bytes=>{const j=JSON.parse(bytes.toString());rpc.push(j.method);return{status:200,bytes:Buffer.from(JSON.stringify({jsonrpc:'2.0',id:j.id,result:'fixture'}))};}});
  for(const path of ['/zkapi/v1/config','/zkapi/v1/catalog','/zkapi/v1/sessions/12345678-1234-4123-8123-123456789012/receipts?cursor=1'])assert.equal((await call(h.base,path)).status,200);
  for(const path of ['/zkapi/v1/tree/root','/zkapi/v1/tree/snapshot','/zkapi/v1/tree/snapshots/'+'ab'.repeat(32)+'.json'])assert.equal((await call(h.base,path)).status,200);
  assert.equal((await call(h.base,'/rpc','POST',{'content-type':'application/json'},JSON.stringify({jsonrpc:'2.0',id:1,method:'getGenesisHash',params:[]}))).status,200);
  assert.deepEqual(rpc,['getGenesisHash']);assert.equal(control.length,3);assert.equal(indexer.length,3);
  for(const path of ['/','/app.js','/control/zkapi/v1/config','/indexer/zkapi/v1/tree/root','/zkapi/v1/tree/notes/7/path','/v1/chat/completions','/zkapi/v1/config?destination=evil','/zkapi/v1/%63onfig'])assert.equal((await call(h.base,path)).status,400);
  assert.equal(control.length,3);assert.equal(indexer.length,3);
});

test('CORS explicitly allows reviewed browser origin, methods and headers without credentials or financial work',async t=>{
  let upstream=0;const h=await host(t,{controlRelay:async()=>{upstream++;return{status:200,bytes:Buffer.from('{}')};}});
  const headers={origin:browserOrigin,'sec-fetch-site':'cross-site','access-control-request-method':'POST','access-control-request-headers':'authorization, content-type'};
  const r=await call(h.base,'/zkapi/v1/sessions','OPTIONS',headers);assert.equal(r.status,204);assert.equal(upstream,0);
  assert.equal(r.headers['access-control-allow-origin'],browserOrigin);assert.equal(r.headers['access-control-allow-credentials'],undefined);
  assert.equal(r.headers['access-control-allow-methods'],'POST');assert.equal(r.headers.vary,'Origin');
  const invite=await call(h.base,'/zkapi/v1/sessions','OPTIONS',{...headers,'access-control-request-headers':'content-type, authorization, x-zkapi-admission'});
  assert.equal(invite.status,204);assert.ok(String(invite.headers['access-control-allow-headers']).includes('x-zkapi-admission'));
  assert.equal((await call(h.base,'/zkapi/v1/quotes','OPTIONS',{...headers,'access-control-request-headers':'x-zkapi-admission'})).status,400);
  assert.equal((await call(h.base,'/zkapi/v1/sessions','OPTIONS',{...headers,'x-zkapi-admission':Buffer.alloc(32,61).toString('base64url')})).status,400);
  assert.equal((await call(h.base,'/zkapi/v1/config','GET',{origin:browserOrigin,'sec-fetch-site':'cross-site'})).status,200);assert.equal(upstream,1);
  for(const extra of [{origin:'https://unreviewed.example.com'}, {'access-control-request-method':'DELETE'}, {'access-control-request-headers':'cookie'}, {authorization:'Bearer secret'}, {cookie:'private'}] as Record<string,string>[])
    assert.equal((await call(h.base,'/zkapi/v1/sessions','OPTIONS',{...headers,...extra})).status,400);
  assert.equal((await call(h.base,'/v1/chat/completions','OPTIONS',headers)).status,400);assert.equal(upstream,1);
  const status=await call(h.base,'/relay-status','GET',{origin:browserOrigin});
  assert.equal(status.status,200);assert.ok(!status.body.includes('TokenSha256'));assert.ok(!status.body.includes('x-zkapi-admission'));
});

test('native no-Origin transport is explicit and browser headers/cookies cannot impersonate it',async t=>{
  let forwards=0;const controlRelay=async()=>{forwards++;return{status:200,bytes:Buffer.from('{}')};};
  const enabled=await host(t,{controlRelay}),disabled=await host(t,{controlRelay,allowNativeRequests:false});
  assert.equal((await call(enabled.base,'/zkapi/v1/config')).status,200);
  for(const headers of [{'sec-fetch-mode':'cors'}, {'sec-fetch-site':'none'}, {cookie:'private'}, {'x-forwarded-host':new URL(publicOrigin).host}, {'x-api-key':'secret'}, {'proxy-authorization':'secret'}] as Record<string,string>[])
    assert.equal((await call(enabled.base,'/zkapi/v1/config','GET',headers)).status,400);
  assert.equal((await call(disabled.base,'/zkapi/v1/config')).status,400);assert.equal(forwards,1);
  assert.equal((await call(disabled.base,'/zkapi/v1/config','GET',{origin:browserOrigin})).status,200);
});

test('client abort cancels one bounded upstream forward without automatic retry',async t=>{
  let incoming=0;let received!:()=>void;const arrived=new Promise<void>(r=>{received=r;});
  const upstream=createServer((_req,_res)=>{incoming++;received();});
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>{upstream.closeAllConnections();return new Promise<void>(r=>upstream.close(()=>r()));});
  const address=upstream.address();assert.ok(address&&typeof address==='object');
  const controller=new AbortController(),forward=localForwarder();
  const pending=forward('http://127.0.0.1:'+address.port,'GET',undefined,{},1024,controller.signal);
  await arrived;controller.abort();await assert.rejects(pending,/configured upstream/);assert.equal(incoming,1);
});

async function supplementalFixture(t:TestContext,initialize=true){
  const f=await installedFixture(t);
  f.f.profile.modelCapabilities={...f.f.profile.modelCapabilities,'fixture-model':{streaming:true,tools:true}};
  await writeFile(f.config.profilePath,jcsBytes(f.f.profile));f.config.profileSha256=await f.f.profileSha256();
  const deployment={profile_sha256:f.config.profileSha256,manifest_sha256:f.f.manifest.manifest_hash,bundle_sha256:f.f.profile.bundle.sha256,
    sdk_sha256:'aa'.repeat(32),native_sha256:'bb'.repeat(32),tariff_sha256:f.f.profile.models[0].tariff.tariff_hash,
    mode:'direct_openrouter',provider:'openrouter',model:'fixture-model',cap_micro_usdc:'1000000',session_ttl_seconds:60,max_output_tokens:128};
  const script=`import sys,json
from pathlib import Path
sys.path.insert(0, 'scripts')
import provider_acceptance as old
import provider_supplemental_budget as s
from test_provider_acceptance import fixture
root=Path(sys.argv[1]).resolve()
plan=fixture(root);plan['max_requests']=18
old.atomic(root/'plan.json',old.canonical(plan))
state=root/'budget';old.Budget(state,plan).initialize();old.Budget(state,plan).reserve('plain')
a=s.prepare_proposal(state,plan,json.loads(sys.argv[2]));a['approval']={'approved':True,'reference':'SYNTHETIC UNIT TEST ONLY','date':'2026-10-07'}
raw=old.canonical(a);old.atomic(root/'authorization.json',raw)
budget=s.SupplementalBudget(state,plan,root/'authorization.json',old.sha(raw))
if sys.argv[3]=='yes': budget.initialize()
print(json.dumps({'stateDir':str(state),'planPath':str(root/'plan.json'),'authorizationPath':str(root/'authorization.json'),'authorizationSha256':old.sha(raw)}))`;
  const result=await promisify(execFile)('python3',['-c',script,f.directory,JSON.stringify(deployment),initialize?'yes':'no']);
  const budget:SupplementalGatewayBudget={kind:'supplemental-v1',...JSON.parse(result.stdout),sdkSha256:deployment.sdk_sha256,nativeSha256:deployment.native_sha256};
  f.config.budget=budget;f.config.allowNewAdmissions=true;f.config.admissionTokenSha256='dd'.repeat(32);
  const loaded=await loadGatewayPublicProfile(f.config);
  return{...f,loaded,budget};
}

test('supplemental gateway uses seven new slots only and retains exact AUTH recovery during suspension',async t=>{
  const f=await supplementalFixture(t), budget=await loadSupplementalGatewayBudget(f.config,f.loaded);
  const initial=await budget.status();assert.equal(initial.available_requests,7);assert.equal(initial.budget_micro_usdc,'17000000');
  const legacy=await readFile(join(f.budget.stateDir,'budget-state.json'));
  const id=randomUUID(),digest='cc'.repeat(32);
  await assert.rejects(budget.reserve(id,digest,false));assert.equal((await budget.status()).available_requests,7);
  await budget.reserve(id,digest);assert.equal((await budget.status()).available_requests,6);
  const suspended=await loadSupplementalGatewayBudget({...f.config,allowNewAdmissions:false},f.loaded);
  assert.equal((await suspended.status()).available_requests,0);
  await suspended.reserve(id,digest,false);
  await assert.rejects(suspended.reserve(randomUUID(),'ed'.repeat(32),false));
  await assert.rejects(budget.reserve(randomUUID(),digest));
  for(let i=0;i<6;i++)await budget.reserve(randomUUID(),i.toString(16).padStart(2,'0').repeat(32));
  const full=await budget.status();assert.equal(full.available_requests,0);assert.equal(full.remaining_micro_usdc,'9999997');
  await assert.rejects(budget.reserve(randomUUID(),'ef'.repeat(32)));
  assert.deepEqual(await readFile(join(f.budget.stateDir,'budget-state.json')),legacy);
});

test('supplemental gateway rejects uninitialized or substituted grant and mismatched release/deployment pins',async t=>{
  const absent=await supplementalFixture(t,false);
  await assert.rejects(loadSupplementalGatewayBudget(absent.config,absent.loaded));
  const f=await supplementalFixture(t);
  for(const changed of [{authorizationSha256:'00'.repeat(32)},{sdkSha256:'00'.repeat(32)},{nativeSha256:'00'.repeat(32)}])
    await assert.rejects(loadSupplementalGatewayBudget({...f.config,budget:{...f.budget,...changed}},f.loaded));
  const raw=JSON.parse(await readFile(f.budget.authorizationPath,'utf8'));
  raw.deployment.profile_sha256='ff'.repeat(32);
  await writeFile(f.budget.authorizationPath,JSON.stringify(raw),{mode:0o600});
  const digest=await sha256Hex(Buffer.from(JSON.stringify(raw)));
  await assert.rejects(loadSupplementalGatewayBudget({...f.config,budget:{...f.budget,authorizationSha256:digest}},f.loaded));
});

async function detachedFixture(t:TestContext){
  const f=await installedFixture(t);
  f.f.profile.modelCapabilities={...f.f.profile.modelCapabilities,'fixture-model':{streaming:true,tools:true}};
  await writeFile(f.config.profilePath,jcsBytes(f.f.profile));f.config.profileSha256=await f.f.profileSha256();
  // The Python suite checks real disposable ledgers. This fixture isolates the
  // gateway's command, status and receipt boundary without installing root files.
  const authorization={schema:2,kind:'detached_supplemental_grant',policy:'new_grant_only_no_original_capacity_transfer',deployment:{
    profile_sha256:f.config.profileSha256,manifest_sha256:f.f.manifest.manifest_hash,bundle_sha256:f.f.profile.bundle.sha256,
    sdk_sha256:'aa'.repeat(32),native_sha256:'bb'.repeat(32),tariff_sha256:f.f.profile.models[0].tariff.tariff_hash,
    mode:'direct_openrouter',provider:'openrouter',model:'fixture-model',cap_micro_usdc:'1000000',session_ttl_seconds:60,max_output_tokens:128}};
  const authorizationPath=join(f.directory,'detached-authorization.json'),raw=jcsBytes(authorization);
  await writeFile(authorizationPath,raw,{mode:0o600});
  const selection:DetachedGatewayBudget={kind:'supplemental-detached-v2',stateDir:join(f.directory,'new-authority'),
    historySnapshotPath:'/srv/zka/history/original-snapshot.json',authorizationPath,authorizationSha256:await sha256Hex(raw),
    sdkSha256:'aa'.repeat(32),nativeSha256:'bb'.repeat(32)};
  f.config.budget=selection;f.config.allowNewAdmissions=true;f.config.admissionTokenSha256='dd'.repeat(32);
  const loaded=await loadGatewayPublicProfile(f.config),rows=new Map<string,string>(),calls:string[][]=[];
  const status=()=>({schema:2,authorization_sha256:selection.authorizationSha256,budget_scope:'active_detached_grant',
    budget_micro_usdc:'7000000',reserved_micro_usdc:String(rows.size*1_000_000),remaining_micro_usdc:String((7-rows.size)*1_000_000),
    max_requests:7,reserved_requests:rows.size,remaining_requests:7-rows.size,supplemental_remaining_requests:7-rows.size,
    request_max_cost_micro_usdc:'1000000',historical_snapshot:{live:false,original_capacity_transferred_micro_usdc:'0'},
    refunds_supported:false,inference_replays_supported:false});
  const runner=(async(file:string,args:readonly string[])=>{
    assert.equal(file,'python3');assert.match(args[0],/\/provider_detached_budget\.py$/);
    assert.ok(['status','reserve'].includes(args[1]));assert.ok(!args.includes('--plan'));
    assert.equal(args[args.indexOf('--history-snapshot')+1],selection.historySnapshotPath);
    calls.push([...args]);
    if(args[1]==='status')return{stdout:JSON.stringify(status())};
    const id=args[args.indexOf('--request-id')+1],digest=args[args.indexOf('--auth-sha256')+1];
    if(rows.has(id))assert.equal(rows.get(id),digest);
    else{assert.ok(!args.includes('--no-new-reservations')&&rows.size<7);assert.ok(![...rows.values()].includes(digest));rows.set(id,digest);}
    return{stdout:JSON.stringify({schema:2,request_id:id,authorization_sha256:digest,grant_sha256:selection.authorizationSha256,
      reserved_micro_usdc:'1000000',reservation_source:'active_detached_grant',auth_forward_allowed:true,inference_replays_supported:false})};
  }) as Parameters<typeof loadSupplementalGatewayBudget>[2];
  return{...f,loaded,selection,authorization,status,runner,calls};
}

test('detached gateway selects only new authority commands and publishes active seven-cap status',async t=>{
  const f=await detachedFixture(t),budget=await loadSupplementalGatewayBudget(f.config,f.loaded,f.runner);
  const initial=await budget.status();assert.equal(initial.budget_micro_usdc,'7000000');assert.equal(initial.max_requests,7);
  assert.equal(initial.available_requests,7);assert.equal((initial as any).budget_scope,'active_detached_grant');
  assert.deepEqual((initial as any).historical_snapshot,{live:false,original_capacity_transferred_micro_usdc:'0'});
  const id=randomUUID(),digest='cc'.repeat(32);
  await assert.rejects(budget.reserve(id,digest,false));await budget.reserve(id,digest);
  const suspended=await loadSupplementalGatewayBudget({...f.config,allowNewAdmissions:false},f.loaded,f.runner);
  await suspended.reserve(id,digest,false);assert.equal((await suspended.status()).available_requests,0);
  await assert.rejects(suspended.reserve(randomUUID(),'ed'.repeat(32),false));
  assert.equal((await budget.status()).available_requests,6);
  assert.ok(f.calls.every(args=>!args.includes('initialize-approved')&&!args.includes('export-history')&&!args.includes('--plan')));
  for(const key of ['historySnapshotPath','stateDir','authorizationPath','request_id'])assert.ok(!JSON.stringify(initial).includes(key));
});

test('detached gateway rejects live aggregate, historical receipt and changed deployment pins',async t=>{
  const f=await detachedFixture(t);
  for(const changed of [{sdkSha256:'00'.repeat(32)},{nativeSha256:'00'.repeat(32)}])
    await assert.rejects(loadSupplementalGatewayBudget({...f.config,budget:{...f.selection,...changed}},f.loaded,f.runner));
  const invalid=(async()=>({stdout:JSON.stringify({...f.status(),budget_micro_usdc:'17000000',remaining_micro_usdc:'17000000'})})) as Parameters<typeof loadSupplementalGatewayBudget>[2];
  await assert.rejects(loadSupplementalGatewayBudget(f.config,f.loaded,invalid));
  const oldReceipt=(async(_file:string,args:readonly string[])=>({stdout:JSON.stringify(args[1]==='status'?f.status():{
    schema:2,request_id:'12345678-1234-4123-8123-123456789012',authorization_sha256:'ee'.repeat(32),grant_sha256:f.selection.authorizationSha256,
    reserved_micro_usdc:'1000000',reservation_source:'original',auth_forward_allowed:true,inference_replays_supported:false})})) as Parameters<typeof loadSupplementalGatewayBudget>[2];
  const budget=await loadSupplementalGatewayBudget(f.config,f.loaded,oldReceipt);
  await assert.rejects(budget.reserve('12345678-1234-4123-8123-123456789012','ee'.repeat(32)));
  await assert.rejects(loadGatewayPublicProfile({...f.config,budget:{...f.selection,planPath:'/legacy/plan.json'} as any}));
});
