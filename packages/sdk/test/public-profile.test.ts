import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicDeploymentProfile, preflightPublicDeployment, publicProfileClientOptions, PublicProfileError, PUBLIC_PROFILE_SDK_VERSION } from '../src/public-profile.ts';
import { jcsBytes, sha256Hex } from '../src/trust.ts';
import { publicProfileFixture } from './public-profile-fixture.ts';
import { gatewayPublicProfileFixture } from './gateway-public-profile-fixture.ts';
import { API_ONBOARDING_DECLARATION } from './api-onboarding-fixture.ts';

const component=(name:string)=>(e:unknown)=>e instanceof PublicProfileError && e.component===name;
const legacyVersions=['0.2.0-devnet.8','0.2.0-devnet.9','0.2.0-devnet.10','0.2.0-devnet.11','0.2.0-devnet.12'];
test('legacy inference SDK profile compatibility preserves exact authenticated bytes and installed hash pins',async()=>{
  for(const version of [...legacyVersions,PUBLIC_PROFILE_SDK_VERSION]){
    const f=await publicProfileFixture();f.profile.sdkVersions=[version];
    const original=jcsBytes(f.profile),pin=await f.profileSha256();
    const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:pin,installedProfileSha256:pin,fetch:f.fetcher});
    assert.equal(loaded.profile.schema,1);assert.equal(loaded.profileSha256,pin);
    assert.deepEqual(jcsBytes(loaded.profile),original);assert.deepEqual(jcsBytes(f.profile),original);
    assert.deepEqual(loaded.profile.sdkVersions,[version]);
    assert.deepEqual(publicProfileClientOptions(loaded).deployment.manifest,f.state.controlManifest);
    assert(f.calls.every(call=>call.method==='GET'));assert(!f.calls.some(call=>/quotes|sessions|notes/.test(call.url)));
  }
});
test('recovery update preserves .13/.14 profiles and exact pins across all supported schemas',async()=>{
  for(const version of ['0.2.0-devnet.13','0.2.0-devnet.14'])for(const schema of [1,2,3]){
    const f=schema===3?await gatewayPublicProfileFixture():schema===2?await publicProfileFixture({schema:2,selection:'api'}):await publicProfileFixture();
    f.profile.sdkVersions=[version];
    const original=jcsBytes(f.profile),pin=await f.profileSha256();
    const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:pin,installedProfileSha256:pin,fetch:f.fetcher});
    assert.equal(loaded.profile.schema,schema);assert.equal(loaded.profileSha256,pin);
    assert.deepEqual(jcsBytes(loaded.profile),original);assert.deepEqual(jcsBytes(f.profile),original);
    assert(f.calls.every(call=>call.method==='GET'));assert(!f.calls.some(call=>/quotes|sessions|notes/.test(call.url)));
    await assert.rejects(loadPublicDeploymentProfile(f.profileUrl,{profileSha256:pin,installedProfileSha256:'00'.repeat(32),fetch:f.fetcher}),component('profile'));
  }
});
test('API profile schemas require explicit compatible SDK membership before fetching assets',async()=>{
  for(const version of [...legacyVersions,'0.2.0-devnet.9-onboarding.0'])for(const schema of [2,3]){
    const f=schema===3?await gatewayPublicProfileFixture():await publicProfileFixture({schema:2,selection:'api'});
    f.profile.sdkVersions=[version];
    await assert.rejects(loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher}),component('compatibility'));
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,f.profileUrl);
  }
  const f=await gatewayPublicProfileFixture();f.profile.sdkVersions=['0.2.0-devnet.12',PUBLIC_PROFILE_SDK_VERSION];
  const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
  assert.equal(loaded.profile.schema,3);assert.deepEqual(publicProfileClientOptions(loaded).gateway,f.profile.gateway);
});
test('one pinned public profile loads all assets and preflights without custody, quotes, AUTH, inference or selected-note reads',async()=>{
  const f=await publicProfileFixture();
  const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
  const checked=await preflightPublicDeployment(loaded,{nowSeconds:2600n});
  assert.equal(checked.chainAllowsNewOperations,true);assert.equal(checked.snapshot.activeCount,0);assert.equal(checked.slot,'110');
  assert.equal(checked.manifestHash,f.manifest.manifest_hash);
  assert(f.calls.every(c=>c.method==='GET'||['getGenesisHash','getAccountInfo','getBlock','getMultipleAccounts'].includes(c.rpc??'')));
  assert(!f.calls.some(c=>/quotes|sessions|notes|chat|completions|provider\.example/.test(c.url)));
  const options=publicProfileClientOptions(loaded);
  assert.equal(options.mode,'direct_openrouter');assert.deepEqual(options.models[0].capabilities,{streaming:true,tools:false});
  assert.equal(options.deployment.indexerOrigin,f.profile.indexerOrigin);
});
test('independent profile hash and retained installation pin fail before following downloaded inputs',async()=>{
  const f=await publicProfileFixture(),pin=await f.profileSha256();
  await assert.rejects(loadPublicDeploymentProfile(f.profileUrl,{profileSha256:pin,installedProfileSha256:'00'.repeat(32),fetch:f.fetcher}),component('profile'));
  assert.equal(f.calls.length,0);
  await assert.rejects(loadPublicDeploymentProfile(f.profileUrl,{profileSha256:'00'.repeat(32),fetch:f.fetcher}),component('profile'));
  assert.equal(f.calls.length,1);
});
test('profile compatibility, public URLs, modes, capabilities and closed fields fail before asset fetch',async()=>{
  const changes:((p:any)=>void)[]=[p=>{p.sdkVersions=['0.1.0-devnet.1'];},p=>{p.sdkVersions=['0.2.0-devnet.2'];},p=>{p.protocolLayoutVersion=3;},p=>{p.schema=2;},
    p=>{p.surprise='secret';},p=>{p.rpcUrl='https://rpc.example.com/?key=SECRET';},p=>{p.rpcUrl='https://127.0.0.1/';},
    p=>{p.indexerOrigin='http://indexer.example.com';},p=>{p.bundle.url='https://user:SECRET@assets.example.com/bundle.json';},
    p=>{p.models[0].apis=['messages'];},p=>{p.models[0].apis=['chat','chat'];},p=>{p.mode='proxy';},
    p=>{p.modelCapabilities={};},p=>{p.modelCapabilities['fixture-model'].tools='true';},p=>{p.models[0].tariff.rates=[{unit:'input_tokens',nano_usdc_numerator:'1',unit_denominator:'0'}];}];
  for(const change of changes){const f=await publicProfileFixture();change(f.profile);
    await assert.rejects(loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher}),PublicProfileError);assert.equal(f.calls.length,1);}
});
test('manifest/artifact/WASM and model tariff mismatches are rejected before financial or chain operations',async()=>{
  for(const change of [
    (f:Awaited<ReturnType<typeof publicProfileFixture>>)=>{f.profile.bundle.sha256='00'.repeat(32);},
    (f:Awaited<ReturnType<typeof publicProfileFixture>>)=>{f.files.set('https://assets.example.com/prover.wasm',new Uint8Array([1]));},
    (f:Awaited<ReturnType<typeof publicProfileFixture>>)=>{f.files.set('https://assets.example.com/requestVk.bin',new Uint8Array([1]));},
    (f:Awaited<ReturnType<typeof publicProfileFixture>>)=>{f.profile.models[0].tariff.valid_until='9000000000';},
  ]){const f=await publicProfileFixture();change(f);await assert.rejects(loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher}),PublicProfileError);assert(f.calls.every(c=>c.method==='GET'));}
});
test('preflight names failing RPC, Pool, control, catalog, stale-clock and snapshot components without private errors',async()=>{
  const changes:[string,(f:Awaited<ReturnType<typeof publicProfileFixture>>)=>void][]=[
    ['rpc',f=>{f.state.genesis=f.manifest.program_id;}],['pool',f=>{f.poolData[42]^=1;}],
    ['control',f=>{f.state.controlManifest=jcsBytes({private:'SECRET'});}],['catalog',f=>{f.state.catalogAvailable=false;}],
    ['snapshot',f=>{f.clock.writeBigInt64LE(0n,32);}],['snapshot',f=>{f.state.snapshotDigestValid=false;}],
    ['snapshot',f=>{f.treeData[10]=1;}],
  ];
  for(const [expected,change] of changes){const f=await publicProfileFixture();const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});change(f);
    await assert.rejects(preflightPublicDeployment(loaded,{nowSeconds:2600n}),e=>component(expected)(e)&&!(e as Error).message.includes('SECRET'));}
});
test('paused deployment retains read-only diagnosis and never reports admission ready',async()=>{
  const f=await publicProfileFixture();f.poolData[355]=1;
  const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
  const r=await preflightPublicDeployment(loaded,{nowSeconds:2600n});assert.equal(r.paused,true);assert.equal(r.chainAllowsNewOperations,false);
});
test('authenticated configuration and byte getters cannot be rebound by caller mutation',async()=>{
  const f=await publicProfileFixture();const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
  assert.throws(()=>{loaded.profile.rpcUrl='https://evil.example.com/';});
  loaded.assets.manifest.fill(0);loaded.assets.wasm.fill(0);loaded.assets.artifacts.idl.fill(0);
  const options=publicProfileClientOptions(loaded);options.models[0].capabilities!.tools=true;options.deployment.manifest.fill(0);
  assert.equal(publicProfileClientOptions(loaded).models[0].capabilities!.tools,false);
  assert.equal((await preflightPublicDeployment(loaded,{nowSeconds:2600n})).chainAllowsNewOperations,true);
  await assert.rejects(preflightPublicDeployment({...loaded},{nowSeconds:2600n}),component('profile'));
});
test('authenticated schema-2 notices remain detached across asset getters',async()=>{
  const f=await publicProfileFixture(),notice=new TextEncoder().encode('Synthetic upstream notice\n');
  const descriptor={...f.descriptor,schema:2,notices:{'NOTICE.txt':'upstream-notice.txt'},files:{...f.descriptor.files,
    'upstream-notice.txt':{sha256:await sha256Hex(notice),bytes:notice.length}}};
  const bytes=jcsBytes(descriptor);f.files.set('https://assets.example.com/upstream-notice.txt',notice);
  f.files.set(f.profile.bundle.url,bytes);f.profile.bundle.sha256=await sha256Hex(bytes);
  const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
  const exposed=loaded.assets.notices;assert.deepEqual(exposed['NOTICE.txt'],notice);
  exposed['NOTICE.txt'].fill(0);delete exposed['NOTICE.txt'];exposed['unexpected.txt']=new Uint8Array([0]);
  assert.deepEqual(Object.keys(loaded.assets.notices),['NOTICE.txt']);
  assert.deepEqual(loaded.assets.notices['NOTICE.txt'],notice);
  assert.equal((await preflightPublicDeployment(loaded,{nowSeconds:2600n})).chainAllowsNewOperations,true);
});
test('load and preflight deadlines bound custom fetch and body implementations without retries',async()=>{
  let calls=0;
  await assert.rejects(loadPublicDeploymentProfile('https://profiles.example.com/p.json',{profileSha256:'00'.repeat(32),timeoutMs:15,fetch:async()=>{calls++;return new Promise(()=>{});}}),component('profile'));
  assert.equal(calls,1);
  let canceled=false;
  await assert.rejects(loadPublicDeploymentProfile('https://profiles.example.com/p.json',{profileSha256:'00'.repeat(32),timeoutMs:15,fetch:async()=>new Response(new ReadableStream({cancel(){canceled=true;return new Promise(()=>{});}}))}),component('profile'));
  assert.equal(canceled,true);
  const f=await publicProfileFixture(),loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});calls=0;
  await assert.rejects(preflightPublicDeployment(loaded,{nowSeconds:2600n,timeoutMs:15,fetch:async()=>{calls++;return new Promise(()=>{});}}),component('rpc'));
  assert.equal(calls,1);
});
test('duplicate JSON fields are rejected even if exact malicious bytes are pinned',async()=>{
  const raw=new TextEncoder().encode('{"schema":1,"schema":1}');
  await assert.rejects(loadPublicDeploymentProfile('https://profiles.example.com/p.json',{profileSha256:await sha256Hex(raw),fetch:async()=>new Response(raw)}),component('profile'));
});

