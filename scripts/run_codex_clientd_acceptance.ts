/** Credential-free actual Codex CLI compatibility probe.
 * Production Go + shared SDK must reject unsupported requests before AUTH.
 * A SEPARATE synthetic Responses endpoint tests Codex configuration, streaming,
 * local tool continuation and no-retry behavior. It is not ZKAPI acceptance. */
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer, type Server} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, writeFile, readFile, realpath, chmod, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, delimiter} from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {ClientDaemon} from '../packages/sdk/src/clientd-bridge.ts';
import {ControlClient, validateNoteJournal, type NoteJournal, type VerificationContext} from '../packages/sdk/src/control.ts';
import {EncryptedJournal, importJournalKey} from '../packages/sdk/src/journal.ts';
import {NativeJournalStore} from '../packages/sdk/src/journal-node.ts';
import {writeNodeResponse} from '../packages/sdk/src/clientd-network.ts';

const root=resolve('.'),out=resolve(process.argv[2]??'target/codex-clientd-acceptance');
const selected=process.env.ZKAPI_CODEX??'codex',go=resolve(process.env.ZKAPI_GO??'target/toolchains/go/bin/go');
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const temporary=await realpath(await mkdtemp(join(tmpdir(),'zkapi-cdx-')));
const children:ChildProcess[]=[],servers:Server[]=[];
const checks:string[]=[],cases:Record<string,unknown>={};
const localToken=randomBytes(32).toString('hex'),managementToken=randomBytes(32).toString('hex');
let authorizeCalls=0,providerCalls=0,fixtureCase='',fixtureRequests:any[]=[],sequence=0;
const observations:any[]=[];
async function executable(name:string):Promise<string>{
 if(name.includes('/'))return realpath(name);
 for(const dir of (process.env.PATH??'').split(delimiter))try{const path=join(dir,name);await access(path);return realpath(path);}catch{}
 throw Error('Codex executable not found. Set ZKAPI_CODEX to its absolute path.');
}
async function run(command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,input='',timeout=45_000){
 const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe']});children.push(child);
 let stdout='',stderr='',timedOut=false;child.stdout!.on('data',b=>{stdout+=b;if(stdout.length>2*1024*1024)child.kill('SIGKILL')});child.stderr!.on('data',b=>{stderr+=b;if(stderr.length>2*1024*1024)child.kill('SIGKILL')});child.stdin!.end(input);
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},timeout);const[code,signal]=await once(child,'exit');clearTimeout(timer);
 return{code,signal,timedOut,stdout,stderr};
}
function config(port:number){return `model = "gpt-5.4"
model_provider = "zkapi"
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
[features]
apps = false
plugins = false
browser_use = false
computer_use = false
image_generation = false
multi_agent = false
skill_search = false
tool_suggest = false
enable_request_compression = false
[model_providers.zkapi]
name = "ZKAPI local compatibility fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
env_key = "ZKAPI_CODEX_FIXTURE_TOKEN"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`;}
async function isolated(name:string,port:number){
 const home=join(temporary,name);await mkdir(home);const work=join(home,'work'),codexHome=join(home,'codex');await mkdir(work);await mkdir(codexHome);await writeFile(join(work,'probe.txt'),'CODEX_TOOL_FIXTURE_OK\n');await writeFile(join(codexHome,'config.toml'),config(port),{mode:0o600});
 const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:codexHome,TMPDIR:tmpdir(),ZKAPI_CODEX_FIXTURE_TOKEN:localToken,DO_NOT_TRACK:'1'};
 return{home,work,env};
}
const event=(type:string,data:Record<string,unknown>)=>`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence++,...data})}\n\n`;
function responseEvents(tool:boolean,work:string,toolName='exec_command'){
 sequence=0;const id='resp_fixture',message={id:'msg_fixture',type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:fixtureCase==='tool'?'CODEX_TOOL_FIXTURE_OK':'CODEX_TEXT_FIXTURE_OK',annotations:[]}]};
 const call={id:'fc_fixture',type:'function_call',status:'completed',call_id:'call_fixture',name:toolName,arguments:JSON.stringify(toolName==='exec_command'?{cmd:'cat probe.txt',workdir:work,yield_time_ms:1000,max_output_tokens:1000}:{command:'cat probe.txt',workdir:work,timeout_ms:1000})};
 const output=tool?call:message;const response={id,object:'response',created_at:100,model:'gpt-5.4',status:'in_progress',output:[],error:null};
 let text=event('response.created',{response})+event('response.output_item.added',{response_id:id,output_index:0,item:tool?{...call,arguments:''}:{...message,content:[]}});
 if(tool)text+=event('response.function_call_arguments.delta',{response_id:id,item_id:call.id,output_index:0,delta:call.arguments})+event('response.function_call_arguments.done',{response_id:id,item_id:call.id,output_index:0,arguments:call.arguments});
 else text+=event('response.content_part.added',{response_id:id,item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}})+event('response.output_text.delta',{response_id:id,item_id:message.id,output_index:0,content_index:0,delta:message.content[0].text})+event('response.output_text.done',{response_id:id,item_id:message.id,output_index:0,content_index:0,text:message.content[0].text});
 return text+event('response.output_item.done',{response_id:id,output_index:0,item:output})+event('response.completed',{response:{...response,status:'completed',output:[output],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
}
function observe(body:any,path:string,headers:Record<string,unknown>){
 return{path,bodySha256:hash(JSON.stringify(body)),topLevelFields:Object.keys(body).sort(),inputTypes:[...new Set(body.input?.map((i:any)=>i.type??'message'))],tools:body.tools?.map((t:any)=>({type:t.type,name:t.name})),store:body.store,stream:body.stream,include:body.include,promptCacheKeyPresent:Object.hasOwn(body,'prompt_cache_key'),clientMetadataKeys:Object.keys(body.client_metadata??{}).sort(),headerNames:Object.keys(headers).sort()};
}
try{
 await mkdir(out,{recursive:true});const codex=await executable(selected);const bootstrap=await isolated('version',1);const version=await run(codex,['--version'],bootstrap.work,bootstrap.env);assert.equal(version.code,0);assert.equal(version.stdout.trim(),'codex-cli 0.145.0');checks.push('actual installed Codex CLI 0.145.0');
 const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');const context:VerificationContext={deployment_id:'fixture',pool:'pool',vault_binding:field(1),state_key:[field(2),field(3)],cap_micro_usdc:'100',control_api_origin:'https://control.invalid',inference_api_origin:'https://proxy.invalid',quote_public_key:'00'.repeat(32),receipt_public_key:'11'.repeat(32),request_vk_sha256:'22'.repeat(32),tariff_hashes:['33'.repeat(32)]};
 const journal=new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(join(temporary,'journal')),await importJournalKey(new Uint8Array(32).fill(9)),{deploymentId:'fixture',pool:'pool'},validateNoteJournal);await journal.create('note',{schema:1,state:{balance_micro_usdc:'100',balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(7),state_signature:null},pending:null,history:[]});
 const client=new ControlClient({context,journal,verifier:{async prepare(){throw Error('must reject before proof')},async settle(){throw Error('must reject before settlement')}},fetch:async()=>{providerCalls++;throw Error('no network allowed in this direct compatibility probe')}});
 const service=new ClientDaemon({client,journal,noteId:'note',mode:'direct_oa',models:[{id:'gpt-5.4',provider:'oa',apis:['responses']}],keyReuseSeconds:0,prepare:async()=>{authorizeCalls++;throw Error('must reject before AUTH')}});await service.start();
 const socket=join(temporary,'sdk.sock');const sdk=createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);const bytes=new Uint8Array(Buffer.concat(parts));if(req.url==='/v1/responses'){const body=JSON.parse(new TextDecoder().decode(bytes));observations.push(observe(body,req.url!,req.headers));}await writeNodeResponse(await service.handle(req.method!,req.url!,bytes,new Headers(req.headers as Record<string,string>)),res)});servers.push(sdk);await new Promise<void>(r=>sdk.listen(socket,r));await chmod(socket,0o600);
 const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address()as any).port;await new Promise<void>(r=>reserve.close(()=>r()));
 const frontend=join(temporary,'frontend');const built=await run(go,['-C',join(root,'apps/clientd'),'build','-o',frontend,'./testdata/codex-frontend.go'],root,{PATH:process.env.PATH,HOME:bootstrap.home},'',120_000);assert.equal(built.code,0,built.stderr);
 const front=spawn(frontend,[socket,String(port)],{stdio:['pipe','pipe','pipe']});children.push(front);front.stdin!.end(JSON.stringify({inference_token:localToken,management_token:managementToken}));await once(front.stdout!,'data');
 const direct=await isolated('direct-sdk',port);const args=(work:string,prompt:string)=>['exec','--strict-config','--ephemeral','--skip-git-repo-check','--ignore-rules','--json','-C',work,prompt];
 const rejected=await run(codex,args(direct.work,'Reply exactly CODEX_TEXT_FIXTURE_OK.'),direct.work,direct.env);await writeFile(join(out,'direct-sdk.log'),rejected.stdout+rejected.stderr);assert.equal(rejected.timedOut,false);assert.notEqual(rejected.code,0);assert.equal(observations.length,1);assert.equal(authorizeCalls,0);assert.equal(providerCalls,0);assert.equal((await journal.read('note'))!.value.pending,null);assert.match(rejected.stdout+rejected.stderr,/400|client_request_failed/);checks.push('production Go and shared SDK reject actual request before AUTH or provider dispatch');await writeFile(join(out,'direct-request-shape.json'),JSON.stringify(observations[0],null,2)+'\n');cases.directSdk={supported:false,exitCode:rejected.code,requests:observations.length,authorizeCalls,providerCalls,observedRequest:observations[0],reason:'Current direct guard rejects identity metadata and custom apply_patch tool; exact body remains unchanged'};
 let activeWork='',protocolFailure:unknown;const protocol=createServer(async(req,res)=>{try{const parts=[];for await(const part of req)parts.push(part);assert.equal(req.url,'/v1/responses');assert.equal(req.headers.authorization,`Bearer ${localToken}`);const body=JSON.parse(Buffer.concat(parts).toString('utf8'));assert.equal(body.store,false);assert.equal(body.stream,true);assert.equal(body.previous_response_id,undefined);fixtureRequests.push(body);if(fixtureRequests.length>2){res.writeHead(400);res.end();return;}if(fixtureCase==='http503'){res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":{"message":"synthetic unavailable","type":"server_error"}}');return;}res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});if(fixtureCase==='disconnect'){res.write(event('response.created',{response:{id:'resp_lost',object:'response',status:'in_progress',output:[]}}));setTimeout(()=>res.destroy(),25);return;}const tool=fixtureCase==='tool'&&!body.input.some((i:any)=>i.type==='function_call_output');const toolName=body.tools.find((t:any)=>t.type==='function'&&['exec_command','shell_command'].includes(t.name))?.name;if(tool)assert.ok(toolName);if(fixtureCase==='tool'&&!tool)assert.ok(body.input.some((i:any)=>i.type==='function_call_output'&&i.call_id==='call_fixture'&&String(i.output).includes('CODEX_TOOL_FIXTURE_OK')));res.end(responseEvents(tool,activeWork,toolName));}catch(error){protocolFailure=error;res.destroy();}});servers.push(protocol);await new Promise<void>(r=>protocol.listen(0,'127.0.0.1',r));const protocolPort=(protocol.address()as any).port;
 for(const name of ['text','tool','http503','disconnect']){
  fixtureCase=name;fixtureRequests=[];const isolatedCase=await isolated(name,protocolPort);activeWork=isolatedCase.work;const result=await run(codex,args(isolatedCase.work,name==='tool'?'Read probe.txt and report its contents.':'Reply with the fixture text.'),isolatedCase.work,isolatedCase.env);await writeFile(join(out,`${name}.log`),result.stdout+result.stderr);assert.equal(result.timedOut,false);if(protocolFailure)throw protocolFailure;const expected=name==='tool'?2:1;assert.equal(fixtureRequests.length,expected,`${name} request replay`);
  if(name==='text'||name==='tool'){assert.equal(result.code,0,result.stdout+result.stderr);assert.match(result.stdout,name==='tool'?/CODEX_TOOL_FIXTURE_OK/:/CODEX_TEXT_FIXTURE_OK/);}else assert.notEqual(result.code,0);
  cases[name]={scope:'separate synthetic Responses endpoint, bypasses ZKAPI financial admission',exitCode:result.code,requests:fixtureRequests.length,requestShapes:fixtureRequests.map(body=>observe(body,'/v1/responses',{})),logSha256:hash(result.stdout+result.stderr)};checks.push(`actual Codex synthetic Responses ${name}: ${expected} request(s), no automatic retry`);
 }
 const sources=['scripts/run_codex_clientd_acceptance.ts','apps/clientd/testdata/codex-frontend.go','packages/sdk/src/clientd-bridge.ts','packages/sdk/src/clientd-models.ts','apps/clientd/internal/daemon/server.go','services/control/src/proxy/request.rs'];const report={probeChecksPassed:true,passed:true,productionCompatible:false,scope:'configuration/protocol probes and expected pre-AUTH rejection; not successful clientd inference acceptance',version:version.stdout.trim(),binarySha256:hash(await readFile(codex)),checks,cases,publicDevnet:false,liveProvider:false,funding:false,userGlobalConfigurationChanged:false,sourceSha256:Object.fromEntries(await Promise.all(sources.map(async p=>[p,hash(await readFile(join(root,p)))])))};await writeFile(join(out,'results.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(out,'config-template.toml'),config(8787));console.log(JSON.stringify(report,null,2));
}finally{
 for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');for(const server of servers){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}await rm(temporary,{recursive:true,force:true});
}
