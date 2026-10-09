/** Explicit model expansion for the public OpenRouter Chat deployment.
 * Catalog snapshots are inputs, never executable configuration or credentials. */
import assert from 'node:assert/strict';
import type {PublicDeploymentProfile} from '../packages/sdk/src/public-profile.ts';
import {jcsBytes} from '../packages/sdk/src/trust.ts';
import {validateModelConfigurations} from '../packages/sdk/src/client.ts';

export function requestedPublicModel(id:string):boolean {
  // Batch aliases use a different API. Routing suffixes are not catalog models.
  if(typeof id!=='string'||id.includes(':'))return false;
  const g=/^openai\/gpt-(\d+)(?:\.(\d+))?(?:-[a-z0-9]+)*$/.exec(id);
  if(g)return Number(g[1])>5||Number(g[1])===5&&Number(g[2]??0)>=6;
  const c=/^anthropic\/claude-(?:[a-z]+-)?(\d+)(?:\.(\d+))?(?:-[a-z0-9]+)*$/.exec(id);
  return !!c&&Number(c[1])>=5;
}

export function createPublicModelProfile(base:PublicDeploymentProfile,catalog:unknown):PublicDeploymentProfile {
  assert.ok(catalog&&typeof catalog==='object'&&Array.isArray((catalog as any).data));
  assert.equal(base.mode,'direct_openrouter');assert.equal(base.models.length,1);
  const template=base.models[0];assert.equal(template.provider,'openrouter');assert.equal(template.tariff.model,'*');
  const rows=(catalog as any).data.filter((m:any)=>requestedPublicModel(m?.id));
  const eligible=rows.filter((m:any)=>m.architecture?.input_modalities?.includes('text')&&m.architecture?.output_modalities?.includes('text'));
  assert.ok(eligible.length>0&&eligible.length<=32,'SDK supports at most 32 configured models');
  assert.equal(new Set(eligible.map((m:any)=>m.id)).size,eligible.length,'duplicate catalog model');
  eligible.sort((a:any,b:any)=>a.id.localeCompare(b.id,'en'));
  const profile=structuredClone(base);profile.revision++;
  profile.models=eligible.map((m:any)=>({id:m.id,label:m.name,provider:'openrouter',apis:['chat'],tariff:structuredClone(template.tariff)}));
  profile.modelCapabilities=Object.fromEntries(eligible.map((m:any)=>[m.id,{streaming:true,tools:Array.isArray(m.supported_parameters)&&m.supported_parameters.includes('tools')}]));
  validatePublicModelExpansion(base,profile);return profile;
}

export function validatePublicModelExpansion(base:PublicDeploymentProfile,expanded:PublicDeploymentProfile):void {
  assert.equal(base.mode,'direct_openrouter');assert.equal(base.models.length,1);
  assert.ok(expanded.revision>base.revision&&expanded.models.length>0&&expanded.models.length<=32);
  // Preserve deployment, provider origin, bundle, chain, and compatibility pins.
  const strip=({revision,models,modelCapabilities,sdkVersions,...rest}:PublicDeploymentProfile)=>rest;
  assert.deepEqual(jcsBytes(strip(expanded)),jcsBytes(strip(base)));
  assert.deepEqual(expanded.sdkVersions,base.sdkVersions);
  validateModelConfigurations(expanded.mode,expanded.models);
  for(const model of expanded.models){
    assert.ok(requestedPublicModel(model.id),'model outside requested version range');
    assert.equal(model.provider,'openrouter');assert.deepEqual(model.apis,['chat']);
    assert.deepEqual(jcsBytes(model.tariff),jcsBytes(base.models[0].tariff));
  }
  assert.equal(new Set(expanded.models.map(m=>m.id)).size,expanded.models.length);
  assert.deepEqual(Object.keys(expanded.modelCapabilities).sort(),expanded.models.map(m=>m.id).sort());
  for(const value of Object.values(expanded.modelCapabilities)){
    assert.deepEqual(Object.keys(value).sort(),['streaming','tools']);
    assert.equal(typeof value.streaming,'boolean');assert.equal(typeof value.tools,'boolean');
  }
}
