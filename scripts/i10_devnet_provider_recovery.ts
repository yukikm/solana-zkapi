/** Read-only verification before ordinary WalletClient withdrawal of a failed
 * provider case. Signed waiver/settlement is not successful provider acceptance.
 * This module has no journal writer, HTTP client, budget mutation or send path. */
import {createHash} from 'node:crypto';
import {validateNoteJournal, type NoteJournal, type SessionVerifier, type Tariff,
  type VerificationContext} from '../packages/sdk/src/control.ts';
import {jcsBytes} from '../packages/sdk/src/trust.ts';
import {validateProviderSelection,demoBudgetTemplate} from './i10_devnet_provider.ts';
import {providerAcceptanceBody, type ProviderAcceptanceCase} from './provider_acceptance_client.ts';

export interface ProviderRecoveryPlan {
  schema:1;campaign_id:string;budget_micro_usdc:string;max_requests:number;
  models:{profile:unknown;tariff:Tariff;sources:unknown[]}[];cases:ProviderAcceptanceCase[];
}
export interface SettledProviderRecoveryInput {
  note:NoteJournal;context:VerificationContext;verifier:SessionVerifier;
  plan:ProviderRecoveryPlan;selection:unknown;profile:string;tariffs:Tariff[];
  /** Fresh output of budget-status against the full immutable parent plan. */
  budget:unknown;caseId:string;
}
export class ProviderRecoveryVerificationError extends Error {
  constructor(){super('Settled provider recovery verification failed; preserve journal and budget without replay.');}
}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const same=(a:unknown,b:unknown)=>Buffer.from(jcsBytes(a)).equals(Buffer.from(jcsBytes(b)));
function requireTrue(v:unknown):asserts v{if(!v)throw new ProviderRecoveryVerificationError();}
function object(v:unknown):Record<string,unknown>{requireTrue(v!==null&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,unknown>;}
function exact(v:Record<string,unknown>,keys:string[]){requireTrue(same(Object.keys(v).sort(),keys.sort()));}
function units(v:unknown,max=10_000_000n):bigint{requireTrue(typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&v.length<=38);const n=BigInt(v);requireTrue(n<=max);return n;}
function uuid(v:unknown):asserts v is string{requireTrue(typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v));}

type RecoveryCampaignInput=Pick<SettledProviderRecoveryInput,'plan'|'selection'|'profile'|'tariffs'|'budget'|'caseId'|'context'>;
/** Shared exact selection and append-only campaign accounting checks. */
function verifyRecoveryCampaign(o:RecoveryCampaignInput,selectedReservationPresent=true){
  const planHash=sha(jcsBytes(o.plan)),execution=validateProviderSelection(o.plan,o.selection,o.profile);
  requireTrue(execution.cases.length===1&&execution.cases[0].id===o.caseId
    &&same(o.tariffs,execution.models.map(m=>m.tariff)));
  const c=execution.cases[0];
  const selectedTariffs=o.tariffs.filter(t=>t.provider===c.provider&&t.model===(c.mode==='proxy'?c.model:'*'));
  requireTrue(selectedTariffs.length===1);const tariff=selectedTariffs[0];
  requireTrue(o.context.tariff_hashes.includes(tariff.tariff_hash));
  const b=object(o.budget),identity=object(b.identity);
  exact(b,['identity','reserved_micro_usdc','remaining_micro_usdc','reservations','refunds_supported','inference_replays_supported']);
  exact(identity,['schema','campaign_id','plan_sha256','budget_micro_usdc','max_requests']);
  const cap=units(o.plan.budget_micro_usdc);
  requireTrue(cap>0n&&identity.schema===1&&identity.plan_sha256===planHash&&identity.campaign_id===o.plan.campaign_id
    &&identity.budget_micro_usdc===o.plan.budget_micro_usdc&&identity.max_requests===o.plan.max_requests
    &&Number.isSafeInteger(o.plan.max_requests)&&o.plan.max_requests>0&&o.plan.max_requests<=1000
    &&b.refunds_supported===false&&b.inference_replays_supported===false&&Array.isArray(b.reservations)
    &&b.reservations.length<=o.plan.max_requests);
  const planned=new Map(o.plan.cases.map(row=>[row.id,row]));requireTrue(planned.size===o.plan.cases.length);
  const seen=new Set<string>(),demoSessions=new Set<string>();let reserved=0n;
  for(const value of b.reservations){
    const row=object(value),template=demoBudgetTemplate(row);
    requireTrue(typeof row.case_id==='string'&&!seen.has(row.case_id));seen.add(row.case_id);
    if(template){requireTrue(!planned.has(row.case_id)&&!demoSessions.has(row.request_id as string));demoSessions.add(row.request_id as string);}
    const expected=planned.get(template??row.case_id);requireTrue(expected&&row.max_cost_micro_usdc===expected.max_cost_micro_usdc
    &&row.state==='reserved_no_automatic_replay');
    if(template)requireTrue(expected.mode==='proxy'&&expected.provider==='openai'&&expected.endpoint==='chat_completions'&&!expected.stream&&!expected.tools);
    const amount=units(row.max_cost_micro_usdc);requireTrue(amount>0n);reserved+=amount;
  }
  requireTrue(seen.has(c.id)===selectedReservationPresent&&reserved<=cap&&units(b.reserved_micro_usdc)===reserved&&units(b.remaining_micro_usdc)===cap-reserved);
  return {planHash,c,tariff};
}

