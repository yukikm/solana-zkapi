/** Synthetic chain/proof/settlement fixtures; quote signatures and encrypted
 * journal are real. The separate local acceptance runner verifies real SBF. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { ZkApiClient } from '../src/client.ts';
import { ControlClient, validateNoteJournal, validateApiBinding, apiOperationPath, type ApiBinding, type ApiTariff, type ApiQuote, type NoteJournal, type PreparedSession, type SessionVerifier } from '../src/control.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { jcsBytes, sha256Hex, type VerifiedManifest } from '../src/trust.ts';
import type { NoteProver } from '../src/prover.ts';
import { fixtureSigner } from './kit-helpers.ts';

const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const api:ApiBinding={version:'1',service:'weather',operation:'lookup',method:'POST',path:'/weather/current',origin:'https://weather.invalid',request_max_bytes:'2048',response_max_bytes:'4096',timeout_seconds:'30',billing:'http_2xx_json'};
async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'zkapi-generic-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const store=await NativeJournalStore.open(dir),key=await importJournalKey(new Uint8Array(32).fill(13));
  const journal=new EncryptedJournal<NoteJournal>(store,key,{deploymentId:'generic-fixture',pool:'pool'},validateNoteJournal);
  const tariffBody:Omit<ApiTariff,'tariff_hash'>={version:'2',provider:'generic',api,pricing_basis:'fixed_request',valid_from:'0',valid_until:'9999999999',rates:[{unit:'requests',nano_usdc_numerator:'1000',unit_denominator:'1'}],operator_fee_micro_usdc:'0'};
  const tariff:ApiTariff={...tariffBody,tariff_hash:await sha256Hex(jcsBytes(tariffBody))};
  const signer=generateKeyPairSync('ed25519');
  const context={deployment_id:'generic-fixture',pool:'pool',vault_binding:field(1),state_key:[field(2),field(3)] as [string,string],cap_micro_usdc:'100',control_api_origin:'https://control.invalid',inference_api_origin:'https://proxy.invalid',quote_public_key:bs58.encode(signer.publicKey.export({format:'der',type:'spki'}).subarray(-32)),receipt_public_key:bs58.encode(new Uint8Array(32).fill(9)),request_vk_sha256:'22'.repeat(32),tariff_hashes:[tariff.tariff_hash]};
  const state={balance_micro_usdc:'200',balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(7),state_signature:null};
  await journal.create('note',{schema:1,state,witness:{secret:field(2),note_id:1,deposit_micro_usdc:'200',expiry:'9999999999'},wallet:{status:'active',history:[]},pending:null,history:[]});
  const counts={quotes:0,auth:0,sends:0,closes:0,settles:0};
  const behavior={lose:false,closeUnavailable:false,rejectSettlement:false,quoteOperation:'lookup'};
  const requests:{path:string;body:string;id:string}[]=[],verifiedOperations:string[][]=[];
  const status=async(settled=false)=>{const pending=(await journal.read('note'))!.value.pending!;const q=pending.prepared.request.quote.body;return{request_id:pending.prepared.request.authorization.request_id,mode:'proxy',state:settled?'SETTLED':'ACTIVE',cap_micro_usdc:'100',issued_at:q.issued_at,expires_at:String(BigInt(q.issued_at)+60n),...(settled?{settlement:{charge_micro_usdc:'1',next_commitment:state.commitment,next_anchor:field(8),blind_delta_srv:field(9),next_state_signature:{r_x:field(2),r_y:field(3),s:field(4)}}}:{})};};
  const http:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname;
    if(path.endsWith('/quotes')){
      counts.quotes++;const wanted=JSON.parse(String(init!.body));assert.equal('models' in wanted,false);assert.deepEqual(wanted.api,api);
      const now=BigInt(Math.floor(Date.now()/1000));
      const body:ApiQuote['body']={quote_id:crypto.randomUUID(),deployment_id:context.deployment_id,pool:context.pool,mode:'proxy',provider:'generic',api:{...api,operation:behavior.quoteOperation},tariff_hash:tariff.tariff_hash,cap_micro_usdc:'100',issued_at:String(now),expires_at:String(now+120n),session_ttl_seconds:'60',max_concurrency:'4',control_api_origin:context.control_api_origin,inference_api_origin:context.inference_api_origin};
      const quote_hash=await sha256Hex(jcsBytes(body));return Response.json({body,quote_hash,signature:sign(null,Buffer.from(quote_hash,'hex'),signer.privateKey).toString('base64')});
    }
    if(path==='/zkapi/v1/sessions'){counts.auth++;return Response.json(await status());}
    if(path.endsWith('/close')){counts.closes++;if(behavior.closeUnavailable)return new Response(null,{status:503});return Response.json(await status(true));}
    if(path.endsWith('/receipts'))return Response.json({receipts:[],next_cursor:null});
    if(path.startsWith('/zkapi/v1/sessions/'))return Response.json(await status());
    assert.equal(path,apiOperationPath(api));assert.equal(init!.method,'POST');counts.sends++;
    const saved=(await journal.read('note'))!.value.pending!.operations.at(-1)!;
    assert.equal(saved.phase,'send_unknown');assert.equal(saved.bodyRedacted,true);assert.equal(saved.bodyBase64,'');
    const body=Buffer.from(init!.body as Uint8Array).toString('utf8'),id=new Headers(init!.headers).get('Idempotency-Key')!;requests.push({path,body,id});
    if(behavior.lose)throw Error('response lost');return Response.json({temperature_c:21,query:JSON.parse(body)});
  };
  const verifier:SessionVerifier={async prepare(){},async settle(_c,previous,_p,_s,_receipts,operations){if(behavior.rejectSettlement)throw Error('invalid successor');counts.settles++;verifiedOperations.push(operations);return{...previous,balance_micro_usdc:String(BigInt(previous.balance_micro_usdc)-1n),anchor:field(8)};}};
  const prover={async prepareSession(_w:unknown,_s:unknown,_root:string,_siblings:string[],quote:ApiQuote,tariff:ApiTariff,c:any):Promise<PreparedSession>{return{request:{authorization:{version:'1',deployment_id:context.deployment_id,pool:context.pool,request_id:c.requestId,quote_hash:quote.quote_hash,mode:'proxy',control_secret_hash:c.controlHash,proxy_secret_hash:c.proxyHash},quote,public_inputs:Array(12).fill(field(1)),proof:{backend:'groth16_bn254',proof:'synthetic'}},control_token:c.controlToken,proxy_token:c.proxyToken,tariff,rerandomization:field(2)};}} as unknown as NoteProver;
  const walletAddress=(await fixtureSigner(new Uint8Array(32).fill(1))).address;
  const make=()=>{
    const control=new ControlClient({context,journal,verifier,fetch:http});
    const client=new ZkApiClient({store,noteId:'note',mode:'proxy',models:[],services:[{tariff}],control,wallet:{manifest:{deployment_id:context.deployment_id,pool:context.pool,cap_micro_usdc:'100',control_api_origin:context.control_api_origin,inference_api_origin:context.inference_api_origin} as unknown as VerifiedManifest,journal,prover,fetch:http,chain:{async sessionSnapshot(){return{root:field(1),siblings:Array(32).fill(field(0)),slot:1,sequence:'1',nextNoteId:2,clock:'100',paused:false};},async snapshot(){throw Error('unexpected');},async blockhash(){throw Error('unexpected');},async buffer(){return null;}},rpc:{} as any,wallets:[{publicKey:walletAddress,supportedTransactionVersions:new Set([0]),async signTransaction(){throw Error('unexpected wallet transaction');}}]}});
    t.after(()=>client.dispose());return{client,control};
  };
  return{...make(),restart:make,journal,counts,behavior,requests,verifiedOperations,tariff};
}

test('registered JSON API uses the application facade and existing journal through settlement without a model',async t=>{
  const f=await fixture(t),operationId=crypto.randomUUID();
  assert.deepEqual(f.client.listModels(),[]);assert.deepEqual(f.client.listApis(),[api]);
  const response=await f.client.requestApi({operationId,service:'weather',operation:'lookup',body:{city:'Tokyo'}});
  assert.deepEqual(await response.json(),{temperature_c:21,query:{city:'Tokyo'}});
  assert.deepEqual(f.counts,{quotes:1,auth:1,sends:1,closes:1,settles:1});assert.deepEqual(f.verifiedOperations,[[operationId]]);
  const saved=(await f.journal.read('note'))!.value;assert.equal(saved.schema,1);assert.equal(saved.pending,null);assert.equal(saved.state.balance_micro_usdc,'199');
  assert.equal(saved.history[0].prepared.tariff.provider,'generic');assert.equal('model' in saved.history[0].prepared.tariff,false);assert.equal('models' in saved.history[0].prepared.request.quote.body,false);
  assert.equal(saved.history[0].operations[0].bodyRedacted,true);assert.equal(f.requests[0].body,'{"city":"Tokyo"}');
  await assert.rejects(f.client.requestApi({operationId,service:'weather',operation:'lookup',body:{city:'Tokyo'}}));assert.equal(f.counts.sends,1);
});

test('unknown API send remains durable and explicit recovery never replays its request',async t=>{
  const f=await fixture(t),operationId=crypto.randomUUID();f.behavior.lose=true;f.behavior.closeUnavailable=true;
  await assert.rejects(f.client.requestApi({operationId,service:'weather',operation:'lookup',body:{city:'Tokyo'}}),/response lost/);
  const saved=(await f.journal.read('note'))!.value.pending!;assert.equal(saved.operations[0].phase,'send_unknown');assert.equal(saved.operations[0].bodyRedacted,true);
  const exactAuthorization=saved.exactRequest;const restarted=f.restart();await assert.rejects(restarted.client.requestApi({operationId:crypto.randomUUID(),service:'weather',operation:'lookup',body:{city:'Osaka'}}),/recover/);
  f.behavior.closeUnavailable=false;await restarted.client.recover();assert.equal(f.counts.sends,1);
  const history=(await f.journal.read('note'))!.value.history;assert.equal(JSON.stringify(history[0].prepared.request),exactAuthorization);assert.equal(history[0].operations[0].id,operationId);
});

test('API operation capabilities and even correctly signed substituted quote descriptors fail before sending',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.client.requestApi({operationId:crypto.randomUUID(),service:'weather',operation:'admin',body:{}}),/registered/);
  await assert.rejects(f.client.requestApi({operationId:crypto.randomUUID(),service:'weather',operation:'lookup',body:{large:'x'.repeat(2048)}}),/limit/);
  assert.equal(f.counts.quotes,0);f.behavior.quoteOperation='admin';
  await assert.rejects(f.client.requestApi({operationId:crypto.randomUUID(),service:'weather',operation:'lookup',body:{}}),/API quote binding/);
  assert.equal(f.counts.auth,0);assert.equal(f.counts.sends,0);
});

test('generic saved authorization rejects another operation and inference routes',async t=>{
  const f=await fixture(t);f.behavior.closeUnavailable=true;
  await(await f.client.requestApi({operationId:crypto.randomUUID(),service:'weather',operation:'lookup',body:{}})).text();
  for(const path of ['/zkapi/v1/api/weather/admin','/v1/chat/completions'])await assert.rejects(f.control.prepareOperation('note',crypto.randomUUID(),path,jcsBytes({model:'fake'})),/proxy session|authorization/);
  assert.equal(f.counts.sends,1);assert.equal((await f.journal.read('note'))!.value.pending!.operations.length,1);
});

test('API descriptors reject traversal, arbitrary origins and noninteger limits',()=>{
  for(const changes of [{path:'//other.invalid/'},{path:'/../admin'},{path:'/%2e/admin'},{path:'/api?x=1'},{origin:'https://user:pass@weather.invalid'},{origin:'http://remote.invalid'},{request_max_bytes:'1.5'},{timeout_seconds:'601'}])assert.throws(()=>validateApiBinding({...api,...changes}));
  validateApiBinding({...api,origin:'http://127.0.0.1:12345'});
});
