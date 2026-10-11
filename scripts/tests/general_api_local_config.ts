/** Test-only loopback preparation. Never accepts public providers or old custody. */
import assert from 'node:assert/strict';
import {createPrivateKey, sign} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {compileApiServices, renderOperatorConfiguration, selectedApiEndpoints, type OperatorPreparation} from '../api_registration.ts';
import {jcsBytes, sha256Hex} from '../../packages/sdk/src/trust.ts';
import {API_ONBOARDING_DECLARATION} from '../../packages/sdk/test/api-onboarding-fixture.ts';

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const run = resolve(process.env.ZKAPI_GENERAL_API_RUN_DIR!);
assert.ok(run.startsWith(resolve('target/general-api-local') + '/'));
assert.ok(input.directory.startsWith(run + '/'));
for (const value of [input.provider, input.secondary, input.controlOrigin]) {
  const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
}
const dir = input.directory, path = (name: string) => join(dir, name);
const declarations = [{...API_ONBOARDING_DECLARATION,
  api:{...API_ONBOARDING_DECLARATION.api,origin:input.provider,
    timeout_seconds:input.variant?.endsWith('upstream_timeout')?'1':API_ONBOARDING_DECLARATION.api.timeout_seconds},
  credentialFile:path('provider.key')}];
const services = await compileApiServices(declarations, input.manifest.cap_micro_usdc, 'local_fixture');
const selection = {id:'local-api-only',revision:1,mode:'proxy' as const,models:[],modelCapabilities:{},services};
const manifest = {...input.manifest, control_api_origin:input.controlOrigin, inference_api_origin:input.controlOrigin,
  tariff_hashes:services.map(s=>s.tariff.tariff_hash), api_endpoints:selectedApiEndpoints(selection)};
assert.equal(manifest.deployment_environment, 'local');
const {manifest_hash: _hash, manifest_signature: _signature, ...body} = manifest;
manifest.manifest_hash = await sha256Hex(jcsBytes(body));
const key = createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,13)]),format:'der',type:'pkcs8'});
manifest.manifest_signature = sign(null, Buffer.from(manifest.manifest_hash,'hex'),key).toString('base64');
const pin = async (binary: string) => ({path:resolve(binary),sha256:await sha256Hex(await readFile(binary))});
const operator: OperatorPreparation = {schema:1,targetRoot:dir,inspectionBinary:await pin(input.controld),
 control:{listen:input.listen,primaryRpc:input.provider+'/rpc',secondaryRpc:input.secondary+'/rpc',indexerOrigin:input.controlOrigin,quoteSeedFile:path('quote.seed'),receiptSeedFile:path('receipt.seed')},
 dispatcher:{binary:await pin(input.dispatcherd),databaseUrl:input.databaseUrl,claimsDirectory:path('dispatch-claims')},
 indexer:{rpcUrl:input.provider+'/rpc',startSlot:0,listen:new URL(input.provider).host,publicOrigin:input.controlOrigin,snapshotsDirectory:path('snapshots')},
 signer:{journal:path('journal'),socket:input.signerSocket,stateSeedFile:path('state.seed'),clearanceSeedFile:path('clearance.seed')},
 database:{migrationDsnFile:path('migration.dsn'),writerDsnFile:path('writer.dsn'),signerDsnFile:path('signer.dsn')},
 challenger:{rpcUrl:input.provider+'/rpc',databaseDsnFile:path('challenger.dsn'),journalDirectory:path('challenger'),node:process.execPath,transportBridge:await pin(resolve('packages/sdk/src/challenger-cli.ts')),feeKeyFile:path('fee.key'),payer:manifest.authorities.admin.authority,pollSeconds:1},inferenceProviders:[]};
const rendered = renderOperatorConfiguration({operator,manifest,selection,declarations,rpcUrl:input.controlOrigin+'/rpc',network:'local',
 artifacts:{manifest:path('public/manifest.json'),idl:path('public/idl.json'),program:process.env.ZKAPI_TEST_VAULT_ELF!,
 buildManifest:path('public/unused-build.json'),publicProfile:path('public/unused-profile.json'),treePk:process.env.ZKAPI_TEST_TREE_PK!,buildManifestHash:'00'.repeat(32),publicProfileHash:'00'.repeat(32)}});
await mkdir(path('private'),{mode:0o700}); await mkdir(path('public'),{mode:0o700});
const put = async(name:string,value:unknown)=>writeFile(path(name),jcsBytes(value),{flag:'wx',mode:0o600});
await put('public/manifest.json',manifest);
for(const name of ['control','dispatcher','indexer','challenger','startup'] as const)await put('private/'+name+'.json',rendered[name]);
await put('private/frontend-routes.json',rendered.routes); await put('private/signer-inputs.json',rendered.signerInputs);
const inspected=JSON.parse(execFileSync(input.controld,['inspect-config',path('private/control.json'),'--input-root',dir,'--target-root',dir],{encoding:'utf8',env:{},maxBuffer:1024*1024}));
assert.equal(inspected.manifestHash,manifest.manifest_hash);assert.deepEqual(inspected.tariffHashes,manifest.tariff_hashes);
assert.deepEqual(jcsBytes(inspected.operations),jcsBytes(services.map(s=>s.tariff.api)));
await put('private/signer.json',inspected.signer);
await put('registration.json',{manifest,tariffs:services.map(s=>s.tariff),selection,routes:rendered.routes});
process.stdout.write(JSON.stringify({schema:1,manifestHash:manifest.manifest_hash,operations:inspected.operations,networkActions:0,providerActions:0,transactionActions:0})+'\n');
