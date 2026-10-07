/** Public-profile operator gateway. Loads pinned public files offline, then
 * exposes only bounded canonical API routes behind an operator-owned TLS proxy.
 * No UI checkout, custody initialization, provider credential or new budget. */
import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadPublicDeploymentProfile, publicProfileClientOptions, type LoadedPublicDeploymentProfile} from '../packages/sdk/src/public-profile.ts';
import {parseStrictJson,sha256Hex,jcsBytes} from '../packages/sdk/src/trust.ts';
import {directControlRelay,loadBrowserChatBudget,localForwarder,type BrowserChatDevnetHostConfig,type DirectDemoBudget} from './browser_chat_devnet_host.ts';
import {startUiHost,type HostOptions,type UiDirectProviderBudget} from './devnet-browser-relay/host.ts';

export interface SupplementalGatewayBudget {
  kind:'supplemental-v1'; planPath:string; stateDir:string;
  authorizationPath:string; authorizationSha256:string;
  /** Reviewed acceptance release pins, not remote client binary attestation. */
  sdkSha256:string; nativeSha256:string;
}
export interface DetachedGatewayBudget {
  kind:'supplemental-detached-v2'; stateDir:string; historySnapshotPath:string;
  authorizationPath:string; authorizationSha256:string;
  /** Reviewed acceptance release pins, not remote client binary attestation. */
  sdkSha256:string; nativeSha256:string;
}
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'), execute=promisify(execFile);
export type BudgetCommandRunner=(file:string,args:readonly string[],options:{cwd:string;env:NodeJS.ProcessEnv;timeout:number;maxBuffer:number})=>Promise<{stdout:string|Buffer}>;

export interface PublicDevnetGatewayConfig {
  port:number;
  publicOrigin:string;
  allowedBrowserOrigins:readonly string[];
  allowNativeRequests:boolean;
  allowTransactions:boolean;
  allowNewAdmissions:boolean;
  admissionTokenSha256?:string;
  profileUrl:string;
  profilePath:string;
  profileSha256:string;
  bundleDescriptorPath:string;
  rpcUrl:string;
  historyRpcUrl?:string;
  indexerUrl:string;
  controlUrl:string;
  localCaPath?:string;
  budget:BrowserChatDevnetHostConfig['budget'] | SupplementalGatewayBudget | DetachedGatewayBudget;
}
function fields(value:any,required:string[],optional:string[]=[]){
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value));
  assert.ok(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)));
}
function validateConfig(config:PublicDevnetGatewayConfig){
  fields(config,['port','publicOrigin','allowedBrowserOrigins','allowNativeRequests','allowTransactions','allowNewAdmissions',
    'profileUrl','profilePath','profileSha256','bundleDescriptorPath','rpcUrl','indexerUrl','controlUrl','budget'],['historyRpcUrl','localCaPath','admissionTokenSha256']);
  assert.ok(Number.isInteger(config.port)&&config.port>=0&&config.port<=65535);
  const origin=new URL(config.publicOrigin);assert.ok(origin.protocol==='https:'&&origin.origin===config.publicOrigin&&!origin.username&&!origin.password);
  assert.ok(Array.isArray(config.allowedBrowserOrigins)&&config.allowedBrowserOrigins.length<=32&&new Set(config.allowedBrowserOrigins).size===config.allowedBrowserOrigins.length);
  for(const input of config.allowedBrowserOrigins){const u=new URL(input);assert.ok(u.protocol==='https:'&&u.origin===input&&!u.username&&!u.password);}
  for(const name of ['allowNativeRequests','allowTransactions','allowNewAdmissions'] as const)assert.equal(typeof config[name],'boolean');
  if(config.allowNewAdmissions||config.admissionTokenSha256!==undefined)assert.match(config.admissionTokenSha256??'',/^[0-9a-f]{64}$/, 'public admission invitation digest required');
  assert.match(config.profileSha256,/^[0-9a-f]{64}$/);
  for(const input of [config.rpcUrl,...(config.historyRpcUrl?[config.historyRpcUrl]:[])]){
    const u=new URL(input);assert.ok(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash);
  }
  for(const input of [config.indexerUrl,config.controlUrl]){
    const u=new URL(input);assert.ok(u.origin===input&&!u.username&&!u.password&&(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname)));
  }
  if('kind' in config.budget){
    assert.ok(config.budget.kind==='supplemental-v1'||config.budget.kind==='supplemental-detached-v2');
    fields(config.budget,['kind',config.budget.kind==='supplemental-v1'?'planPath':'historySnapshotPath',
      'stateDir','authorizationPath','authorizationSha256','sdkSha256','nativeSha256']);
    for(const value of [config.budget.authorizationSha256,config.budget.sdkSha256,config.budget.nativeSha256])assert.match(value,/^[0-9a-f]{64}$/);
  }else{
    fields(config.budget,['planPath','stateDir','caseId']);
    assert.ok(['openrouter-direct-plain','openrouter-direct-sse'].includes(config.budget.caseId));
  }
}
async function publicFile(path:string,maximum:number){
  const info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=maximum);
  const bytes=await readFile(path);assert.ok(bytes.length<=maximum);return bytes;
}
/** All downloaded identities pass through the existing authenticated SDK loader.
 * This server-side mapping reads the installed bundle only; it never downloads
 * arbitrary URLs from the network or serves private paths to clients. */
