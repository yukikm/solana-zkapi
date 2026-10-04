/** Product wallet workflow over the single encrypted NoteJournal and I04 transport.
 * A financial attempt stays unresolved until its exact signed receipt is finalized. */
import { PublicKey, VersionedTransaction, type TransactionInstruction } from '@solana/web3.js';
import { EncryptedJournal, type JournalRecord } from './journal.ts';
import type { NoteJournal, PrivateState, StateSignature } from './control.ts';
import { NoteProver, type NoteWitness, type PublicNote } from './prover.ts';
import { parseField, parseMicroUsdc } from './encoding.ts';
import { encodeLayout2Args, fromHex } from './layout2.ts';
import { parseStrictJson, type VerifiedManifest } from './trust.ts';
import { buildUploadPlan, snapshotPlan, restorePlan, prepareAttempt, recoverAttempt, closePayload, finalizeEscape,
  prepareFinalizationAttempt, recoverFinalizationAttempt, refreshExpiredUpload, vaultAccounts,
  type Attempt, type FinalizationAttempt, type PlanRecord, type V0Wallet, type TransportRpc, type Recovery, type FinalizationPlan } from './transport.ts';
import type { WalletChain, WalletSnapshot } from './wallet-chain.ts';

export interface WalletRoles { uploader:string;rentPayer:string;feePayer:string;payer:string;tokenOwner?:string }
export interface WalletOperation {
  id:string;kind:'deposit'|'mutual_close'|'initiate_escape'|'finalize_escape';phase:'proving'|'ready'|'stale'|'closing_stale'|'failed'|'cancelled';
  roles:WalletRoles;destinationOwner?:string;plan?:PlanRecord;finalization?:FinalizationAttempt['finalization'];step:number;
  attempts:(Attempt|FinalizationAttempt)[];current?:string;finalized:{signature:string;slot:number}[];
}
export interface WalletJournal {
  status:'unfunded'|'active'|'pending_escape'|'closed';
  clearance?:{nullifier:string;phase:'requested'|'verified';signature?:StateSignature};
  operation?:WalletOperation;history:WalletOperation[];
}
export interface WalletOptions {
  manifest:VerifiedManifest;prover:NoteProver;journal:EncryptedJournal<NoteJournal>;chain:WalletChain;rpc:TransportRpc;
  wallets:readonly V0Wallet[];fetch?:typeof fetch;
}
function requireTrue(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
export class WalletClient {
  private readonly o:WalletOptions;
  constructor(options:WalletOptions){this.o={...options,wallets:[...options.wallets]};}
  private async record(id:string):Promise<JournalRecord<NoteJournal>>{const r=await this.o.journal.read(id);requireTrue(r?.value.witness&&r.value.wallet,'full note witness and wallet journal required');return r;}
  private save(id:string,r:JournalRecord<NoteJournal>):Promise<JournalRecord<NoteJournal>>{return this.o.journal.compareAndSwap(id,r.revision,r.value);}
  private roles(roles:WalletRoles):WalletRoles{const copy=structuredClone(roles);for(const v of Object.values(copy))new PublicKey(v);return copy;}
  private signers(instruction:TransactionInstruction,feePayer:PublicKey):V0Wallet[]{const required=new Set([feePayer.toBase58(),...instruction.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58())]);return this.o.wallets.filter(w=>required.has(w.publicKey.toBase58()));}
  private async note(r:JournalRecord<NoteJournal>,s:WalletSnapshot):Promise<PublicNote>{
    const w=r.value.witness!,identity=await this.o.prover.inspect(w,r.value.state);
    requireTrue(s.note&&s.note.note_id===w.note_id&&s.note.registration_commitment===identity.registration_commitment&&s.note.deposit_micro_usdc===w.deposit_micro_usdc&&s.note.expiry===w.expiry,'finalized note does not match secret witness');
    return {note_id:w.note_id,registration_commitment:identity.registration_commitment,deposit_micro_usdc:w.deposit_micro_usdc,expiry:w.expiry};
  }
  /** Import verifies the actual finalized Note and private commitment/signature. */
  async importFinalized(id:string,witness:NoteWitness,state:PrivateState):Promise<void>{
    witness=structuredClone(witness);state=structuredClone(state);
    await this.o.journal.withNoteLock(id,async()=>{
      const snapshot=await this.o.chain.snapshot(witness.note_id,'active');
      const value:NoteJournal={schema:1,witness,state,pending:null,history:[],wallet:{status:'active',history:[]}};
      await this.note({revision:0,value,head:{revision:0,digest:''}},snapshot);await this.o.journal.create(id,value);
    });
  }
  async beginDeposit(id:string,amount:string,roles:WalletRoles):Promise<void>{
    roles=this.roles(roles);requireTrue(roles.tokenOwner,'explicit deposit token owner');parseMicroUsdc(amount);
    await this.o.journal.withNoteLock(id,async()=>{
      const s=await this.o.chain.snapshot();requireTrue(!s.paused,'pool paused');
      const expiry=((BigInt(s.clock)+BigInt(this.o.manifest.note_ttl_seconds)+86399n)/86400n*86400n).toString();
      const candidate=await this.o.prover.deposit(s.nextNoteId,amount,expiry);
      const r=await this.o.journal.create(id,{schema:1,witness:candidate.witness,state:candidate.state,pending:null,history:[],wallet:{status:'unfunded',history:[],operation:{id:crypto.randomUUID(),kind:'deposit',phase:'proving',roles,step:0,attempts:[],finalized:[]}}});
      await this.build(id,r,s);
    });
  }
  async beginWithdrawal(id:string,mode:'mutual_close'|'initiate_escape',destinationOwner:string,roles:WalletRoles):Promise<void>{
    requireTrue(mode==='mutual_close'||mode==='initiate_escape','explicit withdrawal mode');new PublicKey(destinationOwner);roles=this.roles(roles);
    await this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);requireTrue(!r.value.pending&&!r.value.wallet!.operation&&r.value.wallet!.status==='active','note unavailable for withdrawal');
      r.value.wallet!.operation={id:crypto.randomUUID(),kind:mode,phase:'proving',roles,destinationOwner,step:0,attempts:[],finalized:[]};
      if(mode==='mutual_close'){
        const {nullifier}=await this.o.prover.inspect(r.value.witness!,r.value.state);
        requireTrue(!r.value.wallet!.clearance||r.value.wallet!.clearance.nullifier===nullifier,'clearance state mismatch');
        r.value.wallet!.clearance??={nullifier,phase:'requested'};
      }
      r=await this.save(id,r);await this.build(id,r);
    });
  }
  /** Explicit user selection when clearance is unavailable. Any signed upload
   * may still arrive, so only a never-signed mutual operation can be replaced.
   * Permanent clearance/N intent remains even if its HTTP response was lost. */
  async fallbackToEscape(id:string):Promise<void>{
    await this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);const w=r.value.wallet!,old=w.operation;
      requireTrue(w.status==='active'&&!r.value.pending&&old?.kind==='mutual_close'&&['proving','ready'].includes(old.phase),'unsent mutual withdrawal required');
      requireTrue(old.attempts.length===0&&!old.current,'signed withdrawal must be reconciled before another operation');
      requireTrue(old.destinationOwner&&w.clearance,'saved withdrawal destination and clearance intent required');
      const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);
      requireTrue(w.clearance.nullifier===identity.nullifier,'clearance state mismatch');
      old.phase='cancelled';w.history.push(old);
      w.operation={id:crypto.randomUUID(),kind:'initiate_escape',phase:'proving',roles:structuredClone(old.roles),destinationOwner:old.destinationOwner,step:0,attempts:[],finalized:[]};
      r=await this.save(id,r);await this.build(id,r);
    });
  }
  /** Repeating this after a lost clearance response uses the same permanently reserved N. */
  private async clearance(id:string,r:JournalRecord<NoteJournal>):Promise<JournalRecord<NoteJournal>>{
    const c=r.value.wallet!.clearance!;
    if(c.phase==='verified'){requireTrue(c.signature,'missing verified clearance');await this.o.prover.verifyClearance(c.nullifier,c.signature);return r;}
    const response=await (this.o.fetch??fetch)(this.o.manifest.control_api_origin+'/zkapi/v1/withdraw/clearance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nullifier:c.nullifier}),redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(60_000)});
    requireTrue(response.ok,'clearance unavailable; saved nullifier retained');
    const reader=response.body?.getReader();requireTrue(reader,'clearance response');let count=0;const chunks:Uint8Array[]=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;requireTrue(count<=4096,'clearance response bound');chunks.push(value);}}finally{await reader.cancel();}
    const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const result=parseStrictJson(bytes) as unknown as {nullifier:string;signature:StateSignature};
    requireTrue(result.nullifier===c.nullifier&&Object.keys(result).sort().join(',')==='nullifier,signature','clearance identity');
    await this.o.prover.verifyClearance(c.nullifier,result.signature);c.signature=result.signature;c.phase='verified';return this.save(id,r);
  }
  private async build(id:string,record:JournalRecord<NoteJournal>,snapshot?:WalletSnapshot):Promise<JournalRecord<NoteJournal>>{
    let r=record;let op=r.value.wallet!.operation!;requireTrue(op.phase==='proving'&&!op.current,'proof cannot replace unresolved transaction');
    const s=snapshot??await this.o.chain.snapshot(op.kind==='deposit'?undefined:r.value.witness!.note_id,op.kind==='deposit'?'zero':'active');
    requireTrue(!s.paused,'pool paused');
    let note:PublicNote;
    if(op.kind==='deposit'){
      const expiry=((BigInt(s.clock)+BigInt(this.o.manifest.note_ttl_seconds)+86399n)/86400n*86400n).toString();
      if(r.value.witness!.note_id!==s.nextNoteId||r.value.witness!.expiry!==expiry){
        const c=await this.o.prover.rebaseDeposit(r.value.witness!,s.nextNoteId,expiry);r.value.witness=c.witness;r.value.state=c.state;r=await this.save(id,r);op=r.value.wallet!.operation!;
      }
      const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);note={note_id:s.nextNoteId,registration_commitment:identity.registration_commitment,deposit_micro_usdc:r.value.witness!.deposit_micro_usdc,expiry};
    }else{note=await this.note(r,s);requireTrue(s.note!.status==='active','note not active');}
    if(op.kind==='mutual_close'){r=await this.clearance(id,r);op=r.value.wallet!.operation!;}
    const tree=await this.o.prover.tree(note,s.root,s.siblings,op.kind==='deposit'?0:1);
    let nullifier:string|undefined;
    let payload:Uint8Array;
    if(op.kind==='deposit')payload=encodeLayout2Args({operation:'deposit',expectedId:note.note_id,expectedRoot:s.root,expiry:BigInt(note.expiry),commitment:note.registration_commitment,amount:BigInt(note.deposit_micro_usdc),tree});
    else{
      requireTrue(op.kind==='mutual_close'||op.kind==='initiate_escape','invalid proof operation');
      const auth=await this.o.prover.withdrawal(r.value.witness!,r.value.state,s.root,s.siblings,new PublicKey(op.destinationOwner!),op.kind==='mutual_close'?r.value.wallet!.clearance!.signature!:null);
      nullifier=auth.public_inputs[11];payload=encodeLayout2Args({operation:op.kind,auth,tree});
    }
    const m=this.o.manifest,roles=op.roles,operation=op.kind;
    const plan=await buildUploadPlan({programId:new PublicKey(m.program_id),pool:new PublicKey(m.pool),uploader:new PublicKey(roles.uploader),rentPayer:new PublicKey(roles.rentPayer),feePayer:new PublicKey(roles.feePayer),nonce:crypto.getRandomValues(new Uint8Array(32)),expires:BigInt(s.clock)+3600n,operation,payload,
      financial:vaultAccounts({programId:new PublicKey(m.program_id),pool:new PublicKey(m.pool),mint:new PublicKey(m.mint),payer:new PublicKey(roles.payer),noteId:note.note_id,operation,tokenOwner:roles.tokenOwner?new PublicKey(roles.tokenOwner):undefined,destinationOwner:op.destinationOwner?new PublicKey(op.destinationOwner):undefined,treasuryOwner:new PublicKey(s.treasuryOwner),nullifier:nullifier?parseField(nullifier):undefined}),snapshot:{slot:s.slot,sequence:BigInt(s.sequence)}});
    op.plan=snapshotPlan(plan);op.phase='ready';op.step=0;return this.save(id,r);
  }
  async resumeProof(id:string):Promise<void>{await this.o.journal.withNoteLock(id,async()=>{await this.build(id,await this.record(id));});}
  /** Explicit retry after the cause of a finalized rejection has been addressed.
   * Recheck that exact signature before replacing any transaction. Unknown or
   * expired attempts cannot enter this path, and existing buffers close before
   * a new proof is built. Witness, destination and permanent clearance stay put. */
  async retryRejected(id:string):Promise<void>{
    await this.o.journal.withNoteLock(id,async()=>{
      const r=await this.record(id),op=r.value.wallet!.operation;
      requireTrue(op?.phase==='failed'&&!op.current,'finalized rejected operation required');
      const attempt=op.attempts.at(-1);requireTrue(attempt,'missing rejected attempt');
      const result=attempt.kind==='finalize'
        ?await recoverFinalizationAttempt(attempt as FinalizationAttempt,this.o.rpc)
        :await recoverAttempt(attempt as Attempt,this.o.rpc);
      requireTrue(result.state==='rejected','exact rejection must be finalized before retry');
      if(op.kind==='finalize_escape'){
        const s=await this.o.chain.snapshot(r.value.witness!.note_id,'zero',result.slot);await this.note(r,s);
        const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);
        requireTrue(s.note?.status==='pending_escape'&&s.pending?.nullifier===identity.nullifier
          &&s.pending.destinationOwner===op.destinationOwner&&s.pending.balance_micro_usdc===r.value.state.balance_micro_usdc
          &&BigInt(s.clock)>=BigInt(s.pending.deadline),'saved escape is not ready to finalize');
        const m=this.o.manifest,financial=vaultAccounts({programId:new PublicKey(m.program_id),pool:new PublicKey(m.pool),mint:new PublicKey(m.mint),payer:new PublicKey(op.roles.payer),operation:'finalize_escape',noteId:r.value.witness!.note_id,destinationOwner:new PublicKey(op.destinationOwner!),treasuryOwner:new PublicKey(s.treasuryOwner)});
        op.finalization!.financial=Object.fromEntries(Object.entries(financial).map(([k,v])=>[k,v.toBase58()])) as FinalizationAttempt['finalization']['financial'];
        op.finalization!.snapshotSlot=s.slot;op.finalization!.snapshotSequence=s.sequence;op.phase='ready';
      }else{
        requireTrue(op.plan,'missing rejected proof plan');
        const buffer=await this.o.chain.buffer(await restorePlan(op.plan),result.slot);
        if(buffer)op.phase='closing_stale';
        else{op.phase='proving';op.plan=undefined;op.step=0;}
      }
      await this.save(id,r);
    });
  }
  async beginFinalize(id:string,roles:WalletRoles):Promise<void>{
    roles=this.roles(roles);
    await this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);requireTrue(!r.value.pending&&!r.value.wallet!.operation&&r.value.wallet!.status==='pending_escape','pending escape required');
      const s=await this.o.chain.snapshot(r.value.witness!.note_id,'zero');await this.note(r,s);
      const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);
      requireTrue(s.note?.status==='pending_escape'&&s.pending?.nullifier===identity.nullifier&&BigInt(s.clock)>=BigInt(s.pending.deadline),'escape challenge period has not ended');
      const m=this.o.manifest,financial=vaultAccounts({programId:new PublicKey(m.program_id),pool:new PublicKey(m.pool),mint:new PublicKey(m.mint),payer:new PublicKey(roles.payer),operation:'finalize_escape',noteId:r.value.witness!.note_id,destinationOwner:new PublicKey(s.pending.destinationOwner),treasuryOwner:new PublicKey(s.treasuryOwner)});
      r.value.wallet!.operation={id:crypto.randomUUID(),kind:'finalize_escape',phase:'ready',roles,destinationOwner:s.pending.destinationOwner,step:0,attempts:[],finalized:[],finalization:{programId:m.program_id,pool:m.pool,noteId:r.value.witness!.note_id,feePayer:roles.feePayer,financial:Object.fromEntries(Object.entries(financial).map(([k,v])=>[k,v.toBase58()])) as FinalizationAttempt['finalization']['financial'],snapshotSlot:s.slot,snapshotSequence:s.sequence}};
      r=await this.save(id,r);
    });
  }
  /** One bounded sign/recover step. Call again when pending; never loops inference or switches mode. */
  async advance(id:string):Promise<Recovery|{state:'ready'|'proof_required'|'complete'}>{
    return this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);let op=r.value.wallet!.operation;requireTrue(op,'no financial operation');
      requireTrue(op.phase!=='failed','finalized rejection requires explicit review');
      if(op.phase==='proving')return {state:'proof_required'};
      const saveAttempt=async(attempt:Attempt|FinalizationAttempt)=>{
        requireTrue(!op!.attempts.some(a=>a.signature===attempt.signature),'duplicate financial signature');
        op!.attempts.push(structuredClone(attempt));op!.current=attempt.signature;r=await this.save(id,r);op=r.value.wallet!.operation!;
      };
      let attempt=op.attempts.find(a=>a.signature===op!.current);
      if(!attempt){
        if(op.kind==='finalize_escape'){
          const p=op.finalization!;
          const plan:FinalizationPlan={programId:new PublicKey(p.programId),pool:new PublicKey(p.pool),noteId:p.noteId,feePayer:new PublicKey(p.feePayer),financial:Object.fromEntries(Object.entries(p.financial).map(([k,v])=>[k,new PublicKey(v)])) as FinalizationPlan['financial'],snapshot:{slot:p.snapshotSlot,sequence:BigInt(p.snapshotSequence)}};
          const step=await finalizeEscape(plan.programId,plan.financial,plan.noteId);
          attempt=await prepareFinalizationAttempt(plan,await this.o.chain.blockhash(),this.signers(step.instruction,plan.feePayer),{save:saveAttempt});
        }else{
          requireTrue(op.plan,'missing prepared proof');const plan=await restorePlan(op.plan);
          if(op.phase==='stale'){op.phase='closing_stale';r=await this.save(id,r);op=r.value.wallet!.operation!;}
          const step=op.phase==='closing_stale'?await closePayload(plan):plan.steps[op.step];requireTrue(step,'invalid upload step');
          attempt=await prepareAttempt(plan,step,await this.o.chain.blockhash(),this.signers(step.instruction,plan.feePayer),{save:saveAttempt});
        }
      }
      let recovery=attempt.kind==='finalize'?await recoverFinalizationAttempt(attempt as FinalizationAttempt,this.o.rpc,true):await recoverAttempt(attempt as Attempt,this.o.rpc,true);
      if(recovery.state==='expired_reconcile_required'&&!['execute','close','finalize'].includes(attempt.kind)){
        const plan=await restorePlan((attempt as Attempt).plan);
        const tx=VersionedTransaction.deserialize(fromHex(attempt.wireHex,attempt.wireHex.length/2)),required=new Set(tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(k=>k.toBase58()));
        const refreshed=await refreshExpiredUpload(attempt as Attempt,this.o.rpc,await this.o.chain.buffer(plan),await this.o.chain.blockhash(),this.o.wallets.filter(w=>required.has(w.publicKey.toBase58())),{save:saveAttempt});
        if('next'in refreshed){op!.step=plan.steps.findIndex(s=>s===refreshed.next||s.kind===refreshed.next.kind&&s.offset===refreshed.next.offset);requireTrue(op!.step>=0,'invalid recovered upload prefix');delete op!.current;r=await this.save(id,r);return {state:'ready'};}
        return recoverAttempt(refreshed,this.o.rpc,true);
      }
      if(recovery.state==='rejected'){
        op!.phase=recovery.needsNewProof?'stale':'failed';delete op!.current;await this.save(id,r);return recovery;
      }
      if(recovery.state!=='finalized')return recovery;
      op!.finalized.push({signature:attempt.signature,slot:recovery.slot});delete op!.current;
      if(attempt.kind==='close'&&op!.phase==='closing_stale'){op!.phase='proving';op!.plan=undefined;op!.step=0;await this.save(id,r);return {state:'proof_required'};}
      if(attempt.kind!=='execute'&&attempt.kind!=='finalize'){op!.step++;await this.save(id,r);return {state:'ready'};}
      // Receipt success is necessary; actual finalized Note binding is also required before activation.
      const snapshot=await this.o.chain.snapshot(r.value.witness!.note_id,'none',recovery.slot);await this.note(r,snapshot);
      const status=op!.kind==='deposit'?'active':op!.kind==='initiate_escape'?'pending_escape':'closed';requireTrue(snapshot.note!.status===status,'finalized financial account state mismatch');
      if(status==='pending_escape'){
        const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);
        requireTrue(snapshot.pending?.nullifier===identity.nullifier&&snapshot.pending.destinationOwner===op!.destinationOwner&&snapshot.pending.balance_micro_usdc===r.value.state.balance_micro_usdc,'finalized Pending mismatch');
      }
      r.value.wallet!.status=status;r.value.wallet!.history.push(op!);delete r.value.wallet!.operation;await this.save(id,r);return {state:'complete'};
    });
  }
}
