/** Synthetic chain/proof/settlement fixtures; quote signatures and encrypted
 * journal are real. The separate local acceptance runner verifies real SBF. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import {ClientDaemon} from '../src/clientd-bridge.ts';
import { ZkApiClient } from '../src/client.ts';
import { ControlClient, validateNoteJournal, validateApiBinding, apiOperationPath, type ApiBinding, type ApiTariff, type ApiQuote, type NoteJournal, type PreparedSession, type SessionVerifier } from '../src/control.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { jcsBytes, sha256Hex, type VerifiedManifest } from '../src/trust.ts';
import type { NoteProver } from '../src/prover.ts';
import { fixtureSigner } from './kit-helpers.ts';

const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
import {decodeGatewayRequest, GATEWAY_RESPONSE_TYPE, type ApiBindingV2, type TariffV3, type HeaderPairs} from '../src/gateway.ts';
const vector=JSON.parse(await readFile(new URL('../../../docs/contracts/universal-api-gateway-vectors.json',import.meta.url),'utf8'));
const baseApi=vector.binding as ApiBindingV2;const api=baseApi;
const wireFrame=(tag:number,bytes:Uint8Array=new Uint8Array())=>{const p=Buffer.alloc(5);p[0]=tag;p.writeUInt32BE(bytes.length,1);return Buffer.concat([p,bytes]);};
async function fixture(t:TestContext,completionSatisfied=true){
  const api={...baseApi,completion:{...baseApi.completion,billable_statuses:completionSatisfied?baseApi.completion.billable_statuses:[]}};
  const dir=await mkdtemp(join(tmpdir(),'zkapi-generic-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=await NativeJournalStore.open(dir),key=await importJournalKey(new Uint8Array(32).fill(13));
  const journal=new EncryptedJournal<NoteJournal>(store,key,{deploymentId:'generic-fixture',pool:'11111111111111111111111111111111'},validateNoteJournal);
  const tariffBody:Omit<TariffV3,'tariff_hash'>={version:'3',provider:'generic',api,pricing_basis:'fixed_request',valid_from:'0',valid_until:'9999999999',rates:[{unit:'requests',nano_usdc_numerator:'1000',unit_denominator:'1',reservation_max_count:'1'}],operator_fee_micro_usdc:'0'};
  const tariff:TariffV3={...tariffBody,tariff_hash:await sha256Hex(jcsBytes(tariffBody))};
  const signer=generateKeyPairSync('ed25519');
  const context={deployment_id:'generic-fixture',pool:'11111111111111111111111111111111',vault_binding:field(1),state_key:[field(2),field(3)] as [string,string],cap_micro_usdc:'100',control_api_origin:'https://control.invalid',inference_api_origin:'https://proxy.invalid',quote_public_key:bs58.encode(signer.publicKey.export({format:'der',type:'spki'}).subarray(-32)),receipt_public_key:bs58.encode(signer.publicKey.export({format:'der',type:'spki'}).subarray(-32)),request_vk_sha256:'22'.repeat(32),tariff_hashes:[tariff.tariff_hash]};
  const state={balance_micro_usdc:'200',balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(7),state_signature:null};
  await journal.create('note',{schema:1,state,witness:{secret:field(2),note_id:1,deposit_micro_usdc:'200',expiry:'9999999999'},wallet:{status:'active',history:[]},pending:null,history:[]});
  const counts={quotes:0,auth:0,sends:0,closes:0,settles:0};
  const behavior={lose:false,closeUnavailable:false,rejectSettlement:false,quoteOperation:'lookup',wrongReceiptHmac:false,lostMeasured:false,truncated:false};
  const requests:{path:string;body:string;id:string}[]=[],verifiedOperations:string[][]=[];
  const status=async(settled=false)=>{const pending=(await journal.read('note'))!.value.pending!;const q=pending.prepared.request.quote.body;return{request_id:pending.prepared.request.authorization.request_id,mode:'proxy',state:settled?'SETTLED':'ACTIVE',cap_micro_usdc:'100',issued_at:q.issued_at,expires_at:String(BigInt(q.issued_at)+60n),...(settled?{settlement:{charge_micro_usdc:behavior.lose||!completionSatisfied?'0':'1',next_commitment:state.commitment,next_anchor:field(8),blind_delta_srv:field(9),next_state_signature:{r_x:field(2),r_y:field(3),s:field(4)}}}:{})};};
  const http:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/quotes')){
      counts.quotes++;const wanted=JSON.parse(String(init!.body));assert.equal('models' in wanted,false);assert.deepEqual(wanted.api,api);
      const now=BigInt(Math.floor(Date.now()/1000));
      const body:ApiQuote['body']={quote_id:crypto.randomUUID(),deployment_id:context.deployment_id,pool:context.pool,mode:'proxy',provider:'generic',api:{...api,operation:behavior.quoteOperation},tariff_hash:tariff.tariff_hash,cap_micro_usdc:'100',issued_at:String(now),expires_at:String(now+120n),session_ttl_seconds:'60',max_concurrency:api.limits.max_concurrency,control_api_origin:context.control_api_origin,inference_api_origin:context.inference_api_origin};
      const quote_hash=await sha256Hex(jcsBytes(body));return Response.json({body,quote_hash,signature:sign(null,Buffer.from(quote_hash,'hex'),signer.privateKey).toString('base64')});
    }
    if(path==='/zkapi/v1/sessions'){counts.auth++;return Response.json(await status());}
    if(path.endsWith('/close')){counts.closes++;if(behavior.closeUnavailable)return new Response(null,{status:503});return Response.json(await status(true));}
    if(path.endsWith('/receipts')){
      if(new URL(String(input)).searchParams.has('cursor'))return Response.json({receipts:[],next_cursor:null});
      const p=(await journal.read('note'))!.value.pending!,op=p.operations.at(-1)!;
      const measured=!behavior.lose;
      const body={version:'3',receipt_id:'00000000-0000-4000-8000-000000000005',deployment_id:context.deployment_id,pool:context.pool,request_id:p.prepared.request.authorization.request_id,operation_id:op.id,billing_effect:'charge',related_receipt_hash:null,observed_at:'100',evidence_kind:measured?'PROXY_USAGE':'UNKNOWN_OPERATOR_LOSS',provider_request_id:null,provider_evidence_digest:null,tariff_hash:tariff.tariff_hash,usage:measured?[{unit:'requests',count:completionSatisfied?'1':'0'}]:[],provider_reported_usd:null,reservation_nano_usdc:'1000',observed_nano_usdc:measured?(completionSatisfied?'1000':'0'):null,charged_nano_usdc:measured&&completionSatisfied?'1000':'0',operator_loss_nano_usdc:measured?'0':null,reason:measured?'metered':'waived_unknown',binding_hash:await sha256Hex(jcsBytes(api)),operation_hmac:behavior.wrongReceiptHmac?'00'.repeat(32):op.operationHmac,meter_hash:await sha256Hex(jcsBytes(api.meter)),resource:null,completion:measured?{rule_hash:await sha256Hex(jcsBytes(api.completion)),outcome:completionSatisfied?'satisfied':'not_satisfied',http_status:200}:null};
      const receipt_hash=await sha256Hex(jcsBytes(body));return Response.json({receipts:[{body,receipt_hash,signature:sign(null,Buffer.from(receipt_hash,'hex'),signer.privateKey).toString('base64')}],next_cursor:'1'});
    }
    if(path.startsWith('/zkapi/v1/sessions/'))return Response.json(await status());
    assert.equal(path,apiOperationPath(api));assert.equal(init!.method,'POST');counts.sends++;
    const saved=(await journal.read('note'))!.value.pending!.operations.at(-1)!;
    assert.deepEqual((await journal.read('note'))!.value.gatewayRecoveryHold,{request_id:(await journal.read('note'))!.value.pending!.prepared.request.authorization.request_id,operation_id:saved.id,delivered:false});assert.equal(saved.phase,'send_unknown');assert.equal(saved.bodyRedacted,true);assert.equal(saved.bodyBase64,'');
    const invocation=await decodeGatewayRequest(api,init!.body as Uint8Array),body=Buffer.from(invocation.body).toString('hex'),id=new Headers(init!.headers).get('Idempotency-Key')!;requests.push({path,body,id});assert.equal(saved.invocationVersion,'2');assert.match(saved.operationHmac!,/^[0-9a-f]{64}$/);assert.equal(saved.bodySha256,undefined);assert.equal(invocation.target,'/v1/lookup?tag=a&tag=b%2f&empty=');
    if(behavior.lose||behavior.lostMeasured)throw Error('response lost');return new Response(Buffer.concat([wireFrame(1,jcsBytes({status:200,headers:[['x-tag','gP8='],['x-tag','c2Vjb25k']]})),wireFrame(2,new Uint8Array([0,255,1,2])),...(behavior.truncated?[]:[wireFrame(4)])]),{headers:{'content-type':GATEWAY_RESPONSE_TYPE}});
  };
  const verifier:SessionVerifier={async prepare(){},async settle(_c,previous,_p,_s,_receipts,operations){if(behavior.rejectSettlement)throw Error('invalid successor');counts.settles++;verifiedOperations.push(operations);return{...previous,balance_micro_usdc:String(BigInt(previous.balance_micro_usdc)-(behavior.lose||!completionSatisfied?0n:1n)),anchor:field(8)};}};
  const prover={async prepareSession(_w:unknown,_s:unknown,_root:string,_siblings:string[],quote:ApiQuote,tariff:TariffV3,c:any):Promise<PreparedSession>{return{request:{authorization:{version:'1',deployment_id:context.deployment_id,pool:context.pool,request_id:c.requestId,quote_hash:quote.quote_hash,mode:'proxy',control_secret_hash:c.controlHash,proxy_secret_hash:c.proxyHash},quote,public_inputs:Array(12).fill(field(1)),proof:{backend:'groth16_bn254',proof:'synthetic'}},control_token:c.controlToken,proxy_token:c.proxyToken,tariff,rerandomization:field(2)};}} as unknown as NoteProver;
  const walletAddress=(await fixtureSigner(new Uint8Array(32).fill(1))).address;
  const make=()=>{
    const control=new ControlClient({context,journal,verifier,fetch:http});
    const client=new ZkApiClient({store,noteId:'note',mode:'proxy',models:[],services:[{tariff}],control,wallet:{manifest:{deployment_id:context.deployment_id,pool:context.pool,cap_micro_usdc:'100',control_api_origin:context.control_api_origin,inference_api_origin:context.inference_api_origin} as unknown as VerifiedManifest,journal,prover,fetch:http,chain:{async sessionSnapshot(){return{root:field(1),siblings:Array(32).fill(field(0)),slot:1,sequence:'1',nextNoteId:2,clock:'100',paused:false};},async snapshot(){throw Error('unexpected');},async blockhash(){throw Error('unexpected');},async buffer(){return null;}},rpc:{} as any,wallets:[{publicKey:walletAddress,supportedTransactionVersions:new Set([0]),async signTransaction(){throw Error('unexpected wallet transaction');}}]}});
    t.after(()=>client.dispose());return{client,control};
  };
  return{...make(),restart:make,journal,counts,behavior,requests,verifiedOperations,tariff};
}

const request=(operationId=crypto.randomUUID())=>({version:'2' as const,operationId,service:api.service,operation:api.operation,method:'POST',target:'/v1/lookup?tag=a&tag=b%2f&empty=',headers:[['x-extra','gP8=']] as HeaderPairs,body:new Uint8Array([0,255,13,10])});

test('gateway facade completes through the existing encrypted note, signed v3 receipt and settlement',async t=>{
  const f=await fixture(t),input=request(),response=await f.client.requestApi(input);
  assert.equal(response.status,200);assert.deepEqual(response.headers,[['x-tag','gP8='],['x-tag','c2Vjb25k']]);assert.deepEqual(Buffer.from(await new Response(response.body).arrayBuffer()),Buffer.from([0,255,1,2]));await response.completed;assert.deepEqual(await response.trailers,[]);
  if((await f.journal.read('note'))!.value.pending)await f.control.close('note');
  assert.deepEqual(f.counts,{quotes:1,auth:1,sends:1,closes:1,settles:1});assert.deepEqual(f.verifiedOperations,[[input.operationId]]);
  const note=(await f.journal.read('note'))!.value;assert.equal(note.schema,3);assert.equal(note.pending,null);assert.equal(note.state.balance_micro_usdc,'199');const op=note.history[0].operations[0];assert.equal(op.bodyBase64,'');assert.equal(op.bodySha256,undefined);assert.equal(op.operationHmac,note.history[0].receipts[0].body.operation_hmac);assert.equal(JSON.stringify(op).includes('tag='),false);
  await assert.rejects(f.client.requestApi(input));assert.equal(f.counts.sends,1);
});

test('gateway facade snapshots the caller selection and operation identity before asynchronous admission',async t=>{
  const f=await fixture(t),input=request(),operationId=input.operationId;
  const pending=f.client.requestApi(input);
  input.service='changed-service';input.operation='changed-operation';input.operationId=crypto.randomUUID();
  const response=await pending;
  assert.equal(response.operationId,operationId);
  await new Response(response.body).arrayBuffer();
  assert.equal(f.requests[0].id,operationId);
  assert.equal(f.counts.sends,1);
});

test('gateway lost response survives restart with only a commitment and recovery never dispatches again',async t=>{
  const f=await fixture(t);f.behavior.lose=true;f.behavior.closeUnavailable=true;const input=request();await assert.rejects(f.client.requestApi(input),/response lost/);
  const pending=(await f.journal.read('note'))!.value.pending!;assert.equal(pending.operations[0].bodyBase64,'');assert.equal(pending.operations[0].invocationVersion,'2');const exact=pending.exactRequest;
  const restarted=f.restart();await assert.rejects(restarted.client.requestApi(request()),/recover/);f.behavior.closeUnavailable=false;await restarted.client.recover();assert.equal(f.counts.sends,1);const final=(await f.journal.read('note'))!.value;assert.equal(final.state.balance_micro_usdc,'200');assert.equal(final.pending,null);assert.equal(JSON.stringify(final.history[0].prepared.request),exact);assert.equal(final.history[0].receipts[0].body.reason,'waived_unknown');
});

test('a correctly signed v3 receipt with another request commitment cannot advance the note',async t=>{
  const f=await fixture(t);f.behavior.wrongReceiptHmac=true;const response=await f.client.requestApi(request());await new Response(response.body).arrayBuffer();assert.equal(f.counts.settles,0);assert.equal((await f.journal.read('note'))!.value.state.balance_micro_usdc,'200');await assert.rejects(f.control.close('note'),/gateway receipt binding/);assert.equal(f.counts.sends,1);
});

for(const failure of ['lostMeasured','truncated','cancel','unknown'] as const)test(`gateway ${failure} delivery hold survives verified settlement and restart before a different new ID`,async t=>{
  const f=await fixture(t);if(failure==='unknown')f.behavior.lose=true;else if(failure!=='cancel')f.behavior[failure]=true;
  if(failure==='lostMeasured'||failure==='unknown')await assert.rejects(f.client.requestApi(request()),/response lost/);
  else {const response=await f.client.requestApi(request());if(failure==='cancel')await response.body.cancel();else await assert.rejects(new Response(response.body).arrayBuffer());}
  let note=(await f.journal.read('note'))!.value;if(note.pending)await f.control.close('note');note=(await f.journal.read('note'))!.value;
  assert.equal(note.pending,null);assert.equal(note.gatewayRecoveryHold?.delivered,false);assert.equal(note.history[0].receipts[0].body.reason,failure==='unknown'?'waived_unknown':'metered');assert.equal((await f.client.status()).canRequest,false);
  const fresh=request();fresh.body=new Uint8Array([9,8,7]);await assert.rejects(f.client.requestApi(fresh),/recover/);assert.equal(f.counts.auth,1);assert.equal(f.counts.sends,1);
  const restarted=f.restart();await assert.rejects(restarted.client.requestApi(request()),/recover/);assert.equal((await f.journal.read('note'))!.value.gatewayRecoveryHold?.delivered,false);
  await restarted.client.recover();assert.equal((await f.journal.read('note'))!.value.gatewayRecoveryHold,undefined);assert.equal(f.counts.auth,1);assert.equal(f.counts.sends,1);f.behavior.lose=false;f.behavior.lostMeasured=false;f.behavior.truncated=false;const next=await restarted.client.requestApi(request());await new Response(next.body).arrayBuffer();assert.equal(f.counts.auth,2);assert.equal(f.counts.sends,2);
});
test('a metered2xx response with an unsatisfied completion still requires explicit recovery',async t=>{
  const f=await fixture(t,false),response=await f.client.requestApi(request());await new Response(response.body).arrayBuffer();if((await f.journal.read('note'))!.value.pending)await f.control.close('note');const note=(await f.journal.read('note'))!.value;assert.equal(note.pending,null);assert.equal(note.history[0].receipts[0].body.reason,'metered');assert.equal(note.gatewayRecoveryHold?.delivered,true);await assert.rejects(f.client.requestApi(request()),/recover/);await f.client.recover();assert.equal((await f.journal.read('note'))!.value.gatewayRecoveryHold,undefined);
});

test('gateway hold is versioned, linked to its existing operation and fences a native legacy-route fallback',async t=>{
  const f=await fixture(t);f.behavior.lostMeasured=true;await assert.rejects(f.client.requestApi(request()));if((await f.journal.read('note'))!.value.pending)await f.control.close('note');const note=(await f.journal.read('note'))!.value;assert.equal(note.pending,null);assert.ok(note.gatewayRecoveryHold);
  await assert.rejects(f.control.prepare('note',note.history[0].prepared,field(1)),/gateway recovery/);
  for(const mutate of [(v:NoteJournal)=>{v.schema=2;},(v:NoteJournal)=>{v.schema=1;},(v:NoteJournal)=>{v.gatewayRecoveryHold!.request_id=crypto.randomUUID();},(v:NoteJournal)=>{v.gatewayRecoveryHold!.operation_id=crypto.randomUUID();},(v:NoteJournal)=>{(v.gatewayRecoveryHold as any).delivered=null;}]){const changed=structuredClone(note);mutate(changed);await assert.rejects(validateNoteJournal(changed));}
  const native=new ClientDaemon({client:f.control,journal:f.journal,noteId:'note',mode:'proxy',models:['legacy'],services:[{tariff:f.tariff}],prepareApi:async()=>{throw Error('gateway preparation must remain fenced');},prepare:async()=>{throw Error('legacy preparation must remain fenced');}});await native.start();const result=await native.handle('POST','/v1/chat/completions',jcsBytes({model:'legacy',messages:[{role:'user',content:'different body and route'}]}),new Headers());assert.equal(result.status,409);assert.equal((await result.json()).error.code,'recovery_required');assert.equal(f.counts.auth,1);assert.equal(f.counts.sends,1);assert.equal((await native.status() as any).recovery_required,true);await native.management('close');assert.ok((await f.journal.read('note'))!.value.gatewayRecoveryHold);await native.management('recover');assert.equal((await f.journal.read('note'))!.value.gatewayRecoveryHold,undefined);
});
