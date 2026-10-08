import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPublicDeploymentProfile, preflightPublicDeployment, publicProfileClientOptions, PublicProfileError } from '../src/public-profile.ts';
import { jcsBytes, sha256Hex } from '../src/trust.ts';
import { publicProfileFixture } from './public-profile-fixture.ts';

const component=(name:string)=>(e:unknown)=>e instanceof PublicProfileError && e.component===name;
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
