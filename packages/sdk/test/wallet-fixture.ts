import {fixtureSigner} from './kit-helpers.ts';
/** Local runtime fixtures only. Test setup is known-public entropy; no live deployment claim. */
/** Local runtime fixtures only. Test setup is known-public entropy; no live deployment claim. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { manifestDigest,verifyManifest, type ArtifactBundle, type Manifest } from '../src/trust.ts';
export const read=async(path:string)=>new Uint8Array(await readFile(resolve(path)));
export const json=async(path:string)=>JSON.parse(await readFile(resolve(path),'utf8'));
export const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function walletFixture(){
  const m=await json('target/i05/public-manifest.json');
  m.authorities.admin.authority=(await fixtureSigner(new Uint8Array(32).fill(1))).address;
  m.manifest_hash=await manifestDigest(m);
  // Manifest is a generated local test fixture; the harness supplies this explicit test pin.
  const manifest=await verifyManifest(new TextEncoder().encode(JSON.stringify(m)),{anchor:{kind:'hash',sha256:m.manifest_hash},expected:{deployment_id:m.deployment_id,deployment_environment:m.deployment_environment,genesis_hash:m.genesis_hash,program_id:m.program_id,pool:m.pool,mint:m.mint,token_program:m.token_program,control_api_origin:m.control_api_origin,inference_api_origin:m.inference_api_origin},build:{stateKey:m.state_key,clearanceKey:m.clearance_key,circuitProfileHash:m.circuit_profile_hash,idlHash:m.idl_hash,setupProfile:m.setup_profile}});
  const idl=await read('docs/contracts/zkapi_vault.json');
  const artifacts:ArtifactBundle={idl,requestPk:await read('vendor/ethereum-zkapi/protocol/setup/v2/request.pk'),requestVk:await read('vendor/ethereum-zkapi/protocol/setup/v2/request.vk'),withdrawalPk:await read('vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.pk'),withdrawalVk:await read('vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.vk'),treePk:await read('target/i09-challenger/test-tree.pk'),treeVk:await read('tests/fixtures/layout2/test-tree.vk'),treeSourceBundle:await read('target/i08-wallet/circuit-source.tar'),treeVerifierConstants:await read('tests/fixtures/layout2/tree-vk-wire.bin'),additional:{vault_idl:idl}};
  return {manifest,artifacts};
}
