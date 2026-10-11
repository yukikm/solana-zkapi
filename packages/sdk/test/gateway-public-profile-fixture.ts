/** Synthetic finite HTTP profile; no deployment, credential or financial state. */
import {readFile} from 'node:fs/promises';
import {publicProfileFixture} from './public-profile-fixture.ts';
import {jcsBytes,manifestDigest,sha256Hex,type ManifestTrustPolicy} from '../src/trust.ts';
import {apiOperationPath} from '../src/control.ts';
import type {PublicDeploymentProfileV3} from '../src/public-profile.ts';
import type {ApiBindingV2,TariffV3} from '../src/gateway.ts';

export async function gatewayPublicProfileFixture(){
 const f=await publicProfileFixture({schema:2,selection:'api'});
 const vectors=JSON.parse(await readFile(new URL('../../../docs/contracts/universal-api-gateway-vectors.json',import.meta.url),'utf8'));
 const api:ApiBindingV2=structuredClone(vectors.binding);
 const body:Omit<TariffV3,'tariff_hash'>={version:'3',provider:'generic',api,pricing_basis:'fixed_request',valid_from:'0',valid_until:'9999999999',rates:[{unit:'requests',nano_usdc_numerator:'250000',unit_denominator:'1',reservation_max_count:'1'}],operator_fee_micro_usdc:'0'};
 const tariff:TariffV3={...body,tariff_hash:await sha256Hex(jcsBytes(body))};
 const profile=f.profile as unknown as PublicDeploymentProfileV3;
 Object.assign(profile,{schema:3,services:[{tariff}],gateway:{capabilities:['finite_http_v1'],mounts:[{prefix:'',service:api.service,operation:api.operation,binding_hash:await sha256Hex(jcsBytes(api))}]}});
 f.manifest.tariff_hashes=[tariff.tariff_hash];
 f.manifest.api_endpoints=[...f.manifest.api_endpoints.filter(path=>!path.startsWith('/zkapi/v1/api/')),apiOperationPath(api)];
 f.manifest.manifest_hash=await manifestDigest(f.manifest);f.trust.anchor.sha256=f.manifest.manifest_hash;
 Object.assign(f.trust.build,{gatewayAdapters:{transport:[api.transport.artifact_sha256],meters:[api.meter.adapter.artifact_sha256]}});
 const manifestBytes=jcsBytes(f.manifest);f.files.set('https://assets.example.com/manifest.json',manifestBytes);f.state.controlManifest=manifestBytes;
 f.descriptor.files['manifest.json']={sha256:await sha256Hex(manifestBytes),bytes:manifestBytes.length};
 const descriptorBytes=jcsBytes(f.descriptor);f.files.set('https://assets.example.com/bundle.json',descriptorBytes);profile.bundle.sha256=await sha256Hex(descriptorBytes);
 f.state.catalog={models:[],apis:[{api,mode:'proxy',provider:'generic',endpoint:apiOperationPath(api),tariff_hash:tariff.tariff_hash}]};
 return {...f,profile};
}
