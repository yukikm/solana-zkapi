/** Pure registration contract. No files, credentials, network, clocks or custody. */
import {resolve} from 'node:path';
import bs58 from 'bs58';
import {validateApiBinding,validateApiService,apiOperationPath,type ApiBinding,type ApiService,type Mode} from '../packages/sdk/src/control.ts';
import {validateClientConfiguration,type ModelConfiguration,type CreateClientOptions} from '../packages/sdk/src/client.ts';
import {jcsBytes,sha256Hex} from '../packages/sdk/src/trust.ts';

export const REGISTRATION_CONTRACT_VERSION=1;
export type RegistrationErrorCode='invalid_schema'|'unsupported_api_contract'|'duplicate_operation'|'invalid_tariff'|'price_exceeds_cap'|'pin_mismatch'|'authority_mismatch'|'provider_config_mismatch'|'staging_provenance_required'|'output_exists'|'unsafe_path'|'incomplete_output'|'artifact_verification_failed';
export class RegistrationError extends Error { readonly code:RegistrationErrorCode;readonly field:string;readonly reason:string;constructor(code:RegistrationErrorCode,field:string,reason:string){super(`${code}: ${field}: ${reason}`);this.code=code;this.field=field;this.reason=reason;} }
export function requireConfig(condition:unknown,code:RegistrationErrorCode,field:string,reason:string):asserts condition{if(!condition)throw new RegistrationError(code,field,reason);}
export function exact(value:any,required:readonly string[],optional:readonly string[]=[],field='config'){
  requireConfig(value!==null&&typeof value==='object'&&!Array.isArray(value),'invalid_schema',field,'object required');
  requireConfig(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)),'invalid_schema',field,'exact fields required');
}
export function canonicalPath(value:unknown,field='path'):asserts value is string{
  requireConfig(typeof value==='string'&&value.startsWith('/')&&value.length<=4096&&value!== '/'&&!value.split('/').some(part=>part==='REPLACE'||part.startsWith('REPLACE_'))&&resolve(value)===value&&!/[\x00-\x1f\x7f\\]/.test(value),'unsafe_path',field,'canonical absolute path required');
}
export function publicHttps(value:unknown,origin=false,field='origin'):asserts value is string{
  let u:URL;try{u=new URL(String(value));}catch{throw new RegistrationError('unsupported_api_contract',field,'public HTTPS URL required');}
  const h=u.hostname.toLowerCase();requireConfig(typeof value==='string'&&u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&h.includes('.')&&!h.endsWith('.')&&!h.startsWith('[')&&!/^\d+(?:\.\d+){3}$/.test(h)&&!['localhost','local','internal','invalid','test','onion'].some(s=>h===s||h.endsWith('.'+s))&&(origin?u.origin:u.href)===value,'unsupported_api_contract',field,'canonical public HTTPS URL required');
}
export function integerString(value:unknown,field:string,positive=false,maximum=0x7fffffffffffffffn):bigint{
  requireConfig(typeof value==='string'&&(positive?/^[1-9][0-9]{0,18}$/:/^(0|[1-9][0-9]{0,18})$/).test(value),'invalid_tariff',field,'canonical integer string required');
  const n=BigInt(value);requireConfig(n<=maximum,'invalid_tariff',field,'integer exceeds supported bound');return n;
}
export interface PinnedFile{path:string;sha256:string}
export interface ServiceDeclaration{api:ApiBinding;priceMicroUsdc:string;validFrom:string;validUntil:string;credentialFile:string}
export interface ApiProject{schema:1;target:'devnet-new';staging:PinnedFile;operator:PinnedFile;services:readonly ServiceDeclaration[]}
export interface StagingConsumer{id:string;revision:number;mode:Mode;models:readonly ModelConfiguration[];modelCapabilities:Readonly<Record<string,{streaming:boolean;tools:boolean}>>;services:readonly ApiService[];directProviderBases?:CreateClientOptions['directProviderBases'];oaVerifier?:CreateClientOptions['oaVerifier']}
export function validatePin(pin:PinnedFile,field:string){exact(pin,['path','sha256'],[],field);canonicalPath(pin.path,field+'.path');requireConfig(typeof pin.sha256==='string'&&/^[0-9a-f]{64}$/.test(pin.sha256),'pin_mismatch',field+'.sha256','SHA256 required');}
export function validateApiProject(project:ApiProject){exact(project,['schema','target','staging','operator','services']);requireConfig(project.schema===1&&project.target==='devnet-new','invalid_schema','target','new Devnet staging required');validatePin(project.staging,'staging');validatePin(project.operator,'operator');requireConfig(Array.isArray(project.services)&&project.services.length>0&&project.services.length<=64,'invalid_schema','services','one to 64 operations required');}
export async function compileApiServices(declarations:readonly ServiceDeclaration[],capMicroUsdc:string,policy:'public'|'local_fixture'='public'):Promise<readonly ApiService[]>{
  requireConfig(Array.isArray(declarations)&&declarations.length>0&&declarations.length<=64,'invalid_schema','services','one to 64 operations required');
  const cap=integerString(capMicroUsdc,'capMicroUsdc',true),seen=new Set<string>(),result:ApiService[]=[];
  for(const [i,item] of declarations.entries()){
    const f=`services[${i}]`;exact(item,['api','priceMicroUsdc','validFrom','validUntil','credentialFile'],[],f);
    try{validateApiBinding(item.api);}catch{throw new RegistrationError('unsupported_api_contract',f+'.api','registered POST JSON descriptor required');}
    if(policy==='public')publicHttps(item.api.origin,true,f+'.api.origin');else{const u=new URL(item.api.origin);requireConfig(u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname),'unsupported_api_contract',f+'.api.origin','numeric loopback HTTP required');}
    canonicalPath(item.credentialFile,f+'.credentialFile');
    const identity=apiOperationPath(item.api);requireConfig(!seen.has(identity),'duplicate_operation',f+'.api','operation already declared');seen.add(identity);
    const price=integerString(item.priceMicroUsdc,f+'.priceMicroUsdc',true),nano=price*1000n;
    requireConfig(nano<=0x7fffffffffffffffn,'invalid_tariff',f+'.priceMicroUsdc','nano rate exceeds signed i64');requireConfig(price<=cap,'price_exceeds_cap',f+'.priceMicroUsdc','operation exceeds authorization cap');
    const start=integerString(item.validFrom,f+'.validFrom'),end=integerString(item.validUntil,f+'.validUntil');requireConfig(end>start,'invalid_tariff',f+'.validUntil','validity interval must increase');
    const body={version:'2' as const,provider:'generic' as const,pricing_basis:'fixed_request' as const,api:structuredClone(item.api),valid_from:item.validFrom,valid_until:item.validUntil,rates:[{unit:'requests',nano_usdc_numerator:nano.toString(),unit_denominator:'1'}],operator_fee_micro_usdc:'0'};
    const service={tariff:{...body,tariff_hash:await sha256Hex(jcsBytes(body))}};validateApiService(service);
    Object.freeze(service.tariff.api);Object.freeze(service.tariff.rates[0]);Object.freeze(service.tariff.rates);Object.freeze(service.tariff);Object.freeze(service);result.push(service);
  }
  return Object.freeze(result);
}
export function validateStagingConsumer(c:StagingConsumer){
  exact(c,['id','revision','mode','models','modelCapabilities','services'],['directProviderBases','oaVerifier'],'consumer');
  requireConfig(typeof c.id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(c.id)&&Number.isSafeInteger(c.revision)&&c.revision>0,'invalid_schema','consumer','valid profile identity required');
  validateClientConfiguration(c.mode,c.models,c.services);exact(c.modelCapabilities,c.models.map(m=>m.id),[],'consumer.modelCapabilities');
  for(const m of c.models){exact(c.modelCapabilities[m.id],['streaming','tools'],[],'consumer.modelCapabilities');requireConfig(Object.values(c.modelCapabilities[m.id]).every(v=>typeof v==='boolean'),'invalid_schema','consumer.modelCapabilities','boolean capabilities required');}
}
export function selectedTariffHashes(c:Pick<StagingConsumer,'models'|'services'>){return [...new Set([...c.models.map(m=>m.tariff.tariff_hash),...c.services.map(s=>s.tariff.tariff_hash)])].sort();}
export const COMMON_API_ENDPOINTS=['/zkapi/v1/config','/zkapi/v1/catalog','/zkapi/v1/quotes','/zkapi/v1/sessions','/zkapi/v1/withdraw/clearance'];
export function selectedApiEndpoints(c:Pick<StagingConsumer,'models'|'services'>){const result=[...COMMON_API_ENDPOINTS];if(c.models.length)result.push('/v1/models');for(const m of c.models)for(const api of m.apis)result.push(...(api==='chat'?['/v1/chat/completions']:api==='responses'?['/v1/responses']:['/v1/messages','/v1/messages/count_tokens']));for(const s of c.services)result.push(apiOperationPath(s.tariff.api));return [...new Set(result)].sort();}

