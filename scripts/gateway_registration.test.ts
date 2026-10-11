/** Synthetic offline gateway registration. No network, provider or financial actions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileApiServices,validateApiProject,validateStagingConsumer,renderOperatorConfiguration,selectedApiEndpoints,type GatewayServiceDeclaration,type StagingConsumer} from './api_registration.ts';
import {operatorFixture} from './api_registration-fixture.ts';
import {jcsBytes,sha256Hex} from '../packages/sdk/src/trust.ts';
import {validateClientSelectionPins} from '../packages/sdk/src/client.ts';
const vectors=JSON.parse(await readFile('docs/contracts/universal-api-gateway-vectors.json','utf8'));
async function fixture(){
 const api=structuredClone(vectors.binding);
 api.transport.artifact_sha256=await sha256Hex(await readFile('services/control/src/gateway/http.rs'));
 api.meter.adapter.artifact_sha256=await sha256Hex(await readFile('services/control/src/gateway/meter.rs'));
 const declaration:GatewayServiceDeclaration={api,rates:[{unit:'requests',nano_usdc_numerator:'250000',unit_denominator:'1',reservation_max_count:'1'}],validFrom:'0',validUntil:'9999999999',transportArtifactSha256:api.transport.artifact_sha256,meterArtifactSha256:api.meter.adapter.artifact_sha256};
 const services=await compileApiServices([declaration],'1000000');
 const consumer:StagingConsumer={id:'finite-http-fixture',revision:1,mode:'proxy',models:[],modelCapabilities:{},services,gateway:{capabilities:['finite_http_v1'],mounts:[{prefix:'',service:api.service,operation:api.operation,binding_hash:await sha256Hex(jcsBytes(api))}]}};
 return {declaration,consumer};
}
test('gateway compiler emits immutable v3 tariff, full cap reservation and independently pinned adapters',async()=>{
 const {declaration,consumer}=await fixture(),tariff=consumer.services[0].tariff;
 assert.equal(tariff.version,'3');assert.equal(tariff.provider,'generic');assert.ok(!Object.hasOwn(tariff,'model'));
 const {tariff_hash,...body}=tariff;assert.equal(tariff_hash,await sha256Hex(jcsBytes(body)));
 validateStagingConsumer(consumer);
 const manifest={tariff_hashes:[tariff_hash],cap_micro_usdc:'1000000'} as any;
 await assert.rejects(validateClientSelectionPins(consumer,manifest));
 await validateClientSelectionPins(consumer,manifest,undefined,{transport:[declaration.transportArtifactSha256],meters:[declaration.meterArtifactSha256]});
 for(const value of [tariff,tariff.api,tariff.api.version==='2'&&tariff.api.routes,tariff.rates,tariff.rates[0]])assert.ok(Object.isFrozen(value));
 await assert.rejects(compileApiServices([{...declaration,transportArtifactSha256:'00'.repeat(32)}],'1000000'));
 await assert.rejects(compileApiServices([{...declaration,rates:[{...declaration.rates[0],nano_usdc_numerator:'1000000001'}]}],'1000000'));
 await assert.rejects(compileApiServices([{...declaration,credentialFile:'/private/key'}],'1000000'));
 await assert.rejects(compileApiServices([declaration,declaration],'1000000'));
});
test('gateway schema2 project and destination configs share exact binding and envelope limits',async()=>{
 const {declaration,consumer}=await fixture();
 const project={schema:2 as const,target:'devnet-new' as const,staging:{path:'/private/staging.json',sha256:'11'.repeat(32)},operator:{path:'/private/operator.json',sha256:'22'.repeat(32)},services:[declaration],gateway:consumer.gateway!};validateApiProject(project);
 assert.throws(()=>validateApiProject({...project,schema:1} as any));assert.throws(()=>validateStagingConsumer({...consumer,gateway:undefined}));
 const m={pool:'11111111111111111111111111111111',manifest_hash:'44'.repeat(32),control_api_origin:'https://control.example',inference_api_origin:'https://execution.example'};
 const artifacts={manifest:'/manifest',idl:'/idl',program:'/program',buildManifest:'/build',publicProfile:'/profile',treePk:'/tree',buildManifestHash:'55'.repeat(32),publicProfileHash:'66'.repeat(32)};
 const rendered=renderOperatorConfiguration({operator:operatorFixture,manifest:m,selection:consumer,declarations:[declaration],artifacts,rpcUrl:'https://control.example/rpc',network:'devnet'});
 assert.deepEqual(rendered.dispatcher.providers.api,[]);assert.deepEqual(rendered.control.providers.gateway,rendered.dispatcher.providers.gateway);assert.equal(rendered.control.providers.gateway?.[0].transport_artifact_sha256,declaration.transportArtifactSha256);
 assert.deepEqual(rendered.startup.providerCredentialFiles,[]);
 const endpoint='/zkapi/v2/execute/fixture/lookup';assert.ok(selectedApiEndpoints(consumer).includes(endpoint));
 const route=rendered.routes.routes.find(r=>r.path===endpoint)!;assert.equal(route.requestMaxBytes,1048576+65540);assert.equal(route.responseMaxBytes,6*16777216+3*(65536+5));
});
