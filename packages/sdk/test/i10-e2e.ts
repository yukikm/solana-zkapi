import {decodeRpcAccount} from '../src/solana-rpc.ts';
import {createSolanaRpcWithFetch} from '../src/solana.ts';
import {transactionSignature} from '../src/solana.ts';
import {fixtureSigner, signWith, decodeTransaction, kitAddress} from './kit-helpers.ts';
/** I10 local full lifecycle. The Rust integration test supplies the real control
 * App/PostgreSQL/signerd/dispatcherd. Only provider wire and finality are fixtures.
 * stdout is a private JSON protocol to that test; never print note/key material. */
/** I10 local full lifecycle. The Rust integration test supplies the real control
 * App/PostgreSQL/signerd/dispatcherd. Only provider wire and finality are fixtures.
 * stdout is a private JSON protocol to that test; never print note/key material. */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {createServer as createTlsServer, request as tlsRequest} from 'node:https';
import {once} from 'node:events';
import {mkdtemp, rm, readdir, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';

import bs58 from 'bs58';
import {WalletClient} from '../src/wallet.ts';
import {SolanaWalletChain} from '../src/wallet-chain.ts';
import {NoteProver} from '../src/prover.ts';
import {NativeProver} from '../src/prover-node.ts';
import {NativeSessionVerifier} from '../src/control-node.ts';
import {ControlClient, createCredentials, verifiedClientContext, validateNoteJournal,
  type NoteJournal, type Mode, type Tariff} from '../src/control.ts';
import {EncryptedJournal, importJournalKey} from '../src/journal.ts';
import {NativeJournalStore} from '../src/journal-node.ts';
import {verifyManifest, jcsBytes} from '../src/trust.ts';
import {buildUploadPlan, prepareAttempt, recoverAttempt, vaultAccounts, type Attempt, type UploadPlan, type TransportRpc, type V0Wallet} from '../src/transport.ts';
import {challengePlan} from '../src/challenger.ts';
import {encodeLayout2Args, hex} from '../src/layout2.ts';
import {parseField} from '../src/encoding.ts';
import {walletFixture, read, digest} from './wallet-fixture.ts';

const stdin = createInterface({input:process.stdin});
const input = stdin[Symbol.asyncIterator]();
const svm = spawn(resolve('tests/svm/target/debug/wallet'), [], {stdio:['pipe','pipe','pipe']});
let svmError = '';
svm.stderr.on('data', b => svmError += b);
const pending: {resolve(v:any):void; reject(e:unknown):void}[] = [];
createInterface({input:svm.stdout}).on('line', line => {
  const p = pending.shift(); if (p) {try {p.resolve(JSON.parse(line));} catch(e) {p.reject(e);}}
});
svm.on('exit', code => {for (const p of pending.splice(0)) p.reject(Error(`SBF exited ${code}: ${svmError}`));});
const call = (value:object) => new Promise<any>((resolve,reject) => {
  pending.push({resolve,reject}); svm.stdin.write(JSON.stringify(value)+'\n');
});
const fixture = await walletFixture();
// Optional exact bytes for a retained local fixture manifest. Production trust
// verification still checks every digest; CI normally uses its freshly built IDL.
const fixtureIdl=process.env.ZKAPI_I10_FIXTURE_IDL?await read(process.env.ZKAPI_I10_FIXTURE_IDL):fixture.artifacts.idl;
assert.equal(digest(fixtureIdl),fixture.manifest.idl_hash,'fixture IDL must match the existing manifest');
const base=fixture.manifest,artifacts={...fixture.artifacts,idl:fixtureIdl,
  additional:{...fixture.artifacts.additional,vault_idl:fixtureIdl}};
const directory = await mkdtemp(join(tmpdir(),'zkapi-i10-e2e-'));
const counts: Record<string,number> = {};
const count = (key:string) => counts[key] = (counts[key] ?? 0)+1;
const now = () => Math.floor(Date.now()/1000);
let origin = '', directOrigin = '', controlOrigin = '', routerKey:any, oaKey:any;
const streamGates=new Map<string,{release():void;cancelled:boolean;finalUsageSent:boolean}>();
const providerCases=new Map<string,number>();
const sharedSnapshotFiles=new Map<string,Uint8Array>();
let sharedSnapshotReads=0, sharedSnapshotDownloads=0, fixtureOaEvidenceMappings=0;
async function sharedSnapshotFixture(){
  // Read real SBF state for every note. This lifecycle requests authorization
  // only at active/closed cuts; refuse unsupported pending cuts rather than
  // inventing pending fields or omitting them from the pool-wide snapshot.
  const root=await call({kind:'root'}),next=Number(root.next_note_id),active_notes:any[]=[];
  assert.ok(Number.isSafeInteger(next)&&next>=0&&next<=16_384);
  for(let id=0;id<next;id++){
    const view=await call({kind:'snapshot',note_id:id});
    assert.equal(view.root,root.root);assert.equal(String(view.slot),root.slot);
    assert.equal(view.sequence,root.sequence);assert.equal(String(view.nextNoteId),root.next_note_id);
    assert.equal(view.note.note_id,id);assert.equal(view.pending,undefined);
    assert.ok(['active','closed'].includes(view.note.status),'shared fixture requires an active/closed cut');
    if(view.note.status==='active')active_notes.push({note_id:String(id),commitment:view.note.registration_commitment,
      deposit_micro_usdc:view.note.deposit_micro_usdc,expiry:view.note.expiry});
  }
  assert.deepEqual(await call({kind:'root'}),root,'one coherent SBF snapshot cut');
  const bytes=jcsBytes({schema_version:'1',snapshot:root,active_notes,pending_withdrawals:[]}),hash=digest(bytes);
  const previous=sharedSnapshotFiles.get(hash);if(previous)assert.deepEqual(previous,bytes);
  else sharedSnapshotFiles.set(hash,new Uint8Array(bytes));
  return {snapshot:root,sha256:hash,download_url:origin+'/zkapi/v1/tree/snapshots/'+hash+'.json'};
}
const reply = (res:ServerResponse, value:unknown) => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
const chatUsage={prompt_tokens:10,completion_tokens:5,total_tokens:15,prompt_tokens_details:{cached_tokens:2}};
const responsesUsage={input_tokens:7,output_tokens:1,total_tokens:8,input_tokens_details:{cached_tokens:0}};
const messagesUsage={input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0};
async function inferenceFixture(provider:string,path:string,b:any,res:ServerResponse){
  const marker=typeof b.input==='string'?b.input:Array.isArray(b.input)?b.input.find((v:any)=>v.role==='user')?.content:b.messages[0].content;
  assert.ok(typeof marker==='string'&&marker.startsWith('I10_PRIVATE_PROMPT:'));
  const variant=marker.split(':')[1],caseKey=provider+':'+variant;
  providerCases.set(caseKey,(providerCases.get(caseKey)??0)+1);count('inference_'+provider);
  if(variant.endsWith('http_error')){res.statusCode=503;reply(res,{error:{message:'I10_PRIVATE_RESPONSE i10-provider-secret'}});return;}
  if(path==='/v1/messages/count_tokens'){assert.equal(b.max_tokens,undefined);reply(res,{input_tokens:10});return;}
  const responseApi=path.endsWith('/responses'),anthropic=path==='/v1/messages';
  if(variant.includes('tools')){
    assert.equal(b.tools[0].name??b.tools[0].function?.name,'lookup');
    if(responseApi)assert.ok(b.input.some((v:any)=>v.type==='function_call_output'));
    else if(anthropic)assert.ok(b.messages.some((v:any)=>Array.isArray(v.content)&&v.content.some((c:any)=>c.type==='tool_result')));
    else assert.ok(b.messages.some((v:any)=>v.role==='tool'));
  }
  if(responseApi){assert.equal(b.store,false);assert.equal(b.background,false);}
  if(b.stream){
    if(!anthropic&&!responseApi)assert.equal(b.stream_options.include_usage,true);
    let release!:()=>void;
    const wait=new Promise<void>(r=>release=r),gate={release,cancelled:false,finalUsageSent:false};
    if(variant.endsWith('disconnect'))streamGates.set(caseKey,gate);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const event=(name:string,value:unknown)=>`${name?'event: '+name+'\n':''}data: ${JSON.stringify(value)}\n\n`;
    const id='i10-'+caseKey;
    if(responseApi){res.write(event('response.created',{type:'response.created',response:{id}}));res.write(event('response.output_text.delta',{type:'response.output_text.delta',delta:'I10_PRIVATE_RESPONSE'}));if(variant.includes('tools'))res.write(event('response.output_item.added',{type:'response.output_item.added',output_index:1,item:{type:'function_call',id:'fc_i10',call_id:'call_i10',name:'lookup',arguments:''}})+event('response.function_call_arguments.delta',{type:'response.function_call_arguments.delta',item_id:'fc_i10',output_index:1,delta:'{}'}));}
    else if(anthropic){res.write(event('message_start',{type:'message_start',message:{id,usage:{...messagesUsage,output_tokens:0}}}));res.write(event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'I10_PRIVATE_RESPONSE'}}));if(variant.includes('tools'))res.write(event('content_block_start',{type:'content_block_start',index:1,content_block:{type:'tool_use',id:'call_i10',name:'lookup',input:{}}})+event('content_block_delta',{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{}'}}));}
    else res.write(event('',{id,choices:[{delta:{content:'I10_PRIVATE_RESPONSE',...(variant.includes('tools')?{tool_calls:[{index:0,id:'call_i10',type:'function',function:{name:'lookup',arguments:'{}'}}]}:{})}}],usage:null}));
    if(variant.endsWith('disconnect')){await wait;assert.equal(gate.cancelled,true);}
    else await new Promise(r=>setTimeout(r,20));
    if(variant.endsWith('truncated_sse')){res.end();return;}
    gate.finalUsageSent=true;
    if(responseApi)res.end(event('response.completed',{type:'response.completed',response:{id,status:'completed',usage:responsesUsage}}));
    else if(anthropic)res.end(event('message_delta',{type:'message_delta',usage:{output_tokens:5}})+event('message_stop',{type:'message_stop'}));
    else res.end(event('',{id,choices:[],usage:chatUsage})+'data: [DONE]\n\n');
    return;
  }
  const id='i10-'+caseKey,tools=variant.endsWith('tools'),missing=variant.endsWith('missing_usage');
  if(responseApi)reply(res,{id,object:'response',status:'completed',error:null,output:tools?[{type:'function_call',id:'fc_i10',call_id:'call_i10',name:'lookup',arguments:'{}'}]:[{type:'message',role:'assistant',content:[{type:'output_text',text:'I10_PRIVATE_RESPONSE'}]}],...(!missing?{usage:responsesUsage}:{})});
  else if(anthropic)reply(res,{id,type:'message',role:'assistant',content:tools?[{type:'tool_use',id:'call_i10',name:'lookup',input:{}}]:[{type:'text',text:'I10_PRIVATE_RESPONSE'}],stop_reason:tools?'tool_use':'end_turn',usage:messagesUsage});
  else reply(res,{id,object:'chat.completion',choices:[{message:{role:'assistant',content:'I10_PRIVATE_RESPONSE',...(tools?{tool_calls:[{id:'call_i10',type:'function',function:{name:'lookup',arguments:'{}'}}]}:{})}}],usage:chatUsage});
}
const handler = async (req:IncomingMessage,res:ServerResponse) => {
  try {
    const chunks:Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(); const b = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    if (path === '/rpc') {
      const a=b.params; let result:any;
      switch(b.method) {
        case 'getGenesisHash':result=base.genesis_hash;break;
        case 'getSlot':result=Number((await call({kind:'root'})).slot);break;
        case 'getBlock':result={blockhash:bs58.encode(new Uint8Array(32).fill(1)),previousBlockhash:bs58.encode(new Uint8Array(32).fill(1)),parentSlot:a[0]-1,blockTime:now(),blockHeight:a[0]};break;
        case 'getMultipleAccounts':result=await call({kind:'accounts',addresses:a[0]});break;
        case 'getAccountInfo':{const cut=await call({kind:'accounts',addresses:[a[0]]});result={context:cut.context,value:cut.value[0]};break;}
        case 'getLatestBlockhash':result={context:{slot:100},value:await call({kind:'blockhash'})};break;
        default:throw Error('unexpected RPC '+b.method);
      }
      reply(res,{jsonrpc:'2.0',id:b.id,result});return;
    }
    if(path==='/zkapi/v1/tree/snapshot'){
      assert.equal(req.method,'GET');sharedSnapshotReads++;reply(res,await sharedSnapshotFixture());return;
    }
    if(/^\/zkapi\/v1\/tree\/snapshots\/[0-9a-f]{64}\.json$/.test(path)){
      assert.equal(req.method,'GET');const bytes=sharedSnapshotFiles.get(path.split('/').at(-1)!.slice(0,-5));
      if(!bytes){res.writeHead(404);res.end();return;}
      sharedSnapshotDownloads++;res.setHeader('Content-Type','application/json');res.end(Buffer.from(bytes));return;
    }
    if(path==='/zkapi/v1/tree/root'){reply(res,await call({kind:'root'}));return;}
    if(path.startsWith('/zkapi/v1/tree/notes/')){reply(res,await call({kind:'path',note_id:Number(path.split('/')[5])}));return;}
    // Explicit fixture wire for all three proxy adapters and both direct modes.
    if(path==='/v1/chat/completions'||path==='/api/v1/chat/completions'||path==='/inference/chat/completions'||path==='/v1/responses') {
      const provider=path==='/v1/chat/completions'?'openai':path==='/inference/chat/completions'?'oa':req.headers.authorization==='Bearer i10-openrouter-runtime'?'direct_openrouter':'openrouter';
      const actualProvider=path==='/v1/responses'?'openai':provider;
      assert.equal(req.headers.authorization,'Bearer '+({openai:'i10-provider-secret',openrouter:'i10-provider-secret',oa:'i10-oa-runtime',direct_openrouter:'i10-openrouter-runtime'}[actualProvider]));
      await inferenceFixture(actualProvider,path,b,res);return;
    }
    if(path==='/v1/messages'||path==='/v1/messages/count_tokens') {
      assert.equal(req.headers['x-api-key'],'i10-provider-secret');assert.equal(req.headers['anthropic-version'],'2023-06-01');
      await inferenceFixture('anthropic',path,b,res);return;
    }
    if(path==='/api/v1/keys'&&req.method==='POST') {
      assert.equal(req.headers.authorization,'Bearer i10-provider-secret');count('openrouter_create');
      routerKey={...b,hash:'i10-router-reference',disabled:false,usage:0,byok_usage:0};
      reply(res,{key:'i10-openrouter-runtime',data:routerKey});return;
    }
    if(path==='/api/v1/keys/i10-router-reference') {
      assert.equal(req.headers.authorization,'Bearer i10-provider-secret');
      if(req.method==='PATCH'){assert.equal(b.disabled,true);count('openrouter_disable');routerKey.disabled=true;reply(res,{data:routerKey});return;}
      assert.equal(routerKey.disabled,true);
      if(req.method==='GET'){count('openrouter_usage');reply(res,{data:{...routerKey,usage:0.000001234,byok_usage:0.0000000011}});return;}
      if(req.method==='DELETE'){assert.equal(counts.openrouter_usage,1);count('openrouter_delete');reply(res,{deleted:true});return;}
    }
    if(path==='/api/zkapi/request_key') {
      assert.equal(req.headers.authorization,'Bearer i10-provider-secret');count('oa_create');
      oaKey={...b,expiry:now()+60};
      reply(res,{source:'oa_org',key:'i10-oa-runtime',key_hash:'i10-oa-reference',credit_limit:b.credit_limit,duration_minutes:b.duration_minutes,expires_at_unix:oaKey.expiry,station_id:'i10-station',station_recently_attested:true,station_signature:'ab'.repeat(64),org_signature:'cd'.repeat(64),verifier_url:origin,openrouter_api_base:directOrigin+'/inference'});return;
    }
    if(path==='/submit_key'){assert.equal(b.api_key,'i10-oa-runtime');assert.equal(req.headers.authorization,undefined);count('oa_verify');reply(res,{status:'verified'});return;}
    if(path==='/api/zkapi/key_usage') {
      assert.equal(req.headers.authorization,'Bearer i10-provider-secret');count('oa_retire_usage');
      reply(res,{source:'oa_org',version:1,status:'finalized',client_request_id:b.client_request_id,station_request_id:createHash('sha256').update('oa-org:zkapi:v1:'+b.client_request_id).digest('hex'),key_hash:'i10-oa-reference',usage_credits:3,credit_limit_credits:1000000,expires_at_unix:oaKey.expiry,closed_at_unix:now(),finalized_at_unix:now(),station_id:'i10-station',station_signature:'ab'.repeat(64),org_signature:'cd'.repeat(64)});return;
    }
    throw Error('unexpected fixture endpoint '+path);
  } catch(e) {process.stderr.write(String(e)+'\n');res.writeHead(500);res.end('{"error":"local fixture failure"}');}
};
const primary=createServer(handler),secondary=createServer(handler);
// SDK direct bases require HTTPS. Pin this disposable local CA only for the
// fixture origin, leaving the SDK's production origin validation untouched.
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'tls-key.pem'),'-out',join(directory,'tls-cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
const tlsCa=await readFile(join(directory,'tls-cert.pem'));
const directServer=createTlsServer({key:await readFile(join(directory,'tls-key.pem')),cert:tlsCa},handler);
const listen=async(server:ReturnType<typeof createServer>|ReturnType<typeof createTlsServer>,scheme='http')=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `${scheme}://127.0.0.1:${(server.address() as any).port}`;};
const fixtureFetch:typeof fetch=async(url,init)=>{
  // The OpenRouter adapter deliberately pins its HTTPS inference URL to the
  // public canonical base. Inject only this exact test route into local TLS;
  // never contact that provider or relax either production origin check.
  if(String(url)==='https://openrouter.ai/api/v1/chat/completions')url=directOrigin+'/api/v1/chat/completions';
  if(!String(url).startsWith(directOrigin+'/')){
    assert.equal(new URL(String(url)).origin,controlOrigin,'fixture fetch refuses non-local or unlisted provider routes');
    const response=await fetch(url,init);
    if(String(url)===controlOrigin+'/zkapi/v1/sessions'&&init?.method==='POST'&&response.ok){
      const body=await response.clone().json();
      if(body.mode==='direct_oa'&&body.provider_key!==undefined){
        // The Rust provider fixture verifies over its numeric-loopback HTTP
        // origin. Explicitly map only that synthetic verifier metadata to this
        // fixture's CA-pinned TLS endpoint for the SDK's independent check.
        // AUTH, proof, receipt and signed successor bytes are never rewritten.
        assert.equal(body.provider_key_verification.verifier_url,origin);
        assert.equal(body.provider_key_verification.station_id,'i10-station');
        assert.equal(body.provider_api_origin,directOrigin+'/inference');
        body.provider_key_verification.verifier_url=directOrigin;fixtureOaEvidenceMappings++;
        await response.body?.cancel();return Response.json(body,{status:response.status});
      }
    }
    return response;
  }
  if(String(url)===directOrigin+'/submit_key'){
    assert.equal(init?.method,'POST');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    assert.equal(new Headers(init?.headers).has('Authorization'),false);
  }
  return new Promise<Response>((resolve,reject)=>{
    const headers:Record<string,string>={};new Headers(init?.headers).forEach((value,key)=>headers[key]=value);
    const request=tlsRequest(String(url),{ca:tlsCa,method:init?.method,headers,signal:init?.signal??undefined},response=>{
      const parts:Buffer[]=[];response.on('data',chunk=>parts.push(chunk));response.on('error',reject);
      response.on('end',()=>resolve(new Response(Buffer.concat(parts),{status:response.statusCode,headers:{'Content-Type':'application/json'}})));
    });
    request.on('error',reject);request.end(init?.body);
  });
};
interface InferenceCase {name:string;path:string;expectedNano:number;status:number;unknown:boolean;stream:boolean;disconnect:boolean;tools:boolean}
function caseDefinition(name:string,path:string):InferenceCase{
  const unknown=/http_error|missing_usage|truncated_sse/.test(name);
  return {name,path,expectedNano:unknown||path.endsWith('count_tokens')?0:path.endsWith('responses')?8:15,status:unknown&&!name.endsWith('truncated_sse')?502:200,unknown,stream:/sse|disconnect/.test(name),disconnect:name.endsWith('disconnect'),tools:name.includes('tools')};
}
function casesFor(provider:string,mode:Mode):InferenceCase[]{
  if(mode!=='proxy')return [caseDefinition('chat_plain','/v1/chat/completions')];
  const chat=(name:string)=>caseDefinition('chat_'+name,'/v1/chat/completions');
  const messages=(name:string)=>caseDefinition('messages_'+name,'/v1/messages');
  const responses=(name:string)=>caseDefinition('responses_'+name,'/v1/responses');
  if(provider==='openai')return ['plain','tools','sse','tools_sse','disconnect'].map(chat).concat(['plain','tools','sse','tools_sse','disconnect'].map(responses),[chat('http_error'),responses('missing_usage')]);
  if(provider==='anthropic')return ['plain','tools','sse','tools_sse','disconnect'].map(messages).concat([caseDefinition('count_tokens','/v1/messages/count_tokens'),messages('http_error'),messages('truncated_sse')]);
  return ['plain','tools','sse','tools_sse','disconnect','http_error'].map(chat);
}
function caseBody(test:InferenceCase,model:string):Uint8Array{
  const marker='I10_PRIVATE_PROMPT:'+test.name,body:any={model};
  const user={role:'user',content:marker};
  if(test.path==='/v1/responses'){
    body.input=test.tools?[user,{type:'function_call',id:'fc_prior',status:'completed',call_id:'call_prior',name:'lookup',arguments:'{}'},{type:'function_call_output',call_id:'call_prior',output:'client result'}]:marker;
    body.max_output_tokens=40;
    if(test.tools)body.tools=[{type:'function',name:'lookup',parameters:{type:'object',properties:{}}}];
  }else{
    body.messages=[user];
    if(test.path==='/v1/chat/completions'){
      body.max_completion_tokens=40;
      if(test.tools){body.tools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{}}}}];body.messages.push({role:'assistant',content:null,tool_calls:[{id:'call_prior',type:'function',function:{name:'lookup',arguments:'{}'}}]},{role:'tool',tool_call_id:'call_prior',content:'client result'});}
    }else if(!test.path.endsWith('count_tokens')){
      body.max_tokens=40;
      if(test.tools){body.tools=[{name:'lookup',input_schema:{type:'object',properties:{}}}];body.messages.push({role:'assistant',content:[{type:'tool_use',id:'call_prior',name:'lookup',input:{}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'call_prior',content:'client result'}]});}
    }
  }
  if(test.stream)body.stream=true;
  return new TextEncoder().encode(JSON.stringify(body));
}
try {
  origin=await listen(primary);const second=await listen(secondary);directOrigin=await listen(directServer,'https');
  await call({kind:'clock',time:now()});
  process.stdout.write(JSON.stringify({ready:true,origin,secondary:second,direct_origin:directOrigin,manifest:base})+'\n');
  const configuration=JSON.parse((await input.next()).value!);
  const m=configuration.manifest;
  controlOrigin=m.control_api_origin;
  const manifest=await verifyManifest(new TextEncoder().encode(JSON.stringify(m)),{anchor:{kind:'hash',sha256:m.manifest_hash},expected:{deployment_id:m.deployment_id,deployment_environment:m.deployment_environment,genesis_hash:m.genesis_hash,program_id:m.program_id,pool:m.pool,mint:m.mint,token_program:m.token_program,control_api_origin:m.control_api_origin,inference_api_origin:m.inference_api_origin},build:{stateKey:m.state_key,clearanceKey:m.clearance_key,circuitProfileHash:m.circuit_profile_hash,idlHash:m.idl_hash,setupProfile:m.setup_profile}});
  const proverBinary=resolve('apps/clientd/prover/target/release/zkapi-client-prover');
  const prover=await NoteProver.create(manifest,artifacts,new NativeProver(proverBinary,digest(await read(proverBinary))));
  const verifierBinary=resolve('apps/clientd/companion/target/debug/zkapi-client-verify');
  const verifier=new NativeSessionVerifier(verifierBinary,digest(await read(verifierBinary)));
  const key=await importJournalKey(crypto.getRandomValues(new Uint8Array(32)));
  const open=async()=>new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(directory),key,{deploymentId:manifest.deployment_id,pool:manifest.pool},validateNoteJournal);
  let journal=await open();
  const connection=createSolanaRpcWithFetch(origin+'/rpc', fetch);
  const observedPool=await connection.getAccountInfo(kitAddress(manifest.pool),{encoding:"base64",commitment:"finalized"}).send();
  const pool={context:{slot:Number(observedPool.context.slot)},value:decodeRpcAccount(observedPool.value)};
  const chain=new SolanaWalletChain(connection,manifest,origin,{allowLoopbackHttp:true});

  const context=await verifiedClientContext(manifest,manifest.genesis_hash,{address:manifest.pool,owner:pool.value!.owner,executable:pool.value!.executable,lamports:BigInt(pool.value!.lamports),data:pool.value!.data,slot:BigInt(pool.context.slot),commitment:'finalized'},0n,artifacts);
  const pair=(await fixtureSigner(new Uint8Array(32).fill(1)));
  const wallet:V0Wallet={publicKey:pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(tx){tx = await signWith(tx, [pair]);return tx;}};
  const address=pair.address,roles={payer:address,uploader:address,feePayer:address,rentPayer:address,tokenOwner:address};
  let loseSend=true;
  const sends:string[]=[];
  const rpc:TransportRpc={signatureStatus:async()=>null,finalizedBlockHeight:async()=>100,finalizedReceipt:async(signature)=>{const v=await call({kind:'receipt',signature});return v?{...v,message:new Uint8Array(Buffer.from(v.message,'base64'))}:null;},sendRawTransaction:async(bytes)=>{
    const signature=transactionSignature(decodeTransaction(bytes));
    const r=(await journal.read('note'))!;
    assert.ok(r.value.wallet!.operation!.attempts.some(a=>a.signature===signature&&a.wireHex===Buffer.from(bytes).toString('hex')),'persist exact signed bytes before execution');
    sends.push(signature);const result=await call({kind:'send',base64:Buffer.from(bytes).toString('base64')});
    if(loseSend){loseSend=false;throw Error('local finalized send response lost');}return result.signature;
  }};
  let walletClient=new WalletClient({manifest,prover,journal,chain,rpc,wallets:[wallet]});
  const drive=async()=>{for(let i=0;i<80;i++){const r=await walletClient.advance('note');if(r.state==='complete')return;if(r.state==='proof_required')await walletClient.resumeProof('note');assert.notEqual(r.state,'rejected');}throw Error('wallet did not complete');};
  await walletClient.beginDeposit('note','5000000',roles);
  assert.equal((await walletClient.advance('note')).state,'unknown');
  journal=await open();walletClient=new WalletClient({manifest,prover,journal,chain,rpc,wallets:[wallet]});await drive();
  assert.equal(sends.filter(s=>s===sends[0]).length,1,'finalized lost send recovered without duplicate execution');
  assert.equal((await journal.read('note'))!.value.wallet!.status,'active');
  const witness=structuredClone((await journal.read('note'))!.value.witness!);
  const options=()=>({context,journal,verifier,fetch:fixtureFetch,allowLoopbackHttp:true,oaVerifier:{base:directOrigin,stationId:'i10-station'},directProviderBases:{direct_oa:directOrigin+'/inference',direct_openrouter:'https://openrouter.ai/api/v1'}});
  let client=new ControlClient(options());
  const modes:any[]=[],cases:any[]=[];
  for(const tariff of configuration.tariffs as Tariff[]) {
    const mode:Mode=tariff.model==='*'?(tariff.provider==='oa'?'direct_oa':'direct_openrouter'):'proxy';
    const before=(await journal.read('note'))!.value;
    const quote=await client.quote({mode,provider:tariff.provider as any,models:[tariff.model],session_ttl_seconds:'60'},tariff);
    const snapshot=await chain.sessionSnapshot(witness.note_id,prover);
    const prepared=await prover.prepareSession(witness,before.state,snapshot.root,snapshot.siblings,quote,tariff,await createCredentials(mode));
    await client.prepare('note',prepared,snapshot.root);
    const status=await client.submit('note');assert.equal(status.state,'ACTIVE');
    const modeCases=casesFor(tariff.provider,mode),accepted:any[]=[];
    for(const test of modeCases){
      const id=crypto.randomUUID(),body=caseBody(test,tariff.model==='*'?'i10-model':tariff.model);
      let response:Response;
      if(mode==='proxy'){await client.prepareOperation('note',id,test.path,body,tariff.provider==='anthropic'?'2023-06-01':'');response=await client.sendOperation('note',id);}
      else response=await client.sendDirectOperation('note',id,test.path,body);
      if(response.status!==test.status)process.stderr.write('I10 fixture counts at failure: '+JSON.stringify(counts)+'\n');
      assert.equal(response.status,test.status,`${mode}/${tariff.provider}/${test.name}: ${response.headers.get('x-zkapi-error-code')??'no-error-code'}`);
      const fixtureProvider=mode==='direct_openrouter'?'direct_openrouter':tariff.provider;
      const fixtureCase=fixtureProvider+':'+test.name;
      if(test.disconnect){
        const reader=response.body!.getReader(),chunk=await reader.read();assert.equal(chunk.done,false);assert.ok(chunk.value!.length>0);
        const gate=streamGates.get(fixtureCase)!;assert.ok(gate);assert.equal(gate.finalUsageSent,false,'final usage is gated until the client disconnects');
        await reader.cancel();gate.cancelled=true;gate.release();
      }else{
        const text=await response.text();
        assert.equal(text.includes('i10-provider-secret'),false,'provider error must not echo credentials');
        if(test.status===502){assert.equal(text.includes('I10_PRIVATE_RESPONSE'),false);assert.ok(text.includes('Provider result unavailable'));}
        else if(test.stream){assert.ok(text.includes('I10_PRIVATE_RESPONSE'));assert.ok(text.includes(test.unknown?'error':test.path==='/v1/responses'?'response.completed':test.path==='/v1/messages'?'message_stop':'[DONE]'));if(test.tools)assert.ok(text.includes('"name":"lookup"'),'streamed tool call reaches the caller');}
        else if(test.path.endsWith('count_tokens'))assert.equal(JSON.parse(text).input_tokens,10);
        else if(test.tools){const result=JSON.parse(text);assert.equal(test.path==='/v1/responses'?result.output[0].name:test.path==='/v1/messages'?result.content[0].name:result.choices[0].message.tool_calls[0].function.name,'lookup');}
        else assert.ok(text.includes('I10_PRIVATE_RESPONSE'));
      }
      if(mode==='proxy'){
        let operation:any;
        for(let i=0;i<200;i++){operation=await client.operationStatus('note',id);if(operation.state===(test.unknown?'USAGE_UNKNOWN':'DONE'))break;await new Promise(r=>setTimeout(r,20));}
        assert.equal(operation.state,test.unknown?'USAGE_UNKNOWN':'DONE',test.name+' terminal provider observation');
        await assert.rejects(client.sendOperation('note',id),/replay/);
      }else await assert.rejects(client.sendDirectOperation('note',id,test.path,body),/replayed/);
      assert.equal(providerCases.get(fixtureCase),1,'one upstream send per explicit operation');
      if(test.disconnect)assert.equal(streamGates.get(fixtureCase)!.finalUsageSent,true,'upstream metering completes after downstream cancel');
      accepted.push({test,id,fixtureCase});
    }
    await client.close('note');
    // Reopen the same encrypted record and verify terminal receipts/successor
    // with the actual native verifier. Recovery never calls inference again.
    journal=await open();client=new ControlClient(options());
    for(let i=0;(await journal.read('note'))!.value.pending&&i<100;i++){await new Promise(r=>setTimeout(r,30));await client.recover('note');}
    const after=(await journal.read('note'))!.value;assert.equal(after.pending,null);assert.deepEqual(after.witness,witness);
    const history=after.history.at(-1)!;
    assert.equal(history.prepared.request.authorization.mode,mode);assert.equal(history.receipts.length,mode==='proxy'?modeCases.length:1);assert.equal(history.operations.length,modeCases.length);
    const expected=mode==='proxy'?1:mode==='direct_oa'?3:2;
    assert.equal(history.settlement.charge_micro_usdc,String(expected));
    assert.equal(BigInt(before.state.balance_micro_usdc)-BigInt(after.state.balance_micro_usdc),BigInt(expected));
    assert.notEqual(after.state.anchor,before.state.anchor);
    for(const {test,id,fixtureCase} of accepted){
      const receipt=mode==='proxy'?history.receipts.find(r=>r.body.operation_id===id)!:history.receipts[0];assert.ok(receipt);
      if(mode==='proxy'){
        assert.equal(receipt.body.charged_nano_usdc,String(test.expectedNano));
        assert.equal(receipt.body.evidence_kind,test.unknown?'UNKNOWN_OPERATOR_LOSS':'PROXY_USAGE');
        assert.equal(receipt.body.reason,test.unknown?'waived_unknown':'metered');
        if(test.unknown)assert.equal(receipt.body.observed_nano_usdc,null);
        else assert.equal(receipt.body.observed_nano_usdc,String(test.expectedNano));
        if(test.path.endsWith('count_tokens')){assert.equal(receipt.body.reservation_nano_usdc,'0');assert.ok((receipt.body.usage as any[]).every(unit=>unit.count==='0'),'count_tokens never becomes billed inference usage');}
      }
      cases.push({mode,provider:tariff.provider,variant:test.name,endpoint:test.path,request_id:prepared.request.authorization.request_id,operation_id:id,http_status:test.status,provider_calls:providerCases.get(fixtureCase),receipt_verified:true,reservation_nano_usdc:receipt.body.reservation_nano_usdc,charged_nano_usdc:receipt.body.charged_nano_usdc,evidence_kind:receipt.body.evidence_kind,expected_operation_state:mode==='proxy'?(test.unknown?'WAIVED_OPERATOR_LOSS':'DONE'):null,disconnect_before_final_usage:test.disconnect,automatic_replays:0});
    }
    modes.push({mode,provider:tariff.provider,request_id:prepared.request.authorization.request_id,operation_ids:accepted.map(x=>x.id),charge_micro_usdc:String(expected),receipts_verified:history.receipts.length,real_request_proof:true,signed_successor_verified:true,inference_sends:modeCases.length,variants:modeCases.map(x=>x.name)});
    process.stderr.write(`I10 ${mode}/${tariff.provider}: receipt and successor verified\n`);
  }
  assert.equal((await journal.read('note'))!.value.history.length,5);
  assert.equal(sharedSnapshotReads,5);assert.equal(sharedSnapshotDownloads,5);
  const retainedSnapshot=[...sharedSnapshotFiles.entries()][0];assert.ok(retainedSnapshot);
  assert.deepEqual(counts,{inference_openai:12,inference_anthropic:8,inference_openrouter:6,oa_create:1,oa_verify:2,inference_oa:1,oa_retire_usage:1,openrouter_create:1,inference_direct_openrouter:1,openrouter_disable:1,openrouter_usage:1,openrouter_delete:1});
  assert.equal(fixtureOaEvidenceMappings,1,'one fixture-only OA verifier metadata mapping');
  assert.equal(cases.length,28);assert.equal(cases.filter(c=>c.disconnect_before_final_usage).length,4);
  // An adversarial stale client can retain the pre-authorization witness even
  // though WalletClient correctly forbids an escape while that session is open.
  // Exercise that on-chain race with existing low-level SDK plans, never by
  // mutating the ordinary client's journal or introducing another state machine.
  const raceBefore=(await journal.read('note'))!.value;
  const raceTariff=(configuration.tariffs as Tariff[]).find(t=>t.provider==='openai')!;
  const raceQuote=await client.quote({mode:'proxy',provider:'openai',models:['i10-model'],session_ttl_seconds:'60'},raceTariff);
  await call({kind:'clock',time:now()});
  const raceSnapshot=await chain.snapshot(witness.note_id,'active');
  const racePrepared=await prover.prepareSession(witness,raceBefore.state,raceSnapshot.root,raceSnapshot.siblings,raceQuote,raceTariff,await createCredentials('proxy'));
  await client.prepare('note',racePrepared,raceSnapshot.root);
  assert.equal((await client.submit('note')).state,'ACTIVE');
  const directTariff=(configuration.tariffs as Tariff[]).find(t=>t.provider==='oa')!;
  const directQuote=await client.quote({mode:'direct_oa',provider:'oa',models:['*'],session_ttl_seconds:'60'},directTariff);
  const refusedPrepared=await prover.prepareSession(witness,raceBefore.state,raceSnapshot.root,raceSnapshot.siblings,directQuote,directTariff,await createCredentials('direct_oa'));
  const destination=kitAddress(new Uint8Array(32).fill(7));
  const escapeAuth=await prover.withdrawal(witness,raceBefore.state,raceSnapshot.root,raceSnapshot.siblings,destination,null);
  assert.equal(escapeAuth.public_inputs[11],racePrepared.request.public_inputs[8],'escape consumes the accepted authorization nullifier');
  const raceNote={note_id:witness.note_id,registration_commitment:raceSnapshot.note!.registration_commitment,deposit_micro_usdc:witness.deposit_micro_usdc,expiry:witness.expiry};
  const escapeTree=await prover.tree(raceNote,raceSnapshot.root,raceSnapshot.siblings,1);
  const programId=kitAddress(manifest.program_id),poolId=kitAddress(manifest.pool),mint=kitAddress(manifest.mint);
  const escapePlan=await buildUploadPlan({programId,pool:poolId,uploader:pair.address,rentPayer:pair.address,feePayer:pair.address,nonce:crypto.getRandomValues(new Uint8Array(32)),expires:BigInt(raceSnapshot.clock)+3600n,operation:'initiate_escape',payload:encodeLayout2Args({operation:'initiate_escape',auth:escapeAuth,tree:escapeTree}),snapshot:{slot:raceSnapshot.slot,sequence:BigInt(raceSnapshot.sequence)},financial:(await vaultAccounts({programId,pool:poolId,mint,payer:pair.address,noteId:witness.note_id,operation:'initiate_escape',destinationOwner:destination,nullifier:parseField(escapeAuth.public_inputs[11])}))});
  const attemptJournal=new EncryptedJournal<Attempt>(await NativeJournalStore.open(directory),key,{deploymentId:manifest.deployment_id,pool:manifest.pool},(value:unknown):asserts value is Attempt=>{assert.equal((value as Attempt)?.schema,1);assert.equal(typeof(value as Attempt)?.signature,'string');});
  const raceRpc:TransportRpc={...rpc,sendRawTransaction:async(bytes)=>{
    const signature=transactionSignature(decodeTransaction(bytes));
    const saved=await attemptJournal.read('race-'+signature);assert.equal(saved!.value.wireHex,hex(bytes),'persist exact signed race transaction before sending');
    return (await call({kind:'send',base64:Buffer.from(bytes).toString('base64')})).signature;
  }};
  const sendPlan=async(plan:UploadPlan)=>{
    const signatures:string[]=[];
    for(const step of plan.steps){
      const attempt=await prepareAttempt(plan,step,await chain.blockhash(),[wallet],{save:async(value)=>{await attemptJournal.create('race-'+value.signature,value);}});
      assert.equal((await recoverAttempt(attempt,raceRpc,true)).state,'pending');
      const recovered=await recoverAttempt(attempt,raceRpc);assert.equal(recovered.state,'finalized',JSON.stringify(recovered));signatures.push(attempt.signature);
    }
    return signatures;
  };
  const providerBeforeRace=structuredClone(counts),escapeSignatures=await sendPlan(escapePlan);
  const escaped=await chain.snapshot(witness.note_id,'zero');
  assert.equal(escaped.note!.status,'pending_escape');assert.equal(escaped.pending!.nullifier,escapeAuth.public_inputs[11]);
  assert.equal(escaped.pending!.balance_micro_usdc,raceBefore.state.balance_micro_usdc);assert.notEqual(escaped.root,raceSnapshot.root);
  const exitAddress=escapePlan.financial.exit,exitBeforeChallenge=decodeRpcAccount((await connection.getAccountInfo(exitAddress,{encoding:'base64',commitment:'finalized'}).send()).value);
  assert.ok(exitBeforeChallenge);assert.equal(exitBeforeChallenge.data.length,11);assert.equal(exitBeforeChallenge.data[10],1);
  const raceOperation=crypto.randomUUID(),raceBody=caseBody(caseDefinition('chat_escape_blocked','/v1/chat/completions'), 'i10-model');
  await client.prepareOperation('note',raceOperation,'/v1/chat/completions',raceBody);
  const blocked=await client.sendOperation('note',raceOperation);
  assert.equal(blocked.status,503);assert.equal(blocked.headers.get('x-zkapi-error-code'),'operation_unavailable');await blocked.body?.cancel();
  const refused=await fixtureFetch(controlOrigin+'/zkapi/v1/sessions',{method:'POST',headers:{Authorization:'Bearer '+refusedPrepared.control_token,'Content-Type':'application/json'},body:JSON.stringify(refusedPrepared.request)});
  assert.equal(refused.status,409);assert.equal((await refused.json()).error.code,'exit_consumed');
  assert.deepEqual(counts,providerBeforeRace,'actual exit must prevent both inference egress and new direct issuance');
  const challengeTree=await prover.tree(raceNote,escaped.root,escaped.siblings,2);
  const challengePayload=encodeLayout2Args({operation:'challenge_escape',noteId:witness.note_id,auth:{public_inputs:racePrepared.request.public_inputs,proof_wire_hex:Buffer.from(racePrepared.request.proof.proof,'base64').toString('hex')},tree:challengeTree});
  const challenge=await challengePlan({programId:manifest.program_id,pool:manifest.pool,mint:manifest.mint,payer:address,noteId:witness.note_id,payloadHex:hex(challengePayload),nonceHex:hex(crypto.getRandomValues(new Uint8Array(32))),expires:(BigInt(escaped.clock)+3600n).toString(),slot:escaped.slot,sequence:escaped.sequence});
  const challengeSignatures=await sendPlan(challenge),restored=await chain.snapshot(witness.note_id,'active');
  assert.equal(restored.root,raceSnapshot.root);assert.equal(restored.pending,undefined);assert.equal(restored.note!.status,'active');
  assert.deepEqual((decodeRpcAccount((await connection.getAccountInfo(exitAddress,{encoding:'base64',commitment:'finalized'}).send()).value))!.data,exitBeforeChallenge.data,'the consumed nullifier tombstone survives a successful challenge');
  await client.close('note');
  journal=await open();client=new ControlClient(options());
  for(let i=0;(await journal.read('note'))!.value.pending&&i<100;i++){await new Promise(r=>setTimeout(r,30));await client.recover('note');}
  const raceAfter=(await journal.read('note'))!.value,raceHistory=raceAfter.history.at(-1)!;
  assert.equal(raceAfter.pending,null);assert.equal(raceAfter.history.length,6);assert.equal(raceHistory.settlement.charge_micro_usdc,'0');
  assert.equal(raceAfter.state.balance_micro_usdc,raceBefore.state.balance_micro_usdc);assert.notEqual(raceAfter.state.anchor,raceBefore.state.anchor);
  assert.equal(raceHistory.receipts.length,1);const raceReceipt=raceHistory.receipts[0].body;
  assert.equal(raceReceipt.operation_id,raceOperation);assert.equal(raceReceipt.evidence_kind,'NOT_DISPATCHED');assert.equal(raceReceipt.reason,'not_dispatched');assert.equal(raceReceipt.charged_nano_usdc,'0');
  assert.deepEqual(counts,providerBeforeRace);
  const exitRace={request_id:racePrepared.request.authorization.request_id,operation_id:raceOperation,rejected_issuance_request_id:refusedPrepared.request.authorization.request_id,accepted_real_request_proof:true,actual_sbf_escape:true,exit_nullifier_observed:true,proxy_status:blocked.status,direct_issuance_status:refused.status,direct_issuance_error:'exit_consumed',provider_calls:0,dispatch_attempts:0,escape_signatures:escapeSignatures,challenge_signatures:challengeSignatures,historical_request_root:raceSnapshot.root,challenge_zero_root:escaped.root,restored_root:restored.root,exact_accepted_request_proof_used:true,pending_cleared:true,exit_tombstone_preserved:true,receipt_evidence_kind:raceReceipt.evidence_kind,receipt_verified:true,signed_successor_verified:true,charge_micro_usdc:'0',challenger_daemon_joined:false,scope:'actual SBF race with SDK challenger plan; challenger daemon scheduling covered separately'};
  await walletClient.beginWithdrawal('note','mutual_close',destination,roles);await drive();
  assert.equal((await journal.read('note'))!.value.wallet!.status,'closed');
  // A later real Vault transition must not rewrite previously advertised bytes.
  assert.notEqual((await call({kind:'root'})).root,JSON.parse(Buffer.from(retainedSnapshot[1]).toString()).snapshot.root);
  const retainedResponse=await fetch(origin+'/zkapi/v1/tree/snapshots/'+retainedSnapshot[0]+'.json');
  assert.equal(retainedResponse.status,200);const retainedBytes=new Uint8Array(await retainedResponse.arrayBuffer());
  assert.deepEqual(retainedBytes,retainedSnapshot[1]);assert.equal(digest(retainedBytes),retainedSnapshot[0]);
  const absentHash='0'.repeat(64);assert.equal(sharedSnapshotFiles.has(absentHash),false);
  assert.equal((await fetch(origin+'/zkapi/v1/tree/snapshots/'+absentHash+'.json')).status,404);
  const chainReport=await call({kind:'report',name:'i10'});
  assert.equal(chainReport.vault_micro_usdc,0);assert.equal(chainReport.destination_micro_usdc,4999992);assert.equal(chainReport.treasury_micro_usdc,8);assert.equal(chainReport.source_micro_usdc,95000000);
  assert.equal(chainReport.source_micro_usdc+chainReport.destination_micro_usdc+chainReport.vault_micro_usdc+chainReport.treasury_micro_usdc,100000000);
  assert.ok(chainReport.rows.every((row:any)=>row.error===null));
  const journalBytes=Buffer.concat(await Promise.all((await readdir(directory)).map(name=>readFile(join(directory,name)).catch(()=>Buffer.alloc(0))))).toString();
  for(const secret of ['I10_PRIVATE_PROMPT',witness.secret,'i10-oa-runtime','i10-openrouter-runtime'])assert.equal(journalBytes.includes(secret),false);
  process.stdout.write(JSON.stringify({passed:true,modes,cases,exit_race:exitRace,coverage:cases.map(c=>`${c.mode}/${c.provider}/${c.variant}`),provider_fixture_counts:counts,chain:chainReport,encrypted_journal:true,same_note_all_modes:true,lost_finalized_send_recovered:true,automatic_inference_replays:0,deposit_micro_usdc:'5000000',withdrawal_micro_usdc:'4999992',total_charge_micro_usdc:'8',balance_conservation:true,direct_openrouter_transport:'canonical HTTPS pin, test fetch maps to local TLS fixture',direct_oa_verifier_transport:'synthetic loopback verifier metadata explicitly mapped to CA-pinned local TLS; control and SDK verify separately',live_provider_verified:false,public_rpc_verified:false,release_gates_passed:[]})+'\n');
} finally {
  stdin.close();
  for(const gate of streamGates.values()){gate.cancelled=true;gate.release();}
  await Promise.all([primary,secondary,directServer].map(server=>new Promise<void>(r=>{
    server.close(()=>r());
    // Assertions and the report precede cleanup. Aborting the Rust recovery
    // worker can leave an incomplete loopback RPC socket which close() alone
    // regards as active; terminate these disposable fixture connections.
    server.closeAllConnections();
  })));
  if(svm.exitCode===null){const exited=once(svm,'exit');svm.stdin.end();await exited;}
  await rm(directory,{recursive:true,force:true});
}
