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
import {loadGatewayPublicProfile,validateGatewayProfile,gatewayModelDiscovery,loadSupplementalGatewayBudget,type PublicDevnetGatewayConfig,type SupplementalGatewayBudget,type DetachedGatewayBudget} from './public_devnet_gateway.ts';
import {createPublicModelProfile} from './public_model_profile.ts';
import {startUiHost,type HostOptions} from './devnet-browser-relay/host.ts';
import {localForwarder} from './browser_chat_devnet_host.ts';
import {preflightPublicDeployment} from '../packages/sdk/src/public-profile.ts';
import {SolanaWalletChain} from '../packages/sdk/src/wallet-chain.ts';
import {createSolanaRpcWithFetch} from '../packages/sdk/src/solana.ts';
import {address,getAddressEncoder,getProgramDerivedAddress} from '@solana/kit';
import {u32} from '../packages/sdk/src/layout2.ts';

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

test('model expansion is independently pinned and does not replace the grant profile',async t=>{
  const {config,f,directory}=await installedFixture(t),loaded=await loadGatewayPublicProfile(config);
  const original=structuredClone(config);
  const expanded=createPublicModelProfile(f.profile,{data:[{id:'openai/gpt-5.6-sol',name:'GPT 5.6 Sol',architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:['tools']}]});
  const raw=jcsBytes(expanded),path=join(directory,'models.json');await writeFile(path,raw);
  config.modelProfile={url:publicOrigin+'/releases/models.json',path,sha256:await sha256Hex(raw)};
  const found=await gatewayModelDiscovery(config,loaded);
  assert.deepEqual(found.models.map(m=>m.id),['openai/gpt-5.6-sol']);
  assert.equal(found.profileSha256,config.modelProfile.sha256);
  assert.equal(config.profileSha256,original.profileSha256);assert.deepEqual(config.budget,original.budget);
  assert.equal(validateGatewayProfile(config,loaded).model.id,f.profile.models[0].id);
  await assert.rejects(gatewayModelDiscovery({...config,modelProfile:{...config.modelProfile,sha256:'0'.repeat(64)}},loaded));
  expanded.models[0].id='openai/gpt-5.5';const bad=jcsBytes(expanded);await writeFile(path,bad);
  await assert.rejects(gatewayModelDiscovery({...config,modelProfile:{...config.modelProfile,sha256:await sha256Hex(bad)}},loaded));
});

test('public model and profile discovery support CORS without forwarding or financial activity',async t=>{
  let forwarded=0;
  const discovery={profileUrl:publicOrigin+'/releases/models.json',profileSha256:'a'.repeat(64),models:[{id:'anthropic/claude-opus-5',label:'Claude Opus 5',capabilities:{streaming:true,tools:true}}]};
  const h=await host(t,{allowedBrowserOrigins:['*'],modelDiscovery:discovery,controlRelay:async()=>{forwarded++;throw Error('unexpected forward');}});
  const models=await call(h.base,'/zkapi/v1/models','GET',{origin:'http://localhost:5173'});
  assert.equal(models.status,200);assert.equal(models.headers['access-control-allow-origin'],'*');assert.deepEqual(JSON.parse(models.body).data,[{id:'anthropic/claude-opus-5',object:'model',owned_by:'anthropic'}]);
  const profile=await call(h.base,'/zkapi/v1/client-profile');assert.equal(profile.status,200);assert.equal(JSON.parse(profile.body).profileSha256,discovery.profileSha256);
  for(const path of ['/zkapi/v1/models','/zkapi/v1/client-profile']){
    assert.equal((await call(h.base,path,'OPTIONS',{origin:'https://example.com','access-control-request-method':'GET'})).status,204);
    assert.equal((await call(h.base,path,'POST',{'content-type':'application/json'},'{}')).status,400);
    assert.equal((await call(h.base,path,'GET',{authorization:'Bearer secret'})).status,400);
    assert.equal((await call(h.base,path+'?extra=1')).status,400);
  }
  assert.equal(forwarded,0);
});

