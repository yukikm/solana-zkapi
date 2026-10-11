/** Versioned finite HTTP carrier. It owns bytes and validation, never balances. */
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { jcsBytes, parseStrictJson, sha256Hex } from './trust.ts';

export type HeaderPairs = [string, string][];
export interface AdapterPin { id: string; version: string; artifact_sha256: string }
export interface ApiBindingV2 {
  version: '2'; service: string; operation: string; mode: 'proxy'; transport: AdapterPin; origin: string;
  routes: {method: string; path: string}[]; query: 'preserve';
  headers: {request:'end_to_end';request_reject:string[];response:'end_to_end';response_reject:string[];trailers:string[];static_request:HeaderPairs};
  representation: {request_media_types:string[];response_media_types:string[];request_encoding:'identity';response_encodings:string[]};
  limits: Record<'target_bytes'|'header_pairs'|'header_bytes'|'request_bytes'|'response_bytes'|'decoded_response_bytes'|'decode_ratio'|'parser_bytes'|'relay_buffer_bytes'|'header_seconds'|'idle_seconds'|'execution_seconds'|'max_concurrency',string>;
  authentication: {scheme:'none'|'bearer'|'basic';policy_id:string} | {scheme:'api_key_header';policy_id:string;header:string};
  privacy: {identifiers:'allow'|'reject_by_meter';resources:'stateless'|'shared_public'};
  meter: {adapter:AdapterPin;resource:null|{provider:'openai'|'anthropic';model:string};config:Record<string,string>;config_hash:string};
  completion: {kind:'http_complete'|'provider_terminal_usage';billable_statuses:number[]};
  recovery: {policy:'finite_unknown_v1';reconciliation_seconds:'900'};
}
export type GatewayBinding = ApiBindingV2;
export interface TariffV3 {
  tariff_hash:string;version:'3';provider:'generic';api:ApiBindingV2;pricing_basis:'fixed_request'|'fixed_usage_rates';
  valid_from:string;valid_until:string;rates:{unit:string;nano_usdc_numerator:string;unit_denominator:string;reservation_max_count:string}[];operator_fee_micro_usdc:'0';
}
export type GatewayTariff = TariffV3;
export interface GatewayInvocation { version:'2';method:string;target:string;headers:HeaderPairs;body:Uint8Array }
export interface GatewayResponse { status:number;headers:HeaderPairs;trailerNames:string[];body:ReadableStream<Uint8Array>;trailers:Promise<HeaderPairs>;completed:Promise<void>;confirmDelivery?:()=>Promise<void> }
export interface GatewayResult extends GatewayResponse {operationId:string;statusPath:string}
export interface GatewayConfiguration { capabilities:['finite_http_v1'];mounts:{prefix:string;service:string;operation:string;binding_hash:string}[] }
export const GATEWAY_REQUEST_TYPE = 'application/vnd.zkapi.http-request.v2';
export const GATEWAY_RESPONSE_TYPE = 'application/vnd.zkapi.http-response.v2';
const id = /^[a-z0-9][a-z0-9_-]{0,63}$/, hash = /^[0-9a-f]{64}$/, headerName = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const methods = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
const i64 = 0x7fffffffffffffffn, numericMax = 10n ** 38n - 1n;
function check(v:unknown,message='invalid gateway contract'):asserts v { if(!v)throw Error(message); }
function fields(value:unknown,names:string[]):asserts value is Record<string,any> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).sort().join(',') === [...names].sort().join(','),'invalid gateway fields');
}
function uint(v:unknown,max=i64,min=0n):bigint { check(typeof v==='string' && /^(0|[1-9][0-9]*)$/.test(v) && v.length<=38,'invalid gateway integer');const n=BigInt(v);check(n>=min && n<=max);return n; }
function sorted(values:unknown,max:number,accept:(v:any)=>boolean):asserts values is any[] { check(Array.isArray(values)&&values.length<=max);let previous:string|undefined;for(const value of values){check(accept(value)&&(previous===undefined||previous<value));previous=value;} }
function pin(value:AdapterPin,ids:string[]):void {fields(value,['id','version','artifact_sha256']);check(ids.includes(value.id)&&value.version==='1'&&hash.test(value.artifact_sha256));}
function reserved(name:string):boolean {return /^(?:connection|keep-alive|transfer-encoding|te|trailer|upgrade|host|content-length|expect|forwarded|authorization|cookie|idempotency-key)$/.test(name)||/^(?:proxy-|x-zkapi-|x-forwarded-)/.test(name);}
function responseReserved(name:string):boolean {return reserved(name)||/^(?:set-cookie|www-authenticate|access-control-|content-security-policy|strict-transport-security|cross-origin-|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|clear-site-data)/.test(name);}
function trailerForbidden(name:string):boolean {return responseReserved(name)||name.startsWith('content-')||['cache-control','location'].includes(name);}
function singleton(name:string,credential?:string):boolean {return ['content-type','content-encoding','content-length','host','authorization','cookie'].includes(name)||name===credential;}
function valueBytes(value:unknown):Uint8Array {check(typeof value==='string');const bytes=Buffer.from(value,'base64');check(bytes.toString('base64')===value && bytes.every(b=>b===9 || b>=32&&b!==127),'invalid gateway header value');return new Uint8Array(bytes);}
function trim(bytes:Uint8Array):Uint8Array {let a=0,b=bytes.length;while(a<b&&(bytes[a]===32||bytes[a]===9))a++;while(b>a&&(bytes[b-1]===32||bytes[b-1]===9))b--;return bytes.slice(a,b);}
/** Inputs use Base64 bytes, never Headers, so repeated values and obs-text survive. */
export function semanticHeaderPairs(input:HeaderPairs,binding:ApiBindingV2,direction:'request'|'response'|'trailers'='request'):HeaderPairs {
  check(Array.isArray(input)&&input.length<=Number(binding.limits.header_pairs));
  const credential=binding.authentication.scheme==='api_key_header'?binding.authentication.header:'authorization';
  let size=0;const seen=new Set<string>(),pairs:HeaderPairs=[];
  for(const pair of input){check(Array.isArray(pair)&&pair.length===2&&typeof pair[0]==='string');const name=pair[0].toLowerCase();check(headerName.test(name));const bytes=valueBytes(pair[1]);size+=name.length+bytes.length;
    check(!singleton(name,credential)||!seen.has(name),'duplicate singleton header');seen.add(name);
    if(direction==='request')check(!reserved(name)&&name!==credential&&!binding.headers.request_reject.includes(name)&&!binding.headers.static_request.some(p=>p[0]===name),'forbidden request header');
    else if(direction==='trailers')check(binding.headers.trailers.includes(name)&&!trailerForbidden(name)&&!binding.headers.response_reject.includes(name),'forbidden trailer');
    else check((name==='content-length'||!responseReserved(name))&&!binding.headers.response_reject.includes(name),'forbidden response header');
    pairs.push([name,Buffer.from(trim(bytes)).toString('base64')]);
  }
  check(size<=Number(binding.limits.header_bytes),'gateway header limit');
  return pairs.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
}
/** Native ingress strips local/hop identity before constructing the envelope. */
export function gatewayIngressHeaders(input:HeaderPairs,binding:ApiBindingV2):HeaderPairs {
  const nominated=new Set<string>();
  for(const [name,value] of input)if(name.toLowerCase()==='connection')for(const field of Buffer.from(valueBytes(value)).toString('latin1').split(',')){check(headerName.test(field.trim().toLowerCase()));nominated.add(field.trim().toLowerCase());}
  const seen=new Set<string>();for(const [raw] of input){const name=raw.toLowerCase();check(!singleton(name)||!seen.has(name),'duplicate singleton header');seen.add(name);}
  const cleaned:HeaderPairs=[];
  for(const [raw,value] of input){const name=raw.toLowerCase();const bytes=trim(valueBytes(value));if((reserved(name)&&name!=='cookie')||nominated.has(name))continue;cleaned.push([name,Buffer.from(bytes).toString('base64')]);}
  return semanticHeaderPairs(cleaned,binding);
}
export function validateGatewayTarget(target:string,max=8192):void {
  check(typeof target==='string'&&target.length<=max&&/^\/(?!\/)[\x21-\x7e]*$/.test(target)&&!/[#\\]/.test(target)&&!/%(?![0-9a-fA-F]{2})/.test(target),'invalid raw target');
  const path=target.split('?')[0],segments=path.split('/').slice(1);
  for(let n=0;n<segments.length;n++){const part=segments[n];check(part!==''||n===segments.length-1,'empty path segment');check(!/%(?:2f|5c|25)/i.test(part),'encoded path separator');const decoded=part.replace(/%([0-9a-f]{2})/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));check(decoded!=='.'&&decoded!=='..'&&!/[\x00-\x20\x7f]/.test(decoded),'invalid path segment');}
}
export function gatewayRouteMatches(route:{method:string;path:string},method:string,target:string):boolean {
  if(route.method!==method)return false;const a=route.path.split('/'),b=target.split('?')[0].split('/');return a.length===b.length&&a.every((part,n)=>/^\{[a-z0-9][a-z0-9_-]{0,63}\}$/.test(part)?b[n].length>0&&b[n].length<=256:part===b[n]);
}
export function validateGatewayBinding(binding:ApiBindingV2):void {
  fields(binding,['version','service','operation','mode','transport','origin','routes','query','headers','representation','limits','authentication','privacy','meter','completion','recovery']);
  check(binding.version==='2'&&id.test(binding.service)&&id.test(binding.operation)&&binding.mode==='proxy'&&binding.query==='preserve');pin(binding.transport,['http_finite']);
  const origin=new URL(binding.origin);check((origin.protocol==='https:'||origin.protocol==='http:'&&(/^127(?:\.[0-9]{1,3}){3}$/.test(origin.hostname)||origin.hostname==='[::1]'))&&origin.origin===binding.origin&&!origin.username&&!origin.password,'gateway requires canonical HTTPS origin');
  check(Array.isArray(binding.routes)&&binding.routes.length>0&&binding.routes.length<=32);let previous='';
  for(const route of binding.routes){fields(route,['method','path']);check(methods.has(route.method)&&typeof route.path==='string'&&route.path.length<=1024&&!route.path.includes('?'));const params=new Set<string>();for(const segment of route.path.split('/'))if(/[{}]/.test(segment)){check(/^\{[a-z0-9][a-z0-9_-]{0,63}\}$/.test(segment)&&!params.has(segment));params.add(segment);}validateGatewayTarget(route.path.replace(/\{[^}]+\}/g,'param'));const key=route.method+' '+route.path;check(key>previous);previous=key;}
  for(let a=0;a<binding.routes.length;a++)for(let b=0;b<a;b++){const x=binding.routes[a],y=binding.routes[b],xs=x.path.split('/'),ys=y.path.split('/');check(x.method!==y.method||xs.length!==ys.length||!xs.every((segment,n)=>segment===ys[n]||segment.startsWith('{')||ys[n].startsWith('{')),'intersecting gateway routes');}
  fields(binding.headers,['request','request_reject','response','response_reject','trailers','static_request']);check(binding.headers.request==='end_to_end'&&binding.headers.response==='end_to_end');
  for(const names of [binding.headers.request_reject,binding.headers.response_reject,binding.headers.trailers])sorted(names,64,(n:unknown)=>typeof n==='string'&&headerName.test(n));
  check(binding.headers.trailers.every(n=>!trailerForbidden(n)&&!binding.headers.response_reject.includes(n)));
  fields(binding.limits,['target_bytes','header_pairs','header_bytes','request_bytes','response_bytes','decoded_response_bytes','decode_ratio','parser_bytes','relay_buffer_bytes','header_seconds','idle_seconds','execution_seconds','max_concurrency']);
  const maxima={target_bytes:8192,header_pairs:128,header_bytes:32768,request_bytes:1048576,response_bytes:16777216,decoded_response_bytes:67108864,decode_ratio:64,parser_bytes:1048576,relay_buffer_bytes:1048576,header_seconds:600,idle_seconds:600,execution_seconds:600,max_concurrency:4};
  for(const key of Object.keys(maxima) as (keyof typeof maxima)[])uint(binding.limits[key],BigInt(maxima[key]),['request_bytes','response_bytes','decoded_response_bytes'].includes(key)?0n:1n);
  check(BigInt(binding.limits.header_seconds)<=BigInt(binding.limits.execution_seconds)&&BigInt(binding.limits.idle_seconds)<=BigInt(binding.limits.execution_seconds));
  const auth=binding.authentication;fields(auth,auth.scheme==='api_key_header'?['scheme','policy_id','header']:['scheme','policy_id']);check(['none','bearer','basic','api_key_header'].includes(auth.scheme)&&id.test(auth.policy_id));if(auth.scheme==='api_key_header')check(headerName.test(auth.header)&&!reserved(auth.header));
  check(Array.isArray(binding.headers.static_request));let staticPrevious='';const staticSeen=new Set<string>();
  for(const pair of binding.headers.static_request){check(Array.isArray(pair)&&pair.length===2&&headerName.test(pair[0])&&!reserved(pair[0])&&pair[0]>=staticPrevious&&(!singleton(pair[0],auth.scheme==='api_key_header'?auth.header:undefined)||!staticSeen.has(pair[0]))&&!binding.headers.request_reject.includes(pair[0])&&(auth.scheme!=='api_key_header'||pair[0]!==auth.header));staticSeen.add(pair[0]);staticPrevious=pair[0];check(Buffer.from(trim(valueBytes(pair[1]))).toString('base64')===pair[1]);}
  check(binding.headers.static_request.length<=Number(binding.limits.header_pairs)&&binding.headers.static_request.reduce((sum,[name,value])=>sum+name.length+valueBytes(value).length,0)<=Number(binding.limits.header_bytes));
  fields(binding.representation,['request_media_types','response_media_types','request_encoding','response_encodings']);check(binding.representation.request_encoding==='identity');
  for(const media of [binding.representation.request_media_types,binding.representation.response_media_types]){check(media.length>0);sorted(media,64,(v:unknown)=>typeof v==='string'&&(/^[a-z0-9!#$%&'+.^_`|~-]+\/[a-z0-9!#$%&'+.^_`|~-]+$/.test(v)||v==='*'&&media.length===1));}
  sorted(binding.representation.response_encodings,4,(v:unknown)=>['identity','gzip','deflate','br'].includes(v as string));check(binding.representation.response_encodings.includes('identity'));
  fields(binding.privacy,['identifiers','resources']);check(['allow','reject_by_meter'].includes(binding.privacy.identifiers)&&['stateless','shared_public'].includes(binding.privacy.resources));
  fields(binding.meter,['adapter','resource','config','config_hash']);pin(binding.meter.adapter,['fixed_http','openai_responses','anthropic_messages']);check(hash.test(binding.meter.config_hash));
  const fixed=binding.meter.adapter.id==='fixed_http';
  if(fixed){check(binding.meter.resource===null&&binding.privacy.identifiers==='allow');fields(binding.meter.config,['exposure']);check(binding.meter.config.exposure==='operator_upstream_cost');}
  else {fields(binding.meter.resource,['provider','model']);check(binding.meter.resource.provider===(binding.meter.adapter.id==='openai_responses'?'openai':'anthropic')&&/^[\x20-\x7e]{1,256}$/.test(binding.meter.resource.model));fields(binding.meter.config,['provider_contract_sha256','context_max_tokens','output_max_tokens','service_tier','extra_cost_policy']);check(hash.test(binding.meter.config.provider_contract_sha256)&&/^[\x20-\x7e]{1,64}$/.test(binding.meter.config.service_tier)&&['reject_unclassified','operator_absorbs_unpriced'].includes(binding.meter.config.extra_cost_policy));uint(binding.meter.config.context_max_tokens,i64,1n);uint(binding.meter.config.output_max_tokens,i64,1n);}
  fields(binding.completion,['kind','billable_statuses']);check(binding.completion.kind===(fixed?'http_complete':'provider_terminal_usage'));let last=199;check(Array.isArray(binding.completion.billable_statuses)&&binding.completion.billable_statuses.length<=400);for(const status of binding.completion.billable_statuses){check(Number.isInteger(status)&&status>last&&status<=599);last=status;}
  fields(binding.recovery,['policy','reconciliation_seconds']);check(binding.recovery.policy==='finite_unknown_v1'&&binding.recovery.reconciliation_seconds==='900');check(jcsBytes(binding).length<=8192,'gateway binding exceeds 8 KiB');
}
export async function validateGatewayHashes(binding:ApiBindingV2):Promise<void> {validateGatewayBinding(binding);check(await sha256Hex(jcsBytes(binding.meter.config))===binding.meter.config_hash,'gateway meter config hash mismatch');}
/** Additional v3 checks join signed evidence to the saved, redacted invocation.
 * The ordinary verifier remains responsible for successor algebra and receipt sets. */
export async function validateGatewayReceipt(body:unknown,tariff:TariffV3,operationHmac:string):Promise<void> {
  fields(body,['version','receipt_id','deployment_id','pool','request_id','operation_id','billing_effect','related_receipt_hash','observed_at','evidence_kind','provider_request_id','provider_evidence_digest','tariff_hash','usage','provider_reported_usd','reservation_nano_usdc','observed_nano_usdc','charged_nano_usdc','operator_loss_nano_usdc','reason','binding_hash','operation_hmac','meter_hash','resource','completion']);
  const binding=tariff.api;
  check(body.version==='3'&&body.tariff_hash===tariff.tariff_hash&&body.operation_hmac===operationHmac&&hash.test(operationHmac)
    &&body.binding_hash===await sha256Hex(jcsBytes(binding))&&body.meter_hash===await sha256Hex(jcsBytes(binding.meter))
    &&Buffer.from(jcsBytes(body.resource)).equals(Buffer.from(jcsBytes(binding.meter.resource)))&&body.provider_reported_usd===null,'gateway receipt binding');
  const reservation=gatewayAmount(tariff.rates,tariff.rates.map(r=>r.reservation_max_count));check(uint(body.reservation_nano_usdc,numericMax)===reservation,'gateway receipt reservation');
  const charged=uint(body.charged_nano_usdc,numericMax);check(Array.isArray(body.usage));
  if(body.reason==='metered'||body.reason==='late_usage'){
    check(body.evidence_kind==='PROXY_USAGE'&&body.usage.length===tariff.rates.length,'gateway receipt usage');
    const counts=body.usage.map((usage:unknown,n:number)=>{fields(usage,['unit','count']);check(usage.unit===tariff.rates[n].unit);uint(usage.count);return usage.count as string;});
    const observed=gatewayAmount(tariff.rates,counts);check(uint(body.observed_nano_usdc,numericMax)===observed&&uint(body.operator_loss_nano_usdc,numericMax)===observed-charged,'gateway receipt arithmetic');
    fields(body.completion,['rule_hash','outcome','http_status']);const completion=body.completion;
    check(completion.rule_hash===await sha256Hex(jcsBytes(binding.completion))&&['satisfied','not_satisfied'].includes(completion.outcome)&&Number.isInteger(completion.http_status)&&completion.http_status>=200&&completion.http_status<=599,'gateway receipt completion');
    if(binding.meter.adapter.id==='fixed_http')check(counts[0]===(completion.outcome==='satisfied'?'1':'0')&&(completion.outcome==='satisfied')===binding.completion.billable_statuses.includes(completion.http_status),'gateway fixed completion count');
    if(body.reason==='metered')check(body.billing_effect==='charge'&&body.related_receipt_hash===null&&charged===(observed<reservation?observed:reservation),'gateway metered charge');
    else check(body.billing_effect==='late_loss_observation'&&hash.test(body.related_receipt_hash)&&charged===0n,'gateway late observation');
  } else {
    check(body.usage.length===0&&body.completion===null&&charged===0n&&body.billing_effect==='charge'&&body.related_receipt_hash===null,'gateway unknown evidence');
    if(body.reason==='not_dispatched')check(body.evidence_kind==='NOT_DISPATCHED'&&body.observed_nano_usdc==='0'&&body.operator_loss_nano_usdc==='0'&&body.provider_request_id===null&&body.provider_evidence_digest===null,'gateway not dispatched evidence');
    else check(body.reason==='waived_unknown'&&body.evidence_kind==='UNKNOWN_OPERATOR_LOSS'&&body.observed_nano_usdc===null&&body.operator_loss_nano_usdc===null,'gateway unknown variant');
  }
}
export function gatewayAmount(rates:TariffV3['rates'],counts:readonly string[]):bigint {
  check(rates.length===counts.length);let numerator=0n,denominator=1n;const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a;
  rates.forEach((rate,n)=>{const d=uint(rate.unit_denominator,i64,1n),v=uint(rate.nano_usdc_numerator)*uint(counts[n]);numerator=numerator*d+v*denominator;denominator*=d;const common=gcd(numerator,denominator);numerator/=common;denominator/=common;});
  const amount=(numerator+denominator-1n)/denominator;check(amount<=numericMax,'gateway amount overflow');return amount;
}
export function validateGatewayTariff(t:TariffV3):void {
  fields(t,['tariff_hash','version','provider','api','pricing_basis','valid_from','valid_until','rates','operator_fee_micro_usdc']);validateGatewayBinding(t.api);check(t.version==='3'&&t.provider==='generic'&&hash.test(t.tariff_hash)&&t.operator_fee_micro_usdc==='0');check(uint(t.valid_until,0xffffffffffffffffn)>uint(t.valid_from,0xffffffffffffffffn));
  const fixed=t.api.meter.adapter.id==='fixed_http';check(t.pricing_basis===(fixed?'fixed_request':'fixed_usage_rates')&&Array.isArray(t.rates)&&t.rates.length>0&&t.rates.length<=32);let previous='';
  for(const rate of t.rates){fields(rate,['unit','nano_usdc_numerator','unit_denominator','reservation_max_count']);check(/^[a-z][a-z0-9_]{0,63}$/.test(rate.unit)&&rate.unit>previous);previous=rate.unit;uint(rate.nano_usdc_numerator);uint(rate.unit_denominator,i64,1n);uint(rate.reservation_max_count);}
  if(fixed)check(t.rates.length===1&&t.rates[0].unit==='requests'&&t.rates[0].unit_denominator==='1'&&t.rates[0].reservation_max_count==='1'&&BigInt(t.rates[0].nano_usdc_numerator)>0n);
  else {const expected=t.api.meter.adapter.id==='openai_responses'?['cache_read_tokens','input_tokens','output_tokens']:['cache_read_tokens','cache_write_1h_tokens','cache_write_5m_tokens','input_tokens','output_tokens'];check(t.rates.map(r=>r.unit).join(',')===expected.join(','),'gateway meter unit set');for(const rate of t.rates)check(BigInt(rate.reservation_max_count)===BigInt(t.api.meter.config[rate.unit==='output_tokens'?'output_max_tokens':'context_max_tokens']),'gateway reservation bound');}
  gatewayAmount(t.rates,t.rates.map(r=>r.reservation_max_count));
}
export function validateGatewayInvocation(binding:ApiBindingV2,invocation:GatewayInvocation):GatewayInvocation {
  validateGatewayBinding(binding);fields(invocation,['version','method','target','headers','body']);check(invocation.version==='2'&&invocation.body instanceof Uint8Array&&invocation.body.length<=Number(binding.limits.request_bytes),'gateway request limit');validateGatewayTarget(invocation.target,Number(binding.limits.target_bytes));check(binding.routes.some(r=>gatewayRouteMatches(r,invocation.method,invocation.target)),'unregistered gateway route');check(!['GET','HEAD'].includes(invocation.method)||invocation.body.length===0,'body forbidden for GET/HEAD');
  const headers=semanticHeaderPairs(invocation.headers,binding),allHeaders=[...headers,...binding.headers.static_request];check(allHeaders.length<=Number(binding.limits.header_pairs)&&allHeaders.reduce((sum,[name,value])=>sum+name.length+valueBytes(value).length,0)<=Number(binding.limits.header_bytes),'combined request header limit');const text=(name:string)=>allHeaders.filter(p=>p[0]===name).map(p=>Buffer.from(p[1],'base64').toString('latin1'));
  const contentType=text('content-type')[0]?.split(';')[0].trim().toLowerCase(),types=binding.representation.request_media_types;check(types[0]==='*'||invocation.body.length===0&&!contentType||contentType&&types.includes(contentType),'unsupported request media type');check(text('content-encoding').every(v=>v==='identity'),'unsupported request encoding');
  for(const offered of text('accept-encoding').flatMap(v=>v.split(','))){const match=/^\s*([a-zA-Z][a-zA-Z0-9-]*)(?:\s*;\s*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?\s*$/.exec(offered);check(match,'invalid Accept-Encoding');check(match[2]!==undefined&&Number(match[2])===0||binding.representation.response_encodings.includes(match[1].toLowerCase()),'unsupported response encoding');}
  if(binding.meter.resource){
    check(invocation.body.length<=Number(binding.limits.parser_bytes),'gateway shadow parser limit');const payload=parseStrictJson(invocation.body);check(payload&&typeof payload==='object'&&!Array.isArray(payload)&&payload.model===binding.meter.resource.model,'gateway model mismatch');
    const openai=binding.meter.resource.provider==='openai',limit=openai?payload.max_output_tokens:payload.max_tokens;
    if(limit!==undefined)check(Number.isSafeInteger(limit)&&Number(limit)>0&&BigInt(limit as number)<=BigInt(binding.meter.config.output_max_tokens),'gateway output bound');
    check((payload.service_tier===undefined?'auto':payload.service_tier)===binding.meter.config.service_tier,'gateway service tier');
    check(binding.meter.config.service_tier!=='auto'||binding.meter.config.extra_cost_policy==='operator_absorbs_unpriced','auto tier requires operator exposure');
    if(openai){
      check(payload.store===false&&(payload.background===undefined||payload.background===false),'stateless Responses required');
      check(payload.prompt===undefined||payload.prompt===null,'provider stored prompt references unsupported');
    }
    const privateHandles=(value:unknown):boolean=>Array.isArray(value)?value.some(privateHandles):value!==null&&typeof value==='object'&&Object.entries(value).some(([key,child])=>['previous_response_id','conversation','file_id','vector_store_ids','container_id'].includes(key)||key==='container'&&child!==null||key==='type'&&child==='item_reference'||privateHandles(child));
    check(!privateHandles(payload),'provider private resources unsupported');
    if(binding.meter.config.extra_cost_policy==='reject_unclassified'){
      if(payload.tools!==undefined){check(Array.isArray(payload.tools),'invalid tools');for(const tool of payload.tools){check(tool&&typeof tool==='object'&&!Array.isArray(tool));const type=tool.type;check(openai?type==='function'||type==='custom':type===undefined||type==='custom','unpriced hosted tool');}}
      check(payload.audio===undefined&&(payload.modalities===undefined||JSON.stringify(payload.modalities)==='["text"]'),'unpriced media');
    }
  }
  return {version:'2',method:invocation.method,target:invocation.target,headers,body:new Uint8Array(invocation.body)};
}
export function validateGatewayConfiguration(gateway:GatewayConfiguration,services:readonly {tariff:{api:{version:string;service:string;operation:string}}}[],legacyModels:readonly {id:string;apis:readonly string[]}[]=[]):void {
  fields(gateway,['capabilities','mounts']);check(JSON.stringify(gateway.capabilities)==='["finite_http_v1"]'&&Array.isArray(gateway.mounts)&&gateway.mounts.length>0&&gateway.mounts.length<=64);let previous='';
  const selections:{binding:ApiBindingV2;routes:{method:string;path:string}[]}[]=[];
  const legacyPaths:Record<string,string>={chat:'/v1/chat/completions',responses:'/v1/responses',messages:'/v1/messages',count_tokens:'/v1/messages/count_tokens'};
  const intersects=(a:{method:string;path:string},b:{method:string;path:string})=>{const ap=a.path.split('/'),bp=b.path.split('/');return a.method===b.method&&ap.length===bp.length&&ap.every((p,n)=>p===bp[n]||p.startsWith('{')||bp[n].startsWith('{'));};
  for(const mount of gateway.mounts){
    fields(mount,['prefix','service','operation','binding_hash']);check(typeof mount.prefix==='string'&&/^(?:\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/.test(mount.prefix)&&id.test(mount.service)&&id.test(mount.operation)&&hash.test(mount.binding_hash));
    check(!/^\/(?:admin|zkapi)(?:\/|$)/.test(mount.prefix)&&mount.prefix!=='/v1/models','reserved gateway mount');const key=mount.prefix+'\0'+mount.service+'\0'+mount.operation;check(key>previous);previous=key;
    const selected=services.find(s=>s.tariff.api.version==='2'&&s.tariff.api.service===mount.service&&s.tariff.api.operation===mount.operation);check(selected,'gateway mount has no service');const binding=selected.tariff.api as ApiBindingV2;
    const routes=binding.routes.map(route=>({method:route.method,path:mount.prefix+route.path}));
    for(const route of routes){const first=route.path.split('/')[1];check(first!=='admin'&&first!=='zkapi'&&!first.startsWith('{')&&!intersects(route,{method:route.method,path:'/v1/models'}),'reserved gateway route');for(const model of legacyModels){check(!model.apis.some(api=>legacyPaths[api]&&intersects(route,{method:'POST',path:legacyPaths[api]})),'legacy/gateway route collision');if(binding.meter.resource)check(model.id!==binding.meter.resource.model,'ambiguous model discovery');}}
    for(const old of selections){const overlap=routes.some(a=>old.routes.some(b=>intersects(a,b)));if(overlap)check(binding.meter.resource&&old.binding.meter.resource&&binding.meter.resource.model!==old.binding.meter.resource.model,'ambiguous gateway routes');}
    selections.push({binding,routes});
  }
  const discovered=new Map<string,string>();for(const {binding} of selections){if(!binding.meter.resource)continue;const model=binding.meter.resource.model,key=binding.service+'/'+binding.operation;check(!discovered.has(model)||discovered.get(model)===key,'ambiguous mounted model discovery');discovered.set(model,key);}
}
export async function gatewayOperationHmac(secret:Uint8Array,identity:{deployment_id:string;pool:string;authorization_id:string;operation_id:string;binding_hash:string;tariff_hash:string},invocation:GatewayInvocation):Promise<string> {
  check(secret.length===32);const uuid=(value:string)=>{check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value));return Buffer.from(value.replaceAll('-',''),'hex');};check(hash.test(identity.binding_hash)&&hash.test(identity.tariff_hash));const pool=bs58.decode(identity.pool);check(pool.length===32&&bs58.encode(pool)===identity.pool);
  const pairs=[...invocation.headers].map(([name,value]):[string,string]=>[name.toLowerCase(),Buffer.from(trim(valueBytes(value))).toString('base64')]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  const parts=[Buffer.from(identity.deployment_id),pool,uuid(identity.authorization_id),uuid(identity.operation_id),Buffer.from(identity.binding_hash,'hex'),Buffer.from(identity.tariff_hash,'hex'),Buffer.from(invocation.method,'ascii'),Buffer.from(invocation.target,'ascii'),jcsBytes(pairs),invocation.body];
  const label=Buffer.from('solana-zkapi-operation-v2'),prefix=Buffer.alloc(2+label.length+2);prefix.writeUInt16BE(label.length);prefix.set(label,2);prefix.writeUInt16BE(parts.length,2+label.length);
  const framed=Buffer.concat([prefix,...parts.flatMap(part=>{const length=Buffer.alloc(4);length.writeUInt32BE(part.length);return[length,Buffer.from(part)];})]);
  const keyBytes=await crypto.subtle.digest('SHA-256',new Uint8Array(Buffer.concat([Buffer.from('zkapi-proxy-body-v2'),secret]))),key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);return Buffer.from(await crypto.subtle.sign('HMAC',key,new Uint8Array(framed))).toString('hex');
}
export async function encodeGatewayRequest(binding:ApiBindingV2,input:GatewayInvocation):Promise<Uint8Array> {const invocation=validateGatewayInvocation(binding,input);const metadata=jcsBytes({version:'2',binding_hash:await sha256Hex(jcsBytes(binding)),method:invocation.method,target:invocation.target,headers:invocation.headers,body_length:String(invocation.body.length)});check(metadata.length>0&&metadata.length<=65536);const prefix=Buffer.alloc(4);prefix.writeUInt32BE(metadata.length);return new Uint8Array(Buffer.concat([prefix,metadata,invocation.body]));}
export async function decodeGatewayRequest(binding:ApiBindingV2,bytes:Uint8Array):Promise<GatewayInvocation> {binding=structuredClone(binding);bytes=new Uint8Array(bytes);check(bytes.length>=4);const length=new DataView(bytes.buffer,bytes.byteOffset,4).getUint32(0);check(length>0&&length<=65536&&bytes.length>=4+length);const metadata:unknown=parseStrictJson(bytes.subarray(4,4+length));fields(metadata,['version','binding_hash','method','target','headers','body_length']);check(hash.test(metadata.binding_hash)&&metadata.binding_hash===await sha256Hex(jcsBytes(binding)),'gateway envelope binding');check(Buffer.from(jcsBytes(metadata)).equals(Buffer.from(bytes.subarray(4,4+length))),'noncanonical gateway envelope');check(uint(metadata.body_length,BigInt(binding.limits.request_bytes))===BigInt(bytes.length-4-length));return validateGatewayInvocation(binding,{version:metadata.version,method:metadata.method,target:metadata.target,headers:metadata.headers,body:bytes.slice(4+length)});}

/** Incremental decoder with no background tee and no allocation from unchecked lengths. */
export async function decodeGatewayResponse(response:Response,binding:ApiBindingV2,method:string):Promise<GatewayResponse> {
  if(response.status!==200||response.headers.get('content-type')!==GATEWAY_RESPONSE_TYPE||response.headers.has('content-encoding')){await response.body?.cancel();throw Error('invalid gateway carrier');}check(response.body,'gateway carrier body missing');
  const reader=response.body.getReader();let chunk=new Uint8Array(),offset=0,terminal=false,aggregate=0,gotTrailers=false;
  let resolveTrailers!:(v:HeaderPairs)=>void,rejectTrailers!:(e:unknown)=>void,resolveCompletion!:()=>void,rejectCompletion!:(e:unknown)=>void;
  const trailers=new Promise<HeaderPairs>((resolve,reject)=>{resolveTrailers=resolve;rejectTrailers=reject;});const completion=new Promise<void>((resolve,reject)=>{resolveCompletion=resolve;rejectCompletion=reject;});void trailers.catch(()=>{});void completion.catch(()=>{});
  const exact=async(length:number,allowEof=false):Promise<Uint8Array|null>=>{const result=new Uint8Array(length);let used=0;while(used<length){if(offset===chunk.length){const next=await reader.read();if(next.done){if(allowEof&&used===0)return null;throw Error('truncated gateway frame');}chunk=new Uint8Array(next.value);offset=0;}const take=Math.min(length-used,chunk.length-offset);result.set(chunk.subarray(offset,offset+take),used);offset+=take;used+=take;}return result;};
  const frame=async()=>{const prefix=await exact(5);check(prefix);const tag=prefix[0],length=new DataView(prefix.buffer,prefix.byteOffset+1,4).getUint32(0);check(tag>=1&&tag<=5&&length<=65536&&(tag===4?length===0:length>0),'invalid gateway frame');return{tag,bytes:(await exact(length))!};};
  const eof=async()=>{check(await exact(1,true)===null,'bytes after gateway terminal');};
  const fail=async(error:unknown)=>{terminal=true;rejectTrailers(error);rejectCompletion(error);try{await reader.cancel(error);}catch{};};
  const metadata=(bytes:Uint8Array):unknown=>{const value=parseStrictJson(bytes);check(Buffer.from(jcsBytes(value)).equals(Buffer.from(bytes)),'noncanonical gateway metadata');return value;};
  const gatewayError=(bytes:Uint8Array)=>{const error=metadata(bytes);fields(error,['code','request_id','operation_id']);check(typeof error.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code));for(const name of ['request_id','operation_id'])check(error[name]===null||typeof error[name]==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(error[name]));return Error(`gateway ${error.code}; use status recovery`);};
  try {
    const first=await frame();if(first.tag===5){const error=gatewayError(first.bytes);await eof();throw error;}check(first.tag===1,'gateway HEADERS required');const head=metadata(first.bytes);fields(head,['status','headers']);check(Number.isInteger(head.status)&&head.status>=200&&head.status<=599);const status=head.status as number,headers=semanticHeaderPairs(head.headers,binding,'response');const lengthHeader=headers.find(p=>p[0]==='content-length');check(!lengthHeader||['HEAD'].includes(method)||status===304,'forbidden response Content-Length');if(lengthHeader)check(/^[0-9]+$/.test(Buffer.from(lengthHeader[1],'base64').toString('latin1')));
    const headerText=(name:string)=>headers.find(p=>p[0]===name)?.[1];const encoding=headerText('content-encoding');check(!encoding||binding.representation.response_encodings.includes(Buffer.from(encoding,'base64').toString('latin1')),'unsupported gateway response encoding');
    const contentType=headerText('content-type'),media=contentType?Buffer.from(contentType,'base64').toString('latin1').split(';')[0].trim().toLowerCase():undefined;
    check(!media||binding.representation.response_media_types[0]==='*'||binding.representation.response_media_types.includes(media),'unsupported gateway response media');
    let pendingTrailers:HeaderPairs=[];
    const body=new ReadableStream<Uint8Array>({async pull(controller){try{for(;;){const next=await frame();if(next.tag===2){check(!gotTrailers&&method!=='HEAD'&&![204,205,304].includes(status),'forbidden gateway DATA');check(binding.representation.response_media_types[0]==='*'||media,'missing gateway response media');aggregate+=next.bytes.length;check(aggregate<=Number(binding.limits.response_bytes),'gateway response limit');controller.enqueue(next.bytes);return;}if(next.tag===3){check(!gotTrailers,'duplicate gateway trailers');gotTrailers=true;const data=metadata(next.bytes);fields(data,['headers']);pendingTrailers=semanticHeaderPairs(data.headers,binding,'trailers');continue;}if(next.tag===5){const error=gatewayError(next.bytes);await eof();throw error;}check(next.tag===4,'unexpected gateway frame');check(binding.headers.trailers.every(name=>pendingTrailers.some(p=>p[0]===name)),'required gateway trailer missing');await eof();terminal=true;resolveTrailers(pendingTrailers);resolveCompletion();controller.close();return;}}catch(error){await fail(error);controller.error(error);}},async cancel(reason){if(!terminal)await fail(reason??Error('gateway response canceled'));}},{highWaterMark:0});
    return{status,headers,trailerNames:[...binding.headers.trailers],body,trailers,completed:completion};
  }catch(error){await fail(error);throw error;}
}

/** Confirm only a validated successful response, after its one consumer sees EOF.
 * Native writers defer the confirmation until their local socket finishes. */
export function trackGatewayDelivery<T extends GatewayResponse>(result:T,delivered:()=>Promise<void>,defer=false):T {
  let confirmation:Promise<void>|undefined;
  const confirmDelivery=()=>confirmation??=(async()=>{await result.completed;if(result.status>=200&&result.status<300)await delivered();})();
  if(defer)return {...result,confirmDelivery};
  const reader=result.body.getReader();let canceled=false;
  const body=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await reader.read();if(canceled)return;if(next.done){await confirmDelivery();controller.close();}else controller.enqueue(next.value);}catch(error){controller.error(error);}},async cancel(reason){canceled=true;await reader.cancel(reason);}},{highWaterMark:0});
  return {...result,body};
}