export interface UnstartedProviderRecoveryInput extends RecoveryCampaignInput {
  note:NoteJournal;
  /** Parsed immutable provider-case failure file from the existing run. */
  failure:unknown;
  /** Original amount from the existing lifecycle configuration, never a new deposit. */
  depositMicroUsdc:string;
}
/** A quote failure is local absence evidence only. This function grants no
 * financial authority: WalletClient must still obtain permanent clearance and
 * verify the finalized Note/proof. No HTTP, journal or budget mutation occurs. */
export function verifyUnstartedProviderCase(input:UnstartedProviderRecoveryInput){
  try{
    const o=structuredClone(input),n=o.note;
    validateNoteJournal(n);
    requireTrue(n.witness&&n.pending===null&&n.history.length===0&&n.wallet
      &&['active','closed'].includes(n.wallet.status)&&n.wallet.clearedAuthorization===undefined
      &&(!n.wallet.operation||n.wallet.status==='active'&&n.wallet.operation.kind==='mutual_close'));
    // This narrow runner path begins with its recorded deposit, not an import
    // or an escape. A completed mutual close preserves the same private state.
    const kinds=n.wallet.history.map(entry=>entry.kind);
    requireTrue(same(kinds,n.wallet.status==='closed'?['deposit','mutual_close']:['deposit']));
    const deposit=units(o.depositMicroUsdc,0xffffffffffffffffn),cap=units(o.context.cap_micro_usdc);
    requireTrue(deposit>0n&&cap>0n&&deposit>=cap&&n.witness.deposit_micro_usdc===o.depositMicroUsdc
      &&n.state.balance_micro_usdc===o.depositMicroUsdc&&n.state.state_signature===null
      &&n.state.anchor==='0x'+'0'.repeat(63)+'1'
      &&typeof o.context.deployment_id==='string'&&o.context.deployment_id.length>0
      &&typeof o.context.pool==='string'&&o.context.pool.length>0);
    // quote precedes proof/reserve; any selected reservation contradicts this narrow checkpoint.
    const {planHash,c,tariff}=verifyRecoveryCampaign(o,false);
    const f=object(o.failure);exact(f,['schema','passed','scope','case_id','plan_sha256','diagnostic','full_g3_passed']);
    requireTrue(f.schema===1&&f.passed===false&&f.full_g3_passed===false&&f.case_id===c.id&&f.plan_sha256===planHash
      &&f.scope==='sanitized SDK provider-case failure checkpoint; no replay or refund authority');
    const d=object(f.diagnostic);exact(d,['schema','stage','elapsed_ms','control_http_status','inference','settlement','inference_replays']);
    requireTrue(d.schema===1&&d.stage==='quote'&&d.control_http_status===503&&d.inference===null
      &&d.settlement==='not_started'&&d.inference_replays===0&&Number.isSafeInteger(d.elapsed_ms)
      &&Number(d.elapsed_ms)>=0&&Number(d.elapsed_ms)<=2_147_483_647);
    return {schema:1,passed:true,scope:'read-only quote-failure and initial-journal checks for ordinary wallet withdrawal; no cryptographic absence or provider acceptance claim',
      plan_sha256:planHash,case_id:c.id,profile:o.profile,deployment_id:o.context.deployment_id,pool:o.context.pool,
      tariff_hash:tariff.tariff_hash,mode:c.mode,provider:c.provider,model:c.model,
      failure_checkpoint_sha256:sha(jcsBytes(f)),failure_stage:'quote',control_http_status:503,
      deposit_micro_usdc:o.depositMicroUsdc,case_max_micro_usdc:c.max_cost_micro_usdc,
      saved_authorization_present:false,settled_sessions:0,budget_reservation_present:false,budget_reservation_created:false,
      permanent_clearance_required:true,cryptographic_absence_verified:false,
      inference_sent_by_verifier:false,journal_modified:false,provider_acceptance_passed:false,full_g3_passed:false};
  }catch{throw new ProviderRecoveryVerificationError();}
}

