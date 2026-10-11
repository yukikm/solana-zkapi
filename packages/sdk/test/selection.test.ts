import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateClientConfiguration,validateClientSelectionPins,ClientSelectionError} from '../src/client.ts';
import {publicProfileFixture} from './public-profile-fixture.ts';

test('shared pure validation checks API-only selection and cap without accessing any transport',async()=>{
  const f=await publicProfileFixture({schema:2,selection:'api'});assert.equal(f.profile.schema,2);
  if(f.profile.schema!==2)throw Error('fixture');
  const services=f.profile.services;
  validateClientConfiguration('proxy',[],services);
  await validateClientSelectionPins({models:[],services},f.manifest);
  await validateClientSelectionPins({models:[],services},{...f.manifest,cap_micro_usdc:'250'});
  await assert.rejects(validateClientSelectionPins({models:[],services},{...f.manifest,cap_micro_usdc:'249'}),e=>e instanceof ClientSelectionError&&e.component==='services');
  await assert.rejects(validateClientSelectionPins({models:[],services},{...f.manifest,tariff_hashes:[]}));
  assert.throws(()=>validateClientConfiguration('proxy',[],[]));
  assert.throws(()=>validateClientConfiguration('direct_openrouter',[],services));
  assert.throws(()=>validateClientConfiguration('proxy',[],[...services,...services]));
  assert.equal(f.calls.length,0);
});