test('gateway refuses altered bundle and origin/model modes before opening budget or listener',async t=>{
  const{config}=await installedFixture(t);await writeFile(config.bundleDescriptorPath,'{}');
  await assert.rejects(loadGatewayPublicProfile(config));
  await assert.rejects(loadGatewayPublicProfile({...config,allowedBrowserOrigins:['*',browserOrigin]}));
  await assert.rejects(loadGatewayPublicProfile({...config,allowNewAdmissions:true}),/invitation digest/);
});

test('invitation-free gateway configuration requires an explicit boolean opt-out and retains all profile pins',async t=>{
  const {config}=await installedFixture(t);
  const open={...config,allowNewAdmissions:true,requireInvitation:false};
  const loaded=await loadGatewayPublicProfile(open);
  assert.equal(validateGatewayProfile(open,loaded).manifest.control_api_origin,publicOrigin);
  await assert.rejects(loadGatewayPublicProfile({...config,allowNewAdmissions:true}),/invitation digest/);
  await assert.rejects(loadGatewayPublicProfile({...open,requireInvitation:'false'} as any));
  await assert.rejects(loadGatewayPublicProfile({...open,admissionTokenSha256:'invalid'}));
  await assert.rejects(loadGatewayPublicProfile({...open,profileSha256:'00'.repeat(32)}));
});

test('public CORS opt-in accepts only a lone wildcard and preserves exact origin configuration',async t=>{
  const {config}=await installedFixture(t);
  await loadGatewayPublicProfile({...config,allowedBrowserOrigins:['*']});
  await loadGatewayPublicProfile({...config,allowedBrowserOrigins:[]});
  for(const origins of [['*',browserOrigin],['*','*'],['http://localhost:5173'],['null'],[browserOrigin+'/'],[browserOrigin,browserOrigin]]) {
    await assert.rejects(loadGatewayPublicProfile({...config,allowedBrowserOrigins:origins}));
    await assert.rejects(host(t,{allowedBrowserOrigins:origins}));
  }
});

test('wildcard CORS permits independent HTTPS, localhost and opaque origins without ambient credentials',async t=>{
  let forwards=0;
  const h=await host(t,{allowedBrowserOrigins:['*'],allowNativeRequests:false,
    controlRelay:async()=>{forwards++;return{status:200,bytes:Buffer.from('{}')};}});
  for(const origin of ['https://unregistered-app.example.com','http://localhost:5173','http://127.0.0.1:3000','http://[::1]:8080','null']){
    for(const [path,method] of [['/zkapi/v1/config','GET'],['/zkapi/v1/tree/snapshot','GET'],['/zkapi/v1/tree/notes/0/zero-path','GET'],['/rpc','POST'],['/zkapi/v1/quotes','POST'],['/zkapi/v1/sessions','POST']]){
      const preflight=await call(h.base,path,'OPTIONS',{origin,'access-control-request-method':method,
        'access-control-request-headers':path==='/zkapi/v1/sessions'?'Authorization, Content-Type, X-Zkapi-Admission':'Content-Type'});
      assert.equal(preflight.status,204);
      assert.equal(preflight.headers['access-control-allow-origin'],'*');
      assert.equal(preflight.headers['access-control-allow-methods'],method);
      assert.equal(preflight.headers['access-control-allow-credentials'],undefined);
    }
    const before=forwards;
    const response=await call(h.base,'/zkapi/v1/config','GET',{origin,'sec-fetch-site':'cross-site'});
    assert.equal(response.status,200);assert.equal(forwards,before+1);
    assert.equal(response.headers['access-control-allow-origin'],'*');
    assert.equal(response.headers['access-control-allow-credentials'],undefined);
    assert.equal(response.headers['access-control-expose-headers'],'x-zkapi-error-code');
    const error=await call(h.base,'/not-an-api-route','GET',{origin});
    assert.equal(error.status,400);assert.equal(error.headers['access-control-allow-origin'],'*');
    for(const headers of [{cookie:'ambient=private'},{'proxy-authorization':'secret'},{'x-api-key':'secret'}])
      assert.equal((await call(h.base,'/zkapi/v1/config','GET',{origin,...headers})).status,400);
    assert.equal(forwards,before+1);
  }
  assert.equal(forwards,5);
  assert.equal((await call(h.base,'/zkapi/v1/config')).status,400);
  assert.equal((await call(h.base,'/zkapi/v1/config','GET',{'sec-fetch-site':'same-origin','sec-fetch-mode':'cors'})).status,200);
});