test('schema 2 API-only, mixed and inference selections preserve exact schema and preflight using fixture reads only',async()=>{
  for (const selection of ['api','mixed','inference'] as const) {
    const f=await publicProfileFixture({schema:2,selection});
    const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
    assert.equal(loaded.profile.schema,2);
    const options=publicProfileClientOptions(loaded), result=await preflightPublicDeployment(loaded,{nowSeconds:2600n});
    assert.equal(options.services!.length,selection==='inference'?0:1);
    assert.equal(result.models.length,selection==='api'?0:1);assert.equal(result.apis.length,selection==='inference'?0:1);
    if(result.apis.length)assert.equal(result.apis[0].endpoint,'/zkapi/v1/api/weather/lookup0');
    assert(f.calls.every(c=>c.method==='GET'||['getGenesisHash','getAccountInfo','getBlock','getMultipleAccounts'].includes(c.rpc??'')));
    assert(!f.calls.some(c=>/quotes|sessions|notes|chat|completions|weather\.example/.test(c.url)));
    assert.equal(options.deployment.indexerOrigin,'https://indexer.example.com');
    assert.equal(f.manifest.inference_api_origin,'https://inference.example.com');
  }
});

test('public API-only onboarding uses the local lifecycle service and price declaration through injected HTTPS reads',async()=>{
  const declaration=API_ONBOARDING_DECLARATION;
  const f=await publicProfileFixture({schema:2,selection:'api',apiDeclaration:declaration});
  const pin=await f.profileSha256();
  const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:pin,fetch:f.fetcher});
  const options=publicProfileClientOptions(loaded),checked=await preflightPublicDeployment(loaded,{nowSeconds:2600n});
  assert.equal(loaded.profileSha256,pin);assert.equal(options.mode,'proxy');assert.deepEqual(options.models,[]);
  assert.equal(options.services!.length,1);
  const tariff=options.services![0].tariff;
  assert.deepEqual(tariff.api,declaration.api);assert.equal(tariff.valid_from,declaration.validFrom);assert.equal(tariff.valid_until,declaration.validUntil);
  assert.deepEqual(tariff.rates,[{unit:'requests',nano_usdc_numerator:(BigInt(declaration.priceMicroUsdc)*1000n).toString(),unit_denominator:'1'}]);
  assert.equal(checked.chainAllowsNewOperations,true);assert.deepEqual(checked.models,[]);assert.equal(checked.apis.length,1);
  assert.deepEqual(checked.apis[0],{service:declaration.api.service,operation:declaration.api.operation,
    endpoint:'/zkapi/v1/api/catalog/lookup',tariffHash:tariff.tariff_hash});
  assert(f.calls.every(call=>new URL(call.url).protocol==='https:'&&(call.method==='GET'||['getGenesisHash','getAccountInfo','getBlock','getMultipleAccounts'].includes(call.rpc??''))));
  assert(!f.calls.some(call=>new URL(call.url).origin===declaration.api.origin||/quotes|sessions|notes|\/api\/catalog\/lookup/.test(call.url)));
});

