import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestedPublicModel,createPublicModelProfile,validatePublicModelExpansion} from './public_model_profile.ts';
import {publicProfileFixture} from '../packages/sdk/test/public-profile-fixture.ts';

test('model range compares numeric generations and excludes other authors and batch APIs',()=>{
  for(const id of ['openai/gpt-5.6-sol','openai/gpt-5.10-pro','openai/gpt-6.1-sol-pro','openai/gpt-10','anthropic/claude-opus-5','anthropic/claude-sonnet-5.5','anthropic/claude-6'])assert.equal(requestedPublicModel(id),true,id);
  for(const id of ['openai/gpt-5.5','openai/gpt-5-mini','openai/gpt-4o-mini','anthropic/claude-opus-4.7','other/gpt-6','openai/gpt-6:batch','anthropic/claude-opus-5:batch','openai/gpt-6-sol:nitro','openai/gpt-5.6foo','anthropic/claude-5evil','openai/gpt-6/evil'])assert.equal(requestedPublicModel(id),false,id);
});

test('expansion retains exact deployment and tariff, selecting only supported text models',async()=>{
  const {profile:base}=await publicProfileFixture();
  const row=(id:string,tools=true)=>({id,name:id,architecture:{input_modalities:['text'],output_modalities:['text']},supported_parameters:tools?['tools']:[]});
  const catalog={data:[row('openai/gpt-5.6-sol'),row('anthropic/claude-opus-5',false),row('openai/gpt-5.5'),row('openai/gpt-6:batch')]};
  const expanded=createPublicModelProfile(base,catalog);
  assert.deepEqual(expanded.models.map(m=>m.id),['anthropic/claude-opus-5','openai/gpt-5.6-sol']);
  assert.equal(expanded.modelCapabilities['anthropic/claude-opus-5'].tools,false);
  for(const change of [(p:any)=>p.bundle.sha256='a'.repeat(64),(p:any)=>p.directProviderBases.direct_openrouter='https://evil.example',(p:any)=>p.models[0].tariff.operator_fee_micro_usdc='1',(p:any)=>p.models[0].id='openai/gpt-5.5',(p:any)=>p.revision=base.revision,(p:any)=>p.sdkVersions=['unsupported'],(p:any)=>p.modelCapabilities.extra={streaming:true,tools:true}]){
    const changed=structuredClone(expanded);change(changed);assert.throws(()=>validatePublicModelExpansion(base,changed));
  }
  assert.throws(()=>createPublicModelProfile(base,{data:[catalog.data[0],catalog.data[0]]}));
  assert.throws(()=>createPublicModelProfile(base,{data:[row('openai/gpt-5.5')]}));
});