test('wildcard CORS retains preflight route/header guards and invitation authorization',async t=>{
  let authForwarded=false;
  const h=await host(t,{allowedBrowserOrigins:['*'],allowNewAdmissions:true,admissionTokenSha256:'aa'.repeat(32),
    controlRelay:async input=>{assert.equal(input.newAdmissionAuthorized,false);authForwarded=true;return{status:403,bytes:Buffer.from('{}')};}});
  const origin='http://localhost:5173',headers={origin,'access-control-request-method':'POST'};
  for(const extra of [{'access-control-request-method':'DELETE'},{'access-control-request-headers':'cookie'},
    {'access-control-request-headers':'authorization, authorization'},{authorization:'Bearer private'}])
    assert.equal((await call(h.base,'/zkapi/v1/sessions','OPTIONS',{...headers,...extra})).status,400);
  assert.equal(authForwarded,false);
  const denied=await call(h.base,'/zkapi/v1/sessions','POST',{origin,'content-type':'application/json'},'{}');
  assert.equal(denied.status,403);assert.equal(denied.headers['access-control-allow-origin'],'*');assert.equal(authForwarded,true);
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

test('native SDK preflight uses actual Node fetch with its lone cors metadata and no browser Origin',async t=>{
  const {config,f}=await installedFixture(t),loaded=await loadGatewayPublicProfile(config);
  const upstream=async(url:string,method='GET',body?:string)=>{
    const response=await f.fetcher(url,{method,body,credentials:'omit',redirect:'error'});
    return{status:response.status,bytes:Buffer.from(await response.arrayBuffer())};
  };
  const h=await host(t,{manifest:loaded.assets.verifiedManifest,
    controlRelay:async v=>{assert.equal(v.method,'GET');return upstream(publicOrigin+v.path);},
    indexer:async path=>upstream(publicOrigin+path),rpc:async bytes=>upstream(publicOrigin+'/rpc','POST',bytes.toString())});
  let observed=0;
  h.server.on('request',request=>{
    observed++;
    assert.equal(request.headers.origin,undefined);
    assert.deepEqual(Object.keys(request.headers).filter(name=>name.startsWith('sec-fetch-')),['sec-fetch-mode']);
    assert.equal(request.headers['sec-fetch-mode'],'cors');
  });
  // Real deployments rewrite Host at the trusted local reverse proxy. Node
  // fetch derives Host from its URL, so a Headers override is not a faithful
  // fixture. Forward the actual fetch headers/body unchanged except for Host.
  const ingress=createServer((incoming,outgoing)=>{
    const forward=request(h.base+incoming.url,{method:incoming.method,headers:{...incoming.headers,host:new URL(publicOrigin).host}},upstream=>{
      outgoing.writeHead(upstream.statusCode!,upstream.headers);upstream.pipe(outgoing);
    });
    forward.on('error',()=>{outgoing.writeHead(502);outgoing.end();});incoming.pipe(forward);
  });
  await new Promise<void>(resolve=>ingress.listen(0,'127.0.0.1',resolve));
  t.after(()=>{ingress.closeAllConnections();return new Promise<void>(resolve=>ingress.close(()=>resolve()));});
  const ingressAddress=ingress.address();assert.ok(ingressAddress&&typeof ingressAddress==='object');
  const nativeFetch:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,publicOrigin);
    const response=await fetch('http://127.0.0.1:'+ingressAddress.port+url.pathname+url.search,init);
    assert.equal(response.headers.get('access-control-allow-origin'),null);
    return response;
  };
  const result=await preflightPublicDeployment(loaded,{fetch:nativeFetch,nowSeconds:2600n});
  assert.equal(result.chainAllowsNewOperations,true);assert.equal(result.operatorAdmission,'unverified');assert.ok(observed>0);
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
  for(const path of ['/','/app.js','/control/zkapi/v1/config','/indexer/zkapi/v1/tree/root','/v1/chat/completions','/zkapi/v1/config?destination=evil','/zkapi/v1/%63onfig'])assert.equal((await call(h.base,path)).status,400);
  assert.equal(control.length,3);assert.equal(indexer.length,3);
});

