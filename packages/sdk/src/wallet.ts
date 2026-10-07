/** Product wallet workflow over the single encrypted NoteJournal and I04 transport.
 * A financial attempt stays unresolved until its exact signed receipt is finalized. */
import { address, getAddressEncoder, getTransactionDecoder, isSignerRole, type Address, type Instruction } from '@solana/kit';
import { EncryptedJournal, type JournalRecord } from './journal.ts';
import type { NoteJournal, PendingSession, PrivateState, StateSignature } from './control.ts';
import { NoteProver, type NoteWitness, type PublicNote } from './prover.ts';
import { parseField, parseMicroUsdc, destinationBinding } from './encoding.ts';
import { encodeLayout2Args, fromHex, u64 } from './layout2.ts';
import { parseStrictJson, supportsInlineDeposit, type VerifiedManifest } from './trust.ts';
import { buildUploadPlan, snapshotPlan, restorePlan, prepareAttempt, recoverAttempt, closePayload, finalizeEscape,
  prepareFinalizationAttempt, recoverFinalizationAttempt, refreshExpiredUpload, vaultAccounts,
  buildInlineDepositPlan, snapshotInlineDepositPlan, restoreInlineDepositPlan, prepareInlineDepositAttempt, recoverInlineDepositAttempt,
  type InlineDepositPlanRecord, type InlineDepositAttempt, type FinancialAttempt,
  type Attempt, type FinalizationAttempt, type PlanRecord, type V0Wallet, type TransportRpc, type Recovery, type FinalizationPlan } from './transport.ts';
import type { WalletChain, WalletSnapshot } from './wallet-chain.ts';

