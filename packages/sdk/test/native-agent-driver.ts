/** Actual pinned CLI driver. Only a disposable loopback fixture may call this. */
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';

export const NATIVE_AGENT_CASES=['text','tool','subsequent_turn','capability400','capability422','rate_limit429','unavailable503','lost_headers','truncated','idle_timeout','cancel','fallback'] as const;
export type NativeAgentCase=typeof NATIVE_AGENT_CASES[number];
// Each fresh lifecycle reaches the existing three-unknown circuit breaker.
// Cases never reset admission or share custody/database state across groups.
export const NATIVE_AGENT_GROUPS:Record<1|2|3,readonly NativeAgentCase[]>={1:NATIVE_AGENT_CASES.slice(0,6),2:NATIVE_AGENT_CASES.slice(6,9),3:NATIVE_AGENT_CASES.slice(9)};
export type NativeAgentKind='codex'|'claude';
export type NativeAgentFixture={requests:{case:NativeAgentCase;bodySha256:string;target:string;headerNames:string[]}[];setCase(name:NativeAgentCase,workdir:string):void;observed():Promise<void>;release():void};
export type NativeAgentOptions=NativeAgentFixture&{kind:NativeAgentKind;binary:string;group?:1|2|3};
export type NativeAgentRequest={method:string;target:string;bodySha256:string;bodyBytes:number;headerNames:string[];bodyKeys:string[];hasPriorAssistant:boolean;hasToolOutput:boolean;status?:number;responseCode?:string};
const hashes={codex:'1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590',claude:'8addc857f3fe64d5a0368af9ee50321b50afb4a6918ba3ef018ab84f5dbbe081'};
const versions={codex:'codex-cli 0.145.0',claude:'2.1.220 (Claude Code)'};
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const textMarker=(kind:NativeAgentKind)=>kind==='codex'?'CODEX_TEXT_FIXTURE_OK':'CLAUDE_CODE_FIXTURE_OK';
const toolMarker=(kind:NativeAgentKind)=>kind==='codex'?'CODEX_TOOL_FIXTURE_OK':'CLAUDE_CODE_TOOL_FIXTURE_OK';
function codexConfig(base:string){return `model = "gpt-5.4"
model_provider = "zkapi"
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "danger-full-access"
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
name = "ZKAPI isolated native gateway acceptance"
base_url = "${base}/v1"
wire_api = "responses"
env_key = "ZKAPI_NATIVE_AGENT_TOKEN"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
`;}
export async function runNativeAgentCase(o:NativeAgentOptions&{name:NativeAgentCase;directory:string;endpoint:string;token:string}){
 const endpoint=new URL(o.endpoint);assert.equal(endpoint.protocol,'http:');assert.equal(endpoint.hostname,'127.0.0.1');
 assert.ok(resolve(o.directory).startsWith(resolve('target/gateway-native-local')+'/')||resolve(o.directory).startsWith(resolve('target/gateway-native-client-work')+'/'));
 const home=resolve(o.directory,o.name),work=join(home,'work'),config=join(home,'config');await mkdir(work,{recursive:true,mode:0o700});await mkdir(config,{mode:0o700});await mkdir(join(home,'tmp'),{mode:0o700});
 const binary=await realpath(o.binary);assert.equal(sha(await readFile(binary)),hashes[o.kind],'pinned client executable changed');
 await writeFile(join(work,'probe.txt'),toolMarker(o.kind)+'\n');
 const policy=join(home,'network.sb');await writeFile(policy,'(version 1)\n(allow default)\n(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n',{mode:0o600});
 const replayRequests:{method:string;target:string;headers:string[];body:Buffer}[]=[];const allRequests:NativeAgentRequest[]=[],requests:NativeAgentRequest[]=[],active=new Set<ChildProcess>();let relayFailure:unknown;
 // The outer macOS sandbox applies to the CLI and all tool descendants. Codex's
 // nested sandbox is disabled because macOS refuses nested sandbox_apply.
 // This fixture relay observes every native attempt, including a changed-body
 // capability retry. Only Host changes to satisfy clientd's loopback boundary;
 // clientd consumes Host before the authenticated gateway envelope is created.
 const relay=createServer(async(req,res)=>{try{
   const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));const raw=Buffer.concat(chunks);assert.ok(raw.length<=1048576);
   let body:any={};try{body=JSON.parse(raw.toString('utf8'));}catch{}
   const input=body.input??body.messages??[];
   const record:NativeAgentRequest={method:req.method!,target:req.url!,bodySha256:sha(raw),bodyBytes:raw.length,headerNames:req.rawHeaders.filter((_,i)=>i%2===0).map(n=>n.toLowerCase()),bodyKeys:Object.keys(body).sort(),hasPriorAssistant:Array.isArray(input)&&input.some((i:any)=>i.role==='assistant'||i.type==='message'&&i.role==='assistant'),hasToolOutput:Array.isArray(input)&&input.some((i:any)=>i.type==='function_call_output'||Array.isArray(i.content)&&i.content.some((b:any)=>b.type==='tool_result'))};allRequests.push(record);if(req.method==='HEAD'&&req.url==='/api/hello'){assert.equal(o.kind,'claude');assert.equal(raw.length,0);}else{requests.push(record);replayRequests.push({method:req.method!,target:req.url!,headers:[...req.rawHeaders],body:raw});}
   const headers=[...req.rawHeaders];for(let i=0;i<headers.length;i+=2)if(headers[i].toLowerCase()==='host')headers[i+1]=endpoint.host;
   const upstream=httpRequest({hostname:endpoint.hostname,port:endpoint.port,path:req.url,method:req.method,headers,agent:false},incoming=>{
     record.status=incoming.statusCode;const errorChunks:Buffer[]=[];let errorSize=0;if(incoming.statusCode!>=400){incoming.on('data',chunk=>{errorSize+=chunk.length;if(errorSize<=65536)errorChunks.push(Buffer.from(chunk));});incoming.on('end',()=>{try{record.responseCode=JSON.parse(Buffer.concat(errorChunks).toString()).error?.code;}catch{}});}res.writeHead(incoming.statusCode!,incoming.rawHeaders);incoming.on('error',error=>res.destroy(error));incoming.on('end',()=>{if(incoming.rawTrailers.length)res.addTrailers(incoming.rawTrailers.reduce<[string,string][]>((a,v,i)=>{if(i%2===0)a.push([v,incoming.rawTrailers[i+1]]);return a;},[]));});incoming.pipe(res);
   });upstream.on('error',error=>res.destroy(error));res.on('close',()=>upstream.destroy());upstream.end(raw);
 }catch(error){relayFailure=error;res.destroy();}});
 await new Promise<void>(resolve=>relay.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${(relay.address()as any).port}`;
 const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',HOME:home,TMPDIR:join(home,'tmp'),DO_NOT_TRACK:'1',TERM:'dumb'};
 let settings='';
 if(o.kind==='codex'){env.CODEX_HOME=config;env.ZKAPI_NATIVE_AGENT_TOKEN=o.token;await writeFile(join(config,'config.toml'),codexConfig(base),{mode:0o600});}
 else{
   const token=join(home,'token');await writeFile(token,o.token+'\n',{mode:0o600});settings=join(home,'settings.json');await writeFile(settings,JSON.stringify({alwaysThinkingEnabled:false}),{mode:0o600});
   Object.assign(env,{CLAUDE_CONFIG_DIR:config,ANTHROPIC_BASE_URL:base,ANTHROPIC_AUTH_TOKEN:o.token,ANTHROPIC_CUSTOM_HEADERS:'Accept-Encoding: identity',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_TERMINAL_TITLE:'1',CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:'1',CLAUDE_CODE_DISABLE_THINKING:'1',CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'512',MAX_THINKING_TOKENS:'0',DISABLE_PROMPT_CACHING:'1',ENABLE_TOOL_SEARCH:'false',CLAUDE_CODE_MAX_RETRIES:'0',DISABLE_AUTOUPDATER:'1'});
 }
 async function run(args:string[],cancel=false){
   const child=spawn('/usr/bin/sandbox-exec',['-f',policy,binary,...args],{cwd:work,env,stdio:['ignore','pipe','pipe']});active.add(child);let stdout='',stderr='',timedOut=false,cancellationSent=false;
   child.stdout!.on('data',b=>{stdout+=b;if(stdout.length>4*1024*1024)child.kill('SIGKILL')});child.stderr!.on('data',b=>{stderr+=b;if(stderr.length>4*1024*1024)child.kill('SIGKILL')});
   const timeout=setTimeout(()=>{timedOut=true;child.kill('SIGKILL')},180_000);let cancelTimer:ReturnType<typeof setTimeout>|undefined;
   if(cancel)void o.observed().then(()=>{if(child.exitCode===null){cancellationSent=true;child.kill('SIGINT');cancelTimer=setTimeout(()=>child.kill('SIGKILL'),10_000);}});
   try{const [code,signal]=await once(child,'exit');return{code,signal,timedOut,cancellationSent,stdout,stderr};}finally{active.delete(child);clearTimeout(timeout);clearTimeout(cancelTimer);}
 }
 const args=(resume?:string)=>o.kind==='codex'?(resume?['exec','resume','--last','--strict-config','--skip-git-repo-check','--ignore-rules','--json','Give the fixture reply to this subsequent user turn.']:['exec','--strict-config',...(o.name==='subsequent_turn'?[]:['--ephemeral']),'--skip-git-repo-check','--ignore-rules','--json','-C',work,o.name==='tool'?'Read probe.txt and report its contents.':'Reply with fixture text.']):['--bare','--print','--model','claude-sonnet-4-20250514','--system-prompt','Return the provided fixture response.','--tools',o.name==='tool'?'Read':'','--permission-mode','dontAsk','--allowedTools','Read','--disable-slash-commands',...(o.name==='subsequent_turn'?[]:['--no-session-persistence']),'--no-chrome','--strict-mcp-config','--setting-sources','','--settings',settings,'--output-format','json',...(resume?['--resume',resume]:[]),resume?'Give the fixture reply to this subsequent user turn.':'Reply with fixture text.'];
 try{
   const version=await run(['--version']);assert.equal(version.code,0,version.stderr);assert.equal(version.stdout.trim(),versions[o.kind]);
   o.setCase(o.name,work);const results=[await run(args(),o.name==='cancel')];
   if(o.name==='subsequent_turn'){assert.equal(results[0].code,0,results[0].stdout+results[0].stderr);const session=o.kind==='codex'?'last':JSON.parse(results[0].stdout).session_id;assert.ok(session);results.push(await run(args(session)));}
   if(relayFailure)throw relayFailure;
   for(let i=0;i<results.length;i++){const r=results[i];await writeFile(join(home,`client-${i}.log`),r.stdout+r.stderr,{mode:0o600});assert.equal(r.timedOut,false,'native client did not terminate');assert.ok(!r.stdout.includes(o.token)&&!r.stderr.includes(o.token),'native token leaked');}
   await writeFile(join(home,'request-shapes.json'),JSON.stringify(allRequests,null,2),{mode:0o600});
   const expected=o.name==='tool'||o.name==='subsequent_turn'?2:1;
   const capabilityRetry=o.kind==='claude'&&o.name==='capability400';assert.equal(requests.length,expected+(capabilityRetry?1:0),`${o.kind}/${o.name}: unexpected native retry/fallback count`);if(capabilityRetry){assert.equal(requests[1].status,409,'capability retry must hit the durable recovery hold');assert.equal(requests[1].responseCode,'recovery_required');}
   for(const r of requests){assert.equal(r.method,'POST');assert.equal(r.target,o.kind==='codex'?'/v1/responses':'/v1/messages?beta=true');}
   if(['text','tool','subsequent_turn'].includes(o.name))for(const r of results){assert.equal(r.code,0,r.stdout+r.stderr);assert.ok(r.stdout.includes(o.name==='tool'?toolMarker(o.kind):textMarker(o.kind)),r.stdout+r.stderr);}
   else if(o.name==='cancel'){assert.equal(results[0].cancellationSent,true);assert.ok(!results[0].stdout.includes(textMarker(o.kind))&&!results[0].stdout.includes(toolMarker(o.kind)),'cancel produced a completed response');}else for(const r of results)assert.notEqual(r.code,0,`${o.name} was incorrectly reported successful`);
   if(o.name==='tool')assert.equal(requests[1].hasToolOutput,true,'second API operation must contain the actual local tool output');
   if(o.name==='subsequent_turn')assert.equal(requests[1].hasPriorAssistant,true,'second user turn must preserve prior stateless assistant history');
   const providerRequests=o.requests.filter(r=>r.case===o.name);assert.equal(providerRequests.length,expected,'upstream must execute each new native operation exactly once');for(let i=0;i<expected;i++){assert.equal(providerRequests[i].bodySha256,requests[i].bodySha256,'native body bytes changed');assert.equal(providerRequests[i].target,requests[i].target,'native raw target changed');}
   const assertDuplicateRejected=async(ids:string[])=>{assert.equal(ids.length,expected);for(let i=0;i<ids.length;i++){const original=replayRequests[i],headers:string[]=[];for(let n=0;n<original.headers.length;n+=2){const name=original.headers[n];if(name.toLowerCase()==='idempotency-key')continue;headers.push(name,name.toLowerCase()==='host'?endpoint.host:original.headers[n+1]);}headers.push('Idempotency-Key',ids[i]);const status=await new Promise<number>((resolve,reject)=>{const req=httpRequest({hostname:endpoint.hostname,port:endpoint.port,path:original.target,method:original.method,headers,agent:false},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));res.on('error',reject);});req.on('error',reject);req.end(original.body);});assert.equal(status,409,'original operation ID must remain nonreplayable after settlement');}};
   const assertRecoveryHold=async()=>{const original=replayRequests[0],headers:string[]=[];for(let n=0;n<original.headers.length;n+=2){const name=original.headers[n];if(name.toLowerCase()==='idempotency-key')continue;headers.push(name,name.toLowerCase()==='host'?endpoint.host:original.headers[n+1]);}const reply=await new Promise<{status:number;code?:string}>((resolve,reject)=>{const req=httpRequest({hostname:endpoint.hostname,port:endpoint.port,path:original.target,method:original.method,headers,agent:false},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{let code;try{code=JSON.parse(Buffer.concat(chunks).toString()).error?.code;}catch{}resolve({status:res.statusCode!,code});});res.on('error',reject);});req.on('error',reject);req.end(original.body);});assert.equal(reply.status,409);assert.equal(reply.code,'recovery_required');};
   return {assertDuplicateRejected,assertRecoveryHold,name:o.name,client:o.kind,clientVersion:versions[o.kind],binarySha256:hashes[o.kind],requests,local_probe_requests:allRequests.filter(r=>r.method==='HEAD'),attempted_requests:requests.length,expected_operations:expected,expected_charge_micro_usdc:['text','tool','subsequent_turn'].includes(o.name)?expected*2:0,external_network_blocked:true,native_automatic_retries:requests.length-expected,client_profile_compatible:requests.length===expected,no_automatic_provider_replay:true,provider_dispatches:providerRequests.length,exits:results.map(r=>({code:r.code,signal:r.signal,logSha256:sha(r.stdout+r.stderr)}))};
 }finally{o.release();for(const child of active)child.kill('SIGKILL');relay.closeAllConnections();await new Promise<void>(resolve=>relay.close(()=>resolve()));}
}
