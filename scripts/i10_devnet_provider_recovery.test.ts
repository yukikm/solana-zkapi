/** Offline recovery-verifier fixtures. Real Ed25519 receipt signatures and
 * actual SDK interfaces; RP/Baby-JubJub verifier is explicitly synthetic. */
import assert from 'node:assert/strict';
import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import bs58 from 'bs58';
import type {NoteJournal,PrivateState,Receipt,SessionVerifier,VerificationContext} from '../packages/sdk/src/control.ts';
import {jcsBytes,verifyEd25519} from '../packages/sdk/src/trust.ts';
import {providerAcceptanceBody} from './provider_acceptance_client.ts';
import {verifySettledProviderCase,verifyUnstartedProviderCase,type ProviderRecoveryPlan,type SettledProviderRecoveryInput,type UnstartedProviderRecoveryInput} from './i10_devnet_provider_recovery.ts';

const parent=JSON.parse(readFileSync(new URL('../config/provider-acceptance.i10.json',import.meta.url),'utf8')) as ProviderRecoveryPlan;
const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const hash=(v:unknown)=>createHash('sha256').update(jcsBytes(v)).digest();
const pair=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,86)]),format:'der',type:'pkcs8'});
const publicKey=bs58.encode(createPublicKey(pair).export({type:'spki',format:'der'}).subarray(-32));
const requestId='12345678-1234-4123-8123-123456789012',operationId='12345678-1234-4123-8123-123456789013';