test('schema boundaries allow 64 operations and reject empty, oversized, duplicate, Direct API and malformed service selections',async()=>{
  const good=await publicProfileFixture({schema:2,selection:'api',serviceCount:64});
  assert.equal(publicProfileClientOptions(await loadPublicDeploymentProfile(good.profileUrl,{profileSha256:await good.profileSha256(),fetch:good.fetcher})).services!.length,64);
  const changes:((p:any)=>void)[]=[p=>{p.services=[];},p=>{p.services=null;},p=>{delete p.services;},p=>{p.mode='direct_openrouter';},
    p=>{p.services.push(structuredClone(p.services[0]));},p=>{p.services[0].endpoint='/lookup';},p=>{p.services[0].tariff.api.method='GET';},
    p=>{p.services[0].tariff.api.origin='https://127.0.0.1';},p=>{p.services[0].tariff.api.auth='Bearer';},
    p=>{p.services[0].tariff.valid_from='01';},p=>{p.services[0].tariff.valid_until='0';},p=>{p.services[0].tariff.valid_until='18446744073709551616';},
    p=>{p.services[0].tariff.tariff_hash='AA'.repeat(32);},p=>{p.modelCapabilities={ghost:{streaming:false,tools:false}};},p=>{p.schema=3;},p=>{p.sdkVersions=['0.2.0-devnet.8'];}];
  for(const change of changes){const f=await publicProfileFixture({schema:2,selection:'api'});change(f.profile);
    await assert.rejects(loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher}),PublicProfileError);assert.equal(f.calls.length,1);}
  const large=await publicProfileFixture({schema:2,selection:'api',serviceCount:65});
  await assert.rejects(loadPublicDeploymentProfile(large.profileUrl,{profileSha256:await large.profileSha256(),fetch:large.fetcher}),component('services'));assert.equal(large.calls.length,1);
  const v1=await publicProfileFixture();Object.assign(v1.profile,{services:[]});
  await assert.rejects(loadPublicDeploymentProfile(v1.profileUrl,{profileSha256:await v1.profileSha256(),fetch:v1.fetcher}),component('profile'));
});

