import {createSolanaRpcWithFetch} from '../src/solana.ts';
import {transactionSignature} from '../src/solana.ts';
import {kitAddress, fixtureSigner, signWith, decodeTransaction} from './kit-helpers.ts';
/** Offline expired-create reconciliation. Synthetic proof/RPC responses and
 * local signatures do not establish public chain or Phantom acceptance. */
/** Offline expired-create reconciliation. Synthetic proof/RPC responses and
 * local signatures do not establish public chain or Phantom acceptance. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import bs58 from 'bs58';
import {WalletClient,type WalletOptions} from '../src/wallet.ts';
import {EncryptedJournal,importJournalKey} from '../src/journal.ts';
import {NativeJournalStore} from '../src/journal-node.ts';
import {validateNoteJournal,type NoteJournal,type PrivateState} from '../src/control.ts';
import {restorePlan,prepareAttempt,closePayload,fetchFinalizedBufferObservation,type Attempt,type FinalizedBufferObservation,type FinalizedReceipt,type SignatureStatus,type V0Wallet} from '../src/transport.ts';
import type {NoteProver} from '../src/prover.ts';
import type {VerifiedManifest} from '../src/trust.ts';
import type {WalletSnapshot} from '../src/wallet-chain.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../tests/fixtures/vault/genesis-a.json',import.meta.url),'utf8'));
const key=(value:string)=>kitAddress(Buffer.from(value,'hex'));
const field=(value:number)=>'0x'+value.toString(16).padStart(64,'0');
const hash=(value:number)=>kitAddress(new Uint8Array(32).fill(value));

async function setup(t:TestContext,kind:'deposit'|'mutual_close'|'initiate_escape'|'emergency_escape'='deposit'){
  const directory=await mkdtemp(join(tmpdir(),'zkapi-create-expiry-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await NativeJournalStore.open(directory),aes=await importJournalKey(new Uint8Array(32).fill(15));
  const open=()=>new EncryptedJournal<NoteJournal>(store,aes,{deploymentId:'fixture',pool:key(fixture.pool)},validateNoteJournal);
  const journal=open(),pair=(await fixtureSigner(new Uint8Array(32).fill(1))),owner=pair.address;
  const state:PrivateState={balance_micro_usdc:String(kind==='deposit'?fixture.deposit:fixture.balance),balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(1),state_signature:null};
  const witness={secret:field(2),note_id:0,deposit_micro_usdc:String(fixture.deposit),expiry:String(fixture.expiry)};
  const nullifier=fixture.auth.withdrawal.public_inputs[11],clearance={nullifier,phase:'verified' as const,signature:{r_x:field(9),r_y:field(10),s:field(11)}};
  const manifest={deployment_id:'fixture',control_api_origin:'https://control.invalid',inference_api_origin:'https://inference.invalid',program_id:key(fixture.program_id),pool:key(fixture.pool),mint:key(fixture.mint),note_ttl_seconds:String(fixture.ttl)} as unknown as VerifiedManifest;
  const snapshot:WalletSnapshot={root:fixture.trees[0].public_inputs[1],siblings:Array(32).fill(field(0)),slot:20,sequence:'1',nextNoteId:kind==='deposit'?0:1,clock:String(fixture.now),paused:false,treasuryOwner:owner,
    ...(kind!=='deposit'?{note:{note_id:0,registration_commitment:'0x'+fixture.commitment,deposit_micro_usdc:witness.deposit_micro_usdc,expiry:witness.expiry,status:'active' as const}}:{})};
  const behavior={height:101,status:null as SignatureStatus|null,receipt:null as FinalizedReceipt|null,failHistory:false,failProof:false,failClearance:false,hash:hash(7),lastValid:100,observationSlot:120,observationHeight:110};
  const counts={signatures:0,sends:0,history:0,proofs:0,rebase:0,clearanceChecks:0};
  const observed:string[]=[],minimums:number[]=[];
  let inspect:(value:FinalizedBufferObservation)=>FinalizedBufferObservation=output=>output;
  const prover={deposit:async(note_id:number,amount:string,expiry:string)=>({state:structuredClone(state),witness:{secret:field(2),note_id,deposit_micro_usdc:amount,expiry}}),
    rebaseDeposit:async(witness:NonNullable<NoteJournal['witness']>,note_id:number,expiry:string)=>{counts.rebase++;return {state:structuredClone(state),witness:{...witness,note_id,expiry}};},
    inspect:async(_w:unknown,s:PrivateState)=>({registration_commitment:'0x'+fixture.commitment,nullifier:s.anchor===state.anchor?nullifier:field(123)}),
    verifyClearance:async(value:string)=>{counts.clearanceChecks++;assert.equal(value,nullifier);if(behavior.failClearance)throw Error('synthetic invalid clearance');},
    withdrawal:async()=>structuredClone(fixture.auth[kind==='mutual_close'?'withdrawal':'escape']),
    tree:async(note:{note_id:number})=>{counts.proofs++;if(counts.proofs>1){const op=(await open().read('note'))!.value.wallet!.operation!;assert.equal(op.phase,'proving');assert.equal(op.current,undefined);assert.equal(op.plan,undefined);assert.ok(op.expiredCreations!.length>0,'anchored absence is durable before proving');assert.ok(op.attempts.length>0,'old signed bytes remain durable before proving');}if(behavior.failProof)throw Error('synthetic proof interrupted');const proof=structuredClone(fixture.trees[kind==='deposit'?0:1]);proof.public_inputs[3]=field(note.note_id);return proof;}} as unknown as NoteProver;
  const wallet:V0Wallet={publicKey:pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(tx){counts.signatures++;tx = await signWith(tx, [pair]);return tx;}};
  const options:WalletOptions={manifest,prover,journal,wallets:[wallet],priorityFeeMicroLamports:1n,
    chain:{snapshot:async(id,path,minimum=0)=>{if(kind!=='deposit'){assert.equal(id,witness.note_id);assert.equal(path,'active');}minimums.push(minimum);return structuredClone(snapshot);},buffer:async()=>null,
      blockhash:async()=>({blockhash:behavior.hash,lastValidBlockHeight:behavior.lastValid}),
      bufferObservation:async(plan,minimum)=>{assert.ok((minimum??0)>=plan.snapshot.slot);observed.push(plan.buffer);return inspect({address:plan.buffer,account:null,slot:behavior.observationSlot,blockHeight:behavior.observationHeight,blockhash:hash(9),commitment:'finalized'});}},
    rpc:{signatureStatus:async()=>{counts.history++;if(behavior.failHistory)throw Error('unavailable');return behavior.status;},finalizedReceipt:async()=>behavior.receipt,finalizedBlockHeight:async()=>behavior.height,
      sendRawTransaction:async bytes=>{counts.sends++;const op=(await open().read('note'))!.value.wallet!.operation!;assert.equal(op.attempts.at(-1)!.wireHex,Buffer.from(bytes).toString('hex'),'persist signed replacement before sending');return transactionSignature(decodeTransaction(bytes));}}};
  const client=new WalletClient(options),restart=()=>new WalletClient({...options,journal:open()});
  const roles={uploader:owner,rentPayer:owner,feePayer:owner,payer:owner,tokenOwner:owner};
  if(kind==='deposit')await client.beginDeposit('note',String(fixture.deposit),roles);
  else{
    const request={authorization:{version:'1',request_id:crypto.randomUUID(),deployment_id:'fixture',pool:manifest.pool,mode:'proxy'},
      quote:{body:{deployment_id:'fixture',pool:manifest.pool,mode:'proxy',control_api_origin:manifest.control_api_origin,inference_api_origin:manifest.inference_api_origin}},
      public_inputs:Array.from({length:12},(_,i)=>i===8?nullifier:field(1))};
    const pending=kind==='emergency_escape'?{phase:'closing',prepared:{request,control_token:'zkc1.fixture',proxy_token:'zkp1.fixture'},
      exactRequest:JSON.stringify(request),operations:[{id:crypto.randomUUID(),path:'/v1/responses',anthropicVersion:'',bodyBase64:'e30=',phase:'send_unknown'}]} as unknown as NoteJournal['pending']:null;
    await journal.create('note',{schema:1,state,witness,pending,history:[],wallet:{status:'active',history:[],...(kind==='mutual_close'?{clearance}:{})}});
    if(kind==='emergency_escape')await client.beginEmergencyEscape('note',key(fixture.destination_owner),roles);
    else await client.beginWithdrawal('note',kind,key(fixture.destination_owner),roles);
  }
  await assert.rejects(client.advance('note'),/missing buffer: finalized history reconciliation required/);
  snapshot.slot=120;snapshot.clock=String(fixture.now+4000);
  return {client,restart,options,journal,open,pair,wallet,behavior,snapshot,counts,observed,minimums,setObservation:(fn:typeof inspect)=>{inspect=fn;}};
}

test('explicit expired-create recovery archives exact attempt and anchored absence before fresh proof/expiry',async t=>{
  const h=await setup(t),before=(await h.journal.read('note'))!,old=before.value.wallet!.operation!,attempt=old.attempts[0] as Attempt;
  const counts={...h.counts};await h.restart().reconcileExpiredCreation('note');
  const after=(await h.open().read('note'))!,op=after.value.wallet!.operation!;
  assert.equal(op.id,old.id);assert.equal(op.phase,'ready');assert.equal(op.step,0);assert.equal(op.current,undefined);
  assert.deepEqual(op.attempts,old.attempts);assert.deepEqual(op.roles,old.roles);assert.deepEqual(after.value.history,before.value.history);
  assert.equal(after.value.witness!.secret,before.value.witness!.secret);assert.equal(after.value.witness!.deposit_micro_usdc,before.value.witness!.deposit_micro_usdc);
  assert.equal(after.value.state.balance_micro_usdc,before.value.state.balance_micro_usdc);
  assert.equal(op.plan!.expires,String(fixture.now+7600));assert.notEqual(op.plan!.nonceHex,attempt.plan.nonceHex);
  assert.deepEqual(op.expiredCreations,[{signature:attempt.signature,buffer:attempt.buffer,slot:120,blockHeight:110,blockhash:hash(9)}]);
  assert.equal(h.minimums.at(-1),120);assert.equal(h.counts.signatures,counts.signatures);assert.equal(h.counts.sends,counts.sends);
  h.behavior.hash=hash(8);h.behavior.lastValid=200;h.behavior.height=150;
  assert.deepEqual(await h.restart().advance('note'),{state:'pending'});
  const signed=(await h.open().read('note'))!.value.wallet!.operation!;
  assert.deepEqual(signed.attempts[0],attempt);assert.equal(signed.attempts.length,2);assert.equal(signed.current,signed.attempts[1].signature);assert.equal(h.counts.sends,1);
});

test('a failed rebuild leaves durable proof recovery with old signed bytes and absence evidence intact',async t=>{
  const h=await setup(t),before=(await h.journal.read('note'))!;h.behavior.failProof=true;
  await assert.rejects(h.client.reconcileExpiredCreation('note'),/synthetic proof interrupted/);
  const stopped=(await h.open().read('note'))!,op=stopped.value.wallet!.operation!;
  assert.equal(op.phase,'proving');assert.equal(op.current,undefined);assert.equal(op.plan,undefined);assert.equal(op.expiredCreations!.length,1);
  assert.deepEqual(op.attempts,before.value.wallet!.operation!.attempts);assert.equal(h.counts.signatures,1);assert.equal(h.counts.sends,0);
  h.behavior.failProof=false;h.snapshot.slot=119;await assert.rejects(h.restart().resumeProof('note'),/stale creation recovery snapshot/);
  assert.equal(h.minimums.at(-1),120);assert.deepEqual(await h.open().read('note'),stopped,'a stale restart snapshot cannot weaken the durable cutoff');
  h.snapshot.slot=120;await h.restart().resumeProof('note');assert.equal((await h.open().read('note'))!.value.wallet!.operation!.phase,'ready');
});

test('mutual-close create recovery preserves the cleared financial state and exact old signature without sending',async t=>{
  const h=await setup(t,'mutual_close'),before=(await h.journal.read('note'))!,old=before.value.wallet!.operation!,attempt=old.attempts[0] as Attempt;
  const counts={...h.counts};await h.restart().reconcileExpiredCreation('note');
  const after=(await h.open().read('note'))!,op=after.value.wallet!.operation!;
  assert.equal(op.kind,'mutual_close');assert.equal(op.id,old.id);assert.equal(op.phase,'ready');assert.equal(op.step,0);assert.equal(op.current,undefined);
  assert.deepEqual(after.value.state,before.value.state);assert.deepEqual(after.value.witness,before.value.witness);
  assert.deepEqual(after.value.history,before.value.history);assert.deepEqual(after.value.wallet!.clearance,before.value.wallet!.clearance);
  assert.deepEqual(op.roles,old.roles);assert.equal(op.destinationOwner,old.destinationOwner);assert.deepEqual(op.attempts,old.attempts);
  assert.notEqual(op.plan!.nonceHex,attempt.plan.nonceHex);assert.equal(op.plan!.operation,'mutual_close');assert.equal(op.plan!.expires,String(fixture.now+7600));
  assert.equal(op.plan!.financial.destinationOwner,attempt.plan.financial.destinationOwner);
  assert.deepEqual(op.expiredCreations,[{signature:attempt.signature,buffer:attempt.buffer,slot:120,blockHeight:110,blockhash:hash(9)}]);
  assert.equal(h.minimums.at(-1),120);assert.equal(h.counts.rebase,0);assert.ok(h.counts.clearanceChecks>counts.clearanceChecks);
  assert.equal(h.counts.signatures,counts.signatures);assert.equal(h.counts.sends,counts.sends);
  h.behavior.hash=hash(8);h.behavior.lastValid=200;h.behavior.height=150;
  assert.deepEqual(await h.restart().advance('note'),{state:'pending'});
  const signed=(await h.open().read('note'))!.value.wallet!.operation!;
  assert.deepEqual(signed.attempts[0],attempt);assert.equal(signed.attempts.length,2);assert.equal(h.counts.sends,1);
});

test('mutual-close recovery requires verified same-state clearance and an active unchanged note before writing',async t=>{
  const h=await setup(t,'mutual_close'),base=(await h.journal.read('note'))!.value;
  const plan=await restorePlan(base.wallet!.operation!.plan!);
  const advanced=await Promise.all([...plan.steps.filter(s=>['append','seal','execute'].includes(s.kind)),await closePayload(plan)]
    .map(step=>prepareAttempt(plan,step,{blockhash:hash(7),lastValidBlockHeight:100},[h.wallet],{save:async()=>{}})));
  const cases:[string,(value:NoteJournal)=>void][]=[
    ['missing-clearance',v=>{delete v.wallet!.clearance;}],['unverified-clearance',v=>{v.wallet!.clearance!.phase='requested';}],
    ['unsigned-clearance',v=>{delete v.wallet!.clearance!.signature;}],['other-nullifier',v=>{v.wallet!.clearance!.nullifier=field(123);}],
    ['closed-wallet',v=>{v.wallet!.status='closed';}],['escape',v=>{v.wallet!.operation!.kind='initiate_escape';}],
    ['missing-destination',v=>{delete v.wallet!.operation!.destinationOwner;}],['advanced',v=>{v.wallet!.operation!.step=1;}],
    ['finalized',v=>{v.wallet!.operation!.finalized.push({signature:v.wallet!.operation!.current!,slot:90});}],
    ...advanced.map((attempt,index)=>[attempt.kind+index,(v:NoteJournal)=>{v.wallet!.operation!.attempts.unshift(attempt);}] as [string,(value:NoteJournal)=>void]),
    ['other-plan',v=>{v.wallet!.operation!.plan!.expires='1';}],
    ['bad-signed-wire',v=>{const a=v.wallet!.operation!.attempts[0];a.wireHex=a.wireHex.slice(0,4)+(a.wireHex.slice(4,6)==='00'?'01':'00')+a.wireHex.slice(6);}],
    ['pending',v=>{const request={authorization:{request_id:crypto.randomUUID()}};v.pending={phase:'prepared',prepared:{request,control_token:'fixture',proxy_token:null},exactRequest:JSON.stringify(request),operations:[]} as unknown as NoteJournal['pending'];}],
  ];
  for(const [name,change] of cases){const value=structuredClone(base);change(value);await h.journal.create(name,value);const before=await h.journal.read(name);await assert.rejects(h.client.reconcileExpiredCreation(name),name);assert.deepEqual(await h.journal.read(name),before,name);}
  const before=await h.journal.read('note');h.behavior.failClearance=true;
  await assert.rejects(h.client.reconcileExpiredCreation('note'),/invalid clearance/);assert.deepEqual(await h.journal.read('note'),before);
  h.behavior.failClearance=false;
  const note=structuredClone(h.snapshot.note!);
  for(const fault of ['closed-note','changed-note','pending-note','stale-snapshot']){
    h.snapshot.note=structuredClone(note);h.snapshot.slot=120;delete h.snapshot.pending;
    if(fault==='closed-note')h.snapshot.note.status='closed';
    if(fault==='changed-note')h.snapshot.note.registration_commitment=field(123);
    if(fault==='pending-note')h.snapshot.pending={nullifier:field(1),balance_micro_usdc:'0',destinationOwner:base.wallet!.operation!.destinationOwner!,deadline:'1'};
    if(fault==='stale-snapshot')h.snapshot.slot=119;
    await assert.rejects(h.client.reconcileExpiredCreation('note'),fault);assert.deepEqual(await h.journal.read('note'),before,fault);
  }
  assert.equal(h.counts.sends,0);
});

test('interrupted mutual-close rebuild resumes with the same clearance and durable finalized cutoff',async t=>{
  const h=await setup(t,'mutual_close'),before=(await h.journal.read('note'))!;h.behavior.failProof=true;
  await assert.rejects(h.client.reconcileExpiredCreation('note'),/synthetic proof interrupted/);
  const stopped=(await h.open().read('note'))!,op=stopped.value.wallet!.operation!;
  assert.equal(op.phase,'proving');assert.equal(op.current,undefined);assert.equal(op.plan,undefined);assert.equal(op.expiredCreations!.length,1);
  assert.deepEqual(stopped.value.state,before.value.state);assert.deepEqual(stopped.value.witness,before.value.witness);
  assert.deepEqual(stopped.value.wallet!.clearance,before.value.wallet!.clearance);assert.deepEqual(op.attempts,before.value.wallet!.operation!.attempts);
  h.behavior.failProof=false;h.behavior.failClearance=true;
  await assert.rejects(h.restart().resumeProof('note'),/invalid clearance/);assert.deepEqual(await h.open().read('note'),stopped);
  h.behavior.failClearance=false;h.snapshot.slot=119;
  await assert.rejects(h.restart().resumeProof('note'),/stale creation recovery snapshot/);assert.deepEqual(await h.open().read('note'),stopped);
  h.snapshot.slot=120;h.snapshot.pending={nullifier:field(1),balance_micro_usdc:'0',destinationOwner:before.value.wallet!.operation!.destinationOwner!,deadline:'1'};
  await assert.rejects(h.restart().resumeProof('note'),/note not active/);assert.deepEqual(await h.open().read('note'),stopped);delete h.snapshot.pending;
  await h.restart().resumeProof('note');const restored=(await h.open().read('note'))!;
  assert.equal(restored.value.wallet!.operation!.phase,'ready');assert.deepEqual(restored.value.state,before.value.state);
  assert.equal(h.counts.signatures,1);assert.equal(h.counts.sends,0);assert.equal(h.counts.rebase,0);
});

test('pending, unknown, non-expired and finalized receipts cannot authorize a replacement',async t=>{
  for(const kind of ['deposit','mutual_close','initiate_escape','emergency_escape'] as const){
  for(const outcome of ['pending','unknown','height','success','rejected','changed-after-observation']){
    const h=await setup(t,kind),before=(await h.journal.read('note'))!,attempt=before.value.wallet!.operation!.attempts[0];
    if(outcome==='pending')h.behavior.status={slot:90,confirmationStatus:'confirmed',err:null};
    if(outcome==='unknown')h.behavior.failHistory=true;
    if(outcome==='height')h.behavior.height=100;
    if(outcome==='success'||outcome==='rejected')h.behavior.receipt={signature:attempt.signature,message:new Uint8Array(decodeTransaction(Buffer.from(attempt.wireHex,'hex')).messageBytes),slot:90,err:outcome==='success'?null:{InstructionError:[0,{Custom:1}]}};
    if(outcome==='changed-after-observation')h.setObservation(value=>{h.behavior.status={slot:90,confirmationStatus:'confirmed',err:null};return value;});
    await assert.rejects(h.client.reconcileExpiredCreation('note'),/creation expiry or history unresolved/,outcome);
    assert.deepEqual(await h.journal.read('note'),before,outcome);assert.equal(h.counts.signatures,1);assert.equal(h.counts.sends,0);
  }
  }
});

test('absent account must be the exact PDA at a finalized safe block height beyond validity',async t=>{
  for(const kind of ['deposit','mutual_close','initiate_escape','emergency_escape'] as const){
  for(const fault of ['wrong-address','present','confirmed','old-slot','unsafe-slot','old-height','unsafe-height','missing-hash']){
    const h=await setup(t,kind),before=(await h.journal.read('note'))!;
    h.setObservation(value=>{if(fault==='wrong-address')value.address=hash(12);if(fault==='present')value.account={} as NonNullable<typeof value.account>;if(fault==='confirmed')value.commitment='confirmed' as 'finalized';if(fault==='old-slot')value.slot=19;if(fault==='unsafe-slot')value.slot=Infinity;if(fault==='old-height')value.blockHeight=100;if(fault==='unsafe-height')value.blockHeight=Infinity;if(fault==='missing-hash')value.blockhash='';return value;});
    await assert.rejects(h.client.reconcileExpiredCreation('note'),fault);assert.deepEqual(await h.journal.read('note'),before,fault);
  }
  }
});

test('non-create, advanced, pending, altered-plan and resolved journal states are refused without writes',async t=>{
  const h=await setup(t),base=(await h.journal.read('note'))!.value,plan=await restorePlan(base.wallet!.operation!.plan!);
  const otherAttempts=await Promise.all([...plan.steps.filter(s=>['append','seal','execute'].includes(s.kind)),await closePayload(plan)].map(step=>prepareAttempt(plan,step,{blockhash:hash(7),lastValidBlockHeight:100},[h.wallet],{save:async()=>{}})));
  const cases:[string,(value:NoteJournal)=>void][]=[
    ...otherAttempts.map((attempt,index)=>[attempt.kind+index,(v:NoteJournal)=>v.wallet!.operation!.attempts.unshift(attempt)] as [string,(value:NoteJournal)=>void]),['step',v=>{v.wallet!.operation!.step=1;}],
    ['finalized',v=>v.wallet!.operation!.finalized.push({signature:base.wallet!.operation!.current!,slot:90})],
    ['phase',v=>{v.wallet!.operation!.phase='proving';}],['resolved',v=>{v.wallet!.status='active';}],
    ['missing-current',v=>{delete v.wallet!.operation!.current;}],['different-plan',v=>{v.wallet!.operation!.plan!.expires='1';}],
    ['pending',v=>{const request={authorization:{request_id:crypto.randomUUID()}};v.pending={phase:'prepared',prepared:{request,control_token:'fixture',proxy_token:null},exactRequest:JSON.stringify(request),operations:[]} as unknown as NoteJournal['pending'];}],
  ];
  for(const [name,change] of cases){const value=structuredClone(base);change(value);await h.journal.create(name,value);const before=await h.journal.read(name);await assert.rejects(h.client.reconcileExpiredCreation(name));assert.deepEqual(await h.journal.read(name),before,name);}
  delete h.options.chain.bufferObservation;const before=await h.journal.read('note');await assert.rejects(h.client.reconcileExpiredCreation('note'),/finalized buffer observation unavailable/);assert.deepEqual(await h.journal.read('note'),before);
});

test('repeated expiry rechecks every saved create and distinct buffer, preserving all signed records',async t=>{
  for(const kind of ['deposit','mutual_close','initiate_escape','emergency_escape'] as const){
  const h=await setup(t,kind);await h.client.reconcileExpiredCreation('note');
  h.behavior.hash=hash(8);h.behavior.lastValid=200;h.behavior.height=201;
  await assert.rejects(h.client.advance('note'),/missing buffer/);
  const before=(await h.journal.read('note'))!;assert.equal(before.value.wallet!.operation!.attempts.length,2);
  h.behavior.observationHeight=210;h.behavior.observationSlot=220;h.snapshot.slot=220;h.observed.length=0;
  const signatureStatus=h.options.rpc.signatureStatus,first=before.value.wallet!.operation!.attempts[0].signature;
  h.options.rpc.signatureStatus=async signature=>signature===first?{slot:90,confirmationStatus:'confirmed',err:null}:null;
  await assert.rejects(h.restart().reconcileExpiredCreation('note'),/creation expiry or history unresolved/);assert.deepEqual(await h.journal.read('note'),before,'an old uncertain create cannot be hidden behind an expired latest create');
  h.options.rpc.signatureStatus=signatureStatus;
  await h.restart().reconcileExpiredCreation('note');const after=(await h.open().read('note'))!.value.wallet!.operation!;
  assert.deepEqual(after.attempts,before.value.wallet!.operation!.attempts);assert.deepEqual(h.observed,after.attempts.map(a=>(a as Attempt).buffer));
  assert.equal(new Set(h.observed).size,2);assert.equal(after.expiredCreations!.length,3);assert.equal(h.counts.sends,0);
  }
});

test('RPC absence observation anchors the returned account slot to its own finalized block, never a slot/height comparison',async t=>{
  const h=await setup(t),plan=await restorePlan((await h.journal.read('note'))!.value.wallet!.operation!.plan!);
  const behavior={slot:120,height:110 as number|null,missing:false,hash:hash(9)};const calls:string[]=[];
  const connection=createSolanaRpcWithFetch('https://rpc.invalid', (async(_url,init)=>{const request=JSON.parse(String(init!.body));calls.push(request.method);let result:unknown;
    if(request.method==='getAccountInfo'){assert.equal(request.params[0],plan.buffer);assert.equal(request.params[1].commitment,'finalized');assert.equal(request.params[1].minContextSlot,100);result={context:{slot:behavior.slot},value:null};}
    else{assert.equal(request.method,'getBlock');assert.equal(request.params[0],behavior.slot);assert.equal(request.params[1].commitment,'finalized');assert.equal(request.params[1].transactionDetails,'none');assert.equal(request.params[1].maxSupportedTransactionVersion,1);result=behavior.missing?null:{blockhash:behavior.hash,previousBlockhash:hash(8),parentSlot:behavior.slot-1,blockTime:fixture.now,blockHeight:behavior.height};}
    return Response.json({jsonrpc:'2.0',id:request.id,result});}) as typeof fetch);
  assert.deepEqual(await fetchFinalizedBufferObservation(connection,plan,100),{address:plan.buffer,account:null,slot:120,blockHeight:110,blockhash:hash(9),commitment:'finalized'});
  assert.deepEqual(calls,['getAccountInfo','getBlock']);
  for(const fault of ['stale-slot','missing-block','null-height','invalid-hash']){behavior.slot=fault==='stale-slot'?99:120;behavior.missing=fault==='missing-block';behavior.height=fault==='null-height'?null:110;behavior.hash=(fault==='invalid-hash'?'invalid':hash(9)) as typeof behavior.hash;await assert.rejects(fetchFinalizedBufferObservation(connection,plan,100));}
});

 test('ordinary and emergency escape expired-create recovery retain state, roles, destination and exact evidence without sending',async t=>{
  for(const kind of ['initiate_escape','emergency_escape'] as const)await t.test(kind,async sub=>{
    const h=await setup(sub,kind),before=(await h.open().read('note'))!.value,counts={...h.counts};
    await h.restart().reconcileExpiredCreation('note');const after=(await h.open().read('note'))!.value,op=after.wallet!.operation!,old=before.wallet!.operation!;
    assert.equal(op.kind,'initiate_escape');assert.equal(op.id,old.id);assert.equal(op.phase,'ready');assert.equal(op.current,undefined);
    assert.deepEqual(after.state,before.state);assert.deepEqual(after.witness,before.witness);assert.deepEqual(op.roles,old.roles);
    assert.equal(op.destinationOwner,old.destinationOwner);assert.deepEqual(op.attempts,old.attempts);assert.equal(op.expiredCreations!.length,1);
    assert.deepEqual(after.wallet!.emergencyEscapes,before.wallet!.emergencyEscapes);assert.equal(after.pending,null);
    assert.notEqual(op.plan!.nonceHex,old.plan!.nonceHex);assert.equal(op.plan!.expires,String(fixture.now+7600));
    assert.equal(h.counts.sends,counts.sends);assert.equal(h.counts.signatures,counts.signatures);assert.equal(h.counts.rebase,0);
  });
});

 test('escape create recovery rejects changed signed state, destination, roles, advanced attempts and inactive note',async t=>{
  const h=await setup(t,'initiate_escape'),base=(await h.open().read('note'))!.value;
  const plan=await restorePlan(base.wallet!.operation!.plan!),execute=await prepareAttempt(plan,plan.steps.find(s=>s.kind==='execute')!,
    {blockhash:hash(7),lastValidBlockHeight:100},[h.wallet],{save:async()=>{}});
  const cases:[string,(v:NoteJournal)=>void][]=[
    ['balance',v=>{v.state.balance_micro_usdc='1';}],['anchor',v=>{v.state.anchor=field(123);}],
    ['witness',v=>{v.witness!.deposit_micro_usdc='1';}],['destination',v=>{v.wallet!.operation!.destinationOwner=hash(8);}],
    ['payer',v=>{v.wallet!.operation!.roles.payer=hash(8);}],['uploader',v=>{v.wallet!.operation!.roles.uploader=hash(8);}],
    ['fee payer',v=>{v.wallet!.operation!.roles.feePayer=hash(8);}],['rent payer',v=>{v.wallet!.operation!.roles.rentPayer=hash(8);}],
    ['execute exists',v=>{v.wallet!.operation!.attempts.unshift(execute);}],
  ];
  for(const [name,change] of cases){const value=structuredClone(base);change(value);await h.journal.create(name,value);
    const before=await h.open().read(name);await assert.rejects(h.restart().reconcileExpiredCreation(name),name);assert.deepEqual(await h.open().read(name),before);}
  const before=await h.open().read('note');h.snapshot.note!.status='pending_escape';
  await assert.rejects(h.restart().reconcileExpiredCreation('note'),/note not active/);assert.deepEqual(await h.open().read('note'),before);
  assert.equal(h.counts.sends,0);assert.equal(h.counts.signatures,2,'only the two deliberate fixture signatures exist');
});

 test('interrupted emergency escape setup recovery resumes from durable absence without changing the archive',async t=>{
  const h=await setup(t,'emergency_escape'),before=(await h.open().read('note'))!.value;h.behavior.failProof=true;
  await assert.rejects(h.restart().reconcileExpiredCreation('note'),/proof interrupted/);
  const stopped=(await h.open().read('note'))!.value;assert.equal(stopped.wallet!.operation!.phase,'proving');
  assert.deepEqual(stopped.wallet!.emergencyEscapes,before.wallet!.emergencyEscapes);assert.deepEqual(stopped.wallet!.operation!.attempts,before.wallet!.operation!.attempts);
  h.behavior.failProof=false;h.snapshot.slot=119;await assert.rejects(h.restart().resumeProof('note'),/stale creation recovery snapshot/);
  h.snapshot.slot=120;await h.restart().resumeProof('note');const after=(await h.open().read('note'))!.value;
  assert.equal(after.wallet!.operation!.phase,'ready');assert.deepEqual(after.wallet!.emergencyEscapes,before.wallet!.emergencyEscapes);
  assert.equal(h.counts.sends,0);assert.equal(h.counts.signatures,1);assert.equal(h.counts.rebase,0);
});
