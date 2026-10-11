import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SDK_VERSION} from '../src/version.ts';
import {PUBLIC_PROFILE_SCHEMA,PUBLIC_PROFILE_SDK_VERSION,PUBLIC_PROFILE_SUPPORTED_SCHEMAS} from '../src/public-profile.ts';
test('source version, package metadata and workspace lock agree exactly for schema 2',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(await readFile(new URL('../../../package-lock.json',import.meta.url),'utf8'));
  assert.equal(SDK_VERSION,pkg.version);assert.equal(PUBLIC_PROFILE_SDK_VERSION,pkg.version);
  assert.equal(lock.packages['packages/sdk'].version,pkg.version);
  assert.notEqual(SDK_VERSION,'0.2.0-devnet.8');assert.equal(PUBLIC_PROFILE_SCHEMA,2);assert.deepEqual(PUBLIC_PROFILE_SUPPORTED_SCHEMAS,[1,2]);
});