test('service hash and descriptor substitution fail as services; historical validity loads but is checked on preflight',async()=>{
  for(const change of [(p:any)=>{p.services[0].tariff.api.path='/other';},(p:any)=>{p.services[0].tariff.tariff_hash='00'.repeat(32);}]){
    const f=await publicProfileFixture({schema:2,selection:'api'});change(f.profile);
    await assert.rejects(loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher}),component('services'));
    assert(f.calls.every(c=>c.method==='GET'));
  }
  const f=await publicProfileFixture({schema:2,selection:'api'});
  const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
  f.calls.length=0;
  await assert.rejects(preflightPublicDeployment(loaded,{nowSeconds:9999999999n}),component('services'));assert.equal(f.calls.length,0);
  const opts=publicProfileClientOptions(loaded);(opts.services![0].tariff.api as import('../src/control.ts').ApiBindingV1).path='/mutated';opts.services![0].tariff.rates[0].nano_usdc_numerator='1';
  assert.equal((publicProfileClientOptions(loaded).services![0].tariff.api as import('../src/control.ts').ApiBindingV1).path,'/lookup');
  assert.throws(()=>{if(loaded.profile.schema===2)(loaded.profile.services[0].tariff.api as import('../src/control.ts').ApiBindingV1).path='/mutated';});
});

