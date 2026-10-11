/** Test-only loopback preparation. Never accepts public providers or old custody. */
import assert from 'node:assert/strict';
import {createPrivateKey, sign} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {compileApiServices, renderOperatorConfiguration, selectedApiEndpoints, type OperatorPreparation,type ServiceDeclaration} from '../api_registration.ts';
import {jcsBytes, sha256Hex} from '../../packages/sdk/src/trust.ts';
import {API_ONBOARDING_DECLARATION} from '../../packages/sdk/test/api-onboarding-fixture.ts';

const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const run = resolve(process.env.ZKAPI_GENERAL_API_RUN_DIR!);
assert.ok(['target/general-api-local','target/gateway-native-local'].some(root=>run.startsWith(resolve(root)+'/')));
assert.ok(input.directory.startsWith(run + '/'));
for (const value of [input.provider, input.secondary, input.controlOrigin]) {
  const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
}
const dir = input.directory, path = (name: string) => join(dir, name);
let declarations:ServiceDeclaration[] = [{...API_ONBOARDING_DECLARATION,
  api:{...API_ONBOARDING_DECLARATION.api,origin:input.provider,
    timeout_seconds:input.variant?.endsWith('upstream_timeout')?'1':API_ONBOARDING_DECLARATION.api.timeout_seconds},
  credentialFile:path('provider.key')}];
if(input.gateway){
  const vector=JSON.parse(await readFile(resolve('docs/contracts/universal-api-gateway-vectors.json'),'utf8'));
  const api=vector.binding;api.service='catalog';api.operation='lookup';api.origin=input.provider;api.routes=[{method:'POST',path:'/lookup'}];
  api.transport.artifact_sha256=await sha256Hex(await readFile(resolve('services/control/src/gateway/http.rs')));
  api.meter.adapter.artifact_sha256=await sha256Hex(await readFile(resolve('services/control/src/gateway/meter.rs')));
  api.authentication={scheme:'bearer',policy_id:'fixture'};api.headers.trailers=['x-gateway-checksum'];
  api.limits.request_bytes='1048576';api.limits.response_bytes='1048576';
  if(input.variant?.endsWith('upstream_timeout'))for(const key of ['execution_seconds','header_seconds','idle_seconds'])api.limits[key]='1';
  declarations=[{api,rates:[{unit:'requests',nano_usdc_numerator:'250000',unit_denominator:'1',reservation_max_count:'1'}],validFrom:'1',validUntil:'4000000000',credentialFile:path('provider.key'),transportArtifactSha256:api.transport.artifact_sha256,meterArtifactSha256:api.meter.adapter.artifact_sha256}];
  if(input.nativeAgent){
    assert.ok(['codex','claude'].includes(input.nativeAgent));
    const openai=input.nativeAgent==='codex';
    api.service=input.nativeAgent;api.operation=openai?'responses':'messages';
    api.routes=[{method:'POST',path:openai?'/v1/responses':'/v1/messages'}];api.headers.trailers=[];
    api.limits.header_seconds='10';api.limits.idle_seconds='2';api.limits.execution_seconds='30';
    api.completion={kind:'provider_terminal_usage',billable_statuses:[200]};
    api.meter.adapter.id=openai?'openai_responses':'anthropic_messages';
    api.meter.resource={provider:openai?'openai':'anthropic',model:openai?'gpt-5.4':'claude-sonnet-4-20250514'};
    api.meter.config={provider_contract_sha256:await sha256Hex(await readFile(resolve('services/control/fixtures/gateway-meter-mappings.json'))),context_max_tokens:'200000',output_max_tokens:'32768',service_tier:'auto',extra_cost_policy:'operator_absorbs_unpriced'};
    api.meter.config_hash=await sha256Hex(jcsBytes(api.meter.config));
    const units=openai?['cache_read_tokens','input_tokens','output_tokens']:['cache_read_tokens','cache_write_1h_tokens','cache_write_5m_tokens','input_tokens','output_tokens'];
    declarations=[{api,rates:units.map(unit=>({unit,nano_usdc_numerator:'1000',unit_denominator:'1',reservation_max_count:unit==='output_tokens'?'32768':'200000'})),validFrom:'1',validUntil:'4000000000',credentialFile:path('provider.key'),transportArtifactSha256:api.transport.artifact_sha256,meterArtifactSha256:api.meter.adapter.artifact_sha256}];
  }
}
const services = await compileApiServices(declarations, input.manifest.cap_micro_usdc, 'local_fixture');
const gateway=input.gateway?{capabilities:['finite_http_v1' as const],mounts:[{prefix:'',service:services[0].tariff.api.service,operation:services[0].tariff.api.operation,binding_hash:await sha256Hex(jcsBytes(services[0].tariff.api))}]}:undefined;
const selection = {...(gateway?{gateway}:{}),id:'local-api-only',revision:1,mode:'proxy' as const,models:[],modelCapabilities:{},services};
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
