import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyProfile, planClientUpgrade } from '../src/client-guidance.ts';
import { checkModelAvailability, describeProviderError } from '../src/provider-status.ts';

const native = () => ({wallet_status:'closed',balance_micro_usdc:'200',wallet_operation:null,wallet_emergency_escape:null,
  recovery_required:false,in_flight:0,phase:'closed',unresolved_operations:[]});
const sdk = () => ({wallet:'closed',settledBalanceMicroUsdc:'200',walletOperation:null,emergencyEscape:null,busy:false,session:null});
test('privacy profiles distinguish routing from deletion/IP guarantees and are detached', () => {
  const a = privacyProfile('direct_openrouter',300);
  assert.equal(a.routingPolicy.zeroDataRetentionRequired,true); assert.equal(a.providerDeletionVerified,false);
  assert.equal(a.network.anonymityGuaranteed,false); assert.equal(a.session.requestsWithinLeaseMayBeLinked,true);
  a.contentRecipients.length=0; assert.equal(privacyProfile('direct_openrouter').contentRecipients.length,2);
  assert.equal(privacyProfile('direct_oa').routingPolicy.zeroDataRetentionRequired,false);
  assert.equal(privacyProfile('proxy').contentRecipients[0],'proxy_operator');
  assert.equal(privacyProfile('proxy').localRetention.proxyBodyUntilDispatch,true);
});
test('upgrade plans never migrate; closed and fresh profiles permit only a separate installation', () => {
  for (const s of [native(),sdk(),{...native(),wallet_status:'unfunded',balance_micro_usdc:'0',phase:'unfunded'},
    {...sdk(),wallet:'empty',settledBalanceMicroUsdc:'0'}]) {
    const before=JSON.stringify(s), p=planClientUpgrade(s);
    assert.equal(p.assessment,'ready_for_separate_installation'); assert.equal(p.inPlaceMigrationSupported,false);
    assert.equal(p.automaticActions,false); assert.ok(p.nextActions.includes('install_in_new_directory_with_new_custody'));
    assert.equal(JSON.stringify(s),before);
  }
});
test('active zero-balance notes, wallet work, session recovery and closed escape archives block upgrade', () => {
  for (const s of [{...sdk(),wallet:'active',settledBalanceMicroUsdc:'0'}, {...sdk(),busy:true}, {...sdk(),session:{phase:'active'}},
    {...native(),wallet_operation:{kind:'withdraw'}},{...native(),in_flight:1},{...native(),recovery_required:true},
    {...native(),unresolved_operations:[{id:'saved'}]},{...native(),phase:'send_unknown'},
    {...native(),wallet_emergency_escape:{phase:'escaping'}},{...sdk(),emergencyEscape:{phase:'challenged'}},
    {...native(),wallet_status:'unfunded',balance_micro_usdc:'1'}]) {
    const p=planClientUpgrade(s); assert.equal(p.assessment,'needs_attention'); assert.ok(p.blockers.length);
    assert.ok(!p.nextActions.includes('install_in_new_directory_with_new_custody'));
  }
});
test('old/incomplete/ambiguous status stays unknown without echoing private input', () => {
  for (const s of [null,{},[],{...native(),wallet_status:'legacy_import'}, {...native(),wallet_operation:undefined,wallet_status:'oops'},
    {...native(),balance_micro_usdc:'-1'},{...native(),in_flight:'0'},{...sdk(),session:undefined,busy:undefined},
    {wallet_status:'closed',private:'SECRET'}]) {
    assert.equal(planClientUpgrade(s).assessment,'unknown'); assert.ok(!JSON.stringify(planClientUpgrade(s)).includes('SECRET'));
  }
  const missing=native() as any; delete missing.wallet_emergency_escape; assert.equal(planClientUpgrade(missing).assessment,'unknown');
});
test('ZDR catalog query is explicit, keyless, bounded and intersects only configured models', async () => {
  let calls=0;const ids=['vendor/one','vendor/two'];
  const fetcher:typeof fetch=async(u,o)=>{
    calls++;assert.equal(String(u),'https://router.invalid/api/v1/models?zdr=true');assert.equal(o?.method,'GET');
    assert.equal(o?.body,undefined);assert.equal(new Headers(o?.headers).get('Authorization'),null);
    assert.equal(o?.credentials,'omit');assert.equal(o?.redirect,'error');assert.equal(o?.cache,'no-store');
    assert.equal(o?.referrerPolicy,'no-referrer');
    ids.push('injected');return Response.json({data:[{id:'vendor/one'},{id:'not/configured'}],total_count:2,links:{next:null}});
  };
  const r=await checkModelAvailability('direct_openrouter',ids,{base:'https://router.invalid/api/v1',fetch:fetcher});
  assert.equal(calls,1);assert.equal(r.basis,'public_zdr_catalog');assert.equal(r.providerAccess,'unverified');
  assert.deepEqual(r.models,[{id:'vendor/one',status:'zdr_endpoint_listed'},{id:'vendor/two',status:'not_listed'}]);
  assert.equal(r.inferencePerformed,false);assert.ok(r.checkedAt);
});
test('other modes do not make metadata requests', async()=>{
  for(const mode of ['proxy','direct_oa'] as const) {
    const r=await checkModelAvailability(mode,['one'],{fetch:async()=>{throw Error('must not run');}});
    assert.equal(r.basis,'not_applicable');assert.equal(r.models[0].status,'not_applicable');
  }
});
test('failed, malformed, partial, duplicate, and redirected catalogs stay unknown', async()=>{
  const responses=[new Response('secret',{status:401}),new Response('not json'),Response.json({data:[{id:'one'}],total_count:2}),
    Response.json({data:[{id:'one'}],links:{next:'https://evil.invalid'}}),Response.json({data:[{id:'one'},{id:'one'}]}),
    Response.json({data:[{id:3}]}),new Response('{"data":[],"data":[{"id":"one"}]}')];
  for (const response of responses) {
    const r=await checkModelAvailability('direct_openrouter',['one'],{base:'https://router.invalid/v1',fetch:async()=>response});
    assert.equal(r.basis,'unavailable');assert.equal(r.models[0].status,'unknown');assert.equal(r.checkedAt,null);
    assert.ok(!JSON.stringify(r).includes('secret'));
  }
  const r=await checkModelAvailability('direct_openrouter',['one'],{base:'https://router.invalid/v1',fetch:async()=>{throw Error('SECRET');}});
  assert.equal(r.basis,'unavailable');assert.ok(!JSON.stringify(r).includes('SECRET'));
});
test('stalled catalog body is canceled when the explicit check is aborted',async()=>{
  const controller=new AbortController();let canceled=false;
  const timer=setTimeout(()=>controller.abort(),15);
  try {
    const r=await checkModelAvailability('direct_openrouter',['one'],{base:'https://router.invalid/v1',signal:controller.signal,
      fetch:async()=>new Response(new ReadableStream({cancel(){canceled=true;}}))});
    assert.equal(r.models[0].status,'unknown');assert.equal(canceled,true);
  } finally {clearTimeout(timer);}
});
test('provider policy HTTP errors expose a safe code without leaking bodies, headers or advising downgrade',async()=>{
  const response=await describeProviderError(Response.json({error:{message:'No endpoints found matching your data policy. SECRET',metadata:{key:'SECRET'}}},
    {status:404,headers:{'Set-Cookie':'secret=SECRET','X-Correlation':'SECRET'}}),'direct_openrouter');
  assert.equal(response.status,404);assert.equal(response.headers.get('X-Zkapi-Error-Code'),'zdr_endpoint_unavailable');
  const body=await response.json();assert.equal(body.error.privacyPolicyRelaxed,false);assert.equal(body.error.automaticRetry,false);
  assert.equal(body.error.inferenceReplayable,false);assert.ok(!JSON.stringify(body).includes('SECRET'));
  assert.equal(response.headers.get('Set-Cookie'),null);assert.equal(response.headers.get('X-Correlation'),null);
});
test('provider HTTP statuses remain distinct and a generic 404 is not falsely called a ZDR failure',async()=>{
  for(const [status,code] of [[400,'provider_request_rejected'],[401,'provider_access_denied'],[402,'provider_budget_unavailable'],
    [403,'provider_access_denied'],[404,'model_endpoint_unavailable'],[429,'provider_rate_limited'],[503,'provider_unavailable']] as const) {
    const r=await describeProviderError(new Response('SECRET',{status}),'direct_openrouter');
    assert.equal(r.status,status);assert.equal((await r.json()).error.code,code);
  }
});
test('successful streaming and other modes are passed through without reading or reinterpretation',async()=>{
  const response=new Response('data: hello\n\n',{headers:{'Content-Type':'text/event-stream'}});
  assert.equal(await describeProviderError(response,'direct_openrouter'),response);assert.equal(response.bodyUsed,false);
  const oa=new Response('native error',{status:404});assert.equal(await describeProviderError(oa,'direct_oa'),oa);assert.equal(oa.bodyUsed,false);
});
test('oversize provider errors and already-aborted reads return only safe status guidance',async()=>{
  for (const r of [new Response('SECRET'.repeat(20_000),{status:404}), new Response('{"error":{"message":"SECRET"}}',{status:500})]) {
    const out=await describeProviderError(r,'direct_openrouter',r.status===500?AbortSignal.abort():undefined);
    assert.ok(!(await out.text()).includes('SECRET'));
  }
});
