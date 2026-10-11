import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {publicProfileFixture} from './public-profile-fixture.ts';
import {loadPublicDeploymentProfile,PUBLIC_PROFILE_SUPPORTED_SCHEMAS} from '../src/public-profile.ts';

test('machine profile contract declares the loader fixture fields, bounds and exact API tariff shape',async()=>{
  const schema=JSON.parse(await readFile(new URL('../../../docs/contracts/public-profile.schema.json',import.meta.url),'utf8'));
  assert.equal(schema.additionalProperties,false);assert.deepEqual(schema.properties.schema.enum,[...PUBLIC_PROFILE_SUPPORTED_SCHEMAS]);
  assert.equal(schema.properties.models.maxItems,32);assert.equal(schema.properties.services.maxItems,64);
  for(const input of [{schema:1,selection:'inference'},{schema:2,selection:'inference'},{schema:2,selection:'api'},{schema:2,selection:'mixed'}] as const){
    const f=await publicProfileFixture(input);
    for(const name of Object.keys(f.profile))assert(Object.hasOwn(schema.properties,name),name);
    for(const name of schema.required)assert(Object.hasOwn(f.profile,name),name);
    await loadPublicDeploymentProfile(f.profileUrl,{profileSha256:await f.profileSha256(),fetch:f.fetcher});
    if(f.profile.schema===2&&f.profile.services.length){
      const service=schema.properties.services.items;assert.equal(service.additionalProperties,false);
      assert.deepEqual(service.required,['tariff']);assert.deepEqual(Object.keys(service.properties),['tariff']);
      const tariff=service.properties.tariff, actual=f.profile.services[0].tariff;
      assert.deepEqual([...tariff.required].sort(),Object.keys(actual).sort());
      assert.deepEqual([...tariff.properties.api.required].sort(),Object.keys(actual.api).sort());
      assert.equal(tariff.additionalProperties,false);assert.equal(tariff.properties.api.additionalProperties,false);
      assert.equal(tariff.properties.api.properties.method.const,'POST');assert.equal(tariff.properties.api.properties.billing.const,'http_2xx_json');
    }
  }
});