export async function loadGatewayPublicProfile(config:PublicDevnetGatewayConfig):Promise<LoadedPublicDeploymentProfile>{
  config=structuredClone(config);validateConfig(config);
  const raw=await publicFile(config.profilePath,1024*1024);assert.equal(await sha256Hex(raw),config.profileSha256);
  const parsed=parseStrictJson(raw) as any;
  assert.ok(parsed&&typeof parsed.bundle?.url==='string');
  const bundleUrl=new URL(parsed.bundle.url), directory=new URL('.',bundleUrl).href;
  const descriptor=resolve(config.bundleDescriptorPath);
  const fetcher:typeof fetch=async(input,init)=>{
    init?.signal?.throwIfAborted();assert.equal(init?.method??'GET','GET');
    assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    const url=String(input);let bytes:Buffer;
    if(url===config.profileUrl)bytes=raw;
    else if(url===bundleUrl.href)bytes=await publicFile(descriptor,1024*1024);
    else {
      assert.ok(url.startsWith(directory));const name=url.slice(directory.length);
      assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);assert.ok(name!=='.'&&name!=='..');
      bytes=await publicFile(join(dirname(descriptor),name),512*1024*1024);
    }
    init?.signal?.throwIfAborted();return new Response(new Uint8Array(bytes));
  };
  return loadPublicDeploymentProfile(config.profileUrl,{profileSha256:config.profileSha256,fetch:fetcher});
}
/** Pin validation is exported so operators can validate placement without
 * starting a listener or loading the private budget. */
export function validateGatewayProfile(config:PublicDevnetGatewayConfig,loaded:LoadedPublicDeploymentProfile){
  validateConfig(config);publicProfileClientOptions(loaded); // Reject fabricated loader objects.
  assert.equal(loaded.profileSha256,config.profileSha256);
  const p=loaded.profile,m=loaded.assets.verifiedManifest;
  assert.equal(p.mode,'direct_openrouter');assert.equal(p.directProviderBases?.direct_openrouter,'https://openrouter.ai/api/v1');
  assert.equal(p.rpcUrl,config.publicOrigin+'/rpc');assert.equal(p.indexerOrigin,config.publicOrigin);
  assert.equal(m.control_api_origin,config.publicOrigin);assert.equal(p.models.length,1);
  assert.equal(p.models[0].provider,'openrouter');assert.deepEqual(p.models[0].apis,['chat']);
  assert.equal(m.cap_micro_usdc,'1000000');
  return {profile:p,manifest:m,model:p.models[0]};
}

/** Select only explicitly initialized, independently pinned supplemental state.
 * This adapter has no initialization command and never changes the old ledger. */