test('canonical wallet paths forward only exact u32 GET routes with existing origin and credential guards',async t=>{
  const forwarded:string[]=[];
  const h=await host(t,{indexer:async path=>{forwarded.push(path);return{status:200,bytes:Buffer.from(JSON.stringify({path}))};}});
  for(const id of ['0','7','4294967295'])for(const kind of ['path','zero-path']){
    const path=`/zkapi/v1/tree/notes/${id}/${kind}`;
    const r=await call(h.base,path,'GET',{'sec-fetch-mode':'cors'});
    assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.body),{path});assert.equal(forwarded.at(-1),path);
  }
  const path='/zkapi/v1/tree/notes/0/zero-path',count=forwarded.length;
  for(const bad of ['-1','+1','01','4294967296','99999999999','1.0','1e1','%30'])
    assert.equal((await call(h.base,`/zkapi/v1/tree/notes/${bad}/zero-path`)).status,400);
  for(const bad of [path+'?x=1',path+'/',path+'/other',path.replace('zero-path','ZERO-PATH'),'/indexer'+path])
    assert.equal((await call(h.base,bad)).status,400);
  for(const headers of [{authorization:'Bearer private'},{cookie:'private'},{'x-zkapi-admission':'A'.repeat(43)},{origin:'https://unreviewed.example.com'}])
    assert.equal((await call(h.base,path,'GET',headers)).status,400);
  assert.equal((await call(h.base,path,'POST')).status,400);
  const cors=await call(h.base,path,'OPTIONS',{origin:browserOrigin,'access-control-request-method':'GET'});
  assert.equal(cors.status,204);assert.equal(cors.headers['access-control-allow-origin'],browserOrigin);
  assert.equal(cors.headers['access-control-allow-credentials'],undefined);assert.equal(forwarded.length,count);
  assert.equal((await call(h.base,path,'GET',{origin:browserOrigin})).status,200);
  assert.equal(forwarded.length,count+1);
});

