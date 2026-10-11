/** Offline synthetic carrier/crypto vectors. No provider, RPC or financial send. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac, createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { writeGatewayResponse } from '../src/clientd-network.ts';
import { decodeGatewayResponse, encodeGatewayRequest, decodeGatewayRequest, gatewayOperationHmac, gatewayAmount, validateGatewayBinding, validateGatewayTariff, validateGatewayInvocation, validateGatewayReceipt, validateGatewayConfiguration, semanticHeaderPairs, GATEWAY_RESPONSE_TYPE, type ApiBindingV2, type TariffV3, type HeaderPairs } from '../src/gateway.ts';
import { jcsBytes, sha256Hex } from '../src/trust.ts';

const fixture=JSON.parse(await readFile(new URL('../../../docs/contracts/universal-api-gateway-vectors.json',import.meta.url),'utf8'));
const binding=fixture.binding as ApiBindingV2,tariff=fixture.tariff as TariffV3;
const frame=(tag:number,bytes:Uint8Array=new Uint8Array())=>{const prefix=Buffer.alloc(5);prefix[0]=tag;prefix.writeUInt32BE(bytes.length,1);return Buffer.concat([prefix,bytes]);};
const header=(status=200,headers:HeaderPairs=[])=>frame(1,jcsBytes({status,headers}));
const carrier=(bytes:Uint8Array,fragment=bytes.length)=>new Response(new ReadableStream({start(c){for(let offset=0;offset<bytes.length;offset+=fragment)c.enqueue(bytes.slice(offset,offset+fragment));c.close();}}),{headers:{'content-type':GATEWAY_RESPONSE_TYPE}});
const invocation=()=>({version:'2' as const,method:'POST',target:'/v1/lookup?tag=a&tag=b%2f&empty=',headers:[] as HeaderPairs,body:new Uint8Array([0,255,13,10])});

test('SDK agrees with independent framed HMAC vectors and preserves opaque bytes',async()=>{
  validateGatewayBinding(binding);validateGatewayTariff(tariff);
  for(const vector of fixture.vectors){const {body_hex,...input}=vector.input;const inv={version:'2' as const,method:input.method,target:input.target,headers:semanticHeaderPairs(input.headers,binding),body:new Uint8Array(Buffer.from(body_hex,'hex'))};
    const identity={...input,binding_hash:fixture.binding_hash,tariff_hash:tariff.tariff_hash};
    const key=Buffer.from(fixture.proxy_secret_hex,'hex');assert.equal(await gatewayOperationHmac(key,identity,inv),vector.operation_hmac);
    assert.equal(createHmac('sha256',createHash('sha256').update(Buffer.concat([Buffer.from('zkapi-proxy-body-v2'),key])).digest()).update(Buffer.from(vector.frame_hex,'hex')).digest('hex'),vector.operation_hmac);
    const wire=await encodeGatewayRequest(binding,inv);assert.deepEqual(await decodeGatewayRequest(binding,wire),inv);
    for(const mutation of ['deployment_id','pool','authorization_id','operation_id','binding_hash','tariff_hash']){
      const changed={...identity,[mutation]:mutation.endsWith('_hash')?'aa'.repeat(32):mutation==='pool'?'11111111111111111111111111111112':mutation.endsWith('_id')&&mutation!=='deployment_id'?'00000000-0000-4000-8000-000000000009':'other'};
      assert.notEqual(await gatewayOperationHmac(key,changed,inv),vector.operation_hmac);
    }
    for(const change of [{method:'PUT'},{target:inv.target+'x'},{headers:[...inv.headers,['x-extra','eA==']] as HeaderPairs},{body:new Uint8Array([...inv.body,1])}])assert.notEqual(await gatewayOperationHmac(key,identity,{...inv,...change}),vector.operation_hmac);
    const renamed={...inv,headers:inv.headers.map(([name,value]):[string,string]=>[name.toUpperCase(),value])};assert.equal(await gatewayOperationHmac(key,identity,renamed),vector.operation_hmac);
  }
});

test('gateway rejects route, framing, credential and representation mutations before AUTH',()=>{
  for(const target of ['/v1//lookup','/v1/../lookup','/v1/%2e%2e/lookup','/v1/%2Flookup','/v1/%25lookup','/v1/lookup#fragment','/v1/lookup?bad=%xx','https://other.test/v1/lookup'])assert.throws(()=>validateGatewayInvocation(binding,{...invocation(),target}));
  for(const headers of [[['authorization','eA==']],[['cookie','eA==']],[['x-zkapi-foo','eA==']],[['content-type','eA=='],['Content-Type','eA==']],[['x-header','Cg==']],[['accept-encoding','YnI=']]] as HeaderPairs[])assert.throws(()=>validateGatewayInvocation(binding,{...invocation(),headers}));
  assert.throws(()=>validateGatewayInvocation(binding,{...invocation(),method:'GET'}));
  assert.throws(()=>validateGatewayBinding({...binding,limits:{...binding.limits,idle_seconds:'601'}}));
  assert.throws(()=>validateGatewayBinding({...binding,meter:{...binding.meter,resource:{provider:'openai',model:'test'}}}));
  validateGatewayConfiguration({capabilities:['finite_http_v1'],mounts:[{prefix:'',service:'fixture',operation:'lookup',binding_hash:fixture.binding_hash}]},[{tariff}]);
  assert.throws(()=>validateGatewayConfiguration({capabilities:['finite_http_v1'],mounts:[{prefix:'/v1/models',service:'fixture',operation:'lookup',binding_hash:fixture.binding_hash}]},[{tariff}]));
});

test('native LLM admission preserves opaque bytes while enforcing resource, output and tier policies',async()=>{
  const api=structuredClone(binding);api.routes=[{method:'POST',path:'/v1/responses'}];api.meter={adapter:{id:'openai_responses',version:'1',artifact_sha256:'22'.repeat(32)},resource:{provider:'openai',model:'fixture-model'},config:{provider_contract_sha256:'33'.repeat(32),context_max_tokens:'8192',output_max_tokens:'4096',service_tier:'auto',extra_cost_policy:'operator_absorbs_unpriced'},config_hash:''};api.meter.config_hash=await sha256Hex(jcsBytes(api.meter.config));api.completion.kind='provider_terminal_usage';
  const payload={model:'fixture-model',store:false,tools:[{type:'custom',name:'fixture-tool',format:{type:'text'}}],input:'test',future_nonfinancial_flag:true};
  const raw=new TextEncoder().encode(JSON.stringify(payload,null,2)+'\n'),request={...invocation(),target:'/v1/responses',body:raw};assert.deepEqual(validateGatewayInvocation(api,request).body,raw);
  for(const change of [{store:true},{background:true},{model:'other-model'},{max_output_tokens:4097},{service_tier:'default'},{service_tier:null},{input:[{type:'item_reference',id:'remote-handle'}]},{tools:[{type:'function',nested:{file_id:'remote-file'}}]}])assert.throws(()=>validateGatewayInvocation(api,{...request,body:jcsBytes({...payload,...change})}));
  assert.throws(()=>validateGatewayInvocation(api,{...request,body:new TextEncoder().encode('{"model":"fixture-model","model":"fixture-model","store":false}')}));
  for(const prompt of [undefined,null])validateGatewayInvocation(api,{...request,body:jcsBytes({...payload,...(prompt===undefined?{}:{prompt}),tools:[{type:'function',name:'local-tool',parameters:{type:'object',properties:{prompt:{type:'string'}}}}]})});
});

test('streaming frames preserve repeated octets and validate END even at exact length',async()=>{
  const headers:HeaderPairs=[['x-tag','gP8='],['x-tag','dHdv']];const bytes=Buffer.concat([header(201,headers),frame(2,new Uint8Array([0,255,1])),frame(2,new Uint8Array([2,3])),frame(4)]);
  const result=await decodeGatewayResponse(carrier(bytes,1),binding,'POST');assert.equal(result.status,201);assert.deepEqual(result.headers,headers);assert.deepEqual(Buffer.from(await new Response(result.body).arrayBuffer()),Buffer.from([0,255,1,2,3]));assert.deepEqual(await result.trailers,[]);await result.completed;
  for(const invalid of [bytes.subarray(0,bytes.length-5),Buffer.concat([bytes,Buffer.from([0])]),Buffer.concat([header(),frame(3,jcsBytes({headers:[]})),frame(2,new Uint8Array([1])),frame(4)]),Buffer.concat([header(),header(),frame(4)]),Buffer.concat([header(205),frame(2,new Uint8Array([1])),frame(4)]),Buffer.concat([header(),Buffer.from([2,0,1,0,1])])]){
    const parsed=await decodeGatewayResponse(carrier(invalid,1),binding,'POST');await assert.rejects(new Response(parsed.body).arrayBuffer());await assert.rejects(parsed.completed);await assert.rejects(parsed.trailers);
  }
  for(let n=0;n<5;n++)await assert.rejects(decodeGatewayResponse(carrier(bytes.subarray(0,n),1),binding,'POST'));
});

test('HEAD and 304 retain valid HTTP Content-Length spelling without accepting non-ASCII digits',async()=>{
  const headers:HeaderPairs=[['content-length',Buffer.from('0004').toString('base64')]];
  for(const [method,status] of [['HEAD',200],['GET',304]] as const){
    const result=await decodeGatewayResponse(carrier(Buffer.concat([header(status,headers),frame(4)])),binding,method);
    assert.deepEqual(result.headers,headers);
    assert.equal((await new Response(result.body).arrayBuffer()).byteLength,0);
    await result.completed;
  }
  const invalid:HeaderPairs=[['content-length',Buffer.from([0xb1]).toString('base64')]];
  await assert.rejects(decodeGatewayResponse(carrier(Buffer.concat([header(200,invalid),frame(4)])),binding,'HEAD'));
});

test('trailers are required, ordered and never fabricate successful carrier completion',async()=>{
  const api=structuredClone(binding);api.headers.trailers=['x-checksum'];
  const pairs:HeaderPairs=[['x-checksum','YWJj']];const result=await decodeGatewayResponse(carrier(Buffer.concat([header(),frame(3,jcsBytes({headers:pairs})),frame(4)]),1),api,'POST');await new Response(result.body).arrayBuffer();assert.deepEqual(await result.trailers,pairs);
  const missing=await decodeGatewayResponse(carrier(Buffer.concat([header(),frame(4)])),api,'POST');await assert.rejects(new Response(missing.body).arrayBuffer());
  const interrupted=await decodeGatewayResponse(carrier(Buffer.concat([header(),frame(5,jcsBytes({code:'execution_timeout',request_id:null,operation_id:null}))])),binding,'POST');await assert.rejects(new Response(interrupted.body).arrayBuffer(),/execution_timeout/);await assert.rejects(interrupted.completed);
});

test('configured response rejections also apply to declared and received trailers',async()=>{
  const api=structuredClone(binding);api.headers.trailers=['x-private'];api.headers.response_reject=['x-private'];
  assert.throws(()=>validateGatewayBinding(api));
  assert.throws(()=>semanticHeaderPairs([['x-private','dmFsdWU=']],api,'trailers'));
});

test('native bodyless responses withhold success until END and clean carrier EOF',async t=>{
  const server=createServer(async(req,res)=>{
    const parsed=await decodeGatewayResponse(carrier(header(req.method==='HEAD'?200:205)),binding,req.method!);
    await writeGatewayResponse(parsed,res).catch(()=>{});
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as {port:number}).port;
  for(const method of ['HEAD','POST'])await new Promise<void>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,method},response=>{response.resume();reject(Error('premature HTTP success'));});req.on('error',()=>resolve());req.end();});
});

test('native response writer preserves repeated obs-text headers and announced trailers',async t=>{
  const api=structuredClone(binding);api.headers.trailers=['x-checksum'];
  const server=createServer(async(_req,res)=>{
    const parsed=await decodeGatewayResponse(carrier(Buffer.concat([header(200,[['x-value','gP8='],['x-value','dHdv']]),frame(2,new Uint8Array([0,255])),frame(3,jcsBytes({headers:[['x-checksum','YWJj']]})),frame(4)])),api,'POST');
    await writeGatewayResponse(parsed,res);
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  await new Promise<void>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:(server.address() as {port:number}).port},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{try{assert.deepEqual(response.rawHeaders.flatMap((name,n)=>n%2===0&&name==='x-value'?[response.rawHeaders[n+1]]:[]),[Buffer.from([128,255]).toString('latin1'),'two']);assert.equal(response.headers.trailer,'x-checksum');assert.equal(response.trailers['x-checksum'],'abc');assert.deepEqual(Buffer.concat(chunks),Buffer.from([0,255]));resolve();}catch(error){reject(error);}});});req.on('error',reject);req.end();});
});

test('rational pricing sums before rounding and receipt v3 distinguishes zero from unknown',async()=>{
  const rates=[{unit:'a',nano_usdc_numerator:'1',unit_denominator:'3',reservation_max_count:'1'},{unit:'b',nano_usdc_numerator:'1',unit_denominator:'3',reservation_max_count:'1'}];assert.equal(gatewayAmount(rates,['1','1']),1n);
  const hmac='33'.repeat(32),base={version:'3',receipt_id:'00000000-0000-4000-8000-000000000004',deployment_id:'test',pool:'11111111111111111111111111111111',request_id:'00000000-0000-4000-8000-000000000001',operation_id:'00000000-0000-4000-8000-000000000002',billing_effect:'charge',related_receipt_hash:null,observed_at:'1',evidence_kind:'PROXY_USAGE',provider_request_id:null,provider_evidence_digest:null,tariff_hash:tariff.tariff_hash,usage:[{unit:'requests',count:'0'}],provider_reported_usd:null,reservation_nano_usdc:'250000',observed_nano_usdc:'0',charged_nano_usdc:'0',operator_loss_nano_usdc:'0',reason:'metered',binding_hash:fixture.binding_hash,operation_hmac:hmac,meter_hash:await sha256Hex(jcsBytes(binding.meter)),resource:null,completion:{rule_hash:await sha256Hex(jcsBytes(binding.completion)),outcome:'not_satisfied',http_status:500}};
  await validateGatewayReceipt(base,tariff,hmac);
  const unknown={...base,reason:'waived_unknown',evidence_kind:'UNKNOWN_OPERATOR_LOSS',usage:[],completion:null,observed_nano_usdc:null,operator_loss_nano_usdc:null};await validateGatewayReceipt(unknown,tariff,hmac);
  for(const change of [{operation_hmac:'44'.repeat(32)},{binding_hash:'44'.repeat(32)},{usage:[{unit:'requests',count:'1'}]},{completion:{...base.completion,http_status:200}},{charged_nano_usdc:'1'}])await assert.rejects(validateGatewayReceipt({...base,...change},tariff,hmac));
  await assert.rejects(validateGatewayReceipt({...unknown,usage:base.usage},tariff,hmac));
});