function fixture(metered=false){
  const plan=structuredClone(parent),c=plan.cases.find(v=>v.id==='openrouter-proxy-plain')!;
  const tariff=structuredClone(plan.models.find(m=>m.tariff.provider===c.provider&&m.tariff.model===c.model)!.tariff);
  const context:VerificationContext={deployment_id:'offline-recovery',pool:'fixture-pool',vault_binding:field(1),state_key:[field(2),field(3)],
    cap_micro_usdc:'1000000',control_api_origin:'https://control.invalid',inference_api_origin:'https://inference.invalid',
    quote_public_key:publicKey,receipt_public_key:publicKey,request_vk_sha256:'00'.repeat(32),tariff_hashes:[tariff.tariff_hash]};
  const previous:PrivateState={balance_micro_usdc:'10000000',balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(1),state_signature:null};
  const next:PrivateState={...previous,balance_micro_usdc:metered?'9999996':'10000000',anchor:field(8),state_signature:{r_x:field(9),r_y:field(10),s:field(11)}};
  const body={version:'1',receipt_id:'12345678-1234-4123-8123-123456789014',deployment_id:context.deployment_id,pool:context.pool,
    request_id:requestId,operation_id:operationId,billing_effect:'charge',related_receipt_hash:null,observed_at:'1791170000',
    evidence_kind:metered?'PROXY_USAGE':'UNKNOWN_OPERATOR_LOSS',provider_request_id:null,provider_evidence_digest:metered?'88'.repeat(32):null,
    tariff_hash:tariff.tariff_hash,usage:[],provider_reported_usd:null,reservation_nano_usdc:'19276800',observed_nano_usdc:metered?'3300':null,
    charged_nano_usdc:metered?'3300':'0',operator_loss_nano_usdc:metered?'0':null,reason:metered?'metered':'waived_unknown'};
  const receipt:Receipt={body,receipt_hash:hash(body).toString('hex'),signature:sign(null,hash(body),pair).toString('base64')};
  const prepared={request:{authorization:{version:'1' as const,deployment_id:context.deployment_id,pool:context.pool,request_id:requestId,
    quote_hash:'00'.repeat(32),mode:'proxy' as const,control_secret_hash:'11'.repeat(32),proxy_secret_hash:'22'.repeat(32)},
    quote:{body:{quote_id:requestId,deployment_id:context.deployment_id,pool:context.pool,mode:'proxy' as const,provider:'openrouter' as const,
      models:[c.model],tariff_hash:tariff.tariff_hash,cap_micro_usdc:context.cap_micro_usdc,issued_at:'1791160000',expires_at:'1791160120',
      session_ttl_seconds:'300',max_concurrency:'4',control_api_origin:context.control_api_origin,inference_api_origin:context.inference_api_origin},
      quote_hash:'00'.repeat(32),signature:'synthetic'},public_inputs:Array(12).fill(field(1)),proof:{backend:'groth16_bn254' as const,proof:'synthetic'}},
    tariff,control_token:'zkc1.synthetic-secret-canary',proxy_token:'zkp1.synthetic-secret-canary',rerandomization:field(13)};
  const settlement={charge_micro_usdc:metered?'4':'0',next_commitment:next.commitment,next_anchor:next.anchor,blind_delta_srv:field(14),next_state_signature:next.state_signature!};
  const note:NoteJournal={schema:1,state:next,pending:null,witness:{secret:field(2),note_id:0,deposit_micro_usdc:'10000000',expiry:'1791200000'},
    wallet:{status:'active',history:[]},history:[{previous,prepared,settlement,receipts:[receipt],operations:[{id:operationId,path:'/v1/chat/completions',
      anthropicVersion:'',bodyBase64:Buffer.from(providerAcceptanceBody(c)).toString('base64'),phase:'send_unknown'}]}]};
  const selected={schema:1,parent_plan_sha256:hash(plan).toString('hex'),role:'openrouter',profile:'openrouter-native',case_ids:[c.id]};
  const budget={identity:{schema:1,campaign_id:plan.campaign_id,plan_sha256:hash(plan).toString('hex'),budget_micro_usdc:plan.budget_micro_usdc,max_requests:plan.max_requests},
    reserved_micro_usdc:c.max_cost_micro_usdc,remaining_micro_usdc:String(BigInt(plan.budget_micro_usdc)-BigInt(c.max_cost_micro_usdc)),
    reservations:[{case_id:c.id,max_cost_micro_usdc:c.max_cost_micro_usdc,state:'reserved_no_automatic_replay'}],refunds_supported:false,inference_replays_supported:false};
  let calls=0;
  const expected=structuredClone({context,previous,prepared,settlement,next});
  const verifier:SessionVerifier={async prepare(){throw Error('must not prepare');},async settle(ctx,old,p,s,receipts,operations){
    calls++;assert.deepEqual(ctx,expected.context);assert.deepEqual(old,expected.previous);assert.deepEqual(p,expected.prepared);assert.deepEqual(s,expected.settlement);
    assert.deepEqual(operations,[operationId]);assert.equal(receipts.length,1);
    assert.equal(hash(receipts[0].body).toString('hex'),receipts[0].receipt_hash);
    await verifyEd25519(ctx.receipt_public_key,hash(receipts[0].body),receipts[0].signature);return structuredClone(expected.next);
  }};
  const input:SettledProviderRecoveryInput={note,context,verifier,plan,selection:selected,profile:selected.profile,tariffs:[tariff],budget,caseId:c.id};
  return {input,next,budget,calls:()=>calls};
}

for(const metered of [false,true])test(`${metered?'metered charge':'unknown waiver'} re-verifies receipt/successor without writes, inference or provider-pass claim`,async()=>{
  const h=fixture(metered),{verifier,...before}=h.input,saved=structuredClone(before);
  const report=await verifySettledProviderCase(h.input);
  assert.equal(h.calls(),1);assert.equal(report.charge_micro_usdc,metered?'4':'0');assert.equal(report.waiver_verified,!metered);
  assert.equal(report.provider_acceptance_passed,false);assert.equal(report.full_g3_passed,false);
  assert.equal(report.upstream_metadata_used_for_billing,false);assert.equal(report.reserved_micro_usdc,'19277');
  const {verifier:_v,...after}=h.input;assert.deepEqual(after,saved);
  assert.ok(!JSON.stringify(report).includes('synthetic-secret-canary'));assert.ok(!JSON.stringify(report).includes('Reply with'));
  h.input.note.wallet!.status='closed';assert.deepEqual(await verifySettledProviderCase(h.input),report);
  h.input.note.wallet!.status='active';h.input.note.wallet!.operation={id:operationId,kind:'mutual_close',phase:'proving',
    roles:{uploader:publicKey,rentPayer:publicKey,feePayer:publicKey,payer:publicKey},destinationOwner:publicKey,step:0,attempts:[],finalized:[]};
  assert.deepEqual(await verifySettledProviderCase(h.input),report);
});

