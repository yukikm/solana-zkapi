/** Lifecycle/IPC fixtures. Native and WASM cryptographic acceptance is separate. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClientDaemon, DaemonConflict, type DaemonOptions } from '../src/clientd-bridge.ts';
import { ControlClient, createCredentials, validateNoteJournal, type Mode, type NoteJournal, type PreparedSession, type VerificationContext, type SessionVerifier } from '../src/control.ts';
import { EncryptedJournal, importJournalKey, JournalIntegrityError } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { initializeJournalKey, unlockJournalKey } from '../src/secret-custody.ts';
import { writeNodeResponse } from '../src/clientd-network.ts';
import { createServer, request } from 'node:http';

const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
async function fixture(t:TestContext,mode:Mode='proxy',reuse=60,models:DaemonOptions['models']=['m','n']){
  const dir=await mkdtemp(join(tmpdir(),'zkapi-clientd-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const key=await importJournalKey(new Uint8Array(32).fill(4)),store=await NativeJournalStore.open(dir);
  const context:VerificationContext={deployment_id:'fixture',pool:'pool',vault_binding:field(1),state_key:[field(2),field(3)],cap_micro_usdc:'100',control_api_origin:'https://control.invalid',inference_api_origin:'https://proxy.invalid',quote_public_key:'00'.repeat(32),receipt_public_key:'11'.repeat(32),request_vk_sha256:'22'.repeat(32),tariff_hashes:['33'.repeat(32)]};
  const journal=new EncryptedJournal<NoteJournal>(store,key,{deploymentId:'fixture',pool:'pool'},validateNoteJournal);
  const state={balance_micro_usdc:'100',balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(7),state_signature:null};
  await journal.create('note',{schema:1,state,pending:null,history:[]});
  let now=100n,creates=0,closes=0,sends=0,controlRequests=0,oaVerifications=0,oaRejected=false,loss=false,direct202=false,missingSettlement=false,controlUnavailable=false,closeDraining=false,settlementRejected=false;
  let pendingInference: ((signal: AbortSignal) => Promise<Response>) | undefined;
  let pendingPreparation: (()=>Promise<void>) | undefined;
  let beforeClose: (()=>Promise<void>) | undefined;
  const sentRequests:{id:string;path:string;body:string}[]=[];
  const status=async(settled=false)=>{const p=(await journal.read('note'))!.value.pending!;return{request_id:p.prepared.request.authorization.request_id,mode,state:settled?'SETTLED':'ACTIVE',cap_micro_usdc:'100',issued_at:String(now),expires_at:String(now+60n),...(settled?{settlement:{charge_micro_usdc:'0',next_commitment:state.commitment,next_anchor:field(8),blind_delta_srv:field(9),next_state_signature:{r_x:field(2),r_y:field(3),s:field(4)}}}:{})};};
  const http:typeof fetch=async(url,init)=>{
    const u=new URL(String(url));
    if(u.pathname.startsWith('/zkapi/')){controlRequests++;if(controlUnavailable)return new Response(null,{status:503});}
    if(u.pathname==='/zkapi/v1/sessions'){creates++;assert.equal((await journal.read('note'))!.value.pending!.phase,'send_unknown');return Response.json({...await status(),...(mode==='proxy'||direct202?{}:{provider_key:'provider-secret',provider_api_origin:'https://direct.invalid/v1',...(mode==='direct_oa'?{provider_key_verification:{verifier_url:'https://verifier.invalid/api',station_id:'trusted-station',station_recently_attested:true,key_valid_till:Number(now+60n),station_signature:'11'.repeat(64),org_signature:'22'.repeat(64)}}:{})})},{status:direct202?202:200});}
    if(u.pathname.endsWith('/close')){closes++;await beforeClose?.();return Response.json(closeDraining?{...await status(),state:'DRAINING'}:await status(true));}
    if(u.pathname.endsWith('/receipts'))return Response.json({receipts:[],next_cursor:null});
    if(u.pathname.includes('/operations/')){assert.equal(new Headers(init!.headers).get('Authorization'),`Bearer ${(await journal.read('note'))!.value.pending!.prepared.control_token}`);return new Response(null,{status:404});}
    if(u.pathname.startsWith('/zkapi/v1/sessions/'))return Response.json(await status(missingSettlement));
    if(u.origin==='https://verifier.invalid'){
      oaVerifications++;assert.equal(u.pathname,'/api/submit_key');assert.equal(init!.method,'POST');
      const headers=new Headers(init!.headers);assert.equal(headers.get('Authorization'),null);assert.equal(headers.get('Content-Type'),'application/json');
      assert.equal(init!.redirect,'error');assert.equal(init!.credentials,'omit');assert.equal(init!.cache,'no-store');
      assert.deepEqual(JSON.parse(String(init!.body)),{station_id:'trusted-station',api_key:'provider-secret',key_valid_till:Number(now+60n),station_signature:'11'.repeat(64),org_signature:'22'.repeat(64)});
      const p=(await journal.read('note'))!.value.pending!;assert.equal(p.providerKey,undefined);assert.deepEqual(p.operations,[]);
      return Response.json({status:oaRejected?'rejected':'verified'});
    }
    sends++;const p=(await journal.read('note'))!.value.pending!;assert.equal(p.operations.at(-1)!.phase,'send_unknown');
    sentRequests.push({id:p.operations.at(-1)!.id,path:u.pathname,body:new TextDecoder().decode(init!.body as Uint8Array)});
    if(mode!=='proxy'){assert.equal((init!.headers as any).Authorization,'Bearer provider-secret');assert.equal(u.origin,'https://direct.invalid');}
    if(loss)throw Error('fixture response loss');
    if(pendingInference)return pendingInference(init!.signal!);
    return new Response('data: first\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  const verifier:SessionVerifier={async prepare(){},async settle(_c,s,_p,_s,_r,operations){if(mode!=='proxy')assert.deepEqual(operations,[]);if(settlementRejected)throw Error('fixture invalid successor signature');if(missingSettlement&&operations.length)throw Error('fixture missing operation receipt');return{...s,anchor:field(8)};}};
  const clientOptions={context,journal,verifier,fetch:http,now:()=>now,directProviderBases:{direct_oa:'https://direct.invalid/v1',direct_openrouter:'https://direct.invalid/v1'},oaVerifier:{base:'https://verifier.invalid/api',stationId:'trusted-station'}};
  const client=new ControlClient(clientOptions);
  const options={client,journal,noteId:'note',mode,models,keyReuseSeconds:reuse,now:()=>now,prepare:async(_model:string,c:any)=>{
    await pendingPreparation?.();
    const p:PreparedSession={request:{authorization:{version:'1',deployment_id:'fixture',pool:'pool',request_id:c.requestId,quote_hash:'00'.repeat(32),mode,control_secret_hash:c.controlHash,proxy_secret_hash:c.proxyHash},quote:{body:{quote_id:crypto.randomUUID(),deployment_id:'fixture',pool:'pool',mode,provider:mode==='direct_oa'?'oa':'openrouter',models:[mode==='proxy'?_model:'*'],tariff_hash:'33'.repeat(32),cap_micro_usdc:'100',issued_at:String(now),expires_at:String(now+120n),session_ttl_seconds:'60',max_concurrency:'4',control_api_origin:context.control_api_origin,inference_api_origin:context.inference_api_origin},quote_hash:'00'.repeat(32),signature:'fixture'},public_inputs:Array(12).fill(field(1)),proof:{backend:'groth16_bn254',proof:'fixture'}},control_token:c.controlToken,proxy_token:c.proxyToken,tariff:{tariff_hash:'33'.repeat(32),version:'1',provider:'openrouter',model:'m',pricing_basis:'fixture',valid_from:'0',valid_until:'1000',rates:[],operator_fee_micro_usdc:'0'},rerandomization:field(2)};return{prepared:p,root:field(2)};}};
  const service=new ClientDaemon(options);await service.start();
  return{service,journal,dir,sentRequests,beforeClose:(handler:()=>Promise<void>)=>{beforeClose=handler;},closeDraining:(value=true)=>{closeDraining=value;},rejectSettlement:(value=true)=>{settlementRejected=value;},pendingPreparation:(handler:()=>Promise<void>)=>{pendingPreparation=handler;},pendingInference:(handler:(signal:AbortSignal)=>Promise<Response>)=>{pendingInference=handler;},restart:()=>{const recoveredJournal=new EncryptedJournal<NoteJournal>(store,key,{deploymentId:'fixture',pool:'pool'},validateNoteJournal);return new ClientDaemon({...options,journal:recoveredJournal,client:new ControlClient({...clientOptions,journal:recoveredJournal})});},prepareUnsent:async()=>{const p=await options.prepare('m',await createCredentials(mode));await client.prepare('note',p.prepared,p.root);},counts:()=>({creates,closes,sends}),oaVerifications:()=>oaVerifications,rejectOa:()=>{oaRejected=true;},controlRequests:()=>controlRequests,advance:()=>{now+=61n;},lose:(value=true)=>{loss=value;},directUnknown:()=>{direct202=true;},missingSettlement:(value=true)=>{missingSettlement=value;},controlUnavailable:(value=true)=>{controlUnavailable=value;}};
}
const body=new TextEncoder().encode('{"model":"m","stream":true,"store":false}');
const otherBody=new TextEncoder().encode('{"model":"n","messages":[{"role":"user","content":"original new send"}],"stream":true}');
test('model switch settles the old session and dispatches the original new operation once',async t=>{
  const f=await fixture(t),oldId=crypto.randomUUID(),newId=crypto.randomUUID();
  await(await f.service.infer('/v1/chat/completions',body,oldId)).text();
  const response=await f.service.infer('/v1/chat/completions',otherBody,newId);await response.text();
  assert.equal(response.headers.get('X-Zkapi-Operation-Id'),newId);
  assert.deepEqual(f.counts(),{creates:2,closes:1,sends:2});
  assert.deepEqual(f.sentRequests.map(request=>request.id),[oldId,newId]);
  assert.equal(f.sentRequests[1].body,new TextDecoder().decode(otherBody));
  const saved=(await f.journal.read('note'))!.value;
  assert.equal(saved.history[0].operations[0].id,oldId);
  assert.equal(saved.pending!.prepared.request.quote.body.models[0],'n');
  await assert.rejects(f.service.infer('/v1/chat/completions',body,oldId),DaemonConflict);
  await assert.rejects(f.service.infer('/v1/chat/completions',otherBody,newId),DaemonConflict);
  assert.deepEqual(f.counts(),{creates:2,closes:1,sends:2});
});
test('model switch cannot close a session with an active response',async t=>{
  const f=await fixture(t),response=await f.service.infer('/v1/chat/completions',body),id=crypto.randomUUID();
  await assert.rejects(f.service.infer('/v1/chat/completions',otherBody,id),DaemonConflict);
  assert.deepEqual(f.counts(),{creates:1,closes:0,sends:1});
  await response.text();await(await f.service.infer('/v1/chat/completions',otherBody,id)).text();
  assert.deepEqual(f.counts(),{creates:2,closes:1,sends:2});
});
test('unfinished or unverifiable close blocks new-model authorization without replay',async t=>{
  for(const failure of ['draining','outage','signature']) {
    const f=await fixture(t);await(await f.service.infer('/v1/chat/completions',body)).text();
    if(failure==='draining')f.closeDraining();else if(failure==='outage')f.controlUnavailable();else f.rejectSettlement();
    const id=crypto.randomUUID();await assert.rejects(f.service.infer('/v1/chat/completions',otherBody,id));
    assert.equal(f.counts().creates,1);assert.equal(f.counts().sends,1);
    assert.ok((await f.journal.read('note'))!.value.pending);
    assert.equal((await f.journal.read('note'))!.value.pending!.operations.some(operation=>operation.id===id),false);
    f.closeDraining(false);f.controlUnavailable(false);f.rejectSettlement(false);
    await(await f.service.infer('/v1/chat/completions',otherBody,id)).text();
    assert.equal(f.counts().creates,2);assert.equal(f.counts().sends,2);
  }
});
test('aborting during old-session settlement never authorizes the new model',async t=>{
  const f=await fixture(t);await(await f.service.infer('/v1/chat/completions',body)).text();
  let closing!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{closing=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  f.beforeClose(async()=>{closing();await blocked;});
  const abort=new AbortController(),request=f.service.infer('/v1/chat/completions',otherBody,crypto.randomUUID(),'',abort.signal);
  const rejected=assert.rejects(request,{name:'AbortError'});await started;abort.abort();release();await rejected;
  assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});assert.equal((await f.journal.read('note'))!.value.pending,null);
});
test('shutdown during model-switch settlement closes without admitting the new send',async t=>{
  const f=await fixture(t);await(await f.service.infer('/v1/chat/completions',body)).text();
  let closing!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{closing=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
  f.beforeClose(async()=>{closing();await blocked;});
  const request=f.service.infer('/v1/chat/completions',otherBody),rejected=assert.rejects(request,DaemonConflict);
  await started;const stopped=f.service.shutdown();release();await Promise.all([rejected,stopped]);
  assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});assert.equal((await f.journal.read('note'))!.value.pending,null);
});
test('reuse expiry and a concurrent maintenance tick admit a new request once after settlement',async t=>{
  const f=await fixture(t);await(await f.service.infer('/v1/chat/completions',body)).text();f.advance();
  const id=crypto.randomUUID();const [response]=await Promise.all([f.service.infer('/v1/chat/completions',body,id),f.service.maintenance()]);
  await response.text();assert.deepEqual(f.counts(),{creates:2,closes:1,sends:2});assert.equal(f.sentRequests[1].id,id);
});
test('validated model policies drive the advertised provider and reject unsupported APIs before AUTH',async t=>{
  const models:DaemonOptions['models']=[{id:'m',provider:'openrouter',apis:['chat']},{id:'n',provider:'anthropic',apis:['messages','count_tokens']}];
  const f=await fixture(t,'proxy',60,models);
  const response=await f.service.handle('GET','/v1/models',new Uint8Array(),new Headers());
  assert.deepEqual((await response.json()).data,[{id:'m',object:'model',owned_by:'openrouter'},{id:'n',object:'model',owned_by:'anthropic'}]);
  await assert.rejects(f.service.infer('/v1/responses',body),/model API/);
  await assert.rejects(f.service.infer('/v1/chat/completions',otherBody),/model API/);
  assert.deepEqual(f.counts(),{creates:0,closes:0,sends:0});
  await(await f.service.infer('/v1/chat/completions',body)).text();assert.equal(f.counts().sends,1);
});
test('direct client tools accept arbitrary JSON Schema property names without admitting unsupported modalities',async t=>{
  const parameters={type:'object',properties:{type:{type:'string',enum:['image_url','function']},image_url:{type:'string'},audio:{type:'boolean'},background:{type:'string'},conversation:{type:'string'}},required:['type'],additionalProperties:false};
  for(const [mode,path] of [['direct_openrouter','/v1/chat/completions'],['direct_oa','/v1/chat/completions'],['direct_oa','/v1/responses']] as const){
    const f=await fixture(t,mode,0),responses=path==='/v1/responses';
    const tool=responses?{type:'function',name:'record_metadata',parameters}:{type:'function',function:{name:'record_metadata',parameters}};
    const input=responses?{input:'Record metadata'}:{messages:[{role:'user',content:'Record metadata'}]};
    const payload={model:'m',...input,tools:[tool],store:false};
    const bytes=new TextEncoder().encode(JSON.stringify(payload));
    await(await f.service.infer(path,bytes)).text();
    assert.equal(f.sentRequests[0].body,new TextDecoder().decode(bytes));
    assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});
    for(const invalid of [
      {...payload,image_url:'https://private.invalid/image'},
      {...payload,tools:[{type:'web_search_preview'}]},
      {...payload,...(responses?{input:[{role:'user',content:[{type:'input_image',image_url:'https://private.invalid/image'}]}]}:{messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://private.invalid/image'}}]}]})},
    ])await assert.rejects(f.service.infer(path,new TextEncoder().encode(JSON.stringify(invalid))),/unsupported modality or hosted tool/);
    assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});
  }
});
test('direct identity and transport metadata is rejected before AUTH or inference',async t=>{
  for(const [mode,path] of [['direct_openrouter','/v1/chat/completions'],['direct_oa','/v1/responses']] as const){
    const f=await fixture(t,mode);
    for(const field of ['user','metadata','safety_identifier','prompt_cache_key','extra_headers','provider']){
      const bytes=new TextEncoder().encode(JSON.stringify({model:'m',store:false,[field]:field==='metadata'?{email:'private@example.invalid'}:'private-identity'}));
      await assert.rejects(f.service.infer(path,bytes),/unsupported identity or transport metadata/);
    }
    assert.deepEqual(f.counts(),{creates:0,closes:0,sends:0});
    assert.equal((await f.journal.read('note'))!.value.pending,null);
  }
});
test('direct structured text formats are supported only at the native API format paths',async t=>{
  const schema={type:'object',properties:{type:{type:'string'},image_url:{type:'string'},audio:{type:'boolean'}},required:['type'],additionalProperties:false};
  for(const [mode,path] of [['direct_openrouter','/v1/chat/completions'],['direct_oa','/v1/chat/completions'],['direct_oa','/v1/responses']] as const){
    const f=await fixture(t,mode,0),responses=path==='/v1/responses';
    for(const structured of [false,true]){
      const format=structured?(responses?{type:'json_schema',name:'metadata',schema,strict:true}:{type:'json_schema',json_schema:{name:'metadata',schema,strict:true}}):{type:'json_object'};
      const payload={model:'m',store:false,...(responses?{input:'Return JSON',text:{format}}:{messages:[{role:'user',content:'Return JSON'}],response_format:format})};
      const bytes=new TextEncoder().encode(JSON.stringify(payload));
      await(await f.service.infer(path,bytes)).text();
      assert.equal(f.sentRequests.at(-1)!.body,new TextDecoder().decode(bytes));
      for(const invalid of [
        {...payload,tools:[{type:'web_search_preview'}]},
        {...payload,...(responses?{text:{format:{type:'input_image',image_url:'https://private.invalid/image'}}}:{response_format:{type:'image_url',image_url:'https://private.invalid/image'}})},
        {...payload,...(responses?{input:[{type:'json_schema',schema}]}:{messages:[{role:'user',content:[{type:'json_schema',schema}]}]})},
      ])await assert.rejects(f.service.infer(path,new TextEncoder().encode(JSON.stringify(invalid))),/unsupported modality or hosted tool/);
    }
    assert.deepEqual(f.counts(),{creates:2,closes:2,sends:2});
  }
});
test('direct Responses requires explicit disabled storage before AUTH',async t=>{
  const f=await fixture(t,'direct_oa',0);
  for(const store of [undefined,null,true,'false',0]){
    const bytes=new TextEncoder().encode(JSON.stringify({model:'m',input:'private prompt',store}));
    await assert.rejects(f.service.infer('/v1/responses',bytes),/direct Responses requires store:false/);
  }
  assert.deepEqual(f.counts(),{creates:0,closes:0,sends:0});
  assert.equal((await f.journal.read('note'))!.value.pending,null);
  const bytes=new TextEncoder().encode(JSON.stringify({model:'m',input:'private prompt',store:false}));
  await(await f.service.infer('/v1/responses',bytes)).text();
  assert.equal(f.sentRequests[0].body,new TextDecoder().decode(bytes));
  assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});
});
test('daemon exposes inference headers without upstream cookies or tracking headers',async t=>{
  for(const mode of ['proxy','direct_openrouter','direct_oa'] as const){
    const f=await fixture(t,mode,0),id=crypto.randomUUID();
    f.pendingInference(async()=>new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream','Retry-After':'3','Set-Cookie':'provider_identity=private; Path=/','X-Request-Id':'private-correlation','Access-Control-Allow-Origin':'*','X-Zkapi-Operation-Id':'untrusted-id','Cache-Control':'public, max-age=3600'}}));
    const response=await f.service.infer('/v1/chat/completions',body,id);await response.text();
    assert.equal(response.headers.get('Set-Cookie'),null);
    assert.equal(response.headers.get('X-Request-Id'),null);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    assert.equal(response.headers.get('Content-Type'),'text/event-stream');
    assert.equal(response.headers.get('Retry-After'),'3');
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal(response.headers.get('X-Zkapi-Operation-Id'),id);
    assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});
  }
});
test('clientd shares encrypted journal, streams once, reuses 60-second session and closes idle',async t=>{
  const f=await fixture(t);for(let i=0;i<2;i++)assert.match(await(await f.service.infer('/v1/chat/completions',body)).text(),/DONE/);
  assert.deepEqual(f.counts(),{creates:1,closes:0,sends:2});f.advance();await f.service.maintenance();assert.deepEqual(f.counts(),{creates:1,closes:1,sends:2});assert.equal((await f.journal.read('note'))!.value.pending,null);
});
test('reuse zero closes after every request and duplicate operation cannot cross settled sessions',async t=>{
  const f=await fixture(t,'proxy',0),id=crypto.randomUUID();await(await f.service.infer('/v1/responses',body,id)).text();
  await assert.rejects(f.service.infer('/v1/responses',body,id),DaemonConflict);await(await f.service.infer('/v1/responses',body)).text();assert.deepEqual(f.counts(),{creates:2,closes:2,sends:2});
});
test('uncertain direct inference is never replayed after restart; volatile key, same mode',async t=>{
  const f=await fixture(t,'direct_openrouter'),id=crypto.randomUUID();f.lose();await assert.rejects(f.service.infer('/v1/chat/completions',body,id));
  assert.equal((await f.journal.read('note'))!.value.pending!.providerKey,undefined);const resumed=f.restart();await resumed.start();
  assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});await assert.rejects(resumed.infer('/v1/chat/completions',body,id),DaemonConflict);
});
test('restart keeps admin reachable for explicit absent-operation reconciliation without inference replay',async t=>{
  const f=await fixture(t),id=crypto.randomUUID();f.lose();await assert.rejects(f.service.infer('/v1/chat/completions',body,id));
  const before=await f.journal.read('note');f.missingSettlement();const resumed=f.restart();await resumed.start();
  const status=await resumed.handle('GET','/admin/status',new Uint8Array(),new Headers());assert.equal(status.status,200);assert.equal((await status.json()).recovery_required,true);
  assert.deepEqual((await f.journal.read('note'))!.head,before!.head);const calls=f.controlRequests();await resumed.startIfNeeded();await resumed.maintenance();assert.equal(f.controlRequests(),calls);
  assert.equal((await resumed.handle('POST','/v1/chat/completions',body,new Headers())).status,409);assert.equal(f.counts().sends,1);
  const reconciled=await resumed.handle('POST','/admin/reconcile',new Uint8Array(),new Headers());assert.equal(reconciled.status,200);assert.equal((await reconciled.json()).recovery_required,false);
  const saved=(await f.journal.read('note'))!.value;assert.equal(saved.pending,null);assert.equal(saved.history[0].operations[0].id,id);assert.equal(saved.history[0].operations[0].phase,'not_accepted');
  await assert.rejects(resumed.infer('/v1/chat/completions',body,id),DaemonConflict);
  f.lose(false);f.missingSettlement(false);assert.match(await(await resumed.infer('/v1/chat/completions',body)).text(),/DONE/);assert.deepEqual(f.counts(),{creates:2,closes:0,sends:2});
});
test('restart outage keeps inference blocked until explicit recovery closes the previous session',async t=>{
  const f=await fixture(t,'direct_oa');await(await f.service.infer('/v1/responses',body)).text();f.controlUnavailable();
  const resumed=f.restart();await resumed.start();assert.equal((await resumed.status() as any).recovery_required,true);
  assert.equal((await resumed.handle('POST','/admin/recover',new Uint8Array(),new Headers())).status,400);assert.equal((await resumed.status() as any).recovery_required,true);
  f.controlUnavailable(false);await resumed.startIfNeeded();await resumed.maintenance();await assert.rejects(resumed.infer('/v1/responses',body),DaemonConflict);assert.equal(f.counts().sends,1);
  const recovered=await resumed.handle('POST','/admin/recover',new Uint8Array(),new Headers());assert.equal(recovered.status,200);assert.equal((await recovered.json()).recovery_required,false);assert.equal((await f.journal.read('note'))!.value.pending,null);
  await(await resumed.infer('/v1/responses',body)).text();assert.deepEqual(f.counts(),{creates:2,closes:1,sends:2});
});
test('startup rejects a tampered encrypted journal before contacting control',async t=>{
  const f=await fixture(t);await(await f.service.infer('/v1/responses',body)).text();const calls=f.controlRequests();
  const name=(await readdir(f.dir)).find(name=>name.endsWith('.json'))!,path=join(f.dir,name),record=JSON.parse(await readFile(path,'utf8'));
  record.ciphertextHex=(record.ciphertextHex.startsWith('00')?'01':'00')+record.ciphertextHex.slice(2);await writeFile(path,JSON.stringify(record));
  await assert.rejects(f.restart().start(),JournalIntegrityError);assert.equal(f.controlRequests(),calls);
});
test('expired never-sent authorization has explicit admin cancellation; uncertain inference cannot be canceled',async t=>{
  const f=await fixture(t);await f.prepareUnsent();const state=(await f.journal.read('note'))!.value.state;f.advance();f.advance();
  const resumed=f.restart();await resumed.start();assert.equal((await resumed.status() as any).recovery_required,true);assert.equal(f.controlRequests(),0);
  const canceled=await resumed.handle('POST','/admin/cancel-unsent',new Uint8Array(),new Headers());assert.equal(canceled.status,200);assert.equal((await canceled.json()).recovery_required,false);
  assert.equal((await f.journal.read('note'))!.value.pending,null);assert.deepEqual((await f.journal.read('note'))!.value.state,state);assert.equal(f.controlRequests(),0);
  f.lose();await assert.rejects(resumed.infer('/v1/responses',body));const before=(await f.journal.read('note'))!.head;
  assert.equal((await resumed.handle('POST','/admin/cancel-unsent',new Uint8Array(),new Headers())).status,400);assert.deepEqual((await f.journal.read('note'))!.head,before);assert.equal(f.counts().sends,1);
});
test('direct 202 with missing key closes without inference or proxy fallback',async t=>{
  const f=await fixture(t,'direct_oa');f.directUnknown();await assert.rejects(f.service.infer('/v1/responses',body),DaemonConflict);assert.deepEqual(f.counts(),{creates:1,closes:1,sends:0});
});
test('OA key is independently verified before clientd inference and reused only within the same session',async t=>{
  const f=await fixture(t,'direct_oa');
  for(let i=0;i<2;i++)assert.match(await(await f.service.infer('/v1/responses',body)).text(),/DONE/);
  assert.equal(f.oaVerifications(),1);assert.deepEqual(f.counts(),{creates:1,closes:0,sends:2});
  assert.equal((await f.journal.read('note'))!.value.pending!.providerKey,undefined);
});
test('OA verifier rejection closes the same authorization without saving a key or sending inference',async t=>{
  const f=await fixture(t,'direct_oa');f.rejectOa();
  await assert.rejects(f.service.infer('/v1/responses',body),DaemonConflict);
  assert.equal(f.oaVerifications(),1);assert.deepEqual(f.counts(),{creates:1,closes:1,sends:0});
  const saved=(await f.journal.read('note'))!.value;
  assert.equal(saved.pending,null);assert.equal(saved.history.length,1);assert.deepEqual(saved.history[0].operations,[]);
  assert.equal(JSON.stringify(saved).includes('provider-secret'),false);
  await f.restart().start();assert.deepEqual(f.counts(),{creates:1,closes:1,sends:0});
});
test('stream cancel still closes reuse-zero session, unsupported direct modalities never authorize',async t=>{
  const f=await fixture(t,'direct_oa',0);await assert.rejects(f.service.infer('/v1/responses',new TextEncoder().encode('{"model":"m","input":[{"type":"input_image"}]}')));assert.equal(f.counts().creates,0);
  const response=await f.service.infer('/v1/chat/completions',body);await response.body!.cancel();assert.equal(f.counts().closes,1);
});
test('graceful shutdown waits for delivered streams and durable session close',async t=>{
  const f=await fixture(t,'direct_oa');const stream=await f.service.infer('/v1/chat/completions',body);
  let done=false;const shutdown=f.service.shutdown().then(()=>{done=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(done,false);
  await stream.body!.cancel();await shutdown;assert.equal((await f.journal.read('note'))!.value.pending,null);assert.equal(f.counts().closes,1);
});
test('canceling a pending read retains native admission until upstream cancellation finishes',async t=>{
  for(const mode of ['proxy','direct_openrouter'] as const){
    const f=await fixture(t,mode,0);
    let reading!:()=>void,canceling!:()=>void,release!:()=>void;
    const readStarted=new Promise<void>(resolve=>{reading=resolve;}),cancelStarted=new Promise<void>(resolve=>{canceling=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
    f.pendingInference(async()=>new Response(new ReadableStream<Uint8Array>({pull(){reading();},async cancel(){canceling();await blocked;}},{highWaterMark:0})));
    const response=await f.service.infer('/v1/chat/completions',body),reader=response.body!.getReader();
    const pendingRead=reader.read();await readStarted;
    const canceled=reader.cancel();await cancelStarted;await pendingRead;
    // Web Streams resolves pending read() as EOF before cancel() settles.
    // That EOF must not free the financial admission boundary.
    try{
      await new Promise(resolve=>setImmediate(resolve));
      assert.equal((await f.service.status() as any).in_flight,1);
      await assert.rejects(f.service.infer('/v1/chat/completions',body),DaemonConflict);
      await assert.rejects(f.service.management('close'),DaemonConflict);
      assert.deepEqual(f.counts(),{creates:1,closes:0,sends:1});
    }finally{release();await canceled;}
    assert.equal((await f.service.status() as any).in_flight,0);
    assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});
  }
});
test('graceful shutdown also waits for admission already preparing its authorization',async t=>{
  const f=await fixture(t,'direct_oa');let preparing!:()=>void,resume!:()=>void;
  const started=new Promise<void>(resolve=>{preparing=resolve;}),blocked=new Promise<void>(resolve=>{resume=resolve;});
  f.pendingPreparation(async()=>{preparing();await blocked;});
  const request=f.service.infer('/v1/chat/completions',body);await started;
  let done=false;const shutdown=f.service.shutdown().then(()=>{done=true;});resume();
  const response=await request;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(done,false);
  await response.body!.cancel();await shutdown;assert.equal((await f.journal.read('note'))!.value.pending,null);assert.equal(f.counts().closes,1);
});
test('native custody wraps random key, authenticates passphrase and metadata, and refuses reset',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'zkapi-custody-'));await chmod(dir,0o700);t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'key.json'),pass=new TextEncoder().encode('a long local passphrase never in argv');
  const key=await initializeJournalKey(path,pass);assert.deepEqual(await unlockJournalKey(path,pass),key);assert.equal((await readFile(path)).includes(Buffer.from(pass)),false);
  await assert.rejects(initializeJournalKey(path,pass));await assert.rejects(unlockJournalKey(path,new Uint8Array(32).fill(1)),/unlock/);
  const e=JSON.parse(await readFile(path,'utf8'));e.salt='00'.repeat(32);await writeFile(path,JSON.stringify(e));await assert.rejects(unlockJournalKey(path,pass),/unlock/);
});

test('actual Unix HTTP disconnect cancels upstream response and waits for stream finalizer',async t=>{
  const dir=await mkdtemp('/tmp/zkapi-cancel-'),socket=join(dir,'http.sock');t.after(()=>rm(dir,{recursive:true,force:true}));
  let resolveCancel!:()=>void;const canceled=new Promise<void>(resolve=>{resolveCancel=resolve;});
  const server=createServer(async(_req,res)=>{await writeNodeResponse(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: first\n\n'));},async cancel(){await new Promise(resolve=>setTimeout(resolve,20));resolveCancel();}})),res);});
  await new Promise<void>(resolve=>server.listen(socket,resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  await new Promise<void>((resolve,reject)=>{const req=request({socketPath:socket,path:'/'},res=>{res.once('data',()=>{res.destroy();resolve();});});req.once('error',reject);req.end();});
  await Promise.race([canceled,new Promise((_,reject)=>setTimeout(()=>reject(Error('disconnect did not cancel')),1000))]);
});

test('disconnect before upstream headers aborts inference and retains its non-replayable intent',async t=>{
  for(const mode of ['proxy','direct_oa'] as const){
    const f=await fixture(t,mode,0),abort=new AbortController(),id=crypto.randomUUID();
    let started!:()=>void;const sending=new Promise<void>(resolve=>{started=resolve;});
    f.pendingInference(signal=>new Promise<Response>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});started();}));
    const response=f.service.infer('/v1/responses',body,id,'',abort.signal);
    await sending;abort.abort();await assert.rejects(response);
    const saved=(await f.journal.read('note'))!.value;
    assert.equal(saved.pending,null);assert.equal(saved.history[0].operations[0].id,id);assert.equal(saved.history[0].operations[0].phase,'send_unknown');
    assert.deepEqual(f.counts(),{creates:1,closes:1,sends:1});await assert.rejects(f.service.infer('/v1/responses',body,id),DaemonConflict);
    assert.equal((await f.service.status() as any).in_flight,0);
  }
});

test('already disconnected Unix response cancels a late body without waiting for its first byte',async t=>{
  const dir=await mkdtemp('/tmp/zkapi-late-'),socket=join(dir,'http.sock');t.after(()=>rm(dir,{recursive:true,force:true}));
  let received!:()=>void,release!:()=>void,finished!:()=>void,peerClosed!:()=>void,canceled=false;
  const requestReceived=new Promise<void>(resolve=>{received=resolve;}),lateResponse=new Promise<void>(resolve=>{release=resolve;}),complete=new Promise<void>(resolve=>{finished=resolve;}),disconnected=new Promise<void>(resolve=>{peerClosed=resolve;});
  const server=createServer(async(_req,res)=>{res.once('close',peerClosed);received();await lateResponse;assert.equal(res.destroyed,true);await writeNodeResponse(new Response(new ReadableStream({cancel(){canceled=true;}})),res);finished();});
  await new Promise<void>(resolve=>server.listen(socket,resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const req=request({socketPath:socket,path:'/'});req.on('error',()=>{});req.end();await requestReceived;
  req.destroy();await disconnected;release();
  await Promise.race([complete,new Promise((_,reject)=>setTimeout(()=>reject(Error('late body was not canceled')),1000))]);assert.equal(canceled,true);
});
