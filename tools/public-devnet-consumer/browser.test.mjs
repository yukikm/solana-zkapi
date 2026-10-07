/** Installed adapter control-flow fixture. The profile loader and preflight are
 * real SDK code over synthetic HTTPS/RPC bytes. Wallet/custody/financial client
 * are explicit stubs: this is not browser, proof, provider or live acceptance. */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { publicProfileFixture } from '../public-profile-fixture.ts';

let scenario;
mock.module('@zkapi/solana-sdk/browser', { namedExports: {
  walletStandardAdapter: (_wallet, account, chain) => {
    assert.equal(chain,'solana:devnet'); return {publicKey:account.address};
  },
  createBrowserClient: async options => {
    scenario.factoryCalls.push(options);
    return {client: {
      status: async () => ({canRequest:true,lastSettlement:null}),
      recover: async () => {scenario.actions.push('recover');},
      prepareWithdrawal: async (destination,mode) => {scenario.actions.push({destination,mode});},
      chat: async input => {
        scenario.actions.push({chat:input.operationId});
        return Response.json({choices:[{message:{content:'synthetic adapter response'},finish_reason:'stop'}]});
      },
    },dispose() {scenario.actions.push('dispose');}};
  },
} });
const {openChat} = await import('./browser.ts');

async function setup(t,{installed=true,available=true,paused=false}={}) {
  const f=await publicProfileFixture(),profileSha256=await f.profileSha256();
  f.clock.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32);
  f.state.catalogAvailable=available;f.poolData[355]=paused?1:0;
  const account={address:f.manifest.authorities.admin.authority};
  const bindingKey=JSON.stringify(['zkapi-public-profile-v1','adapter-fixture',account.address]);
  const storage=new Map(installed?[[bindingKey,profileSha256]]:[]);
  const globals=new Map(['fetch','localStorage','navigator'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:f.fetcher});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{
    getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},
  }});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,_options,action)=>action()}}});
  t.after(()=>{for(const [name,descriptor] of globals){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  scenario={factoryCalls:[],actions:[]};
  const input={profileUrl:f.profileUrl,profileSha256,selectedWallet:{},selectedAccount:account,
    storageName:'adapter-fixture',noteId:'original-note',createWorker(){throw Error('stub factory must not generate proofs');}};
  return {f,input,storage,bindingKey,counts:scenario};
}
const sendInput=()=>({operationId:crypto.randomUUID(),model:'fixture-model',messages:[{role:'user',content:'fixture'}],
  maxOutputTokens:10,stream:false,onDelta(){}});

test('installed browser adapter opens original custody for recovery when catalog is unavailable and gates Send until explicit refresh',async t=>{
  const {f,input,storage,bindingKey,counts}=await setup(t,{available:false});
  const app=await openChat(input);
  assert.equal(app.diagnostic.preflight,null);assert.equal(app.diagnostic.unavailableComponent,'catalog');
  assert.equal(counts.factoryCalls.length,1);assert.equal(counts.factoryCalls[0].initializeStorage,undefined);
  assert.equal(counts.factoryCalls[0].noteId,'original-note');assert.equal(storage.get(bindingKey),input.profileSha256);
  const httpBefore=f.calls.length;
  await app.recover();await app.withdraw();
  assert.equal(f.calls.length,httpBefore,'adapter recovery delegates without new profile/preflight requests');
  assert.deepEqual(counts.actions,['recover',{destination:input.selectedAccount.address,mode:'mutual_close'}]);
  await assert.rejects(app.send(sendInput()),/Refresh connectivity/);assert.equal(counts.actions.length,2);
  f.state.catalogAvailable=true;
  const refreshed=await app.refreshPreflight();assert.equal(refreshed.unavailableComponent,null);
  assert.equal(refreshed.preflight.chainAllowsNewOperations,true);
  assert.equal((await app.send(sendInput())).text,'synthetic adapter response');
  assert.equal(counts.actions.length,3);assert.equal(counts.factoryCalls.length,1,'refresh never recreates custody');
});
test('new storage admission fails before binding/custody creation on catalog outage',async t=>{
  const {input,storage,counts}=await setup(t,{installed:false,available:false});
  await assert.rejects(openChat({...input,initializeStorage:true}),e=>e.component==='catalog');
  assert.equal(storage.size,0);assert.equal(counts.factoryCalls.length,0);assert.deepEqual(counts.actions,[]);
});
test('missing or changed original bindings cannot initialize replacement custody on ordinary reload',async t=>{
  const {f,input,storage,bindingKey,counts}=await setup(t,{installed:false});
  await assert.rejects(openChat(input),/Original profile binding is missing/);assert.equal(f.calls.length,0);
  storage.set(bindingKey,'00'.repeat(32));
  await assert.rejects(openChat(input),e=>e.component==='profile');assert.equal(f.calls.length,0);
  assert.equal(counts.factoryCalls.length,0);assert.equal(storage.get(bindingKey),'00'.repeat(32));
});
test('paused finalized Pool keeps original recovery available while Send remains blocked',async t=>{
  const {input,counts}=await setup(t,{paused:true});
  const app=await openChat(input);assert.equal(app.diagnostic.preflight.chainAllowsNewOperations,false);
  await app.recover();await assert.rejects(app.send(sendInput()),/Refresh connectivity/);
  assert.deepEqual(counts.actions,['recover']);assert.equal(counts.factoryCalls[0].initializeStorage,undefined);
});
test('memory-only invitation reaches only authenticated exact session POST and never loading/preflight/provider traffic',async t=>{
  const {f,input,storage,counts}=await setup(t);
  const token='A'.repeat(43),seen=[];let runtimeProbe=false;
  const fetcher=async(resource,init)=>{
    const url=resource instanceof Request?resource.url:String(resource);
    seen.push({url,method:init?.method??'GET',headers:new Headers(init?.headers),credentials:init?.credentials,redirect:init?.redirect,signal:init?.signal,body:init?.body});
    return runtimeProbe?new Response('{}'):f.fetcher(resource,init);
  };
  const app=await openChat({...input,admissionToken:token,fetch:fetcher});
  assert(seen.length>0);assert(seen.every(row=>row.headers.get('x-zkapi-admission')===null));
  assert([...storage.values()].every(value=>!value.includes(token)));
  assert(!JSON.stringify(app.diagnostic).includes(token));
  assert(!Object.hasOwn(counts.factoryCalls[0],'admissionToken'));
  runtimeProbe=true;
  const send=counts.factoryCalls[0].deployment.fetch,session=f.manifest.control_api_origin+'/zkapi/v1/sessions';
  const signal=new AbortController().signal,body='exact fixture body';
  const probes=[
    [session,'POST',token],[session,'GET',null],[session+'/saved/close','POST',null],
    [session+'?x=1','POST',null],[f.manifest.control_api_origin+'/zkapi/v1/quotes','POST',null],
    [f.profile.directProviderBases.direct_openrouter+'/chat/completions','POST',null],
    [f.profile.rpcUrl,'POST',null],['https://unrelated.example.com/zkapi/v1/sessions','POST',null],
  ];
  for(const [url,method,wanted] of probes){
    await send(url,{method,headers:{'X-Zkapi-Admission':'caller-supplied-header'},credentials:'include',redirect:'follow',signal,...(method==='POST'?{body}:{})});
    const row=seen.at(-1);assert.equal(row.headers.get('x-zkapi-admission'),wanted);
    assert.equal(row.credentials,'omit');assert.equal(row.redirect,'error');assert.equal(row.signal,signal);
    if(method==='POST')assert.equal(row.body,body);
  }
  await send(new Request('https://provider.example.com/v1/chat/completions',{method:'POST',headers:{'x-zkapi-admission':'inherited-secret'},body:'fixture'}));
  assert.equal(seen.at(-1).headers.get('x-zkapi-admission'),null);
  app.dispose();await send(session,{method:'POST',body});
  assert.equal(seen.at(-1).headers.get('x-zkapi-admission'),null,'disposed adapter clears its invitation');
});
test('malformed invitation fails before any profile requests or custody activity',async t=>{
  const {f,input,counts}=await setup(t);
  for(const admissionToken of ['', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42)+'B', 'A'.repeat(42)+'='])
    await assert.rejects(openChat({...input,admissionToken}),/Invalid invitation format/);
  assert.equal(f.calls.length,0);assert.equal(counts.factoryCalls.length,0);assert.deepEqual(counts.actions,[]);
});