test('wrong selection, case, exact body, receipt identity, cap, state or budget refuses recovery',async t=>{
  const mutations:[string,(o:SettledProviderRecoveryInput)=>void][]=[
    ['pending',o=>{o.note.pending={prepared:o.note.history[0].prepared,exactRequest:JSON.stringify(o.note.history[0].prepared.request),phase:'active',operations:[]};}],
    ['extra history',o=>{o.note.history.push(structuredClone(o.note.history[0]));}],
    ['different financial operation',o=>{o.note.wallet!.operation={id:operationId,kind:'initiate_escape',phase:'proving',
      roles:{uploader:publicKey,rentPayer:publicKey,feePayer:publicKey,payer:publicKey},step:0,attempts:[],finalized:[]};}],
    ['wrong case',o=>{o.caseId='openrouter-proxy-sse';}],
    ['wrong selection',o=>{(o.selection as {parent_plan_sha256:string}).parent_plan_sha256='ff'.repeat(32);}],
    ['changed tariff',o=>{o.tariffs[0].operator_fee_micro_usdc='1';}],
    ['wrong mode',o=>{o.note.history[0].prepared.request.authorization.mode='direct_openrouter';}],
    ['wrong provider',o=>{o.note.history[0].prepared.request.quote.body.provider='openai';}],
    ['wrong model',o=>{o.note.history[0].prepared.request.quote.body.models=['other'];}],
    ['changed cap',o=>{o.note.history[0].prepared.request.quote.body.cap_micro_usdc='999';}],
    ['extra operation',o=>{o.note.history[0].operations.push(structuredClone(o.note.history[0].operations[0]));}],
    ['different body',o=>{o.note.history[0].operations[0].bodyBase64=Buffer.from('{}').toString('base64');}],
    ['unsent operation',o=>{o.note.history[0].operations[0].phase='prepared';}],
    ['wrong receipt operation',o=>{o.note.history[0].receipts[0].body.operation_id='12345678-1234-4123-8123-123456789019';}],
    ['wrong receipt request',o=>{o.note.history[0].receipts[0].body.request_id='12345678-1234-4123-8123-123456789019';}],
    ['late loss receipt',o=>{o.note.history[0].receipts[0].body.billing_effect='late_loss_observation';}],
    ['excess reservation',o=>{o.note.history[0].receipts[0].body.reservation_nano_usdc='1000000000';}],
    ['wrong state',o=>{o.note.state.anchor=field(20);}],
    ['waiver charge',o=>{o.note.history[0].settlement.charge_micro_usdc='1';o.note.state.balance_micro_usdc='9999999';}],
    ['missing reservation',o=>{const b=o.budget as ReturnType<typeof fixture>['budget'];b.reservations=[];b.reserved_micro_usdc='0';b.remaining_micro_usdc='10000000';}],
    ['budget reset',o=>{(o.budget as ReturnType<typeof fixture>['budget']).identity.campaign_id='reset';}],
    ['budget refund',o=>{(o.budget as ReturnType<typeof fixture>['budget']).refunds_supported=true;}],
    ['budget arithmetic',o=>{(o.budget as ReturnType<typeof fixture>['budget']).remaining_micro_usdc='10000000';}],
  ];
  for(const [name,mutate] of mutations)await t.test(name,async()=>{const h=fixture();mutate(h.input);
    await assert.rejects(verifySettledProviderCase(h.input),/preserve journal and budget/);});
});

test('invalid Ed25519 receipt and failed or substituted successor verifier are rejected',async()=>{
  const invalid=fixture();invalid.input.note.history[0].receipts[0].signature=Buffer.alloc(64).toString('base64');
  await assert.rejects(verifySettledProviderCase(invalid.input),/preserve journal and budget/);assert.equal(invalid.calls(),1);
  for(const fail of [false,true]){const h=fixture();h.input.verifier={async prepare(){throw Error('unused');},async settle(){
    if(fail)throw Error('private verifier error must not escape');return {...h.next,anchor:field(30)};
  }};await assert.rejects(verifySettledProviderCase(h.input),e=>e instanceof Error&&e.message.includes('preserve journal')&&!e.message.includes('private verifier'));}
});