test('SDK wallet deposit snapshot authenticates canonical zero path through public gateway before any financial action',async t=>{
  const {config,f}=await installedFixture(t),loaded=await loadGatewayPublicProfile(config);
  const indexerCalls:string[]=[],rpcCalls:string[]=[];
  const pool=address(f.manifest.pool),program=address(f.manifest.program_id);
  const derive=(name:string,suffix?:Uint8Array)=>getProgramDerivedAddress({programAddress:program,
    seeds:[Buffer.from(name),getAddressEncoder().encode(pool),...(suffix?[suffix]:[])]});
  const [[tree],[note],[pending]]=await Promise.all([derive('tree'),derive('note',u32(0)),derive('pending',u32(0))]);
  const account=(bytes:Uint8Array,owner:string=program)=>({owner,executable:false,lamports:1,rentEpoch:0,data:[Buffer.from(bytes).toString('base64'),'base64']});
  const h=await host(t,{manifest:loaded.assets.verifiedManifest,
    indexer:async path=>{
      indexerCalls.push(path);assert.ok(['/zkapi/v1/tree/root','/zkapi/v1/tree/notes/0/zero-path'].includes(path));
      const value=path.endsWith('/root')?f.snapshot.snapshot:{snapshot:f.snapshot.snapshot,note_id:'0',leaf:'0x'+'00'.repeat(32),siblings:Array(32).fill('0x'+'00'.repeat(32))};
      return{status:200,bytes:Buffer.from(JSON.stringify(value))};
    },rpc:async bytes=>{
      const request=JSON.parse(bytes.toString());rpcCalls.push(request.method);
      assert.ok(['getGenesisHash','getBlock','getMultipleAccounts'].includes(request.method));
      if(request.method==='getMultipleAccounts'){
        assert.deepEqual(request.params[0],[pool,tree,note,pending,'SysvarC1ock11111111111111111111111111111111']);
        assert.equal(request.params[1].commitment,'finalized');
        return{status:200,bytes:Buffer.from(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{context:{slot:f.state.slot},value:[
          account(f.poolData),account(f.treeData),null,null,account(f.clock,'Sysvar1111111111111111111111111111111111111')]}}))};
      }
      const response=await f.fetcher(publicOrigin+'/rpc',{method:'POST',body:bytes.toString(),credentials:'omit',redirect:'error'});
      return{status:response.status,bytes:Buffer.from(await response.arrayBuffer())};
    }});
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,publicOrigin);
    const result=await call(h.base,url.pathname,init?.method??'GET',{'sec-fetch-mode':'cors',...(init?.body?{'content-type':'application/json'}:{})},init?.body?String(init.body):undefined);
    return new Response(result.body,{status:result.status});
  };
  const chain=new SolanaWalletChain(createSolanaRpcWithFetch(publicOrigin+'/rpc',fetcher),loaded.assets.verifiedManifest,publicOrigin,{fetch:fetcher});
  const snapshot=await chain.snapshot();
  assert.deepEqual(indexerCalls,['/zkapi/v1/tree/root','/zkapi/v1/tree/notes/0/zero-path']);
  assert.equal(snapshot.nextNoteId,0);assert.equal(snapshot.slot,f.state.slot);assert.equal(snapshot.paused,false);
  assert.equal(snapshot.siblings.length,32);assert.equal(snapshot.note,undefined);
  assert.equal(rpcCalls.filter(v=>v==='getMultipleAccounts').length,1);
  assert.equal(rpcCalls.filter(v=>v==='getBlock').length,2);
});

test('invitation-free status exposes the selected access policy without loading budget or sending AUTH',async t=>{
  const h=await host(t,{allowNewAdmissions:true,requireInvitation:false});
  const status=await call(h.base,'/relay-status');
  assert.equal(status.status,200);
  assert.equal(JSON.parse(status.body).invitation_required,false);
  assert.equal(JSON.parse(status.body).admission,'enabled');
  assert.equal(JSON.parse(status.body).recovery,'enabled');
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
  assert.equal((await call(enabled.base,'/zkapi/v1/config','GET',{'sec-fetch-mode':'cors'})).status,200);
  for(const headers of [
    {'sec-fetch-mode':'no-cors'}, {'sec-fetch-mode':'same-origin'}, {'sec-fetch-mode':'navigate'}, {'sec-fetch-mode':'cors, cors'},
    {'sec-fetch-site':'none'}, {'sec-fetch-site':'cross-site','sec-fetch-mode':'cors'},
    {'sec-fetch-site':'same-site','sec-fetch-mode':'cors'}, {'sec-fetch-site':'same-origin','sec-fetch-mode':'cors'},
    {'sec-fetch-dest':'empty','sec-fetch-mode':'cors'}, {'sec-fetch-user':'?1','sec-fetch-mode':'cors'},
    {'sec-fetch-unknown':'fixture','sec-fetch-mode':'cors'},
    {cookie:'private'}, {'x-forwarded-host':new URL(publicOrigin).host}, {'x-api-key':'secret'}, {'proxy-authorization':'secret'}
  ] as Record<string,string>[])
    assert.equal((await call(enabled.base,'/zkapi/v1/config','GET',headers)).status,400);
  assert.equal((await call(disabled.base,'/zkapi/v1/config')).status,400);
  assert.equal((await call(disabled.base,'/zkapi/v1/config','GET',{'sec-fetch-mode':'cors'})).status,400);
  assert.equal((await call(enabled.base,'/zkapi/v1/config','GET',{origin:'https://unreviewed.example.com','sec-fetch-mode':'cors'})).status,400);
  assert.equal(forwards,2);
  assert.equal((await call(disabled.base,'/zkapi/v1/config','GET',{origin:browserOrigin})).status,200);
});

