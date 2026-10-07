/** Same-journal emergency escape recovery with real encryption, ControlClient and v0
 * signing. HTTP, proofs and finalized chain receipts are explicit fixtures. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {Keypair, PublicKey, VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {ClientDaemon,DaemonConflict} from '../src/clientd-bridge.ts';
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
const key=(hex:string)=>new PublicKey(Buffer.from(hex,'hex')).toBase58();
const nullifier:string=fixture.auth.withdrawal.public_inputs[11];
const signature={r_x:field(9),r_y:field(10),s:field(11)};
const manifest={deployment_id:'wallet-clearance-fixture',program_id:key(fixture.program_id),pool:key(fixture.pool),
  mint:key(fixture.mint),note_ttl_seconds:String(fixture.ttl),control_api_origin:'https://control.invalid',
  inference_api_origin:'https://inference.invalid'} as VerifiedManifest;
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

async function setup(t:TestContext,unknownAuth=false){
  const directory=await mkdtemp(join(tmpdir(),'zkapi-emergency-escape-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await NativeJournalStore.open(directory),aes=await importJournalKey(new Uint8Array(32).fill(87));
  const open=()=>new EncryptedJournal<NoteJournal>(store,aes,{deploymentId:manifest.deployment_id,pool:manifest.pool},validateNoteJournal);
  const journal=open(),pair=Keypair.fromSeed(new Uint8Array(32).fill(1)),owner=pair.publicKey.toBase58();
  const state:PrivateState={balance_micro_usdc:String(fixture.deposit),balance_blinding:field(3),note_leaf:field(4),
    commitment:{x:field(5),y:field(6)},anchor:field(1),state_signature:null};
  await journal.create('note',{schema:1,state,witness:{secret:field(2),note_id:0,deposit_micro_usdc:String(fixture.deposit),
    expiry:String(fixture.expiry)},pending:null,history:[],wallet:{status:'active',history:[]}});
  const calls:{url:string;method:string}[]=[],receipts=new Map<string,FinalizedReceipt>();let sends=0,signs=0,settled=false,badSettlement=false;
  const operationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const verifier:SessionVerifier={async prepare(){},async settle(_c,s,_p,_settlement,_receipts,operations){
    assert.deepEqual(s,state);assert.deepEqual(operations,unknownAuth?[]:[operationId]);
    if(badSettlement)throw Error('fixture invalid successor signature');
    return {...state,anchor:field(21),state_signature:signature};
  }};
  const controlOptions={context,journal,verifier,now:()=>150n,fetch:async(url:URL|RequestInfo,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname,method=init?.method??'GET';calls.push({url:String(url),method});
    if(path==='/v1/responses')throw Error('fixture inference response lost');
    if(path.endsWith('/receipts'))return Response.json({receipts:[],next_cursor:null});
    if(path==='/zkapi/v1/sessions'&&unknownAuth)throw Error('fixture AUTH response lost');
    if(path.endsWith('/close')&&!settled)return new Response(null,{status:503});
    return Response.json({request_id:prepared().request.authorization.request_id,mode:'proxy',state:settled?'SETTLED':'ACTIVE',cap_micro_usdc:'100',
      ...(settled?{settlement:{charge_micro_usdc:'0',next_commitment:state.commitment,next_anchor:field(21),blind_delta_srv:field(12),next_state_signature:signature}}:{})});
  }};
  const control=()=>new ControlClient({...controlOptions,journal:open()});
  await control().prepare('note',prepared(),field(1));
  if(unknownAuth)await assert.rejects(control().submit('note'),/AUTH response lost/);
  else{
    await control().submit('note');await control().prepareOperation('note',operationId,'/v1/responses',new TextEncoder().encode('{"model":"fixture-model","input":"keep exact prompt"}'));
    await assert.rejects(control().sendOperation('note',operationId),/inference response lost/);
    await assert.rejects(control().close('note'),/503/);
  }
  const original=(await journal.read('note'))!.value;
  const wallet:V0Wallet={publicKey:pair.publicKey,supportedTransactionVersions:new Set([0]),async signTransaction(tx){signs++;tx.sign([pair]);return tx;}};
  const snapshot:WalletSnapshot={root:fixture.trees[1].public_inputs[1],siblings:Array(32).fill(field(0)),slot:110,sequence:'2',nextNoteId:1,clock:String(fixture.now),paused:false,
    treasuryOwner:owner,note:{note_id:0,registration_commitment:'0x'+fixture.commitment,deposit_micro_usdc:String(fixture.deposit),expiry:String(fixture.expiry),status:'active'}};
  let minimumSlot=0,challengeBeforeObservation=false,hideReceipt=false;
  const challenge=()=>{snapshot.note!.status='active';delete snapshot.pending;snapshot.sequence='4';snapshot.slot=160;};
  const rpc:TransportRpc={async signatureStatus(){return null;},async finalizedReceipt(sig){return hideReceipt?null:receipts.get(sig)??null;},
    async finalizedBlockHeight(){return 50;},async sendRawTransaction(bytes){
      sends++;const tx=VersionedTransaction.deserialize(bytes),sig=bs58.encode(tx.signatures[0]);
      const op=(await journal.read('note'))!.value.wallet!.operation!,attempt=op.attempts.find(a=>a.signature===sig)!;
      assert.ok(attempt);assert.equal(attempt.wireHex,Buffer.from(bytes).toString('hex'));assert.ok(!receipts.has(sig),'no financial replay after receipt');
      if(attempt.kind==='execute'){
        snapshot.note!.status='pending_escape';snapshot.sequence='3';snapshot.slot=140;
        snapshot.pending={nullifier,balance_micro_usdc:state.balance_micro_usdc,destinationOwner:owner,deadline:String(fixture.now+60)};
        if(challengeBeforeObservation)challenge();
      }
      if(attempt.kind==='finalize'){snapshot.note!.status='closed';delete snapshot.pending;snapshot.slot=170;snapshot.sequence='4';}
      receipts.set(sig,{signature:sig,message:tx.message.serialize(),slot:120+receipts.size,err:null});return sig;
    }};
  const prover={async inspect(_w:unknown,s:PrivateState){return {nullifier:s.anchor===field(21)?field(22):nullifier,registration_commitment:'0x'+fixture.commitment};},
    async tree(){return structuredClone(fixture.trees[1]);},async withdrawal(_w:unknown,s:PrivateState,_root:unknown,_path:unknown,_owner:unknown,clearance:unknown){
      assert.deepEqual(s,state);assert.equal(clearance,null);return structuredClone(fixture.auth.escape);
    }} as unknown as NoteProver;
  const options:WalletOptions={manifest,journal,prover,rpc,wallets:[wallet],fetch:async()=>{throw Error('emergency escape must not call operator');},
    chain:{async snapshot(_id,_path,min=0){minimumSlot=min;return structuredClone(snapshot);},async buffer(){throw Error('not used');},
      async blockhash(){return {blockhash:new PublicKey(new Uint8Array(32).fill(7)).toBase58(),lastValidBlockHeight:200};}}};
  const restart=()=>new WalletClient({...options,journal:open()});
  const drive=async()=>{for(let i=0;i<20;i++){if(!(await journal.read('note'))!.value.wallet!.operation)return;await restart().advance('note');}throw Error('fixture did not finish');};
  return {journal,open,control,original,restart,drive,roles:{uploader:owner,rentPayer:owner,feePayer:owner,payer:owner,tokenOwner:owner},owner,calls,receipts,snapshot,
    operationId,challenge,minimum:()=>minimumSlot,settle:(bad=false)=>{settled=true;badSettlement=bad;},hide:(v:boolean)=>{hideReceipt=v;},earlyChallenge:()=>{challengeBeforeObservation=true;},counts:()=>({sends,signs}),
    corrupt:async(mutate:(n:NoteJournal)=>void)=>{const raw=new EncryptedJournal<NoteJournal>(store,aes,{deploymentId:manifest.deployment_id,pool:manifest.pool},(_v:unknown):asserts _v is NoteJournal=>{});
      const r=(await raw.read('note'))!;mutate(r.value);await raw.compareAndSwap('note',r.revision,r.value);}};
}

test('accepted AUTH plus lost inference and close 503 escapes in the same encrypted journal, then finalizes only after deadline',async t=>{
  const h=await setup(t),beforeCalls=h.calls.length;
  assert.equal(h.original.pending!.phase,'closing');assert.equal(h.original.pending!.operations[0].phase,'send_unknown');
  await assert.rejects(h.restart().beginWithdrawal('note','initiate_escape',h.owner,h.roles),/unavailable/);
  await h.restart().beginEmergencyEscape('note',h.owner,h.roles);
  let r=(await h.open().read('note'))!.value;
  assert.equal(r.pending,null);assert.deepEqual(r.state,h.original.state);
  assert.deepEqual(r.wallet!.emergencyEscapes![0].pending,h.original.pending);assert.deepEqual(r.wallet!.emergencyEscapes![0].previous,h.original.state);
  let preparations=0;
  const daemon=new ClientDaemon({client:h.control(),journal:h.open(),noteId:'note',mode:'proxy',models:['fixture-model'],
    now:()=>150n,prepare:async()=>{preparations++;throw Error('emergency must fence before quote/proof');}});
  await daemon.start();const daemonStatus=await daemon.status() as {recovery_required:boolean;wallet_emergency_escape:{phase:string}};
  assert.equal(daemonStatus.recovery_required,true);assert.deepEqual(daemonStatus.wallet_emergency_escape,{phase:'escaping',funds_withdrawn:false});
  await assert.rejects(daemon.infer('/v1/responses',new TextEncoder().encode('{"model":"fixture-model","input":"new"}')),DaemonConflict);
  assert.equal(preparations,0);assert.equal(h.calls.length,beforeCalls);
  await assert.rejects(h.control().prepare('note',prepared(),field(1)),/financial operation/);
  await assert.rejects(h.control().sendOperation('note',h.operationId),/fences inference/);
  await assert.rejects(h.control().submit('note'),/no pending/);await assert.rejects(h.control().close('note'),/no pending/);
  await h.drive();assert.equal((await h.open().read('note'))!.value.wallet!.status,'pending_escape');
  await assert.rejects(h.restart().beginFinalize('note',h.roles),/challenge period/);
  await assert.rejects(h.restart().reconcileChallengedEscape('note'),/restoration not established/);
  h.snapshot.clock=h.snapshot.pending!.deadline;await h.restart().beginFinalize('note',h.roles);
  await assert.rejects(h.restart().reconcileChallengedEscape('note'),/restoration not established/);
  await h.drive();r=(await h.open().read('note'))!.value;
  assert.equal(r.wallet!.status,'closed');assert.deepEqual(r.state,h.original.state);assert.equal(r.history.length,0);
  const closedStatus=await daemon.status() as {recovery_required:boolean;phase:string;wallet_emergency_escape:{phase:string;funds_withdrawn:boolean}};
  assert.equal(closedStatus.recovery_required,false);assert.equal(closedStatus.phase,'closed');assert.equal(closedStatus.wallet_emergency_escape.funds_withdrawn,true);
  assert.deepEqual(r.wallet!.emergencyEscapes![0].pending,h.original.pending);assert.equal(h.calls.length,beforeCalls);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/v1/responses')).length,1);assert.deepEqual(h.counts(),{sends:h.receipts.size,signs:h.receipts.size});
});

test('a new emergency archive omits a legacy direct key while preserving exact financial and inference evidence',async t=>{
  const h=await setup(t);
  await h.corrupt(value=>{
    const p=value.pending!;
    p.prepared.request.authorization.mode='direct_openrouter';p.prepared.request.authorization.proxy_secret_hash=null;
    p.prepared.request.quote.body.mode='direct_openrouter';p.prepared.request.quote.body.provider='openrouter';
    p.prepared.proxy_token=null;p.exactRequest=JSON.stringify(p.prepared.request);p.providerKey='legacy-key-must-not-be-copied';
  });
  const before=(await h.open().read('note'))!.value;
  await h.restart().beginEmergencyEscape('note',h.owner,h.roles);
  const after=(await h.open().read('note'))!.value,archived=after.wallet!.emergencyEscapes![0].pending;
  const expected=structuredClone(before.pending!);delete expected.providerKey;
  assert.deepEqual(archived,expected);assert.deepEqual(after.state,before.state);
  assert.equal(JSON.stringify(after).includes('legacy-key-must-not-be-copied'),false);
  // Existing historical archives are not destructively migrated when reopened.
  await h.corrupt(value=>{value.wallet!.emergencyEscapes![0].pending.providerKey='historical-archive-key';});
  const historical=(await h.open().read('note'))!;
  await assert.rejects(h.control().sendDirectOperation('note',crypto.randomUUID(),'/v1/chat/completions',new TextEncoder().encode('{}')),/fences inference/);
  assert.deepEqual((await h.open().read('note'))!.head,historical.head);
  assert.equal((await h.open().read('note'))!.value.wallet!.emergencyEscapes![0].pending.providerKey,'historical-archive-key');
});

test('finalized challenge restores only close/status recovery and a verified successor; no AUTH or inference replay',async t=>{
  const h=await setup(t);await h.restart().beginEmergencyEscape('note',h.owner,h.roles);await h.drive();
  const archived=(await h.open().read('note'))!.value.wallet!.emergencyEscapes![0];
  h.challenge();h.hide(true);await assert.rejects(h.restart().reconcileChallengedEscape('note'),/not finalized/);h.hide(false);
  h.snapshot.sequence=archived.escape!.sequence;await assert.rejects(h.restart().reconcileChallengedEscape('note'),/restoration not established/);h.snapshot.sequence='4';
  h.snapshot.slot=archived.escape!.slot-1;await assert.rejects(h.restart().reconcileChallengedEscape('note'),/restoration not established/);h.snapshot.slot=160;
  await h.restart().reconcileChallengedEscape('note');let r=(await h.open().read('note'))!.value;
  assert.equal(h.minimum(),archived.escape!.slot);assert.equal(r.wallet!.status,'active');assert.equal(r.pending!.phase,'closing');
  assert.deepEqual(r.wallet!.emergencyEscapes![0].pending,h.original.pending);
  await assert.rejects(h.control().submit('note'),/forbids authorization replay/);
  await assert.rejects(h.control().sendOperation('note',h.operationId),/fences inference/);
  await assert.rejects(h.control().sendDirectOperation('note',crypto.randomUUID(),'/v1/responses',new TextEncoder().encode('{}')),/fences inference/);
  await assert.rejects(h.restart().beginEmergencyEscape('note',h.owner,h.roles),/unresolved authorization/);
  h.settle(true);await assert.rejects(h.control().recover('note'),/invalid successor signature/);
  assert.deepEqual((await h.open().read('note'))!.value.state,h.original.state);
  h.settle();await h.control().recover('note');r=(await h.open().read('note'))!.value;
  assert.equal(r.pending,null);assert.equal(r.state.anchor,field(21));assert.equal(r.history.length,1);assert.equal(r.wallet!.emergencyEscapes![0].phase,'settled');
  assert.deepEqual(r.wallet!.emergencyEscapes![0].pending,h.original.pending);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/sessions')&&c.method==='POST').length,1);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/v1/responses')).length,1);
});

test('challenge before escape execute ACK reconciles exact receipt without another financial send',async t=>{
  const h=await setup(t);h.earlyChallenge();await h.restart().beginEmergencyEscape('note',h.owner,h.roles);
  await assert.rejects(h.drive(),/financial account state mismatch/);const sends=h.counts().sends;
  assert.ok((await h.open().read('note'))!.value.wallet!.operation!.current);
  await h.restart().reconcileChallengedEscape('note');const r=(await h.open().read('note'))!.value;
  assert.equal(r.wallet!.operation,undefined);assert.equal(r.wallet!.emergencyEscapes![0].phase,'challenged');assert.equal(h.counts().sends,sends);
});

test('unacknowledged AUTH escape recovery never repeats AUTH even if original saved phase is send_unknown',async t=>{
  const h=await setup(t,true);await h.restart().beginEmergencyEscape('note',h.owner,h.roles);await h.drive();h.challenge();
  await h.restart().reconcileChallengedEscape('note');h.settle();await h.control().recover('note');
  assert.equal((await h.open().read('note'))!.value.wallet!.emergencyEscapes![0].pending.phase,'send_unknown');
  assert.equal(h.calls.filter(c=>c.url.endsWith('/sessions')&&c.method==='POST').length,1);
  assert.equal(h.calls.filter(c=>c.url.endsWith('/v1/responses')).length,0);
});

test('emergency archive rejects fabricated phase, missing exact receipt, modified state/request/operations and unsafe active reuse',async t=>{
  const mutations:[string,(n:NoteJournal)=>void][]=[
    ['duplicate archive',(n)=>{n.wallet!.emergencyEscapes!.push(structuredClone(n.wallet!.emergencyEscapes![0]));}],
    ['phase',(n)=>{n.wallet!.emergencyEscapes![0].phase='challenged';}],
    ['previous',(n)=>{n.wallet!.emergencyEscapes![0].previous.anchor=field(88);}],
    ['request',(n)=>{n.wallet!.emergencyEscapes![0].pending.exactRequest='{}';}],
    ['nullifier',(n)=>{n.wallet!.emergencyEscapes![0].nullifier=field(88);}],
    ['operation identity',(n)=>{n.wallet!.emergencyEscapes![0].operationId=crypto.randomUUID();}],
    ['active reuse',(n)=>{n.wallet!.status='active';delete n.wallet!.operation;}],
    ['receipt',(n)=>{n.wallet!.emergencyEscapes![0].escape={signature:'fabricated',slot:1,sequence:'3'};}],
    ['extra fields',(n)=>{Object.assign(n.wallet!.emergencyEscapes![0],{cleared:true});}],
  ];
  for(const [name,change] of mutations)await t.test(name,async sub=>{const h=await setup(sub);await h.restart().beginEmergencyEscape('note',h.owner,h.roles);
    await h.corrupt(change);await assert.rejects(h.open().read('note'));await assert.rejects(h.restart().advance('note'));});
  const h=await setup(t);await h.restart().beginEmergencyEscape('note',h.owner,h.roles);await h.drive();h.challenge();await h.restart().reconcileChallengedEscape('note');
  await h.corrupt(n=>{n.pending!.operations[0].bodyBase64=Buffer.from('{"changed":true}').toString('base64');});
  await assert.rejects(h.open().read('note'),/journal integrity failure/);
});

 test('completed emergency recovery rejects duplicated settlement history or a fabricated settled archive',async t=>{
  const h=await setup(t);await h.restart().beginEmergencyEscape('note',h.owner,h.roles);await h.drive();h.challenge();
  await h.restart().reconcileChallengedEscape('note');
  const prior=(await h.open().read('note'))!.value;
  const fabricated=structuredClone(prior);fabricated.wallet!.emergencyEscapes![0].phase='settled';fabricated.pending=null;
  assert.throws(()=>validateNoteJournal(fabricated),/settlement missing/);
  h.settle();await h.control().recover('note');
  const settled=(await h.open().read('note'))!.value;validateNoteJournal(settled);
  settled.history.push(structuredClone(settled.history[0]));assert.throws(()=>validateNoteJournal(settled),/duplicated/);
});

 test('challenge reconciliation cancels only unsigned or conclusively rejected finalization attempts, retaining every signed byte',async t=>{
  for(const outcome of ['unsigned','unknown','successful','rejected'] as const)await t.test(outcome,async sub=>{
    const h=await setup(sub);await h.restart().beginEmergencyEscape('note',h.owner,h.roles);await h.drive();
    h.snapshot.clock=h.snapshot.pending!.deadline;await h.restart().beginFinalize('note',h.roles);
    if(outcome!=='unsigned')await h.restart().advance('note');
    const before=(await h.open().read('note'))!.value.wallet!.operation!;h.challenge();
    if(outcome==='unknown')h.hide(true);
    if(outcome==='rejected')for(const a of before.attempts)h.receipts.get(a.signature)!.err={InstructionError:[1,{Custom:6011}]};
    if(outcome==='unknown'||outcome==='successful'){
      const bytes=await h.open().exportBackup('note');
      await assert.rejects(h.restart().reconcileChallengedEscape('note'),/finalized rejected/);
      assert.deepEqual(await h.open().exportBackup('note'),bytes);return;
    }
    const sends=h.counts().sends;await h.restart().reconcileChallengedEscape('note');
    const after=(await h.open().read('note'))!.value;
    assert.equal(after.wallet!.operation,undefined);assert.equal(after.wallet!.emergencyEscapes![0].phase,'challenged');
    const cancelled=after.wallet!.history.find(o=>o.id===before.id)!;assert.equal(cancelled.phase,'cancelled');
    assert.deepEqual(cancelled.attempts,before.attempts);assert.equal(h.counts().sends,sends);
  });
});
