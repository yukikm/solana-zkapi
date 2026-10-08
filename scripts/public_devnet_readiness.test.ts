/** Read-only synthetic capability observations. No real RPC, signer or provider. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectReadiness,publicReadiness} from './public_devnet_readiness.ts';

const binding={deploymentId:'fixture',manifestHash:'aa'.repeat(32),tariffHash:'bb'.repeat(32)};
function fixture(now=1_000){return{schema:1,scope:'read_only_capabilities',deployment_id:binding.deploymentId,manifest_hash:binding.manifestHash,
  started_at:now-1,completed_at:now,expires_at:now+5,control:'available',indexer:'available',signer:'available',
  providers:[{provider:'openrouter',mode:'direct_openrouter',model:'*',tariff_hash:binding.tariffHash,status:'enabled'}],provider_credit:'not_checked',operator_admission:'not_checked'};}
const reply=(v:unknown,status=503)=>({status,bytes:Buffer.from(JSON.stringify(v))});
const body=(r:{bytes:Buffer})=>JSON.parse(r.bytes.toString());

test('public readiness preserves distinct stale indexer, unavailable signer and disabled provider without credit or admission promises',()=>{
  const good=projectReadiness(reply(fixture(),200),binding,1_000);assert.equal(good.status,200);
  assert.equal(body(good).provider_credit,'not_checked');assert.equal(body(good).operator_admission,'not_checked');
  for(const [field,value] of [['indexer','stale'],['indexer','paused'],['signer','unavailable'],['signer','unreconciled']]){
    const v={...fixture(),[field]:value};const r=projectReadiness(reply(v),binding,1_000);
    assert.equal(r.status,503);assert.equal(body(r)[field],value);assert.equal(body(r).control,'available');
  }
  const disabled=fixture();disabled.providers[0].status='disabled';const r=projectReadiness(reply(disabled),binding,1_000);
  assert.equal(r.status,503);assert.equal(body(r).providers[0].status,'disabled');
  assert.equal(body(projectReadiness(reply({...fixture(),providers:[]}),binding,1_000)).providers[0].status,'unavailable');
});

test('strict public projection rejects stale, contradictory, wrong-identity and private envelopes without reflecting them',()=>{
  const variants:unknown[]=[{...fixture(),manifest_hash:'cc'.repeat(32)},{...fixture(),deployment_id:'PRIVATE_CANARY'},
    {...fixture(),expires_at:1_000},{...fixture(),completed_at:1_001,expires_at:1_006},{...fixture(),started_at:900},
    {...fixture(),signer:'PRIVATE_CANARY'},{...fixture(),config_digest:'PRIVATE_CANARY'},{...fixture(),provider_credit:'available'},
    {...fixture(),operator_admission:'enabled'},{...fixture(),providers:[...fixture().providers,...fixture().providers]},
    {...fixture(),providers:[{...fixture().providers[0],secret:'PRIVATE_CANARY'}]}];
  for(const v of variants){const r=projectReadiness(reply(v),binding,1_000);assert.equal(r.status,503);assert.equal(body(r).control,'unavailable');
    assert.equal(body(r).indexer,'not_checked');assert.equal(body(r).signer,'not_checked');assert.ok(!r.bytes.includes('PRIVATE_CANARY'));}
  for(const bytes of [Buffer.alloc(8193,65),Buffer.from('{"schema":1,"schema":1}'),Buffer.from('PRIVATE_CANARY')]){
    assert.equal(body(projectReadiness({status:503,bytes},binding,1_000)).control,'unavailable');
  }
  assert.equal(body(projectReadiness(reply({...fixture(),signer:'unavailable'},200),binding,1_000)).control,'unavailable');
});

test('only pinned public provider survives projection; unrelated configured adapters are never disclosed',()=>{
  const v=fixture();v.providers.push({...v.providers[0],provider:'PRIVATE_CANARY',model:'private-model',status:'disabled'});
  const r=projectReadiness(reply(v),binding,1_000);assert.equal(r.status,200);assert.equal(body(r).providers.length,1);
  assert.ok(!r.bytes.includes('PRIVATE_CANARY'));assert.ok(!r.bytes.includes('private-model'));
});

test('upstream refusal and caller abort return unknown component states with no retry or error reflection',async()=>{
  let calls=0;const error=await publicReadiness(async()=>{calls++;throw Error('PRIVATE_RPC_KEY');},binding);
  assert.equal(calls,1);assert.equal(error.status,503);assert.equal(body(error).control,'unavailable');assert.ok(!error.bytes.includes('PRIVATE_RPC_KEY'));
  const controller=new AbortController();controller.abort();
  const cancelled=await publicReadiness(async signal=>{calls++;signal.throwIfAborted();throw Error('unreachable');},binding,controller.signal);
  assert.equal(calls,2);assert.equal(cancelled.status,503);assert.equal(body(cancelled).providers[0].status,'not_checked');
});