export interface ProxyProviderConfig{provider:'openai'|'anthropic'|'openrouter'|'oa';credential_file:string;local_test_base:string|null;models:readonly {provider:string;model:string;endpoints:readonly string[];context_tokens:number;max_output_tokens:number;cache_mode:string}[]}
export interface PriorityFeePolicy{base:number;warning:number;page:number;emergency:number;cap:number}
export interface ArchiveBatchPolicy{max_blocks:number;max_bytes:number;rpc_concurrency?:number}
export interface OperatorPreparation{
 schema:1;targetRoot:string;inspectionBinary:PinnedFile;
 control:{listen:string;primaryRpc:string;secondaryRpc:string;indexerOrigin:string;quoteSeedFile:string;receiptSeedFile:string};
 dispatcher:{binary:PinnedFile;databaseUrl:string;claimsDirectory:string};
 indexer:{rpcUrl:string;startSlot:number;listen:string;publicOrigin:string;snapshotsDirectory:string};
 signer:{journal:string;socket:string;stateSeedFile:string;clearanceSeedFile:string};
 database:{migrationDsnFile:string;writerDsnFile:string;signerDsnFile:string};
 challenger:{rpcUrl:string;databaseDsnFile:string;journalDirectory:string;node:string;transportBridge:PinnedFile;feeKeyFile:string;payer:string;pollSeconds:number;alertSinkDirectory?:string;priorityFee?:PriorityFeePolicy;archiveBatch?:ArchiveBatchPolicy};
 inferenceProviders:readonly ProxyProviderConfig[];
}
function number(value:unknown,field:string,min=0,max=Number.MAX_SAFE_INTEGER){requireConfig(typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max,'invalid_schema',field,'integer outside supported bounds');}
function rpc(value:unknown,local:boolean,field:string){let u:URL;try{u=new URL(String(value));}catch{throw new RegistrationError('invalid_schema',field,'RPC URL required');}requireConfig(typeof value==='string'&&!u.username&&!u.password&&!u.hash&&(local?u.protocol==='http:'&&['127.0.0.1','[::1]'].includes(u.hostname):u.protocol==='https:'),'invalid_schema',field,'authenticated transport policy required');}
function validateDatabaseLocation(value:string,local:boolean){
 // Parse only the connection location here, without opening or exposing the DSN.
 // The destination's tokio-postgres parser remains authoritative at startup.
 let hosts:string[]=[];
 if(/^postgres(?:ql)?:\/\//.test(value)){
  let url:URL;try{url=new URL(value);}catch{throw new RegistrationError('invalid_schema','dispatcher.databaseUrl','invalid database URL');}
  requireConfig(!url.searchParams.has('hostaddr'),'invalid_schema','dispatcher.databaseUrl','explicit host addresses forbidden');
  hosts=(url.searchParams.get('host')??decodeURIComponent(url.hostname)).split(',');
 }else{
  const pairs:Record<string,string>={};let remaining=value.trim();
  while(remaining){const key=/^([a-z_]+)\s*=\s*/.exec(remaining);requireConfig(key,'invalid_schema','dispatcher.databaseUrl','invalid database connection syntax');remaining=remaining.slice(key[0].length);let item='';
   if(remaining.startsWith("'")){remaining=remaining.slice(1);let closed=false;while(remaining){const ch=remaining[0];remaining=remaining.slice(1);if(ch==="'"){closed=true;break;}if(ch==='\\'){requireConfig(remaining.length>0,'invalid_schema','dispatcher.databaseUrl','invalid database escape');item+=remaining[0];remaining=remaining.slice(1);}else item+=ch;}requireConfig(closed&&(!remaining||/^\s/.test(remaining)),'invalid_schema','dispatcher.databaseUrl','invalid quoted database value');}
   else{const token=/^[^\s]+/.exec(remaining);requireConfig(token,'invalid_schema','dispatcher.databaseUrl','database value required');item=token[0];remaining=remaining.slice(item.length);}
   requireConfig(!Object.hasOwn(pairs,key[1]),'invalid_schema','dispatcher.databaseUrl','duplicate database connection field');pairs[key[1]]=item;remaining=remaining.trimStart();
  }
  requireConfig(!Object.hasOwn(pairs,'hostaddr'),'invalid_schema','dispatcher.databaseUrl','explicit host addresses forbidden');hosts=(pairs.host??'').split(',');
 }
 requireConfig(hosts.length>0&&hosts.every(host=>host.startsWith('/')||local&&['127.0.0.1','::1','localhost'].includes(host)),'invalid_schema','dispatcher.databaseUrl','explicit Unix database connection required');
 for(const host of hosts)if(host.startsWith('/'))canonicalPath(host,'dispatcher.databaseUrl');
}
export function validateOperator(o:OperatorPreparation,selection:StagingConsumer,local=false){
 exact(o,['schema','targetRoot','inspectionBinary','control','dispatcher','indexer','signer','database','challenger','inferenceProviders']);requireConfig(o.schema===1,'invalid_schema','operator.schema','schema one required');canonicalPath(o.targetRoot,'targetRoot');validatePin(o.inspectionBinary,'inspectionBinary');
 for(const [name,required,optional] of [['control',['listen','primaryRpc','secondaryRpc','indexerOrigin','quoteSeedFile','receiptSeedFile'],[]],['dispatcher',['binary','databaseUrl','claimsDirectory'],[]],['indexer',['rpcUrl','startSlot','listen','publicOrigin','snapshotsDirectory'],[]],['signer',['journal','socket','stateSeedFile','clearanceSeedFile'],[]],['database',['migrationDsnFile','writerDsnFile','signerDsnFile'],[]],['challenger',['rpcUrl','databaseDsnFile','journalDirectory','node','transportBridge','feeKeyFile','payer','pollSeconds'],['alertSinkDirectory','priorityFee','archiveBatch']]] as const)exact(o[name],required,optional,name);
 for(const [name,obj] of Object.entries({control:o.control,dispatcher:o.dispatcher,indexer:o.indexer,signer:o.signer,database:o.database,challenger:o.challenger}))for(const [key,v]of Object.entries(obj))if(/(?:File|Directory)$/.test(key)||['journal','socket','node'].includes(key))canonicalPath(v,name+'.'+key);
 validatePin(o.dispatcher.binary,'dispatcher.binary');validatePin(o.challenger.transportBridge,'challenger.transportBridge');
 for(const listen of [o.control.listen,o.indexer.listen]){requireConfig(typeof listen==='string'&&/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(listen),'invalid_schema','listen','numeric loopback socket required');number(Number(listen.split(':')[1]),'listen.port',1024,65535);}
 requireConfig(o.control.listen!==o.indexer.listen&&o.control.primaryRpc!==o.control.secondaryRpc,'provider_config_mismatch','control','separate listeners and RPC inputs required');
 for(const [f,v]of Object.entries({primary:o.control.primaryRpc,secondary:o.control.secondaryRpc,indexer:o.indexer.rpcUrl,challenger:o.challenger.rpcUrl}))rpc(v,local,f);
 for(const [f,v]of Object.entries({controlIndexer:o.control.indexerOrigin,publicIndexer:o.indexer.publicOrigin})){if(local||f==='controlIndexer'&&/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(v)){rpc(v,true,f);requireConfig(new URL(v).origin===v,'invalid_schema',f,'origin required');}else publicHttps(v,true,f);}
 requireConfig(typeof o.dispatcher.databaseUrl==='string'&&o.dispatcher.databaseUrl.length>0&&o.dispatcher.databaseUrl.length<=8192&&!/[\x00\r\n]/.test(o.dispatcher.databaseUrl),'invalid_schema','dispatcher.databaseUrl','bounded DSN required');
 validateDatabaseLocation(o.dispatcher.databaseUrl,local);
 number(o.indexer.startSlot,'indexer.startSlot');number(o.challenger.pollSeconds,'challenger.pollSeconds',1,30);
 try{requireConfig(bs58.decode(o.challenger.payer).length===32,'invalid_schema','challenger.payer','public key required');}catch{throw new RegistrationError('invalid_schema','challenger.payer','public key required');}
 if(o.challenger.priorityFee!==undefined){const p=o.challenger.priorityFee;exact(p,['base','warning','page','emergency','cap'],[],'priorityFee');for(const v of Object.values(p))number(v,'priorityFee',1,1000000);requireConfig(p.base<=p.warning&&p.warning<=p.page&&p.page<=p.emergency&&p.emergency<=p.cap,'invalid_schema','priorityFee','monotonic priority fees required');}
 if(o.challenger.archiveBatch!==undefined){const p=o.challenger.archiveBatch;exact(p,['max_blocks','max_bytes'],['rpc_concurrency'],'archiveBatch');number(p.max_blocks,'archiveBatch.max_blocks',1,256);number(p.max_bytes,'archiveBatch.max_bytes',1,32*1024*1024);if(p.rpc_concurrency!==undefined)number(p.rpc_concurrency,'archiveBatch.rpc_concurrency',1,16);}
 requireConfig(Array.isArray(o.inferenceProviders)&&o.inferenceProviders.length<=4,'provider_config_mismatch','inferenceProviders','provider list required');const seen=new Set<string>();
 for(const p of o.inferenceProviders){exact(p,['provider','credential_file','local_test_base','models'],[],'inferenceProviders');canonicalPath(p.credential_file);requireConfig(!seen.has(p.provider)&&['openai','anthropic','openrouter'].includes(p.provider)&&Array.isArray(p.models)&&p.models.length>0,'provider_config_mismatch','inferenceProviders','unique supported provider required');seen.add(p.provider);requireConfig(p.local_test_base===null||local,'provider_config_mismatch','local_test_base','fixture base forbidden');if(p.local_test_base!==null)rpc(p.local_test_base,true,'local_test_base');for(const m of p.models){exact(m,['provider','model','endpoints','context_tokens','max_output_tokens','cache_mode'],[],'provider.models');number(m.context_tokens,'context_tokens',1);number(m.max_output_tokens,'max_output_tokens',1);const selected=selection.models.find(s=>s.id===m.model&&s.provider===p.provider);requireConfig(selected&&m.provider===p.provider&&Array.isArray(m.endpoints)&&new Set(m.endpoints).size===m.endpoints.length,'provider_config_mismatch','provider.models','model selection mismatch');const expected=selected.apis.flatMap(a=>a==='chat'?['chat_completions']:a==='responses'?['responses']:['messages','count_tokens']);requireConfig(jcsBytes([...m.endpoints].sort()).toString()===jcsBytes(expected.sort()).toString(),'provider_config_mismatch','provider.models.endpoints','endpoint selection mismatch');requireConfig(['inclusive_read','inclusive_read_write','anthropic_split'].includes(m.cache_mode)&&(p.provider==='anthropic')===(m.cache_mode==='anthropic_split'),'provider_config_mismatch','cache_mode','cache contract mismatch');}}
 const selected=selection.models.map(m=>m.provider+':'+m.id).sort(),provided=o.inferenceProviders.flatMap(p=>p.models.map((m:ProxyProviderConfig['models'][number])=>p.provider+':'+m.model)).sort();requireConfig(JSON.stringify(selected)===JSON.stringify(provided),'provider_config_mismatch','inferenceProviders','exact selected model coverage required');
}

