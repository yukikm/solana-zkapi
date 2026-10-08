/** Strict projection of bounded local control observations. Never probes a provider. */
import assert from 'node:assert/strict';
import {parseStrictJson} from '../packages/sdk/src/trust.ts';

export interface ReadinessBinding { deploymentId:string; manifestHash:string; tariffHash:string }
type Reply={status:number;bytes:Buffer};
const exact=(v:any,keys:string[])=>{assert.ok(v&&typeof v==='object'&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),keys.sort());};
const fields=['schema','scope','deployment_id','manifest_hash','started_at','completed_at','expires_at','control','indexer','signer','providers','provider_credit','operator_admission'];
const provider=(binding:ReadinessBinding,status:string)=>({provider:'openrouter',mode:'direct_openrouter',model:'*',tariff_hash:binding.tariffHash,status});
function unavailable(binding:ReadinessBinding,now:number):Reply{
  return{status:503,bytes:Buffer.from(JSON.stringify({schema:1,scope:'read_only_capabilities',deployment_id:binding.deploymentId,
    manifest_hash:binding.manifestHash,started_at:now,completed_at:now,expires_at:now+5,control:'unavailable',indexer:'not_checked',signer:'not_checked',
    providers:[provider(binding,'not_checked')],provider_credit:'not_checked',operator_admission:'not_checked'}))};
}
export function projectReadiness(reply:Reply,binding:ReadinessBinding,now=Math.floor(Date.now()/1000)):Reply{
  try{
    assert.ok(reply.bytes.length<=8192&&[200,503].includes(reply.status));
    const value:any=parseStrictJson(reply.bytes);exact(value,[...fields]);
    assert.equal(value.schema,1);assert.equal(value.scope,'read_only_capabilities');
    assert.equal(value.deployment_id,binding.deploymentId);assert.equal(value.manifest_hash,binding.manifestHash);
    for(const key of ['started_at','completed_at','expires_at'])assert.ok(Number.isSafeInteger(value[key])&&value[key]>=0);
    assert.ok(value.started_at<=value.completed_at&&value.completed_at-value.started_at<=26
      &&value.completed_at<=now&&value.expires_at===value.completed_at+5&&now<value.expires_at);
    assert.equal(value.control,'available');
    assert.ok(['available','stale','paused','unavailable','invalid'].includes(value.indexer));
    assert.ok(['available','unavailable','invalid','unreconciled'].includes(value.signer));
    assert.equal(value.provider_credit,'not_checked');assert.equal(value.operator_admission,'not_checked');
    assert.ok(Array.isArray(value.providers)&&value.providers.length<=256);
    for(const p of value.providers){exact(p,['provider','mode','model','tariff_hash','status']);assert.ok(['enabled','disabled','unavailable'].includes(p.status));}
    const selected=value.providers.filter((p:any)=>p.provider==='openrouter'&&p.mode==='direct_openrouter'&&p.model==='*'&&p.tariff_hash===binding.tariffHash);
    assert.ok(selected.length<=1);
    const selectedProvider=provider(binding,selected[0]?.status??'unavailable');
    if(reply.status===200)assert.ok(value.indexer==='available'&&value.signer==='available'&&value.providers.length>0&&value.providers.every((p:any)=>p.status==='enabled'));
    const status=value.indexer==='available'&&value.signer==='available'&&selectedProvider.status==='enabled'?200:503;
    // Only the independently pinned public provider entry survives projection.
    return{status,bytes:Buffer.from(JSON.stringify({...value,providers:[selectedProvider]}))};
  }catch{return unavailable(binding,now);}
}
export async function publicReadiness(forward:(signal:AbortSignal)=>Promise<Reply>,binding:ReadinessBinding,signal?:AbortSignal):Promise<Reply>{
  try{return projectReadiness(await forward(AbortSignal.any([AbortSignal.timeout(28_000),...(signal?[signal]:[])])),binding);}
  catch{return unavailable(binding,Math.floor(Date.now()/1000));}
}