export interface WalletRoles { uploader?:string;rentPayer?:string;feePayer:string;payer:string;tokenOwner?:string }
export interface InlineDepositRoles { feePayer:string;payer:string;tokenOwner:string }
type InlineContext = Pick<InlineDepositPlanRecord,'deploymentId'|'manifestHash'|'programId'|'pool'|'mint'|'vaultBinding'>;
interface WalletOperationBase {
  id:string;kind:'deposit'|'mutual_close'|'initiate_escape'|'finalize_escape';phase:'proving'|'ready'|'stale'|'closing_stale'|'failed'|'cancelled';
  roles:WalletRoles;destinationOwner?:string;finalization?:FinalizationAttempt['finalization'];step:number;
  attempts:FinancialAttempt[];current?:string;finalized:{signature:string;slot:number}[];
  rejectedInline?:{signature:string;slot:number}[];
  expiredCreations?:{signature:string;buffer:string;slot:number;blockHeight:number;blockhash:string}[];
}
export type WalletOperation = WalletOperationBase & (
  {transport?:'v0_buffer';plan?:PlanRecord;inlinePlan?:never;inlineContext?:never} |
  {transport:'v0_inline_deposit_v1';kind:'deposit';plan?:never;inlinePlan?:InlineDepositPlanRecord;inlineContext:InlineContext;priorityFeeMicroLamports?:string}
);
export interface EmergencyEscape {
  /** The original unresolved request and inference bytes never change. */
  pending:PendingSession;previous:PrivateState;nullifier:string;operationId:string;
  phase:'escaping'|'challenged'|'settled';
  escape?:{signature:string;slot:number;sequence:string};
  challenge?:{slot:number;sequence:string};
}
export interface WalletJournal {
  status:'unfunded'|'active'|'pending_escape'|'closed';
  clearance?:{nullifier:string;phase:'requested'|'verified';signature?:StateSignature};
  /** Exact uncertain AUTH retained after a signed permanent clearance fences its N.
   * This is not a settlement and does not change the private balance/state. */
  clearedAuthorization?:{pending:PendingSession;previous:PrivateState};
  emergencyEscapes?:EmergencyEscape[];
  operation?:WalletOperation;history:WalletOperation[];
}
export interface WalletOptions {
  manifest:VerifiedManifest;prover:NoteProver;journal:EncryptedJournal<NoteJournal>;chain:WalletChain;rpc:TransportRpc;
  wallets:readonly V0Wallet[];fetch?:typeof fetch;
  /** Snapshot into each newly built upload plan. Omitted/zero retains legacy wire. */
  priorityFeeMicroLamports?:bigint;
}
function requireTrue(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
export class WalletClient {
  private readonly o:WalletOptions;
  constructor(options:WalletOptions){if(options.priorityFeeMicroLamports!==undefined)u64(options.priorityFeeMicroLamports);this.o={...options,wallets:[...options.wallets]};}
  private async record(id:string):Promise<JournalRecord<NoteJournal>>{const r=await this.o.journal.read(id);requireTrue(r?.value.witness&&r.value.wallet,'full note witness and wallet journal required');const op=r.value.wallet.operation;if(op?.transport==='v0_inline_deposit_v1')this.inlinePins(op.inlineContext);return r;}
  private inlineContext():InlineContext{const m=this.o.manifest;return {deploymentId:m.deployment_id,manifestHash:m.manifest_hash,programId:m.program_id,pool:m.pool,mint:m.mint,vaultBinding:m.vault_binding};}
  private inlinePins(p:InlineContext):void{requireTrue(supportsInlineDeposit(this.o.manifest)&&Object.entries(this.inlineContext()).every(([k,v])=>p[k as keyof InlineContext]===v),'inline deployment pins changed');}
  private save(id:string,r:JournalRecord<NoteJournal>):Promise<JournalRecord<NoteJournal>>{return this.o.journal.compareAndSwap(id,r.revision,r.value);}
  private roles(roles:WalletRoles):WalletRoles{const copy=structuredClone(roles);for(const v of Object.values(copy))if(v!==undefined)address(v);return copy;}
  private signers(instruction:Instruction,feePayer:Address):V0Wallet[]{const required=new Set([feePayer,...(instruction.accounts??[]).filter(k=>isSignerRole(k.role)).map(k=>k.address)]);return this.o.wallets.filter(w=>required.has(w.publicKey));}
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
    const inline=this.o.manifest.transaction_formats?.includes('v0_inline_deposit_v1')===true&&supportsInlineDeposit(this.o.manifest);
    if(inline){
      // Legacy adapters may pass buffer roles only when they unambiguously map
      // to the token owner and financial payer. Persist only inline roles.
      requireTrue((roles.uploader===undefined||roles.uploader===roles.tokenOwner)&&(roles.rentPayer===undefined||roles.rentPayer===roles.payer),'ambiguous inline deposit fee roles');
      roles={tokenOwner:roles.tokenOwner,payer:roles.payer,feePayer:roles.feePayer};
    }else requireTrue(roles.uploader&&roles.rentPayer,'explicit buffer roles required');
    await this.o.journal.withNoteLock(id,async()=>{
      const s=await this.o.chain.snapshot();requireTrue(!s.paused,'pool paused');
      const expiry=((BigInt(s.clock)+BigInt(this.o.manifest.note_ttl_seconds)+86399n)/86400n*86400n).toString();
      const candidate=await this.o.prover.deposit(s.nextNoteId,amount,expiry);
      const base:WalletOperationBase={id:crypto.randomUUID(),kind:'deposit',phase:'proving',roles,step:0,attempts:[],finalized:[]};
      const operation:WalletOperation=inline?{...base,kind:'deposit',transport:'v0_inline_deposit_v1',inlineContext:this.inlineContext(),priorityFeeMicroLamports:(this.o.priorityFeeMicroLamports??0n).toString()}:base;
      const r=await this.o.journal.create(id,{schema:inline?2:1,witness:candidate.witness,state:candidate.state,pending:null,history:[],wallet:{status:'unfunded',history:[],operation}});
      await this.build(id,r,s);
    });
  }
  /** Explicit fee selection before the first signature. Preserve the existing
   * proof, nonce, note and operation; never modify a signed or advanced plan. */
  async setUnsentPriorityFee(id:string,price:bigint):Promise<void>{
    u64(price);
    await this.o.journal.withNoteLock(id,async()=>{
      const r=await this.record(id),w=r.value.wallet!,op=w.operation;
      if(op?.transport==='v0_inline_deposit_v1'){
        requireTrue(r.value.pending===null&&w.status==='unfunded'&&op.phase==='ready'&&op.step===0&&op.attempts.length===0&&op.finalized.length===0&&!op.current&&op.inlinePlan,'unsent ready upload required');
        const plan=await restoreInlineDepositPlan(op.inlinePlan);if((plan.priorityFeeMicroLamports??0n)===price)return;
        op.priorityFeeMicroLamports=price.toString();op.inlinePlan=snapshotInlineDepositPlan(await buildInlineDepositPlan({...plan,priorityFeeMicroLamports:price}));await this.save(id,r);return;
      }
      requireTrue(r.value.pending===null&&op?.phase==='ready'&&op.kind!=='finalize_escape'
        &&op.step===0&&op.attempts.length===0&&op.finalized.length===0&&op.current===undefined
        &&op.finalization===undefined&&op.plan&&op.plan.operation===op.kind
        &&(op.kind==='deposit'?w.status==='unfunded':w.status==='active'),'unsent ready upload required');
      const plan=await restorePlan(op.plan);
      if((plan.priorityFeeMicroLamports??0n)===price)return;
      op.plan=snapshotPlan(await buildUploadPlan({...plan,priorityFeeMicroLamports:price}));
      await this.save(id,r);
    });
  }
  async beginWithdrawal(id:string,mode:'mutual_close'|'initiate_escape',destinationOwner:string,roles:WalletRoles):Promise<void>{
    requireTrue(mode==='mutual_close'||mode==='initiate_escape','explicit withdrawal mode');address(destinationOwner);roles=this.roles(roles);
    await this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);requireTrue(!r.value.pending&&!r.value.wallet!.operation&&r.value.wallet!.status==='active'&&!r.value.wallet!.emergencyEscapes?.some(e=>e.phase!=='settled'),'note unavailable for withdrawal');
      r.value.wallet!.operation={id:crypto.randomUUID(),kind:mode,phase:'proving',roles,destinationOwner,step:0,attempts:[],finalized:[]};
      if(mode==='mutual_close'){
        const {nullifier}=await this.o.prover.inspect(r.value.witness!,r.value.state);
        requireTrue(!r.value.wallet!.clearance||r.value.wallet!.clearance.nullifier===nullifier,'clearance state mismatch');
        r.value.wallet!.clearance??={nullifier,phase:'requested'};
      }
      r=await this.save(id,r);await this.build(id,r);
    });
  }
  /** Explicit challengeable escape from the last verified state during an
   * unresolved session. Archive every AUTH/inference byte before proving; this
   * is not clearance, settlement, cancellation, or permission to replay a send. */
  async beginEmergencyEscape(id:string,destinationOwner:string,roles:WalletRoles):Promise<void>{
    address(destinationOwner);roles=this.roles(roles);
    await this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);const w=r.value.wallet!,p=r.value.pending;
      requireTrue(w.status==='active'&&!w.operation&&p&&p.phase!=='prepared'
        &&!w.emergencyEscapes?.some(e=>e.phase!=='settled')&&!w.clearedAuthorization,
        'unresolved authorization on an active note required');
      const request=p.prepared.request,q=request.quote.body,m=this.o.manifest;
      requireTrue(p.exactRequest===JSON.stringify(request)&&request.authorization.deployment_id===m.deployment_id
        &&request.authorization.pool===m.pool&&q.deployment_id===m.deployment_id&&q.pool===m.pool
        &&request.authorization.mode===q.mode&&q.control_api_origin===m.control_api_origin
        &&q.inference_api_origin===m.inference_api_origin,'escape authorization deployment mismatch');
      requireTrue(request.public_inputs.length===12,'escape authorization inputs');request.public_inputs.forEach(parseField);
      const {nullifier}=await this.o.prover.inspect(r.value.witness!,r.value.state);
      requireTrue(request.public_inputs[8]===nullifier,'escape authorization nullifier mismatch');
      requireTrue(!w.clearance||w.clearance.phase==='requested'&&w.clearance.signature===undefined
        &&w.clearance.nullifier===nullifier,'escape conflicts with permanent clearance');
      const operationId=crypto.randomUUID();
      const archived=structuredClone(p);delete archived.providerKey;
      (w.emergencyEscapes??=[]).push({pending:archived,previous:structuredClone(r.value.state),
        nullifier,operationId,phase:'escaping'});
      r.value.pending=null;
      w.operation={id:operationId,kind:'initiate_escape',phase:'proving',roles,destinationOwner,step:0,attempts:[],finalized:[]};
      r=await this.save(id,r);await this.build(id,r);
    });
  }
  /** Reconcile an actual finalized challenge before recovering the old session.
   * Exact escape receipt plus a later authenticated Active/absent-Pending cut
   * establish restoration; absence alone never releases the financial fence.
   * Also handles challenge landing before the execute ACK/account observation. */
  async reconcileChallengedEscape(id:string):Promise<void>{
    await this.o.journal.withNoteLock(id,async()=>{
      const r=await this.record(id),w=r.value.wallet!,e=w.emergencyEscapes?.at(-1);
      requireTrue(e?.phase==='escaping'&&r.value.pending===null,'unresolved emergency escape required');
      const finalize=w.operation?.kind==='finalize_escape'?w.operation:undefined;
      const op=w.operation?.id===e.operationId?w.operation:w.history.find(o=>o.id===e.operationId);
      requireTrue(op?.id===e.operationId&&op.kind==='initiate_escape'&&op.plan
        &&(w.status==='pending_escape'&&(!w.operation||finalize)||w.status==='active'&&w.operation===op),
        'escape execute must be reconciled before challenge recovery');
      const finalizationRejections=async()=>{
        if(!finalize)return;
        requireTrue(!finalize.current||finalize.attempts.some(a=>a.signature===finalize.current),'missing finalization attempt');
        for(const a of finalize.attempts){
          requireTrue(a.kind==='finalize','invalid finalization history');
          requireTrue((await recoverFinalizationAttempt(a as FinalizationAttempt,this.o.rpc)).state==='rejected',
            'signed finalization must be finalized rejected before challenge recovery');
        }
      };
      await finalizationRejections();
      const attempt=op.attempts.find(a=>a.signature===(op.current??e.escape?.signature));
      requireTrue(attempt?.kind==='execute','saved escape execution required');
      const result=await recoverAttempt(attempt as Attempt,this.o.rpc);
      requireTrue(result.state==='finalized','exact escape execution is not finalized');
      requireTrue(!e.escape||e.escape.signature===attempt.signature&&e.escape.slot===result.slot,'escape receipt changed');
      const s=await this.o.chain.snapshot(r.value.witness!.note_id,'active',Math.max(result.slot,e.escape?.slot??0));
      await this.note(r,s);
      const sequence=e.escape?.sequence??(BigInt(op.plan.snapshotSequence)+1n).toString();
      requireTrue(Number.isSafeInteger(s.slot)&&s.slot>=result.slot&&s.slot>=(e.escape?.slot??0)
        &&s.note!.status==='active'&&!s.pending&&BigInt(s.sequence)>BigInt(sequence),
        'finalized challenge restoration not established');
      const {nullifier}=await this.o.prover.inspect(r.value.witness!,r.value.state);
      requireTrue(nullifier===e.nullifier,'escape state changed');
      // Recheck the exact receipt after the chain read; no new transaction is sent.
      const again=await recoverAttempt(attempt as Attempt,this.o.rpc);
      requireTrue(again.state==='finalized'&&again.slot===result.slot,'escape receipt changed');
      await finalizationRejections();
      if(finalize){finalize.phase='cancelled';delete finalize.current;w.history.push(finalize);delete w.operation;}
      if(w.operation===op){
        if(!op.finalized.some(f=>f.signature===attempt.signature))op.finalized.push({signature:attempt.signature,slot:result.slot});
        delete op.current;w.history.push(op);delete w.operation;
      }
      e.escape??={signature:attempt.signature,slot:result.slot,sequence};
      e.challenge={slot:s.slot,sequence:s.sequence};e.phase='challenged';w.status='active';
      r.value.pending={...structuredClone(e.pending),phase:'closing',closeRequested:true};
      await this.save(id,r);
    });
  }
  /** Resolve an unacknowledged AUTH only with the server's signed permanent N
   * clearance. A missing session or expired quote is never sufficient. This
   * sends neither AUTH nor inference/transactions; use beginWithdrawal after it.
   * Lost clearance responses can retry this same method after journal reopen. */
  async reconcileUnacceptedAuthorization(id:string):Promise<void>{
    await this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);const w=r.value.wallet!;
      const p=w.clearedAuthorization?.pending??r.value.pending;
      requireTrue(p?.phase==='send_unknown'&&p.operations.length===0
        &&p.providerKey===undefined&&p.serverState===undefined,'uncertain authorization without inference required');
      const request=p.prepared.request,q=request.quote.body,m=this.o.manifest;
      requireTrue(p.exactRequest===JSON.stringify(request),'saved authorization bytes changed');
      requireTrue(request.authorization.deployment_id===m.deployment_id&&request.authorization.pool===m.pool
        &&q.deployment_id===m.deployment_id&&q.pool===m.pool&&request.authorization.mode===q.mode
        &&q.control_api_origin===m.control_api_origin&&q.inference_api_origin===m.inference_api_origin,
        'clearance authorization deployment mismatch');
      requireTrue(Array.isArray(request.public_inputs)&&request.public_inputs.length===12,'clearance request public inputs');
      request.public_inputs.forEach(parseField);
      const {nullifier}=await this.o.prover.inspect(r.value.witness!,r.value.state);parseField(nullifier);
      requireTrue(request.public_inputs[8]===nullifier,'clearance authorization nullifier mismatch');
      requireTrue(!w.clearance||w.clearance.nullifier===nullifier,'clearance state mismatch');
      if(w.clearedAuthorization){
        requireTrue(r.value.pending===null&&w.clearance?.phase==='verified'&&w.clearance.signature,
          'invalid cleared authorization');
        await this.o.prover.verifyClearance(nullifier,w.clearance.signature);return;
      }
      requireTrue(w.status==='active'&&!w.operation,'note unavailable for authorization clearance');
      if(!w.clearance){w.clearance={nullifier,phase:'requested'};r=await this.save(id,r);}
      r=await this.clearance(id,r);
      // The durable signature is the fence against any delayed/racing AUTH.
      // Archive and release the pending slot in one encrypted CAS, retaining
      // every original request/credential byte and the unchanged prior state.
      r.value.wallet!.clearedAuthorization={pending:structuredClone(r.value.pending!),previous:structuredClone(r.value.state)};
      r.value.pending=null;await this.save(id,r);
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
    if(op.kind==='mutual_close'&&(op.expiredCreations?.length??0)>0)await this.verifyMutualSetupRecovery(r);
    if(op.kind==='initiate_escape'&&(op.expiredCreations?.length??0)>0)await this.verifyEscapeSetupRecovery(r);
    let minimumSlot=0;
    if(op.transport==='v0_inline_deposit_v1'){
      this.inlinePins(op.inlineContext);
      requireTrue(op.kind==='deposit'&&op.attempts.every(a=>a.kind==='deposit_inline'),'inline operation history mismatch');
      for(const attempt of op.attempts){
        const evidence=op.rejectedInline?.find(e=>e.signature===attempt.signature);
        requireTrue(evidence,'inline attempt requires exact finalized rejection before reproof');
        const result=await recoverInlineDepositAttempt(attempt as InlineDepositAttempt,this.o.rpc);
        requireTrue(result.state==='rejected'&&result.slot===evidence.slot,'inline rejection no longer verifiable');
        minimumSlot=Math.max(minimumSlot,evidence.slot);
      }
      // Keep the approved fee across reproof and restarts. Older journals may
      // omit this field, so first recover it from their immutable saved attempt.
      if(op.priorityFeeMicroLamports===undefined){
        const previous=op.attempts.at(-1) as InlineDepositAttempt|undefined;
        op.priorityFeeMicroLamports=previous?(previous.plan.priorityFeeMicroLamports??'0'):(this.o.priorityFeeMicroLamports??0n).toString();
        r=await this.save(id,r);op=r.value.wallet!.operation!;
      }
    }
    for(const evidence of op.expiredCreations??[]){
      const attempt=op.attempts.find(a=>a.signature===evidence.signature);
      requireTrue((op.kind==='deposit'||op.kind==='mutual_close'||op.kind==='initiate_escape')&&attempt?.kind==='create'&&evidence.buffer===(attempt as Attempt).buffer
        &&Number.isSafeInteger(evidence.slot)&&evidence.slot>=(attempt as Attempt).plan.snapshotSlot
        &&Number.isSafeInteger(evidence.blockHeight)&&evidence.blockHeight>attempt.lastValidBlockHeight,
        'invalid creation recovery evidence');
      minimumSlot=Math.max(minimumSlot,evidence.slot);
    }
    const s=snapshot??await this.o.chain.snapshot(op.kind==='deposit'?undefined:r.value.witness!.note_id,op.kind==='deposit'?'zero':'active',minimumSlot);
    requireTrue(Number.isSafeInteger(s.slot)&&s.slot>=minimumSlot,'stale creation recovery snapshot');
    requireTrue(!s.paused,'pool paused');
    let note:PublicNote;
    if(op.kind==='deposit'){
      const expiry=((BigInt(s.clock)+BigInt(this.o.manifest.note_ttl_seconds)+86399n)/86400n*86400n).toString();
      if(r.value.witness!.note_id!==s.nextNoteId||r.value.witness!.expiry!==expiry){
        const c=await this.o.prover.rebaseDeposit(r.value.witness!,s.nextNoteId,expiry);r.value.witness=c.witness;r.value.state=c.state;r=await this.save(id,r);op=r.value.wallet!.operation!;
      }
      const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);note={note_id:s.nextNoteId,registration_commitment:identity.registration_commitment,deposit_micro_usdc:r.value.witness!.deposit_micro_usdc,expiry};
    }else{note=await this.note(r,s);requireTrue(s.note!.status==='active','note not active');
      if((op.kind==='mutual_close'||op.kind==='initiate_escape')&&(op.expiredCreations?.length??0)>0)requireTrue(!s.pending,'note not active');}
    if(op.kind==='mutual_close'){r=await this.clearance(id,r);op=r.value.wallet!.operation!;}
    const tree=await this.o.prover.tree(note,s.root,s.siblings,op.kind==='deposit'?0:1);
    let nullifier:string|undefined;
    let payload:Uint8Array;
    if(op.kind==='deposit')payload=encodeLayout2Args({operation:'deposit',expectedId:note.note_id,expectedRoot:s.root,expiry:BigInt(note.expiry),commitment:note.registration_commitment,amount:BigInt(note.deposit_micro_usdc),tree});
    else{
      requireTrue(op.kind==='mutual_close'||op.kind==='initiate_escape','invalid proof operation');
      const auth=await this.o.prover.withdrawal(r.value.witness!,r.value.state,s.root,s.siblings,address(op.destinationOwner!),op.kind==='mutual_close'?r.value.wallet!.clearance!.signature!:null);
      nullifier=auth.public_inputs[11];payload=encodeLayout2Args({operation:op.kind,auth,tree});
    }
    const m=this.o.manifest,roles=op.roles,operation=op.kind;
    const financial=await vaultAccounts({programId:address(m.program_id),pool:address(m.pool),mint:address(m.mint),payer:address(roles.payer),noteId:note.note_id,operation,tokenOwner:roles.tokenOwner?address(roles.tokenOwner):undefined,destinationOwner:op.destinationOwner?address(op.destinationOwner):undefined,treasuryOwner:address(s.treasuryOwner),nullifier:nullifier?parseField(nullifier):undefined});
    if(op.transport==='v0_inline_deposit_v1'){
      requireTrue(supportsInlineDeposit(m)&&r.value.schema===2,'inline capability unavailable');
      const plan=await buildInlineDepositPlan({deploymentId:m.deployment_id,manifestHash:m.manifest_hash,vaultBinding:m.vault_binding,programId:address(m.program_id),pool:address(m.pool),feePayer:address(roles.feePayer),payload,financial,snapshot:{slot:s.slot,sequence:BigInt(s.sequence)},priorityFeeMicroLamports:BigInt(op.priorityFeeMicroLamports!)});
      op.inlinePlan=snapshotInlineDepositPlan(plan);
    }else{
      requireTrue(roles.uploader&&roles.rentPayer,'explicit buffer roles required');
      const plan=await buildUploadPlan({programId:address(m.program_id),pool:address(m.pool),uploader:address(roles.uploader),rentPayer:address(roles.rentPayer),feePayer:address(roles.feePayer),nonce:crypto.getRandomValues(new Uint8Array(32)),expires:BigInt(s.clock)+3600n,operation,payload,priorityFeeMicroLamports:this.o.priorityFeeMicroLamports,financial,snapshot:{slot:s.slot,sequence:BigInt(s.sequence)}});
      op.plan=snapshotPlan(plan);
    }
    op.phase='ready';op.step=0;return this.save(id,r);
  }
  async resumeProof(id:string):Promise<void>{await this.o.journal.withNoteLock(id,async()=>{await this.build(id,await this.record(id));});}
  /** A close setup may only be replaced with the same permanently cleared state.
   * This check does not fetch/request a new clearance or change the journal. */
  private async verifyMutualSetupRecovery(r:JournalRecord<NoteJournal>):Promise<void>{
    const w=r.value.wallet!,op=w.operation;
    requireTrue(r.value.pending===null&&w.status==='active'&&op?.kind==='mutual_close'&&op.destinationOwner
      &&w.clearance?.phase==='verified'&&w.clearance.signature,'verified mutual-close setup required');
    const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);
    requireTrue(w.clearance.nullifier===identity.nullifier,'clearance state mismatch');
    await this.o.prover.verifyClearance(w.clearance.nullifier,w.clearance.signature);
  }
  /** Match the current authenticated private state and selected destination to
   * every signed escape payload, including after a crash interrupted reproof.
   * A never-landed buffer create still commits to that immutable payload hash. */
  private async verifyEscapeSetupRecovery(r:JournalRecord<NoteJournal>):Promise<void>{
    const w=r.value.wallet!,op=w.operation,m=this.o.manifest,witness=r.value.witness!;
    requireTrue(r.value.pending===null&&w.status==='active'&&op?.kind==='initiate_escape'&&op.destinationOwner
      &&op.attempts.length>0,'same-state escape setup required');
    const identity=await this.o.prover.inspect(witness,r.value.state),destination=address(op.destinationOwner);
    const expectedDestination=await destinationBinding(new Uint8Array(getAddressEncoder().encode(destination)));
    const financial=await vaultAccounts({programId:address(m.program_id),pool:address(m.pool),mint:address(m.mint),
      payer:address(op.roles.payer),noteId:witness.note_id,operation:'initiate_escape',destinationOwner:destination,nullifier:parseField(identity.nullifier)});
    const integer=(n:string|number)=>'0x'+BigInt(n).toString(16).padStart(64,'0');
    for(const saved of op.attempts){
      requireTrue(saved.kind!=='deposit_inline'&&saved.kind!=='finalize','invalid escape attempt');
      const plan=await restorePlan(saved.plan),at=(index:number)=>'0x'+saved.plan.payloadHex.slice(index*64,(index+1)*64);
      requireTrue(plan.operation==='initiate_escape'&&plan.programId===m.program_id&&plan.pool===m.pool
        &&plan.uploader===op.roles.uploader&&plan.rentPayer===op.roles.rentPayer
        &&plan.feePayer===op.roles.feePayer
        &&Object.entries(financial).every(([key,value])=>plan.financial[key as keyof typeof financial]===value),
        'escape destination or financial roles changed');
      requireTrue(at(8)===integer(witness.note_id)&&at(9)===integer(r.value.state.balance_micro_usdc)
        &&at(10)===expectedDestination&&at(11)===identity.nullifier&&at(12)===integer(0)
        &&at(22+6)===identity.registration_commitment&&at(22+7)===integer(witness.deposit_micro_usdc)
        &&at(22+8)===integer(witness.expiry),'signed escape state changed');
    }
  }
  /** Explicit deposit/withdrawal setup recovery, without signing or sending. Every old
   * create must be finalized-expired with no receipt and an absent buffer at a
   * finalized block beyond its validity. Preserve each signed attempt and the
   * absence evidence before rebuilding the proof and buffer expiry. */
  async reconcileExpiredCreation(id:string):Promise<void>{
    await this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);const w=r.value.wallet!,op=w.operation;
      requireTrue(r.value.pending===null&&op&&((w.status==='unfunded'&&op.kind==='deposit')||(w.status==='active'&&(op.kind==='mutual_close'||op.kind==='initiate_escape')))&&op.phase==='ready'
        &&op.step===0&&op.finalized.length===0&&op.finalization===undefined&&op.plan&&op.current
        &&op.attempts.length>0&&op.attempts.at(-1)!.signature===op.current
        &&op.attempts.every(a=>a.kind==='create'),'unresolved deposit or withdrawal creation required');
      if(op.kind==='mutual_close')await this.verifyMutualSetupRecovery(r);
      if(op.kind==='initiate_escape')await this.verifyEscapeSetupRecovery(r);
      requireTrue(this.o.chain.bufferObservation,'finalized buffer observation unavailable');
      const current=op.attempts.at(-1)! as Attempt,active=await restorePlan(op.plan);
      requireTrue(JSON.stringify(snapshotPlan(active))===JSON.stringify(snapshotPlan(await restorePlan(current.plan))),
        'current creation plan mismatch');
      const evidence:NonNullable<WalletOperation['expiredCreations']>=[];
      let minimumSlot=active.snapshot.slot;
      for(const saved of op.attempts){
        const attempt=saved as Attempt,plan=await restorePlan(attempt.plan);
        requireTrue(plan.operation===op.kind&&plan.programId===this.o.manifest.program_id
          &&plan.pool===this.o.manifest.pool,'creation deployment mismatch');
        requireTrue((await recoverAttempt(attempt,this.o.rpc)).state==='expired_reconcile_required','creation expiry or history unresolved');
        const observed=await this.o.chain.bufferObservation(plan,Math.max(minimumSlot,plan.snapshot.slot));
        requireTrue(observed.commitment==='finalized'&&observed.address===plan.buffer
          &&observed.account===null&&Number.isSafeInteger(observed.slot)&&observed.slot>=minimumSlot&&observed.slot>=plan.snapshot.slot
          &&Number.isSafeInteger(observed.blockHeight)&&observed.blockHeight>attempt.lastValidBlockHeight
          &&typeof observed.blockhash==='string'&&address(observed.blockhash)===observed.blockhash,
          'creation absence is not finalized beyond expiry');
        // Recheck history after the anchored account read. No missing account
        // substitutes for exact signature validation or the expiry barrier.
        requireTrue((await recoverAttempt(attempt,this.o.rpc)).state==='expired_reconcile_required','creation expiry or history unresolved');
        evidence.push({signature:attempt.signature,buffer:attempt.buffer,slot:observed.slot,blockHeight:observed.blockHeight,blockhash:observed.blockhash});
        minimumSlot=observed.slot;
      }
      const snapshot=await this.o.chain.snapshot(op.kind==='deposit'?undefined:r.value.witness!.note_id,op.kind==='deposit'?'zero':'active',minimumSlot);
      requireTrue(Number.isSafeInteger(snapshot.slot)&&snapshot.slot>=minimumSlot,'stale creation recovery snapshot');
      if(op.kind==='mutual_close'||op.kind==='initiate_escape'){await this.note(r,snapshot);requireTrue(snapshot.note!.status==='active'&&!snapshot.pending,'note not active');}
      op.expiredCreations=[...(op.expiredCreations??[]),...evidence];op.phase='proving';delete op.current;delete op.plan;op.step=0;
      r=await this.save(id,r);
      await this.build(id,r,snapshot);
    });
  }
  /** Explicit retry after the cause of a finalized rejection has been addressed.
   * Recheck that exact signature before replacing any transaction. Unknown or
   * expired attempts cannot enter this path, and existing buffers close before
   * a new proof is built. Witness, destination and permanent clearance stay put. */
  async retryRejected(id:string):Promise<void>{
    await this.o.journal.withNoteLock(id,async()=>{
      const r=await this.record(id),op=r.value.wallet!.operation;
      requireTrue(op&&(op.phase==='failed'||op.transport==='v0_inline_deposit_v1'&&op.phase==='stale')&&!op.current,'finalized rejected operation required');
      const attempt=op.attempts.at(-1);requireTrue(attempt,'missing rejected attempt');
      const result=attempt.kind==='finalize'
        ?await recoverFinalizationAttempt(attempt as FinalizationAttempt,this.o.rpc)
        :attempt.kind==='deposit_inline'?await recoverInlineDepositAttempt(attempt,this.o.rpc)
        :await recoverAttempt(attempt as Attempt,this.o.rpc);
      requireTrue(result.state==='rejected','exact rejection must be finalized before retry');
      if(op.transport==='v0_inline_deposit_v1'){
        op.rejectedInline=[...(op.rejectedInline??[]).filter(e=>e.signature!==attempt.signature),{signature:attempt.signature,slot:result.slot}];
        op.priorityFeeMicroLamports??=op.inlinePlan!.priorityFeeMicroLamports??'0';
        op.phase='proving';delete op.inlinePlan;op.step=0;
      }else if(op.kind==='finalize_escape'){
        const s=await this.o.chain.snapshot(r.value.witness!.note_id,'zero',result.slot);await this.note(r,s);
        const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);
        requireTrue(s.note?.status==='pending_escape'&&s.pending?.nullifier===identity.nullifier
          &&s.pending.destinationOwner===op.destinationOwner&&s.pending.balance_micro_usdc===r.value.state.balance_micro_usdc
          &&BigInt(s.clock)>=BigInt(s.pending.deadline),'saved escape is not ready to finalize');
        const m=this.o.manifest,financial=await vaultAccounts({programId:address(m.program_id),pool:address(m.pool),mint:address(m.mint),payer:address(op.roles.payer),operation:'finalize_escape',noteId:r.value.witness!.note_id,destinationOwner:address(op.destinationOwner!),treasuryOwner:address(s.treasuryOwner)});
        op.finalization!.financial={...financial};
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
      const m=this.o.manifest,financial=await vaultAccounts({programId:address(m.program_id),pool:address(m.pool),mint:address(m.mint),payer:address(roles.payer),operation:'finalize_escape',noteId:r.value.witness!.note_id,destinationOwner:address(s.pending.destinationOwner),treasuryOwner:address(s.treasuryOwner)});
      r.value.wallet!.operation={id:crypto.randomUUID(),kind:'finalize_escape',phase:'ready',roles,destinationOwner:s.pending.destinationOwner,step:0,attempts:[],finalized:[],finalization:{programId:m.program_id,pool:m.pool,noteId:r.value.witness!.note_id,feePayer:roles.feePayer,financial:{...financial},snapshotSlot:s.slot,snapshotSequence:s.sequence}};
      r=await this.save(id,r);
    });
  }
  /** Explicit recovery dispatch of the exact durable bytes. Never signs,
   * refreshes blockhash/proof, or changes the financial operation. */
  async resendIdenticalDeposit(id:string):Promise<Recovery>{
    return this.o.journal.withNoteLock(id,async()=>{
      const r=await this.record(id),op=r.value.wallet!.operation;
      requireTrue(op?.transport==='v0_inline_deposit_v1'&&op.phase==='ready'&&op.current,'unresolved inline deposit required');
      const attempt=op.attempts.find(a=>a.signature===op.current);requireTrue(attempt?.kind==='deposit_inline','missing saved inline attempt');
      return recoverInlineDepositAttempt(attempt,this.o.rpc,true);
    });
  }
  /** One bounded sign/recover step. Call again when pending; never loops inference or switches mode. */
  async advance(id:string):Promise<Recovery|{state:'ready'|'proof_required'|'complete'}>{
    return this.o.journal.withNoteLock(id,async()=>{
      let r=await this.record(id);let op=r.value.wallet!.operation;requireTrue(op,'no financial operation');
      requireTrue(op.phase!=='failed'&&!(op.transport==='v0_inline_deposit_v1'&&op.phase==='stale'),'finalized rejection requires explicit review');
      if(op.phase==='proving')return {state:'proof_required'};
      const saveAttempt=async(attempt:FinancialAttempt)=>{
        requireTrue(!op!.attempts.some(a=>a.signature===attempt.signature),'duplicate financial signature');
        op!.attempts.push(structuredClone(attempt));op!.current=attempt.signature;r=await this.save(id,r);op=r.value.wallet!.operation!;
      };
      let attempt=op.attempts.find(a=>a.signature===op!.current);
      let freshInline=false;
      if(!attempt){
        if(op.transport==='v0_inline_deposit_v1'){
          requireTrue(op.inlinePlan,'missing prepared inline proof');
          const m=this.o.manifest,p=op.inlinePlan;
          requireTrue(supportsInlineDeposit(m)&&p.deploymentId===m.deployment_id&&p.manifestHash===m.manifest_hash&&p.programId===m.program_id&&p.pool===m.pool&&p.mint===m.mint&&p.vaultBinding===m.vault_binding,'inline deployment pins changed');
          // Refresh only an unsigned preparation. A signed prior attempt is
          // permitted here solely after retryRejected has persisted its receipt.
          const latest=await this.o.chain.snapshot(undefined,'zero',p.snapshotSlot);
          const expiry=((BigInt(latest.clock)+BigInt(m.note_ttl_seconds)+86399n)/86400n*86400n).toString();
          requireTrue(!latest.paused&&latest.slot>=p.snapshotSlot,'invalid pre-sign snapshot');
          if(latest.root.slice(2)!==p.expectedRoot||latest.nextNoteId!==p.expectedNoteId||expiry!==p.expiry){
            op.priorityFeeMicroLamports??=p.priorityFeeMicroLamports??'0';
            op.phase='proving';delete op.inlinePlan;r=await this.save(id,r);await this.build(id,r,latest);return {state:'ready'};
          }
          const plan=await restoreInlineDepositPlan(p);
          attempt=await prepareInlineDepositAttempt(plan,await this.o.chain.blockhash(),this.signers(plan.steps[0].instruction,plan.feePayer),{save:saveAttempt});freshInline=true;
        }else if(op.kind==='finalize_escape'){
          const p=op.finalization!;
          const plan:FinalizationPlan={programId:address(p.programId),pool:address(p.pool),noteId:p.noteId,feePayer:address(p.feePayer),financial:Object.fromEntries(Object.entries(p.financial).map(([k,v])=>[k,address(v)])) as FinalizationPlan['financial'],snapshot:{slot:p.snapshotSlot,sequence:BigInt(p.snapshotSequence)}};
          const step=await finalizeEscape(plan.programId,plan.financial,plan.noteId);
          attempt=await prepareFinalizationAttempt(plan,await this.o.chain.blockhash(),this.signers(step.instruction,plan.feePayer),{save:saveAttempt});
        }else{
          requireTrue(op.plan,'missing prepared proof');const plan=await restorePlan(op.plan);
          if(op.phase==='stale'){op.phase='closing_stale';r=await this.save(id,r);op=r.value.wallet!.operation!;}
          const step=op.phase==='closing_stale'?await closePayload(plan):plan.steps[op.step];requireTrue(step,'invalid upload step');
          attempt=await prepareAttempt(plan,step,await this.o.chain.blockhash(),this.signers(step.instruction,plan.feePayer),{save:saveAttempt});
        }
      }
      let recovery=attempt.kind==='deposit_inline'?await recoverInlineDepositAttempt(attempt,this.o.rpc,freshInline):attempt.kind==='finalize'?await recoverFinalizationAttempt(attempt as FinalizationAttempt,this.o.rpc,true):await recoverAttempt(attempt as Attempt,this.o.rpc,true);
      if(recovery.state==='expired_reconcile_required'&&!['execute','close','finalize','deposit_inline'].includes(attempt.kind)){
        const plan=await restorePlan((attempt as Attempt).plan);
        const tx=getTransactionDecoder().decode(fromHex(attempt.wireHex,attempt.wireHex.length/2)),required=new Set(Object.keys(tx.signatures));
        const refreshed=await refreshExpiredUpload(attempt as Attempt,this.o.rpc,await this.o.chain.buffer(plan),await this.o.chain.blockhash(),this.o.wallets.filter(w=>required.has(w.publicKey)),{save:saveAttempt});
        if('next'in refreshed){op!.step=plan.steps.findIndex(s=>s===refreshed.next||s.kind===refreshed.next.kind&&s.offset===refreshed.next.offset);requireTrue(op!.step>=0,'invalid recovered upload prefix');delete op!.current;r=await this.save(id,r);return {state:'ready'};}
        return recoverAttempt(refreshed,this.o.rpc,true);
      }
      if(recovery.state==='rejected'){
        op!.phase=recovery.needsNewProof?'stale':'failed';delete op!.current;await this.save(id,r);return recovery;
      }
      if(recovery.state!=='finalized')return recovery;
      op!.finalized.push({signature:attempt.signature,slot:recovery.slot});delete op!.current;
      if(attempt.kind==='close'&&op!.phase==='closing_stale'){op!.phase='proving';op!.plan=undefined;op!.step=0;await this.save(id,r);return {state:'proof_required'};}
      if(attempt.kind!=='execute'&&attempt.kind!=='finalize'&&attempt.kind!=='deposit_inline'){op!.step++;await this.save(id,r);return {state:'ready'};}
      // Receipt success is necessary; actual finalized Note binding is also required before activation.
      const snapshot=await this.o.chain.snapshot(r.value.witness!.note_id,'none',recovery.slot);requireTrue(Number.isSafeInteger(snapshot.slot)&&snapshot.slot>=recovery.slot,'stale finalized financial snapshot');await this.note(r,snapshot);
      const status=op!.kind==='deposit'?'active':op!.kind==='initiate_escape'?'pending_escape':'closed';requireTrue(snapshot.note!.status===status,'finalized financial account state mismatch');
      if(status==='pending_escape'){
        const identity=await this.o.prover.inspect(r.value.witness!,r.value.state);
        requireTrue(snapshot.pending?.nullifier===identity.nullifier&&snapshot.pending.destinationOwner===op!.destinationOwner&&snapshot.pending.balance_micro_usdc===r.value.state.balance_micro_usdc,'finalized Pending mismatch');
        const emergency=r.value.wallet!.emergencyEscapes?.find(e=>e.operationId===op!.id);
        if(emergency){requireTrue(emergency.phase==='escaping'&&emergency.nullifier===identity.nullifier,'emergency escape identity mismatch');emergency.escape={signature:attempt.signature,slot:recovery.slot,sequence:snapshot.sequence};}
      }
      r.value.wallet!.status=status;r.value.wallet!.history.push(op!);delete r.value.wallet!.operation;await this.save(id,r);return {state:'complete'};
    });
  }
}