test('caller mutation during asynchronous verification cannot substitute accepted evidence',async()=>{
  const h=fixture(),original=h.input.verifier;h.input.verifier={async prepare(){throw Error('unused');},async settle(...args){
    h.input.note.state.balance_micro_usdc='1';h.input.caseId='other';return original.settle(...args);
  }};const report=await verifySettledProviderCase(h.input);assert.equal(report.case_id,'openrouter-proxy-plain');assert.equal(report.charge_micro_usdc,'0');
});

test('later explicit demo reservations count globally without replacing acceptance-case recovery evidence',async()=>{
  const h=fixture(),template=h.input.plan.cases.find(c=>c.id==='openai-chat-plain')!;
  const demoOperation='12345678-1234-4123-8123-123456789022',demoRequest='12345678-1234-4123-8123-123456789023';
  const row={case_id:'demo-'+demoOperation,kind:'explicit_demo',template_case_id:template.id,request_id:demoRequest,
    operation_id:demoOperation,max_cost_micro_usdc:template.max_cost_micro_usdc,state:'reserved_no_automatic_replay'};
  h.budget.reservations.push(row);
  h.budget.reserved_micro_usdc=String(BigInt(h.budget.reservations[0].max_cost_micro_usdc)+BigInt(template.max_cost_micro_usdc));
  h.budget.remaining_micro_usdc=String(BigInt(h.input.plan.budget_micro_usdc)-BigInt(h.budget.reserved_micro_usdc));
  const report=await verifySettledProviderCase(h.input);
  assert.equal(report.case_id,'openrouter-proxy-plain');assert.equal(report.provider_acceptance_passed,false);
  for(const [field,value] of [['max_cost_micro_usdc','1'],['template_case_id','openrouter-proxy-plain'],['kind','acceptance'],
      ['request_id','invalid'],['operation_id',demoRequest]] as const){
    const bad=structuredClone({...h.input,verifier:undefined}) as unknown as SettledProviderRecoveryInput;
    bad.verifier=h.input.verifier;
    ((bad.budget as typeof h.budget).reservations[1] as unknown as Record<string,unknown>)[field]=value;
    await assert.rejects(verifySettledProviderCase(bad),/preserve journal and budget/);
  }
});


function unstartedFixture(){
  const settled=fixture(),{verifier,...input}=settled.input;
  const c=input.plan.cases.find(row=>row.id==='openrouter-proxy-sse')!;
  input.caseId=c.id;input.profile='openrouter-sse';
  input.selection={schema:1,parent_plan_sha256:hash(input.plan).toString('hex'),role:'openrouter',profile:input.profile,case_ids:[c.id]};
  const budget=input.budget as ReturnType<typeof fixture>['budget'];
  // Actual quote failure precedes proof and reservation. Earlier cases remain burned.
  const earlier=input.plan.cases.find(row=>row.id==='openai-responses-plain')!;
  budget.reservations.unshift({case_id:earlier.id,max_cost_micro_usdc:earlier.max_cost_micro_usdc,state:'reserved_no_automatic_replay'});
  budget.reserved_micro_usdc='38554';budget.remaining_micro_usdc='9961446';
  input.note.state=structuredClone(input.note.history[0].previous);input.note.history=[];
  const deposit={id:requestId,kind:'deposit' as const,phase:'ready' as const,
    roles:{uploader:publicKey,rentPayer:publicKey,feePayer:publicKey,payer:publicKey,tokenOwner:publicKey},
    step:3,attempts:[],finalized:[]};
  input.note.wallet={status:'active',history:[deposit]};
  const failure={schema:1,passed:false,scope:'sanitized SDK provider-case failure checkpoint; no replay or refund authority',
    case_id:c.id,plan_sha256:hash(input.plan).toString('hex'),diagnostic:{schema:1,stage:'quote',elapsed_ms:50,
      control_http_status:503,inference:null,settlement:'not_started',inference_replays:0},full_g3_passed:false};
  return {...input,failure,depositMicroUsdc:'10000000'} satisfies UnstartedProviderRecoveryInput;
}