export async function verifySettledProviderCase(input:SettledProviderRecoveryInput){
  try{
    // The verifier is supplied by the caller's verified native installation.
    // Everything it verifies is detached before the first asynchronous call.
    const {verifier,...values}=input,o=structuredClone(values),n=o.note;
    validateNoteJournal(n);
    requireTrue(n.witness&&n.pending===null&&n.history.length===1&&n.wallet
      &&['active','closed'].includes(n.wallet.status)&&!n.wallet.clearedAuthorization
      &&(!n.wallet.operation||n.wallet.operation.kind==='mutual_close'));
    const {planHash,c,tariff}=verifyRecoveryCampaign(o),body=providerAcceptanceBody(c);
    const h=n.history[0],a=h.prepared.request.authorization,q=h.prepared.request.quote.body;
    uuid(a.request_id);
    requireTrue(a.mode===c.mode&&a.deployment_id===o.context.deployment_id&&a.pool===o.context.pool
      &&q.deployment_id===o.context.deployment_id&&q.pool===o.context.pool&&q.mode===c.mode&&q.provider===c.provider
      &&same(q.models,[tariff.model])&&q.tariff_hash===tariff.tariff_hash&&same(h.prepared.tariff,tariff)
      &&q.cap_micro_usdc===o.context.cap_micro_usdc&&q.session_ttl_seconds===String(c.session_ttl_seconds)
      &&q.control_api_origin===o.context.control_api_origin&&q.inference_api_origin===o.context.inference_api_origin
      &&h.operations.length===1&&h.receipts.length===1);
    const operation=h.operations[0],receipt=h.receipts[0],r=receipt.body;
    uuid(operation.id);uuid(r.receipt_id);
    const path={chat_completions:'/v1/chat/completions',responses:'/v1/responses',messages:'/v1/messages'}[c.endpoint];
    requireTrue(operation.path===path&&operation.phase==='send_unknown'
      &&operation.anthropicVersion===(c.provider==='anthropic'?'2023-06-01':'')
      &&operation.bodyBase64===Buffer.from(body).toString('base64')
      &&r.deployment_id===o.context.deployment_id&&r.pool===o.context.pool&&r.request_id===a.request_id
      &&r.operation_id===(c.mode==='proxy'?operation.id:null)&&r.billing_effect==='charge'
      &&r.tariff_hash===tariff.tariff_hash&&/^[0-9a-f]{64}$/.test(receipt.receipt_hash));
    const charge=units(h.settlement.charge_micro_usdc),caseMax=units(c.max_cost_micro_usdc);
    const operationReservation=units(r.reservation_nano_usdc,10_000_000_000n);
    requireTrue(charge<=caseMax&&charge<=units(o.context.cap_micro_usdc)
      &&operationReservation>0n&&operationReservation<=caseMax*1000n&&operationReservation<=units(o.context.cap_micro_usdc)*1000n
      &&(c.mode==='proxy'||operationReservation===units(o.context.cap_micro_usdc)*1000n)
      &&units(h.previous.balance_micro_usdc,0xffffffffffffffffn)-units(n.state.balance_micro_usdc,0xffffffffffffffffn)===charge
      &&h.previous.anchor!==n.state.anchor);
    const waived=r.reason==='waived_unknown';
    if(waived)requireTrue(c.mode==='proxy'&&r.evidence_kind==='UNKNOWN_OPERATOR_LOSS'&&charge===0n&&r.charged_nano_usdc==='0');
    else{
      const kind=c.mode==='proxy'?'PROXY_USAGE':c.mode==='direct_oa'?'OA_SIGNED_RECEIPT':'OPENROUTER_USAGE';
      requireTrue(r.reason==='metered'&&r.evidence_kind===kind&&typeof r.provider_evidence_digest==='string'
        &&/^[0-9a-f]{64}$/.test(r.provider_evidence_digest));
    }
    const next=await verifier.settle(o.context,h.previous,h.prepared,h.settlement,h.receipts,c.mode==='proxy'?[operation.id]:[]);
    requireTrue(same(next,n.state));
    return {schema:1,passed:true,scope:'read-only signed settlement verification for ordinary wallet withdrawal; not provider acceptance',
      plan_sha256:planHash,case_id:c.id,profile:o.profile,request_id:a.request_id,operation_id:operation.id,
      receipt_id:r.receipt_id,receipt_hash:receipt.receipt_hash,tariff_hash:tariff.tariff_hash,body_sha256:sha(body),
      mode:c.mode,provider:c.provider,model:c.model,reason:waived?'waived_unknown':'metered',evidence_kind:String(r.evidence_kind),
      charge_micro_usdc:h.settlement.charge_micro_usdc,reserved_micro_usdc:c.max_cost_micro_usdc,
      signed_successor_verified:true,waiver_verified:waived,budget_reservation_retained:true,
      inference_sent_by_verifier:false,journal_modified:false,upstream_metadata_used_for_billing:false,
      provider_acceptance_passed:false,full_g3_passed:false};
  }catch{throw new ProviderRecoveryVerificationError();}
}