export const INDEXER_ROUTES=['/zkapi/v1/tree/root','/zkapi/v1/tree/notes/{id}/path','/zkapi/v1/tree/notes/{id}/zero-path','/zkapi/v1/tree/snapshot','/zkapi/v1/tree/snapshots/{name}'] as const;
export interface FrontendRoute{origin:string;methods:readonly string[];path:string;match:'exact'|'template'|'prefix';backend:'control'|'indexer'|'rpc';requestMaxBytes:number;responseMaxBytes:number;timeoutMs:number}
export interface FrontendRoutes{schema:1;listeners:{control:string;indexer:string;rpc:string};routes:readonly FrontendRoute[];preserveRequestBody:true;preserveHeaders:readonly ['Idempotency-Key','Authorization'];mutationRetries:0;rpcMethods:readonly string[]}
export function frontendRoutes(manifest:any,selection:StagingConsumer,o:OperatorPreparation,rpcUrl:string):FrontendRoutes{
 const control=manifest.control_api_origin,execution=manifest.inference_api_origin,indexer=o.indexer.publicOrigin;
 const routes:FrontendRoute[]=INDEXER_ROUTES.map(path=>({origin:indexer,methods:['GET'],path,match:path.includes('{')?'template':'exact',backend:'indexer',requestMaxBytes:0,responseMaxBytes:16*1024*1024,timeoutMs:60000}));
 for(const s of selection.services)routes.push({origin:execution,methods:['POST'],path:apiOperationPath(s.tariff.api),match:'exact',backend:'control',requestMaxBytes:Number(s.tariff.api.request_max_bytes),responseMaxBytes:Math.max(65536,Number(s.tariff.api.response_max_bytes)),timeoutMs:660000});
 if(selection.models.length)for(const path of selectedApiEndpoints({...selection,services:[]}).filter(p=>p.startsWith('/v1/')))routes.push({origin:execution,methods:[path==='/v1/models'?'GET':'POST'],path,match:'exact',backend:'control',requestMaxBytes:8*1024*1024,responseMaxBytes:32*1024*1024,timeoutMs:300000});
 routes.push({origin:control,methods:['GET','POST','DELETE'],path:'/zkapi/v1',match:'prefix',backend:'control',requestMaxBytes:8*1024*1024,responseMaxBytes:16*1024*1024,timeoutMs:60000});
 const rpc=new URL(rpcUrl);routes.push({origin:rpc.origin,methods:['POST'],path:rpc.pathname,match:'exact',backend:'rpc',requestMaxBytes:8*1024*1024,responseMaxBytes:32*1024*1024,timeoutMs:60000});
 return{schema:1,listeners:{control:o.control.listen,indexer:o.indexer.listen,rpc:o.control.primaryRpc},routes,preserveRequestBody:true,preserveHeaders:['Idempotency-Key','Authorization'],mutationRetries:0,rpcMethods:['getGenesisHash','getAccountInfo','getMultipleAccounts','getBalance','getSlot','getBlock','getBlockHeight','getLatestBlockhash','getMinimumBalanceForRentExemption','getSignatureStatuses','getTransaction','isBlockhashValid','simulateTransaction','sendTransaction']};
}
/** First match wins; indexer routes must precede the shared /zkapi/v1 route. */
export function selectFrontendRoute(description:FrontendRoutes,url:string,method:string){const u=new URL(url);return description.routes.find(r=>r.origin===u.origin&&r.methods.includes(method)&&(r.match==='exact'?u.pathname===r.path:r.match==='prefix'?(u.pathname===r.path||u.pathname.startsWith(r.path+'/')):new RegExp('^'+r.path.replace('{id}','(?:0|[1-9][0-9]*)').replace('{name}','[0-9a-f]{64}\\.json')+'$').test(u.pathname)));}
export function validateFrontendRoutes(d:FrontendRoutes,indexerOrigin:string){
 exact(d,['schema','listeners','routes','preserveRequestBody','preserveHeaders','mutationRetries','rpcMethods'],[],'routes');requireConfig(d.schema===1&&d.preserveRequestBody===true&&d.mutationRetries===0&&JSON.stringify(d.preserveHeaders)===JSON.stringify(['Idempotency-Key','Authorization']),'provider_config_mismatch','routes','preserved bytes and disabled retries required');
 for(const path of INDEXER_ROUTES){const actual=path.replace('{id}','0').replace('{name}','a'.repeat(64)+'.json'),matches=d.routes.filter(r=>r.origin===indexerOrigin&&r.path===path);requireConfig(matches.length===1&&matches[0].backend==='indexer'&&JSON.stringify(matches[0].methods)==='["GET"]'&&selectFrontendRoute(d,indexerOrigin+actual,'GET')===matches[0],'provider_config_mismatch','routes','all indexer routes must take precedence');}
}
export interface RenderArtifacts{manifest:string;idl:string;program:string;buildManifest:string;publicProfile:string;treePk:string;buildManifestHash:string;publicProfileHash:string}
/** Pure destination-path renderer shared with explicit test-only fixture callers. */
export function renderOperatorConfiguration(input:{operator:OperatorPreparation;manifest:any;selection:StagingConsumer;declarations:readonly ServiceDeclaration[];artifacts:RenderArtifacts;rpcUrl:string;network:'devnet'|'local'}){
 const {operator:o,manifest:m,selection:c,declarations,artifacts:a}=input;validateOperator(o,c,input.network==='local');
 requireConfig(c.mode==='proxy','provider_config_mismatch','consumer.mode','proxy registration required');
 requireConfig(c.services.length===declarations.length&&c.services.every((s,i)=>Buffer.from(jcsBytes(s.tariff.api as any)).equals(Buffer.from(jcsBytes(declarations[i].api as any)))),'provider_config_mismatch','services','compiled operation descriptor mismatch');
 const path=(name:string)=>o.targetRoot+'/private/'+name;
 const devnet={idl_file:a.idl,program_file:a.program,build_manifest_file:a.buildManifest,trusted_build_manifest_hash:a.buildManifestHash,public_profile_file:a.publicProfile,trusted_public_profile_hash:a.publicProfileHash};
 const providers={direct:[],proxy:structuredClone(o.inferenceProviders),api:c.services.map((s,i)=>({api:structuredClone(s.tariff.api),credential_file:declarations[i].credentialFile}))};
 const dispatcher={local_test_only:input.network==='local',...(input.network==='devnet'?{devnet:{deployment:devnet,manifest:m,trusted_manifest_hash:m.manifest_hash}}:{}),database_url:o.dispatcher.databaseUrl,pool:[...bs58.decode(m.pool)],claims_directory:o.dispatcher.claimsDirectory,providers};
 const control={local_test_only:true,...(input.network==='devnet'?{devnet}:{}),listen:o.control.listen,manifest:m,trusted_manifest_hash:m.manifest_hash,primary_rpc:o.control.primaryRpc,secondary_rpc:o.control.secondaryRpc,indexer_origin:o.control.indexerOrigin,signer_socket:o.signer.socket,quote_seed_file:o.control.quoteSeedFile,receipt_seed_file:o.control.receiptSeedFile,enable_local_adapter:false,providers:{...providers,dispatcher:{binary:o.dispatcher.binary.path,binary_sha256:o.dispatcher.binary.sha256,config_file:path('dispatcher.json')}},tariffs:[...new Map([...c.models.map(x=>x.tariff),...c.services.map(x=>x.tariff)].map(t=>[t.tariff_hash,t])).values()]};
 const indexer={rpc_url:o.indexer.rpcUrl,program_id:m.program_id,pool:m.pool,genesis_hash:m.genesis_hash,circuit_profile_hash:m.circuit_profile_hash,start_slot:o.indexer.startSlot,listen:o.indexer.listen,public_origin:o.indexer.publicOrigin,snapshots_directory:o.indexer.snapshotsDirectory};
 const ch=o.challenger;const challenger={manifest:a.manifest,manifest_sha256:m.manifest_hash,...(input.network==='devnet'?{devnet}:{}),rpc_url:ch.rpcUrl,database_dsn_file:ch.databaseDsnFile,start_slot:o.indexer.startSlot,journal_directory:ch.journalDirectory,tree_pk:a.treePk,node:ch.node,transport_bridge:ch.transportBridge.path,transport_bridge_sha256:ch.transportBridge.sha256,fee_key_file:ch.feeKeyFile,payer:ch.payer,poll_seconds:ch.pollSeconds,...(ch.alertSinkDirectory===undefined?{}:{alert_sink_directory:ch.alertSinkDirectory}),...(ch.priorityFee===undefined?{}:{priority_fee:ch.priorityFee}),...(ch.archiveBatch===undefined?{}:{archive_batch:ch.archiveBatch})};
 const signerInputs={schema:1,localTest:true,config:path('signer.json'),journal:o.signer.journal,socket:o.signer.socket,stateSeedFile:o.signer.stateSeedFile,clearanceSeedFile:o.signer.clearanceSeedFile,databaseDsnFile:o.database.signerDsnFile};
 const startup={schema:1,targetRoot:o.targetRoot,configs:{control:path('control.json'),dispatcher:path('dispatcher.json'),indexer:path('indexer.json'),challenger:path('challenger.json'),signer:path('signer.json'),signerInputs:path('signer-inputs.json')},database:o.database,dispatcherBinary:o.dispatcher.binary,challengerTransportBridge:ch.transportBridge,providerCredentialFiles:declarations.map(d=>d.credentialFile),requiredBeforeStartup:['independent_finalized_deployment_verification','independent_pool_initialization_slot_verification','new_database_and_financial_state'],order:['migrate_new_database','provision_pool_admission_disabled','initialize_signer_journal_once','initialize_challenger_once','start_signer','start_indexer','reconcile','start_control','start_challenger'],environmentFromFiles:{migrate:{ZKAPI_DATABASE_URL:o.database.migrationDsnFile},control:{ZKAPI_DATABASE_URL:o.database.writerDsnFile},signer:{ZKAPI_SIGNER_DATABASE_URL:o.database.signerDsnFile}}};
 const routes=frontendRoutes(m,c,o,input.rpcUrl);validateFrontendRoutes(routes,o.indexer.publicOrigin);
 return{control,dispatcher,indexer,challenger,signerInputs,startup,routes};
}