test('same-origin browser metadata retains its reviewed-origin branch with native transport disabled',async t=>{
  let forwards=0;
  const h=await host(t,{allowedBrowserOrigins:[publicOrigin],allowNativeRequests:false,
    controlRelay:async()=>{forwards++;return{status:200,bytes:Buffer.from('{}')};}});
  assert.equal((await call(h.base,'/zkapi/v1/config','GET',{'sec-fetch-site':'same-origin','sec-fetch-mode':'cors','sec-fetch-dest':'empty'})).status,200);
  assert.equal((await call(h.base,'/zkapi/v1/config','GET',{'sec-fetch-mode':'cors'})).status,400);
  assert.equal((await call(h.base,'/zkapi/v1/config','GET',{'sec-fetch-site':'cross-site','sec-fetch-mode':'cors','sec-fetch-dest':'empty'})).status,400);
  assert.equal(forwards,1);
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

test('readiness is a credential-free exact GET with reviewed CORS and leaves relay configuration scope unchanged',async t=>{
  let samples=0,other=0;
  const h=await host(t,{readiness:async signal=>{assert.ok(signal);samples++;return{status:503,bytes:Buffer.from('{"scope":"read_only_capabilities","signer":"unavailable"}')};},
    controlRelay:async()=>{other++;throw Error('must not forward');},rpc:async()=>{other++;throw Error('must not forward');}});
  for(const path of ['/zkapi/v1/readiness?x=1','/zkapi/v1/readiness/','/readiness'])assert.equal((await call(h.base,path)).status,400);
  for(const headers of [{authorization:'Bearer private'},{cookie:'private'},{'x-zkapi-admission':'A'.repeat(43)},
    {'x-api-key':'private'},{origin:'https://unreviewed.example.com'}])assert.equal((await call(h.base,'/zkapi/v1/readiness','GET',headers)).status,400);
  assert.equal((await call(h.base,'/zkapi/v1/readiness','POST')).status,400);
  assert.equal((await call(h.base,'/zkapi/v1/readiness','GET',{'content-length':'1'},'x')).status,400);
  assert.equal(samples,0);assert.equal(other,0);
  const preflight=await call(h.base,'/zkapi/v1/readiness','OPTIONS',{origin:browserOrigin,'access-control-request-method':'GET'});
  assert.equal(preflight.status,204);assert.equal(preflight.headers['access-control-allow-origin'],browserOrigin);
  assert.equal(preflight.headers['access-control-allow-credentials'],undefined);assert.equal(samples,0);
  for(const headers of [{origin:browserOrigin},{'sec-fetch-mode':'cors'}]){
    const result=await call(h.base,'/zkapi/v1/readiness','GET',headers);assert.equal(result.status,503);assert.equal(JSON.parse(result.body).signer,'unavailable');
    assert.equal(result.headers['cache-control'],'no-store');
  }
  assert.equal(samples,2);assert.equal(other,0);
  const status=JSON.parse((await call(h.base,'/relay-status')).body);
  assert.equal(status.scope,'relay_configuration_only');assert.equal(status.readiness,'not_checked');assert.equal(status.signer,'not_checked');assert.equal(samples,2);
});