test('unstarted quote failure is read-only across active, mutual-close intent and closed journal',()=>{
  const input=unstartedFixture(),before=structuredClone(input),report=verifyUnstartedProviderCase(input);
  assert.deepEqual(input,before);assert.equal(report.failure_stage,'quote');assert.equal(report.control_http_status,503);
  assert.equal(report.case_id,'openrouter-proxy-sse');assert.equal(report.case_max_micro_usdc,'19277');
  assert.equal(report.saved_authorization_present,false);assert.equal(report.settled_sessions,0);
  assert.equal(report.budget_reservation_present,false);assert.equal(report.budget_reservation_created,false);assert.equal(report.permanent_clearance_required,true);
  assert.equal(report.cryptographic_absence_verified,false);assert.equal(report.inference_sent_by_verifier,false);
  assert.equal(report.journal_modified,false);assert.equal(report.provider_acceptance_passed,false);assert.equal(report.full_g3_passed,false);
  assert.equal(report.failure_checkpoint_sha256,hash(input.failure).toString('hex'));
  assert.ok(!JSON.stringify(report).includes(input.note.witness!.secret));
  const close={id:operationId,kind:'mutual_close' as const,phase:'proving' as const,
    roles:{uploader:publicKey,rentPayer:publicKey,feePayer:publicKey,payer:publicKey},destinationOwner:publicKey,step:0,attempts:[],finalized:[]};
  input.note.wallet!.operation=close;input.note.wallet!.clearance={nullifier:field(21),phase:'requested'};
  assert.deepEqual(verifyUnstartedProviderCase(input),report);
  delete input.note.wallet!.operation;input.note.wallet!.history.push(close);input.note.wallet!.status='closed';
  input.note.wallet!.clearance={nullifier:field(21),phase:'verified',signature:{r_x:field(2),r_y:field(3),s:field(4)}};
  assert.deepEqual(verifyUnstartedProviderCase(input),report);
});