test('API catalogs validate every entry and reject omissions, duplicates and descriptor or endpoint substitution',async()=>{
  const changes:((c:any)=>void)[]=[c=>{delete c.apis;},c=>{c.apis=[];},c=>{c.apis=null;},c=>{c.extra=[];},
    c=>{c.apis.push(structuredClone(c.apis[0]));},c=>{c.apis[0].api.path='/other';},c=>{c.apis[0].endpoint='/v1/chat/completions';},
    c=>{c.apis[0].provider='openai';},c=>{c.apis[0].mode='direct_oa';},c=>{c.apis[0].tariff_hash='00'.repeat(32);},
    c=>{c.apis[0].unknown=true;},c=>{c.apis[0].api.timeout_seconds='601';},c=>{c.apis=Array(257).fill(c.apis[0]);},
    c=>{c.models=[{model:'ghost',provider:'generic',modes:['proxy'],endpoints:['/v1/chat/completions'],modalities:['text'],tariff_hash:'00'.repeat(32)}];}];
  for(const change of changes){const f=await publicProfileFixture({schema:2,selection:'api'});
    const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});change(f.state.catalog);
    await assert.rejects(preflightPublicDeployment(loaded,{nowSeconds:2600n}),component('catalog'));}
});

test('catalog permits additional valid entries and omitted APIs for inference without silently selecting entries',async()=>{
  for(const apis of [undefined,[]]){
    const f=await publicProfileFixture({schema:2,selection:'inference'});const catalog=f.state.catalog as any;
    if(apis===undefined)delete catalog.apis;else catalog.apis=apis;
    const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
    assert.deepEqual((await preflightPublicDeployment(loaded,{nowSeconds:2600n})).apis,[]);
  }
  const f=await publicProfileFixture({schema:2,selection:'api'}),catalog=f.state.catalog as any;
  catalog.apis.push({...structuredClone(catalog.apis[0]),tariff_hash:'01'.repeat(32)});
  catalog.apis.push({...structuredClone(catalog.apis[0]),api:{...catalog.apis[0].api,operation:'extra'},endpoint:'/zkapi/v1/api/weather/extra'});
  const loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
  assert.equal((await preflightPublicDeployment(loaded,{nowSeconds:2600n})).apis.length,1);
  assert.equal(publicProfileClientOptions(loaded).services!.length,1);
});

test('malformed additional inference catalog entries and duplicate modes/endpoints fail closed',async()=>{
  for(const change of [(c:any)=>{c.models.push({...c.models[0]});},(c:any)=>{c.models[0].modes.push('direct_openrouter');},
    (c:any)=>{c.models[0].endpoints=['/v1/messages'];},(c:any)=>{c.models[0].modalities=['text','text'];},
    (c:any)=>{c.models[0].modalities=['image'];},(c:any)=>{c.models[0].model=7;},(c:any)=>{c.models[0].extra=true;}]){
    const f=await publicProfileFixture(),loaded=await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
    change(f.state.catalog);await assert.rejects(preflightPublicDeployment(loaded,{nowSeconds:2600n}),component('catalog'));
  }
});