export async function loadSupplementalGatewayBudget(config:PublicDevnetGatewayConfig,loaded:LoadedPublicDeploymentProfile,
  commandRunner:BudgetCommandRunner=execute):Promise<DirectDemoBudget & {status():Promise<UiDirectProviderBudget>}>{
  config=structuredClone(config);
  const {profile,manifest,model}=validateGatewayProfile(config,loaded), selection=config.budget;
  assert.ok('kind' in selection && (selection.kind==='supplemental-v1'||selection.kind==='supplemental-detached-v2'));
  const detached=selection.kind==='supplemental-detached-v2';
  const info=await lstat(selection.authorizationPath);
  assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.uid===process.getuid?.()&&(info.mode&0o077)===0);
  const raw=await publicFile(selection.authorizationPath,1024*1024);
  assert.equal(await sha256Hex(raw),selection.authorizationSha256);
  const authorization=parseStrictJson(raw) as any;
  if(detached){
    assert.equal(authorization.schema,2);assert.equal(authorization.kind,'detached_supplemental_grant');
    assert.equal(authorization.policy,'new_grant_only_no_original_capacity_transfer');
  }
  assert.deepEqual(jcsBytes(authorization.deployment),jcsBytes({
    profile_sha256:loaded.profileSha256,manifest_sha256:manifest.manifest_hash,bundle_sha256:profile.bundle.sha256,
    sdk_sha256:selection.sdkSha256,native_sha256:selection.nativeSha256,tariff_sha256:model.tariff.tariff_hash,
    mode:'direct_openrouter',provider:'openrouter',model:model.id,cap_micro_usdc:'1000000',session_ttl_seconds:60,max_output_tokens:128,
  }));
  // The seven-case grant includes streaming and tool continuation. AUTH itself
  // cannot attest the private provider body or the caller's binary identity.
  assert.deepEqual(jcsBytes(profile.modelCapabilities[model.id]),jcsBytes({streaming:true,tools:true}));
  const run=async(command:'status'|'reserve',requestId?:string,digest?:string,allowNew=true)=>{
    const env:NodeJS.ProcessEnv={};for(const key of ['PATH','HOME','LANG','LC_ALL','TMPDIR'])if(process.env[key])env[key]=process.env[key];
    try{
      const result=await commandRunner('python3',[join(ROOT,'scripts',detached?'provider_detached_budget.py':'provider_supplemental_budget.py'),command,
        ...(selection.kind==='supplemental-detached-v2'?['--history-snapshot',resolve(selection.historySnapshotPath)]:['--plan',resolve(selection.planPath)]),
        '--state-dir',selection.stateDir,'--authorization',resolve(selection.authorizationPath),
        '--authorization-sha256',selection.authorizationSha256,
        ...(command==='reserve'?['--request-id',requestId!,'--auth-sha256',digest!,...(!allowNew?['--no-new-reservations']:[])]:[])],
        {cwd:ROOT,env,timeout:30_000,maxBuffer:1_048_576});
      return parseStrictJson(Buffer.from(result.stdout)) as any;
    }catch{throw Error('supplemental provider campaign unavailable');}
  };
  const status=async():Promise<UiDirectProviderBudget>=>{
    const value=await run('status');
    assert.equal(value.schema,detached?2:1);assert.equal(value.authorization_sha256,selection.authorizationSha256);
    assert.equal(value.refunds_supported,false);assert.equal(value.inference_replays_supported,false);
    for(const key of ['budget_micro_usdc','reserved_micro_usdc','remaining_micro_usdc'])assert.match(value[key],/^(0|[1-9][0-9]{0,8})$/);
    const total=BigInt(value.budget_micro_usdc),reserved=BigInt(value.reserved_micro_usdc),remaining=BigInt(value.remaining_micro_usdc);
    assert.ok(total<=17_000_000n&&reserved+remaining===total);
    for(const key of ['max_requests','reserved_requests','remaining_requests','supplemental_remaining_requests'])assert.ok(Number.isSafeInteger(value[key])&&value[key]>=0);
    assert.ok(value.max_requests<=1007&&value.reserved_requests+value.remaining_requests===value.max_requests);
    assert.ok(value.supplemental_remaining_requests<=7&&BigInt(value.supplemental_remaining_requests)*1_000_000n<=remaining);
    if(detached){
      assert.equal(total,7_000_000n);assert.equal(value.max_requests,7);
      assert.equal(BigInt(value.reserved_requests)*1_000_000n,reserved);
      assert.equal(value.supplemental_remaining_requests,value.remaining_requests);
      assert.equal(value.budget_scope,'active_detached_grant');
      assert.deepEqual(jcsBytes(value.historical_snapshot),jcsBytes({live:false,original_capacity_transferred_micro_usdc:'0'}));
    }
    return {schema:1,allowTransactions:config.allowTransactions,budget_micro_usdc:total.toString(),reserved_micro_usdc:reserved.toString(),
      remaining_micro_usdc:remaining.toString(),max_requests:value.max_requests,reserved_requests:value.reserved_requests,
      remaining_requests:value.remaining_requests,request_max_cost_micro_usdc:'1000000',
      available_requests:config.allowTransactions&&config.allowNewAdmissions?value.supplemental_remaining_requests:0,
      ...(detached?{budget_scope:'active_detached_grant',historical_snapshot:{live:false,original_capacity_transferred_micro_usdc:'0'}}:{})};
  };
  await status();
  return {status,async reserve(requestId,digest,allowNew=true){
    const value=await run('reserve',requestId,digest,config.allowTransactions&&config.allowNewAdmissions&&allowNew);
    assert.equal(value.auth_forward_allowed,true);assert.equal(value.inference_replays_supported,false);
    assert.equal(value.request_id,requestId);assert.equal(value.authorization_sha256,digest);
    assert.equal(value.grant_sha256,selection.authorizationSha256);assert.equal(value.reserved_micro_usdc,'1000000');
    if(detached){assert.equal(value.schema,2);assert.equal(value.reservation_source,'active_detached_grant');}
  }};
}
export async function configuredPublicDevnetGateway(config:PublicDevnetGatewayConfig){
  config=structuredClone(config);
  const loaded=await loadGatewayPublicProfile(config), {profile,manifest,model}=validateGatewayProfile(config,loaded);
  const budget='kind' in config.budget?await loadSupplementalGatewayBudget(config,loaded):
    await loadBrowserChatBudget(config.budget,manifest,model.tariff,model.id,config.allowTransactions,config.allowNewAdmissions);
  const forward=localForwarder(config.localCaPath?await publicFile(config.localCaPath,1024*1024):undefined);
  const control=directControlRelay({manifest,tariff:model.tariff,budget,
    forward:(path,method,headers,data,signal)=>forward(config.controlUrl+path,method,data,
      {...headers,host:new URL(manifest.control_api_origin).host},65536,signal)});
  const options:HostOptions={port:config.port,application:'public-api',publicOrigin:config.publicOrigin,
    allowedBrowserOrigins:[...config.allowedBrowserOrigins],allowNativeRequests:config.allowNativeRequests,
    allowTransactions:config.allowTransactions,allowNewAdmissions:config.allowNewAdmissions,admissionTokenSha256:config.admissionTokenSha256,manifest,
    preparationCommitment:profile.preparationCommitment,controlRelay:control,directBudget:budget.status,
    rpc:(data,signal)=>forward(config.rpcUrl,'POST',data,{},4*1024*1024,signal),
    ...(config.historyRpcUrl?{historyRpc:(data:Buffer,signal?:AbortSignal)=>forward(config.historyRpcUrl!,'POST',data,{},4*1024*1024,signal)}:{}),
    indexer:(path,signal)=>forward(config.indexerUrl+path,'GET',undefined,{},path.startsWith('/zkapi/v1/tree/snapshots/')?4*1024*1024:65536,signal)};
  return startUiHost(options);
}
async function main(){
  const args=process.argv.slice(2);assert.ok(args.length===2&&args[0]==='--config');
  const path=resolve(args[1]),info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.uid===process.getuid?.()&&(info.mode&0o077)===0);
  const config=parseStrictJson(await publicFile(path,1024*1024)) as unknown as PublicDevnetGatewayConfig;
  const host=await configuredPublicDevnetGateway(config);
  console.log(JSON.stringify({origin:host.origin,application:'public-api',admission:config.allowNewAdmissions?'enabled':'suspended',readiness:'not_checked'}));
  let stopping=false;for(const name of ['SIGINT','SIGTERM'] as const)process.on(name,()=>{if(!stopping){stopping=true;void host.close().then(()=>process.exit(0));}});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(()=>{console.error('Public Devnet gateway startup failed; private inputs suppressed.');process.exitCode=1;});
