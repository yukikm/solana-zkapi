/** Actual pinned OpenClaw CLI -> production Go frontend -> shared SDK daemon.
 * Control/provider/proof/chain are synthetic fixtures. This never spends funds,
 * uses provider credentials, or claims public-devnet/native prover acceptance. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, chmod, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {ClientDaemon} from '@zkapi/solana-sdk/clientd-bridge';
import {ControlClient, validateNoteJournal, type NoteJournal, type PreparedSession, type VerificationContext, type SessionVerifier} from '@zkapi/solana-sdk/control';
import {EncryptedJournal, importJournalKey} from '@zkapi/solana-sdk/journal';
import {NativeJournalStore} from '@zkapi/solana-sdk/journal-node';
import {writeNodeResponse} from '@zkapi/solana-sdk/clientd-network';
import {startInputGate} from './public_openclaw_input_gate.mjs';
const root=resolve('.'),out=resolve(process.argv[2]??'target/openclaw-acceptance'),installation=resolve(process.argv[3]??'target/clientd-external/distribution');
const node=process.execPath,go=resolve(process.env.ZKAPI_GO??'target/toolchains/go/bin/go'),openclaw=resolve(process.env.ZKAPI_OPENCLAW_ENTRYPOINT??join(out,'node_modules/openclaw/openclaw.mjs')),clientd=join(installation,'bin/clientd');
const gateProbe=process.env.ZKAPI_OPENCLAW_INPUT_GATE_TEST==='1';
const directory=await realpath(await mkdtemp(join(tmpdir(),'zkapi-oc-')));const children:ReturnType<typeof spawn>[]=[];
let inputGate:Awaited<ReturnType<typeof startInputGate>>|undefined;
let sdkServer:ReturnType<typeof createServer>|undefined;
const hash=(raw:Uint8Array|string)=>createHash('sha256').update(raw).digest('hex');
async function execute(command:string,args:string[],options:{input?:string;env?:NodeJS.ProcessEnv;timeout?:number}={}){
 const child=spawn(command,args,{cwd:root,env:options.env??process.env,stdio:['pipe','pipe','pipe']});children.push(child);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.end(options.input??'');
 const timer=setTimeout(()=>child.kill('SIGKILL'),options.timeout??120_000);const [code]=await once(child,'exit');clearTimeout(timer);return{code,stdout,stderr};
}
const checks:string[]=[];const check=(name:string)=>checks.push(name);
try{
 await mkdir(out,{recursive:true});const version=await execute(node,[openclaw,'--version']);assert.equal(version.code,0);assert.match(version.stdout,/OpenClaw 2026\.9\.8 /);check('actual pinned OpenClaw 2026.9.8 CLI');
 const manifest=join(installation,'release.json'),manifestPin=hash(await readFile(manifest));
 const runtimePath=join(directory,'reviewed.json'),networkPath=join(directory,'network.json');
 await writeFile(runtimePath,JSON.stringify({manifest:'/fixture/not-a-deployment',policy:{},artifacts:{},mode:'direct_openrouter',models:[{id:'fixture-chat',provider:'openrouter',apis:['chat']}],rpc:'https://fixture.invalid',indexer:'https://fixture.invalid'}),{mode:0o600});
 await writeFile(networkPath,JSON.stringify({mode:'direct',routes:[{origin:'https://fixture.invalid',prefix:'/'}]}),{mode:0o600});
 const free=createServer();await new Promise<void>(r=>free.listen(0,'127.0.0.1',r));const port=(free.address() as any).port;await new Promise<void>(r=>free.close(()=>r()));
 const profile=join(directory,'profile');const setup=await execute(clientd,['setup','--profile',profile,'--distribution',manifest,'--sha256',manifestPin,'--runtime-config',runtimePath,'--runtime-sha256',hash(await readFile(runtimePath)),'--network-config',networkPath,'--listen',`127.0.0.1:${port}`]);assert.equal(setup.code,0,setup.stderr);check('installed setup creates private tokens and profile');
 const tokens={inference_token:(await readFile(join(profile,'inference-token'),'utf8')).trim(),management_token:(await readFile(join(profile,'management-token'),'utf8')).trim()};
 const generated=await execute(clientd,['openclaw-config',profile,'--model','fixture-chat','--context-window','32000','--max-tokens','128']);assert.equal(generated.code,0,generated.stderr);const config=JSON.parse(generated.stdout);
 const work=join(directory,'work');await mkdir(work);await writeFile(join(work,'probe.txt'),'OPENCLAW_TOOL_FIXTURE_OK\n');
 config.agents.defaults.workspace=work;config.agents.defaults.skipBootstrap=true;config.agents.defaults.thinkingDefault='off';
 config.tools={allow:['read'],toolSearch:false};config.plugins={enabled:false};
 const configPath=join(directory,'openclaw.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
 const env={PATH:process.env.PATH,HOME:directory,TMPDIR:tmpdir(),OPENCLAW_STATE_DIR:join(directory,'openclaw-state'),OPENCLAW_CONFIG_PATH:configPath,OPENCLAW_NO_BANNER:'1'};
 const validated=await execute(node,[openclaw,'config','validate','--json'],{env});assert.equal(validated.code,0,validated.stderr+validated.stdout);check('OpenClaw validates generated file SecretRef configuration');
 const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');const store=await NativeJournalStore.open(join(profile,'journal')),key=await importJournalKey(new Uint8Array(32).fill(4));
 const context:VerificationContext={deployment_id:'fixture',pool:'pool',vault_binding:field(1),state_key:[field(2),field(3)],cap_micro_usdc:'100',control_api_origin:'https://control.invalid',inference_api_origin:'https://proxy.invalid',quote_public_key:'00'.repeat(32),receipt_public_key:'11'.repeat(32),request_vk_sha256:'22'.repeat(32),tariff_hashes:['33'.repeat(32)]};
 const journal=new EncryptedJournal<NoteJournal>(store,key,{deploymentId:'fixture',pool:'pool'},validateNoteJournal);
 const state={balance_micro_usdc:'100',balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(7),state_signature:null};await journal.create('note',{schema:1,state,pending:null,history:[]});
 let caseName='plain',sends=0,closes=0,creates=0,controlDown=false,releaseCancel:(()=>void)|undefined,cancelStarted:(()=>void)|undefined;
 const drainUntil=new Map<string,number>();let toolEofs=0,toolCancellations=0;
 const canSettle=async()=>{if(!gateProbe||caseName!=='tool')return true;const id=(await journal.read('note'))!.value.pending!.prepared.request.authorization.request_id;let at=drainUntil.get(id);if(at===undefined){at=Date.now()+1500;drainUntil.set(id,at);}return Date.now()>=at;};
 const requests:any[]=[];
 const status=async(settled=false)=>{const p=(await journal.read('note'))!.value.pending!;return{request_id:p.prepared.request.authorization.request_id,mode:'direct_openrouter',state:settled?'SETTLED':'ACTIVE',cap_micro_usdc:'100',issued_at:'100',expires_at:'160',...(settled?{settlement:{charge_micro_usdc:'0',next_commitment:state.commitment,next_anchor:field(8),blind_delta_srv:field(9),next_state_signature:{r_x:field(2),r_y:field(3),s:field(4)}}}:{})};};
 const http:typeof fetch=async(url,init)=>{
  const u=new URL(String(url));if(controlDown && u.pathname.startsWith('/zkapi/'))return new Response(null,{status:503});
  if(u.pathname==='/zkapi/v1/sessions'){creates++;return Response.json({...await status(),provider_key:'fixture-provider-key',provider_api_origin:'https://direct.invalid/v1'});}
  if(u.pathname.endsWith('/close')){closes++;return Response.json(await status(await canSettle()));}
  if(u.pathname.endsWith('/receipts'))return Response.json({receipts:[],next_cursor:null});
  if(u.pathname.startsWith('/zkapi/v1/sessions/'))return Response.json(await status(gateProbe&&caseName==='tool'&&await canSettle()));
  sends++;assert.equal(u.origin,'https://direct.invalid');assert.equal(u.pathname,'/v1/chat/completions');const body=JSON.parse(new TextDecoder().decode(init!.body as Uint8Array));requests.push(body);
  for(const identity of ['metadata','user','prompt_cache_key','extra_headers','provider'])assert.equal(body[identity],undefined);
  if(caseName==='uncertain'){controlDown=true;throw Error('fixture response loss');}
  if(caseName==='http503')return Response.json({error:{message:'fixture provider unavailable',type:'server_error'}},{status:503});
  const emit=(delta:any,finish:string|null=null)=>`data: ${JSON.stringify({id:'chatcmpl-fixture',object:'chat.completion.chunk',created:100,model:'fixture-chat',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
  if(caseName==='cancel'){cancelStarted?.();return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(emit({role:'assistant',content:'start'})));},cancel(){releaseCancel?.();}}),{headers:{'Content-Type':'text/event-stream'}});}
  const tool=caseName==='tool' && !body.messages.some((m:any)=>m.role==='tool');
  const message=tool?{role:'assistant',content:null,tool_calls:[{id:'call_fixture',type:'function',function:{name:'read',arguments:JSON.stringify({path:join(work,'probe.txt')})}}]}:{role:'assistant',content:caseName==='tool'?'OPENCLAW_TOOL_FIXTURE_OK':'OPENCLAW_TEXT_FIXTURE_OK'};
  if(tool)assert.ok(body.tools?.some((x:any)=>x.function?.name==='read'),'OpenClaw must advertise actual read tool');
  if(!body.stream)return Response.json({id:'chatcmpl-fixture',object:'chat.completion',created:100,model:'fixture-chat',choices:[{index:0,message,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  const delta=tool?{role:'assistant',tool_calls:message.tool_calls!.map((call:any)=>({index:0,...call}))}:message;
  const streamBytes=emit(delta)+emit({},tool?'tool_calls':'stop')+'data: [DONE]\n\n';
  if(gateProbe&&caseName==='tool')return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(streamBytes));controller.close();},pull(){},cancel(){toolCancellations++;}}).pipeThrough(new TransformStream({transform(chunk,controller){controller.enqueue(chunk);},flush(){toolEofs++;}})),{headers:{'Content-Type':'text/event-stream'}});
  return new Response(streamBytes,{headers:{'Content-Type':'text/event-stream'}});
 };
 const verifier:SessionVerifier={async prepare(){},async settle(_c,s){return{...s,anchor:field(8)};}};
 const options={context,journal,verifier,fetch:http,now:()=>100n,directProviderBases:{direct_openrouter:'https://direct.invalid/v1'}};
 const makeService=()=>new ClientDaemon({client:new ControlClient(options),journal,noteId:'note',mode:'direct_openrouter',models:[{id:'fixture-chat',provider:'openrouter',apis:['chat']}],keyReuseSeconds:0,...(gateProbe?{settlementWaitMs:5000}:{}),now:()=>100n,prepare:async(_model:string,c:any)=>{
  const prepared:PreparedSession={request:{authorization:{version:'1',deployment_id:'fixture',pool:'pool',request_id:c.requestId,quote_hash:'00'.repeat(32),mode:'direct_openrouter',control_secret_hash:c.controlHash,proxy_secret_hash:c.proxyHash},quote:{body:{quote_id:crypto.randomUUID(),deployment_id:'fixture',pool:'pool',mode:'direct_openrouter',provider:'openrouter',models:['*'],tariff_hash:'33'.repeat(32),cap_micro_usdc:'100',issued_at:'100',expires_at:'220',session_ttl_seconds:'60',max_concurrency:'1',control_api_origin:context.control_api_origin,inference_api_origin:context.inference_api_origin},quote_hash:'00'.repeat(32),signature:'fixture'},public_inputs:Array(12).fill(field(1)),proof:{backend:'groth16_bn254',proof:'fixture'}},control_token:c.controlToken,proxy_token:c.proxyToken,tariff:{tariff_hash:'33'.repeat(32),version:'1',provider:'openrouter',model:'*',pricing_basis:'fixture',valid_from:'0',valid_until:'1000',rates:[],operator_fee_micro_usdc:'0'},rerandomization:field(2)};return{prepared,root:field(2)};
 }});
 let service=makeService();await service.start();const socket=join(directory,'sdk.sock');sdkServer=createServer(async(req,res)=>{const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort()});const parts=[];for await(const b of req)parts.push(b);const response=await service.handle(req.method!,req.url!,new Uint8Array(Buffer.concat(parts)),new Headers(req.headers as Record<string,string>),abort.signal);await writeNodeResponse(response,res);});await new Promise<void>(r=>sdkServer!.listen(socket,r));await chmod(socket,0o600);
 const frontend=join(directory,'frontend');const built=await execute(go,['-C','apps/clientd','build','-o',frontend,'./testdata/openclaw-frontend.go']);assert.equal(built.code,0,built.stderr);
 const front=spawn(frontend,[socket,String(port)],{stdio:['pipe','pipe','pipe']});children.push(front);front.stdin.end(JSON.stringify(tokens));await once(front.stdout,'data');
 const direct=async(body:any,signal?:AbortSignal)=>fetch(`http://127.0.0.1:${port}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${tokens.inference_token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
 let response=await direct({model:'fixture-chat',messages:[{role:'user',content:'hello'}]});assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'OPENCLAW_TEXT_FIXTURE_OK');check('ordinary Chat JSON through Go and shared SDK');
 const agent=async(name:string,message:string)=>{const result=await execute(node,[openclaw,'agent','--local','--session-id',name,'--message',message,'--thinking','off','--timeout','45','--json'],{env,timeout:60_000});await writeFile(join(out,`${name}.log`),result.stdout+result.stderr);assert.equal(result.code,0,result.stderr+result.stdout);return result;};
 let before=sends;const text=await agent('zkapi-text-fixture','Reply with the fixture text.');assert.match(text.stdout,/OPENCLAW_TEXT_FIXTURE_OK/);assert.equal(sends,before+1);assert.equal(requests.at(-1).stream,true);check('actual OpenClaw streamed text: one inference');
 caseName='tool';before=sends;
 if(gateProbe){inputGate=await startInputGate({listenPort:0,model:'fixture-chat',stateDirectory:join(directory,'input-gate'),tokenFile:join(profile,'inference-token'),upstreamOrigin:`http://127.0.0.1:${port}`});config.models.providers.zkapi.baseUrl=inputGate.origin+'/v1';await writeFile(configPath,JSON.stringify(config),{mode:0o600});}
 const tool=await agent('zkapi-tool-fixture','Read probe.txt exactly once and report its contents. Do not call another tool.');assert.match(tool.stdout,/OPENCLAW_TOOL_FIXTURE_OK/);assert.equal(sends,before+2);assert.ok(requests.at(-1).messages.some((m:any)=>m.role==='tool' && JSON.stringify(m).includes('OPENCLAW_TOOL_FIXTURE_OK')));check('actual OpenClaw read tool execution and tool-result continuation: two distinct inferences');
 if(gateProbe){assert.equal(inputGate!.status().forwarded,2);assert.equal(toolEofs,2);assert.equal(toolCancellations,0);assert.equal((await fetch(inputGate!.origin+'/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${tokens.inference_token}`,'Content-Type':'application/json'},body:JSON.stringify(requests.at(-1))})).status,429);check('acceptance-only incoming gate forwards exactly two; actual OpenClaw/tool continuation observes native EOF and waits for synthetic delayed settlement');await inputGate!.close();inputGate=undefined;config.models.providers.zkapi.baseUrl=`http://127.0.0.1:${port}/v1`;await writeFile(configPath,JSON.stringify(config),{mode:0o600});caseName='plain';await service.management('recover');}
 caseName='http503';before=sends;const failed=await execute(node,[openclaw,'agent','--local','--session-id','zkapi-failure-fixture','--message','Expected failure','--thinking','off','--timeout','30','--json'],{env,timeout:45_000});await writeFile(join(out,'zkapi-failure-fixture.log'),failed.stdout+failed.stderr);assert.equal(sends,before+1);assert.match(failed.stdout+failed.stderr,/503|unavailable|server_error/);check('actual OpenClaw HTTP503: one inference, provider retry disabled');
 caseName='cancel';const canceled=new Promise<void>(r=>releaseCancel=r),started=new Promise<void>(r=>cancelStarted=r);
 const canceledAgent=spawn(node,[openclaw,'agent','--local','--session-id','zkapi-cancel-fixture','--message','Stream until interrupted','--thinking','off','--timeout','30','--json'],{cwd:root,env,stdio:['ignore','pipe','pipe']});children.push(canceledAgent);canceledAgent.stdout.resume();canceledAgent.stderr.resume();await started;const agentExit=once(canceledAgent,'exit');canceledAgent.kill('SIGTERM');await agentExit;await Promise.race([canceled,new Promise((_,reject)=>setTimeout(()=>reject(Error('OpenClaw disconnect did not cancel SDK')),5000))]);
 for(let n=0;n<100 && (await journal.read('note'))!.value.pending;n++)await new Promise(r=>setTimeout(r,10));assert.equal((await journal.read('note'))!.value.pending,null);check('actual OpenClaw process termination cancels its stream and closes shared SDK session');
 caseName='uncertain';before=sends;const uncertain=await execute(node,[openclaw,'agent','--local','--session-id','zkapi-uncertain-fixture','--message','Expected transport loss','--thinking','off','--timeout','30','--json'],{env,timeout:45_000});await writeFile(join(out,'zkapi-uncertain-fixture.log'),uncertain.stdout+uncertain.stderr);assert.equal(sends,before+1);assert.match(uncertain.stdout+uncertain.stderr,/400|client_request_failed|not replayed/);
 service=makeService();await service.start();let local=await execute(clientd,['request',profile,'status']);assert.equal(local.code,0,local.stderr);assert.equal(JSON.parse(local.stdout).recovery_required,true);
 const blocked=await execute(node,[openclaw,'agent','--local','--session-id','zkapi-blocked-fixture','--message','Must remain blocked','--thinking','off','--timeout','30','--json'],{env,timeout:45_000});await writeFile(join(out,'zkapi-blocked-fixture.log'),blocked.stdout+blocked.stderr);assert.equal(sends,before+1);assert.match(blocked.stdout+blocked.stderr,/409|recovery_required/);
 controlDown=false;local=await execute(clientd,['request',profile,'recover']);assert.equal(local.code,0,local.stderr+local.stdout);assert.equal((await journal.read('note'))!.value.pending,null);assert.equal(sends,before+1);check('actual OpenClaw transport loss and next process held until explicit SDK recovery; zero inference replay');
 caseName='plain';const recovered=await agent('zkapi-recovered-fixture','New request after explicit recovery');assert.match(recovered.stdout,/OPENCLAW_TEXT_FIXTURE_OK/);assert.equal(sends,before+2);check('actual OpenClaw new process succeeds after explicit SDK recovery');await service.shutdown();assert.equal((await journal.read('note'))!.value.pending,null);
 const report={passed:true,scope:'actual OpenClaw CLI, production Go HTTP frontend, compiled shared SDK, encrypted journal; synthetic control/provider/proof fixtures',openclaw:version.stdout.trim(),openclawPackageIntegrity:'sha512-G+JkNUhtpDE3cXR4AEi2NyyG9fqI/T2WUSl8ZnR8AATH8Dh1kC3qYFL7wwPoZtgHiP/cszA86PEiE0PDysxb9Q==',checks,acceptanceIncomingGate:gateProbe?{maximumForwarded:2,toolProviderEofs:toolEofs,toolProviderCancellations:toolCancellations,syntheticSettlementDelayMs:1500}:null,inferenceSends:sends,authorizations:creates,closes,uncertainInferenceReplays:0,publicDevnet:false,liveProvider:false,nativeProof:false,actualVault:false,openclawProcessCancellationAndRestart:true,clientdProcessRestart:false,sourceSha256:{'scripts/run_openclaw_clientd_acceptance.ts':hash(await readFile(new URL(import.meta.url))),'apps/clientd/testdata/openclaw-frontend.go':hash(await readFile('apps/clientd/testdata/openclaw-frontend.go'))}};
 await writeFile(join(out,'results.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{if(inputGate)await writeFile(join(out,'input-gate-diagnostic.json'),JSON.stringify(inputGate.status(),null,2)+'\n');await inputGate?.close();for(const child of children)if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');sdkServer?.closeAllConnections();await new Promise<void>(r=>sdkServer?.close(()=>r())??r());await rm(directory,{recursive:true,force:true});}