test('unstarted recovery rejects changed checkpoint, saved AUTH/history, state, selection and budget',async t=>{
  type Input=ReturnType<typeof unstartedFixture>;
  const mutations:[string,(o:Input)=>void][]=[
    ['checkpoint case',o=>{o.failure.case_id='openrouter-proxy-plain';}],
    ['checkpoint parent',o=>{o.failure.plan_sha256='ff'.repeat(32);}],
    ['checkpoint scope',o=>{o.failure.scope='other';}],
    ['checkpoint passed',o=>{o.failure.passed=true;}],
    ['checkpoint full gate',o=>{o.failure.full_g3_passed=true;}],
    ['checkpoint unknown field',o=>{Object.assign(o.failure,{untrusted:'private-secret-canary'});}],
    ['diagnostic unknown field',o=>{Object.assign(o.failure.diagnostic,{message:'private-secret-canary'});}],
    ['diagnostic missing field',o=>{delete (o.failure.diagnostic as Partial<Input['failure']['diagnostic']>).inference;}],
    ['after quote',o=>{o.failure.diagnostic.stage='authorize';}],
    ['wrong status',o=>{o.failure.diagnostic.control_http_status=502;}],
    ['inference observed',o=>{Object.assign(o.failure.diagnostic,{inference:{stage:'send'}});}],
    ['settlement begun',o=>{o.failure.diagnostic.settlement='unresolved';}],
    ['inference replay',o=>{o.failure.diagnostic.inference_replays=1;}],
    ['negative timing',o=>{o.failure.diagnostic.elapsed_ms=-1;}],
    ['fractional timing',o=>{o.failure.diagnostic.elapsed_ms=0.5;}],
    ['oversized timing',o=>{o.failure.diagnostic.elapsed_ms=2_147_483_648;}],
    ['pending AUTH',o=>{const p=fixture().input.note.history[0].prepared;
      o.note.pending={prepared:p,exactRequest:JSON.stringify(p.request),phase:'prepared',operations:[]};}],
    ['settled history',o=>{o.note.history=fixture().input.note.history;}],
    ['cleared AUTH evidence',o=>{Object.assign(o.note.wallet!,{clearedAuthorization:{pending:{},previous:o.note.state}});}],
    ['missing witness',o=>{delete o.note.witness;}],
    ['different deposit witness',o=>{o.note.witness!.deposit_micro_usdc='9999999';}],
    ['different original deposit',o=>{o.depositMicroUsdc='9999999';}],
    ['different balance',o=>{o.note.state.balance_micro_usdc='9999999';}],
    ['non-genesis anchor',o=>{o.note.state.anchor=field(9);}],
    ['signed successor',o=>{o.note.state.state_signature={r_x:field(9),r_y:field(10),s:field(11)};}],
    ['cap above deposit',o=>{o.context.cap_micro_usdc='10000001';}],
    ['missing context tariff',o=>{o.context.tariff_hashes=[];}],
    ['pending escape',o=>{o.note.wallet!.status='pending_escape';}],
    ['escape operation',o=>{o.note.wallet!.operation={...o.note.wallet!.history[0],kind:'initiate_escape',phase:'proving',step:0};}],
    ['imported history',o=>{o.note.wallet!.history=[];}],
    ['historical escape',o=>{o.note.wallet!.history.push({...o.note.wallet!.history[0],kind:'initiate_escape'});}],
    ['closed without mutual history',o=>{o.note.wallet!.status='closed';}],
    ['profile mismatch',o=>{o.profile='different-profile';}],
    ['case mismatch',o=>{o.caseId='openrouter-proxy-plain';}],
    ['selection mismatch',o=>{(o.selection as {case_ids:string[]}).case_ids=['openrouter-proxy-plain'];}],
    ['tariff mismatch',o=>{o.tariffs[0].operator_fee_micro_usdc='1';}],
    ['budget identity mismatch',o=>{(o.budget as ReturnType<typeof fixture>['budget']).identity.plan_sha256='00'.repeat(32);}],
    ['unexpected selected reservation',o=>{const b=o.budget as ReturnType<typeof fixture>['budget'];b.reservations.push({case_id:o.caseId,max_cost_micro_usdc:'19277',state:'reserved_no_automatic_replay'});b.reserved_micro_usdc='57831';b.remaining_micro_usdc='9942169';}],
    ['wrong reservation amount',o=>{(o.budget as ReturnType<typeof fixture>['budget']).reservations[0].max_cost_micro_usdc='1';}],
    ['duplicate reservation',o=>{const b=o.budget as ReturnType<typeof fixture>['budget'];b.reservations.push(structuredClone(b.reservations[0]));}],
    ['budget arithmetic',o=>{(o.budget as ReturnType<typeof fixture>['budget']).remaining_micro_usdc='10000000';}],
    ['refund flag',o=>{(o.budget as ReturnType<typeof fixture>['budget']).refunds_supported=true;}],
  ];
  for(const [name,change] of mutations)await t.test(name,()=>{
    const input=unstartedFixture();change(input);
    assert.throws(()=>verifyUnstartedProviderCase(input),e=>e instanceof Error&&e.message.includes('preserve journal and budget')&&!e.message.includes('private-secret-canary'));
  });
});

test('unstarted guard preserves other consumed cases and also permits a never-used global campaign',()=>{
  const input=unstartedFixture(),budget=input.budget as ReturnType<typeof fixture>['budget'];
  const before=structuredClone(input);assert.equal(verifyUnstartedProviderCase(input).budget_reservation_present,false);assert.deepEqual(input,before);
  budget.reservations=[];budget.reserved_micro_usdc='0';budget.remaining_micro_usdc=input.plan.budget_micro_usdc;
  const emptyBefore=structuredClone(input);assert.equal(verifyUnstartedProviderCase(input).budget_reservation_created,false);assert.deepEqual(input,emptyBefore);
});
