import {v0Message as transactionMessage} from './kit-helpers.ts';
import {transactionSignature} from '../src/solana.ts';
import {kitAddress, fixtureSigner, signWith, decodeTransaction} from './kit-helpers.ts';
/** Same-journal clearance recovery with real encryption, ControlClient and v0
 * signing. HTTP, proofs and finalized chain receipts are explicit fixtures. */
/** Same-journal clearance recovery with real encryption, ControlClient and v0
 * signing. HTTP, proofs and finalized chain receipts are explicit fixtures. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';

import bs58 from 'bs58';
import {ControlClient, validateNoteJournal, type NoteJournal, type PreparedSession, type PrivateState,
  type SessionVerifier, type VerificationContext} from '../src/control.ts';
import {EncryptedJournal, importJournalKey, type EncryptedRecord} from '../src/journal.ts';
import {NativeJournalStore} from '../src/journal-node.ts';
import type {NoteProver} from '../src/prover.ts';
import type {FinalizedReceipt, TransportRpc, V0Wallet} from '../src/transport.ts';
import type {VerifiedManifest} from '../src/trust.ts';
import {WalletClient, type WalletOptions} from '../src/wallet.ts';
import type {WalletSnapshot} from '../src/wallet-chain.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../tests/fixtures/vault/genesis-a.json',import.meta.url),'utf8'));
const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const key=(hex:string)=>kitAddress(Buffer.from(hex,'hex'));
const nullifier:string=fixture.auth.withdrawal.public_inputs[11];
const signature={r_x:field(9),r_y:field(10),s:field(11)};
const manifest={deployment_id:'wallet-clearance-fixture',program_id:key(fixture.program_id),pool:key(fixture.pool),
  mint:key(fixture.mint),note_ttl_seconds:String(fixture.ttl),control_api_origin:'https://control.invalid',
  inference_api_origin:'https://inference.invalid'} as unknown as VerifiedManifest;
const context={deployment_id:manifest.deployment_id,pool:manifest.pool,vault_binding:field(1),state_key:[field(2),field(3)],
  cap_micro_usdc:'100',control_api_origin:manifest.control_api_origin,inference_api_origin:manifest.inference_api_origin,
  quote_public_key:'00'.repeat(32),receipt_public_key:'00'.repeat(32),request_vk_sha256:'00'.repeat(32),tariff_hashes:['33'.repeat(32)]} as VerificationContext;

function prepared():PreparedSession{return {
  request:{authorization:{version:'1',deployment_id:manifest.deployment_id,pool:manifest.pool,
    request_id:'12345678-1234-4123-8123-123456789012',quote_hash:'00'.repeat(32),mode:'proxy',
    control_secret_hash:'11'.repeat(32),proxy_secret_hash:'22'.repeat(32)},
    quote:{body:{quote_id:'fixture',deployment_id:manifest.deployment_id,pool:manifest.pool,mode:'proxy',provider:'openai',
      models:['fixture-model'],tariff_hash:context.tariff_hashes[0],cap_micro_usdc:'100',issued_at:'100',expires_at:'200',
      session_ttl_seconds:'60',max_concurrency:'4',control_api_origin:manifest.control_api_origin,
      inference_api_origin:manifest.inference_api_origin},quote_hash:'00'.repeat(32),signature:'synthetic'},
    public_inputs:Array.from({length:12},(_,i)=>i===8?nullifier:field(1)),proof:{backend:'groth16_bn254',proof:'synthetic'}},
  control_token:'zkc1.synthetic',proxy_token:'zkp1.synthetic',rerandomization:field(13),
  tariff:{tariff_hash:context.tariff_hashes[0],version:'1',provider:'openai',model:'fixture-model',pricing_basis:'fixed_usage_rates',
    valid_from:'100',valid_until:'1000',rates:[],operator_fee_micro_usdc:'0'}};}

async function setup(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'zkapi-wallet-clearance-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await NativeJournalStore.open(directory),aes=await importJournalKey(new Uint8Array(32).fill(81));
  let writesBeforeFailure=Infinity;
  const guarded={read:store.read.bind(store),withLock:store.withLock.bind(store),compareAndSwap:async(k:string,rev:number|null,next:EncryptedRecord)=>{
    if(writesBeforeFailure--===0)throw Error('fixture storage unavailable');await store.compareAndSwap(k,rev,next);
  }};
  const open=()=>new EncryptedJournal<NoteJournal>(guarded,aes,{deploymentId:manifest.deployment_id,pool:manifest.pool},validateNoteJournal);
  const journal=open(),pair=(await fixtureSigner(new Uint8Array(32).fill(1))),owner=pair.address;
  const state:PrivateState={balance_micro_usdc:String(fixture.deposit),balance_blinding:field(3),note_leaf:field(4),
    commitment:{x:field(5),y:field(6)},anchor:field(1),state_signature:null};
  await journal.create('note',{schema:1,state,witness:{secret:field(2),note_id:0,deposit_micro_usdc:String(fixture.deposit),
    expiry:String(fixture.expiry)},pending:null,history:[],wallet:{status:'active',history:[]}});
  const calls:string[]=[],receipts=new Map<string,FinalizedReceipt>();let sends=0,signs=0,closed=false,verifyFailure=false;
  const verifier:SessionVerifier={async prepare(){},async settle(){throw Error('settlement not used');}};
  const control=new ControlClient({context,journal,verifier,now:()=>150n,fetch:async(url)=>{
    calls.push(String(url));throw Error('fixture AUTH ACK lost');}});
  await control.prepare('note',prepared(),field(1));await assert.rejects(control.submit('note'),/ACK lost/);
  const original=(await journal.read('note'))!.value;
  let clearanceReply:(body:string)=>Promise<Response>=async()=>Response.json({nullifier,signature});
  const wallet:V0Wallet={publicKey:pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(tx){signs++;tx = await signWith(tx, [pair]);return tx;}};
  let successorN=false;
  const prover={async inspect(_w:unknown,s:PrivateState){successorN=s.anchor===field(21);return {nullifier:successorN?field(22):nullifier,registration_commitment:'0x'+fixture.commitment};},
    async verifyClearance(n:string,s:typeof signature){assert.equal(n,successorN?field(22):nullifier);assert.deepEqual({...s},signature);if(verifyFailure)throw Error('invalid clearance signature');},
    async tree(){return structuredClone(fixture.trees[1]);},async withdrawal(){const proof=structuredClone(fixture.auth.withdrawal);if(successorN)proof.public_inputs[11]=field(22);return proof;}} as unknown as NoteProver;
  const rpc:TransportRpc={async signatureStatus(){return null;},async finalizedReceipt(sig){return receipts.get(sig)??null;},
    async finalizedBlockHeight(){return 50;},async sendRawTransaction(bytes){
      sends++;const tx=decodeTransaction(bytes),sig=transactionSignature(tx);
      const op=(await journal.read('note'))!.value.wallet!.operation!,attempt=op.attempts.find(a=>a.signature===sig)!;
      assert.ok(attempt);assert.equal(attempt.wireHex,Buffer.from(bytes).toString('hex'));assert.equal(transactionMessage(tx).version,0);
      assert.ok(!receipts.has(sig));if(attempt.kind==='execute')closed=true;
      receipts.set(sig,{signature:sig,message:new Uint8Array(tx.messageBytes),slot:101+receipts.size,err:null});return sig;
    }};
  const options:WalletOptions={manifest,journal,prover,rpc,wallets:[wallet],fetch:async(url,init)=>{
    calls.push(String(url));assert.equal(String(url),manifest.control_api_origin+'/zkapi/v1/withdraw/clearance');
    assert.equal(init?.redirect,'error');assert.deepEqual(JSON.parse(String(init?.body)),{nullifier:successorN?field(22):nullifier});
    const saved=(await journal.read('note'))!.value;assert.equal(saved.wallet!.clearance!.phase,'requested');
    if(!successorN)assert.deepEqual(saved.pending,original.pending);return clearanceReply(String(init?.body));
  },chain:{async snapshot():Promise<WalletSnapshot>{return {root:fixture.trees[1].public_inputs[closed?2:1],
    siblings:Array(32).fill(field(0)),slot:110,sequence:closed?'3':'2',nextNoteId:1,clock:String(fixture.now),paused:false,
    treasuryOwner:owner,note:{note_id:0,registration_commitment:'0x'+fixture.commitment,deposit_micro_usdc:String(fixture.deposit),
      expiry:String(fixture.expiry),status:closed?'closed':'active'}};},async buffer(){throw Error('buffer not used');},
    async blockhash(){return {blockhash:kitAddress(new Uint8Array(32).fill(7)),lastValidBlockHeight:200};}}};
  return {journal,open,original,control,options,client:new WalletClient(options),restart:()=>new WalletClient({...options,journal:open()}),
    roles:{uploader:owner,rentPayer:owner,feePayer:owner,payer:owner,tokenOwner:owner},owner,calls,receipts,
    counts:()=>({signs,sends}),reply:(f:typeof clearanceReply)=>{clearanceReply=f;},badSignature:()=>{verifyFailure=true;},
    settle:async(fail=false)=>new ControlClient({context,journal,now:()=>300n,verifier:{async prepare(){},async settle(){
      if(fail)throw Error('fixture invalid successor signature');return {...state,anchor:field(21),state_signature:signature};
    }},fetch:async(url)=>{calls.push(String(url));return Response.json(String(url).endsWith('/receipts')?{receipts:[],next_cursor:null}:
      {request_id:original.pending!.prepared.request.authorization.request_id,mode:'proxy',state:'SETTLED',cap_micro_usdc:'100',
        settlement:{charge_micro_usdc:'0',next_commitment:state.commitment,next_anchor:field(21),blind_delta_srv:field(12),next_state_signature:signature}});
    }}).recover('note'),
    failStorage:(v=true)=>{writesBeforeFailure=v?0:Infinity;},failStorageAfter:(writes:number)=>{writesBeforeFailure=writes;},
    corrupt:async(mutate:(r:NoteJournal)=>void)=>{const unchecked=new EncryptedJournal<NoteJournal>(store,aes,
      {deploymentId:manifest.deployment_id,pool:manifest.pool},(_v:unknown):asserts _v is NoteJournal=>{});
      const r=(await unchecked.read('note'))!;mutate(r.value);await unchecked.compareAndSwap('note',r.revision,r.value);}};
}

test('signed clearance archives exact lost AUTH in the same journal, then ordinary SDK mutual withdrawal closes',async t=>{
  const h=await setup(t);await h.client.reconcileUnacceptedAuthorization('note');
  const r=(await h.open().read('note'))!.value;
  assert.equal(r.pending,null);assert.deepEqual(r.wallet!.clearedAuthorization,{pending:h.original.pending,previous:h.original.state});
  assert.deepEqual(r.state,h.original.state);assert.deepEqual(r.witness,h.original.witness);assert.deepEqual(r.history,[]);
  assert.equal(r.wallet!.operation,undefined);assert.deepEqual(h.counts(),{signs:0,sends:0});assert.equal(h.calls.length,2);
  await assert.rejects(h.control.prepare('note',prepared(),field(1)),/permanent clearance/);
  const backup=await h.journal.exportBackup('note');await h.restart().reconcileUnacceptedAuthorization('note');
  assert.deepEqual(await h.journal.exportBackup('note'),backup);assert.equal(h.calls.length,2);
  await h.restart().beginWithdrawal('note','mutual_close',h.owner,h.roles);
  for(let i=0;i<20&&(await h.journal.read('note'))!.value.wallet!.operation;i++)await h.client.advance('note');
  const closed=(await h.open().read('note'))!.value;assert.equal(closed.wallet!.status,'closed');assert.equal(closed.wallet!.operation,undefined);
  assert.deepEqual(closed.wallet!.clearedAuthorization,r.wallet!.clearedAuthorization);assert.ok(h.receipts.size>=5);
  assert.deepEqual(h.counts(),{signs:h.receipts.size,sends:h.receipts.size});
  const end=await h.journal.exportBackup('note');await h.restart().reconcileUnacceptedAuthorization('note');
  assert.deepEqual(await h.journal.exportBackup('note'),end);assert.equal(h.calls.length,2);
});

test('accepted or racing AUTH makes authoritative clearance refuse; no AUTH or inference is replayed',async t=>{
  const h=await setup(t);h.reply(async()=>Response.json({error:{code:'nullifier_reserved'}},{status:409}));
  await assert.rejects(h.client.reconcileUnacceptedAuthorization('note'),/clearance unavailable/);
  const r=(await h.open().read('note'))!.value;assert.deepEqual(r.pending,h.original.pending);assert.deepEqual(r.state,h.original.state);
  assert.equal(r.wallet!.clearedAuthorization,undefined);assert.equal(r.wallet!.operation,undefined);
  assert.deepEqual(r.wallet!.clearance,{nullifier,phase:'requested'});assert.deepEqual(h.counts(),{signs:0,sends:0});
  await assert.rejects(h.restart().reconcileUnacceptedAuthorization('note'),/clearance unavailable/);
  assert.equal(h.calls.filter(v=>v.endsWith('/sessions')).length,1);
});

test('verified accepted-AUTH settlement retires only its refused clearance intent and permits successor withdrawal',async t=>{
  const h=await setup(t);h.reply(async()=>Response.json({error:{code:'nullifier_reserved'}},{status:409}));
  await assert.rejects(h.client.reconcileUnacceptedAuthorization('note'),/clearance unavailable/);
  await assert.rejects(h.settle(true),/invalid successor signature/);
  // Exact AUTH recovery persists send_unknown, but no unverified successor or intent deletion.
  const failed=(await h.open().read('note'))!.value;assert.deepEqual(failed.state,h.original.state);
  assert.deepEqual(failed.pending,h.original.pending);assert.deepEqual(failed.wallet!.clearance,{nullifier,phase:'requested'});
  await h.settle();const settled=(await h.open().read('note'))!.value;
  assert.equal(settled.pending,null);assert.equal(settled.wallet!.clearance,undefined);assert.equal(settled.wallet!.clearedAuthorization,undefined);
  assert.equal(settled.history.length,1);assert.deepEqual(settled.history[0].prepared,h.original.pending!.prepared);
  assert.equal(settled.state.anchor,field(21));h.reply(async body=>Response.json({nullifier:JSON.parse(body).nullifier,signature}));
  await h.restart().beginWithdrawal('note','mutual_close',h.owner,h.roles);
  assert.equal((await h.open().read('note'))!.value.wallet!.clearance!.nullifier,field(22));
  for(let i=0;i<20&&(await h.journal.read('note'))!.value.wallet!.operation;i++)await h.client.advance('note');
  assert.equal((await h.open().read('note'))!.value.wallet!.status,'closed');
});

test('a stored clearance signature cannot be discarded by a conflicting settlement even with malformed requested phase',async t=>{
  for(const phase of ['requested','verified'] as const)await t.test(phase,async sub=>{
    const h=await setup(sub);await h.corrupt(r=>{r.wallet!.clearance={nullifier,phase,signature};});
    await assert.rejects(h.settle(),/settlement conflicts with permanent clearance/);
    const r=(await h.open().read('note'))!.value;assert.deepEqual(r.state,h.original.state);
    assert.deepEqual(r.pending,h.original.pending);assert.deepEqual(r.wallet!.clearance,{nullifier,phase,signature});assert.deepEqual(r.history,[]);
  });
});

test('lost clearance ACK keeps exact AUTH and retries only the same N after encrypted-journal reopen',async t=>{
  const h=await setup(t);let count=0;h.reply(async()=>{if(count++===0)throw Error('fixture clearance ACK lost');return Response.json({nullifier,signature});});
  await assert.rejects(h.client.reconcileUnacceptedAuthorization('note'),/clearance ACK lost/);
  assert.deepEqual((await h.open().read('note'))!.value.pending,h.original.pending);
  await h.restart().reconcileUnacceptedAuthorization('note');assert.equal(count,2);
  assert.deepEqual((await h.open().read('note'))!.value.wallet!.clearedAuthorization!.pending,h.original.pending);
  assert.deepEqual(h.counts(),{signs:0,sends:0});assert.equal(h.calls.filter(v=>v.endsWith('/sessions')).length,1);
});

test('bad clearance signature, mismatched N and nonempty inference leave pending authorization intact',async t=>{
  const bad=await setup(t);bad.badSignature();await assert.rejects(bad.client.reconcileUnacceptedAuthorization('note'),/invalid clearance signature/);
  assert.deepEqual((await bad.open().read('note'))!.value.pending,bad.original.pending);
  const wrong=await setup(t);wrong.reply(async()=>Response.json({nullifier:field(17),signature}));
  await assert.rejects(wrong.client.reconcileUnacceptedAuthorization('note'),/clearance identity/);
  assert.deepEqual((await wrong.open().read('note'))!.value.pending,wrong.original.pending);
  assert.equal((await wrong.open().read('note'))!.value.wallet!.clearance!.phase,'requested');
  for(const [name,mutate] of [
    ['N',(r:NoteJournal)=>{r.pending!.prepared.request.public_inputs[8]=field(17);r.pending!.exactRequest=JSON.stringify(r.pending!.prepared.request);}],
    ['deployment',(r:NoteJournal)=>{r.pending!.prepared.request.authorization.pool=key(fixture.program_id);r.pending!.exactRequest=JSON.stringify(r.pending!.prepared.request);}],
    ['operation',(r:NoteJournal)=>{r.pending!.operations.push({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',path:'/v1/responses',anthropicVersion:'',bodyBase64:'e30=',phase:'send_unknown'});}],
    ['active',(r:NoteJournal)=>{r.pending!.phase='active';}],
  ] as const){await t.test(name,async sub=>{const h=await setup(sub);await h.corrupt(mutate);const before=await h.open().exportBackup('note');
    await assert.rejects(h.restart().reconcileUnacceptedAuthorization('note'));
    assert.deepEqual(await h.open().exportBackup('note'),before);assert.equal(h.calls.length,1);assert.deepEqual(h.counts(),{signs:0,sends:0});});}
});

test('a persistence failure after the server clearance cannot erase pending or bypass durable signature',async t=>{
  const h=await setup(t);h.reply(async()=>{h.failStorage();return Response.json({nullifier,signature});});
  await assert.rejects(h.client.reconcileUnacceptedAuthorization('note'),/storage unavailable/);
  assert.deepEqual((await h.open().read('note'))!.value.pending,h.original.pending);
  assert.equal((await h.open().read('note'))!.value.wallet!.clearance!.phase,'requested');
  h.failStorage(false);h.reply(async()=>Response.json({nullifier,signature}));await h.restart().reconcileUnacceptedAuthorization('note');
  assert.equal((await h.open().read('note'))!.value.pending,null);assert.deepEqual(h.counts(),{signs:0,sends:0});
});

test('crash between verified clearance persistence and archive commit resumes without another HTTP request',async t=>{
  const h=await setup(t);h.reply(async()=>{h.failStorageAfter(1);return Response.json({nullifier,signature});});
  await assert.rejects(h.client.reconcileUnacceptedAuthorization('note'),/storage unavailable/);
  const saved=(await h.open().read('note'))!.value;assert.deepEqual(saved.pending,h.original.pending);
  assert.equal(saved.wallet!.clearance!.phase,'verified');assert.equal(saved.wallet!.clearedAuthorization,undefined);
  h.failStorage(false);await h.restart().reconcileUnacceptedAuthorization('note');
  assert.equal(h.calls.length,2);assert.equal((await h.open().read('note'))!.value.pending,null);
});

test('archive corruption is rejected on actual encrypted journal reload',async t=>{
  const mutations:[string,(r:NoteJournal)=>void][]=[
    ['bytes',r=>{r.wallet!.clearedAuthorization!.pending.exactRequest+=' ';}],
    ['state',r=>{r.wallet!.clearedAuthorization!.previous.balance_micro_usdc='1';}],
    ['N',r=>{r.wallet!.clearance!.nullifier=field(19);}],
    ['phase',r=>{r.wallet!.clearedAuthorization!.pending.phase='active';}],
    ['missing signature',r=>{delete r.wallet!.clearance!.signature;}],
    ['missing fence',r=>{r.wallet!.clearance!.phase='requested';}],
    ['live pending',r=>{r.pending=structuredClone(r.wallet!.clearedAuthorization!.pending);}],
    ['unknown field',r=>{(r.wallet!.clearedAuthorization as unknown as Record<string,unknown>).extra=true;}],
  ];
  for(const [name,mutate] of mutations)await t.test(name,async sub=>{const h=await setup(sub);await h.client.reconcileUnacceptedAuthorization('note');
    await h.corrupt(mutate);await assert.rejects(h.open().read('note'));});
});

test('concurrent recovery clients archive once under the shared note lock',async t=>{
  const h=await setup(t);await Promise.all([h.client.reconcileUnacceptedAuthorization('note'),h.restart().reconcileUnacceptedAuthorization('note')]);
  assert.equal(h.calls.length,2);assert.deepEqual((await h.open().read('note'))!.value.wallet!.clearedAuthorization!.pending,h.original.pending);
});
