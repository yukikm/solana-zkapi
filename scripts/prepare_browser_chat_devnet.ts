/** Offline packaging of an independently pinned devnet profile. No wallet key,
 * provider credential, network, AUTH, budget reservation or transaction. */
import assert from 'node:assert/strict';
import {readFile, lstat, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPublicDevnetProfile, profileSha} from './i10_public_devnet_profile.ts';
import {verifyManifest, parseStrictJson, type ManifestTrustPolicy} from '../packages/sdk/src/trust.ts';

const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MINT='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export interface PackagingOptions {
  profileDirectory:string; profileSha256:string; deploymentDirectory:string;
  wasmPath:string; wasmSha256:string; output:string; buildOutput:string;
  port:number; servicePort:number; planPath:string; stateDir:string;
  rpcUrl:string; historyRpcUrl?:string;
}
const sha = (bytes:Uint8Array)=>profileSha(bytes);
const json = async(path:string)=>JSON.parse(JSON.stringify(parseStrictJson(new Uint8Array(await readFile(path)))));
function privateRpc(input:string) {
  const url=new URL(input); assert.equal(url.protocol,'https:'); assert.ok(!url.username&&!url.password&&!url.hash); return input;
}
export async function prepareBrowserChat(options:PackagingOptions) {
  const o={...options};
  assert.ok(Number.isSafeInteger(o.port)&&o.port>=1024&&o.port<=65535);
  assert.ok(Number.isSafeInteger(o.servicePort)&&o.servicePort>=1024&&o.servicePort<=65530);
  assert.ok(o.port<o.servicePort||o.port>o.servicePort+4);
  privateRpc(o.rpcUrl); if(o.historyRpcUrl) privateRpc(o.historyRpcUrl);
  assert.match(o.wasmSha256,/^[0-9a-f]{64}$/);
  const profile=await loadPublicDevnetProfile(resolve(o.profileDirectory),o.profileSha256);
  const deployment=resolve(o.deploymentDirectory), cfg=await json(join(deployment,'deployment.json'));
  assert.equal(cfg.public_profile_sha256,profile.sha256);assert.equal(cfg.genesis,GENESIS);
  assert.equal(cfg.mint,MINT);assert.equal(cfg.token_program,TOKEN);assert.equal(cfg.cap_micro_usdc,'1000000');
  const build=await json(join(deployment,'build-manifest.json'));
  assert.equal(build.public_profile_sha256,profile.sha256);assert.equal(build.program_id,cfg.program_id);
  assert.equal(build.deployment_authority,cfg.initializer);assert.equal(build.genesis_hash,GENESIS);
  assert.deepEqual(build.state_key,profile.profile.state_key);assert.deepEqual(build.clearance_key,profile.profile.clearance_key);
  assert.equal(build.circuit_profile_hash,profile.profile.circuit_profile_hash);
  const manifestPath=join(deployment,'public-manifest.json'), raw=new Uint8Array(await readFile(manifestPath));
  const manifestUntrusted=await json(manifestPath);
  const trust:ManifestTrustPolicy={anchor:{kind:'ed25519',publicKey:cfg.initializer},expected:{
    deployment_id:manifestUntrusted.deployment_id,deployment_environment:'devnet',genesis_hash:GENESIS,
    program_id:cfg.program_id,pool:cfg.pool,mint:MINT,token_program:TOKEN,
    control_api_origin:`https://127.0.0.1:${o.servicePort+2}`,inference_api_origin:`https://127.0.0.1:${o.servicePort+3}`,
  },build:{stateKey:profile.profile.state_key,clearanceKey:profile.profile.clearance_key,
    circuitProfileHash:profile.profile.circuit_profile_hash,idlHash:build.idl_sha256,setupProfile:'test_only',
    transactionFormats:['v0_buffer','v0_inline_deposit_v1']}};
  const manifest=await verifyManifest(raw,trust);
  assert.equal(manifest.cap_micro_usdc,'1000000');assert.equal(manifest.setup_profile,'test_only');
  assert.equal(manifest.quote_public_key,profile.profile.quote_public_key);
  assert.equal(manifest.receipt_public_key,profile.profile.receipt_public_key);
  const artifacts:Record<string,string>={idl:join(deployment,'vault-idl.json'),requestPk:join(profile.directory,'request.pk'),requestVk:join(profile.directory,'request.vk'),
    withdrawalPk:join(profile.directory,'withdrawal.pk'),withdrawalVk:join(profile.directory,'withdrawal.vk'),
    treePk:join(profile.directory,'tree.pk'),treeVk:join(profile.directory,'tree.vk'),
    treeSourceBundle:join(profile.directory,'circuit-source.tar'),treeVerifierConstants:join(profile.directory,'tree-vk-wire.bin'),
    'additional:vault_idl':join(deployment,'vault-idl.json'),
    'additional:vault_program':join(profile.directory,'deployment/zkapi_vault.so'),
    'additional:devnet_build_manifest':join(deployment,'build-manifest.json'),
    'additional:public_devnet_profile':join(profile.directory,'public-profile.json')};
  const hashes:Record<string,string>={idl:manifest.idl_hash,requestPk:manifest.request_pk_hash,requestVk:manifest.request_vk_hash,
    withdrawalPk:manifest.withdrawal_pk_hash,withdrawalVk:manifest.withdrawal_vk_hash,treePk:manifest.tree_proof_artifacts.pk_hash,
    treeVk:manifest.tree_proof_artifacts.vk_hash,treeSourceBundle:manifest.tree_proof_artifacts.source_bundle_hash,
    treeVerifierConstants:manifest.tree_proof_artifacts.verifier_constants_hash,
    ...Object.fromEntries(Object.entries(manifest.artifact_digests).map(([k,v])=>['additional:'+k,v]))};
  assert.deepEqual(Object.keys(artifacts).sort(),Object.keys(hashes).sort());
  for(const [name,path] of Object.entries(artifacts)) {
    const st=await lstat(path);assert.ok(st.isFile()&&!st.isSymbolicLink());assert.equal(sha(new Uint8Array(await readFile(path))),hashes[name]);
  }
  const wasmPath=resolve(o.wasmPath);assert.ok((await lstat(wasmPath)).isFile());assert.equal(sha(new Uint8Array(await readFile(wasmPath))),o.wasmSha256);
  const plan=await json(resolve(o.planPath));assert.equal(plan.budget_micro_usdc,'10000000');
  const cases=plan.cases.filter((c:any)=>c.id==='openrouter-direct-plain');assert.equal(cases.length,1);
  const c=cases[0];assert.equal(c.mode,'direct_openrouter');assert.equal(c.provider,'openrouter');assert.equal(c.max_cost_micro_usdc,'1000000');
  const tariffs=plan.models.filter((m:any)=>m.tariff.provider==='openrouter'&&m.tariff.model==='*'&&m.tariff.pricing_basis==='provider_reported_usd');
  assert.equal(tariffs.length,1);const tariff=tariffs[0].tariff;assert.ok(manifest.tariff_hashes.includes(tariff.tariff_hash));
  const urls:Record<string,unknown>={additional:{}};
  for(const name of Object.keys(artifacts)) {
    const url='/artifacts/'+encodeURIComponent(name);
    if(name.startsWith('additional:'))(urls.additional as Record<string,string>)[name.slice(11)]=url;else urls[name]=url;
  }
  const publicProfile={id:'local-openrouter-direct',label:'Local devnet · OpenRouter direct',chain:'solana:devnet',mode:'direct_openrouter',
    // Verify the independent signer/profile first, then freeze this exact
    // reviewed manifest in the distributed app (including quote/receipt roles).
    trust:{...trust,anchor:{kind:'hash',sha256:manifest.manifest_hash}},manifestUrl:'/manifest',artifacts:urls,wasmUrl:'/wasm',wasmSha256:o.wasmSha256,
    models:[{id:c.model,label:c.model,provider:'openrouter',apis:['chat'],tariff}],
    rpcUrl:'https://rpc.zkapi.invalid',indexerOrigin:'https://indexer.zkapi.invalid',
    directProviderBases:{direct_openrouter:'https://openrouter.ai/api/v1'},relay:{kind:'same_origin_devnet'},preparationCommitment:'confirmed'};
  // Only fixed public fields above enter this file. Private RPC URLs never do.
  const output=resolve(o.output);assert.notEqual(output,deployment);assert.ok(!output.startsWith(deployment+'/'));
  await mkdir(output,{mode:0o700}); // Exclusive output: never overwrite an existing custody/deployment directory.
  const profilePath=join(output,'reviewed-profile.json');const bytes=Buffer.from(JSON.stringify(publicProfile,null,2)+'\n');
  await writeFile(profilePath,bytes,{flag:'wx',mode:0o600});
  const config={port:o.port,profilePath,profileSha256:sha(bytes),output:resolve(o.buildOutput),manifestPath,wasmPath,artifacts,
    rpcUrl:o.rpcUrl,...(o.historyRpcUrl?{historyRpcUrl:o.historyRpcUrl}:{}),indexerUrl:`http://127.0.0.1:${o.servicePort}`,
    controlUrl:`http://127.0.0.1:${o.servicePort+4}`,allowTransactions:true,
    budget:{planPath:resolve(o.planPath),stateDir:resolve(o.stateDir),caseId:'openrouter-direct-plain'}};
  await writeFile(join(output,'private-host-config.json'),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  return {prepared:true,scope:'Offline local devnet browser packaging; no budget reservation or network action',profilePath,
    profileSha256:sha(bytes),privateConfigPath:join(output,'private-host-config.json'),program:cfg.program_id,pool:cfg.pool,
    publicProfileSha256:profile.sha256,wasmSha256:o.wasmSha256,manifestSha256:sha(raw)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const names=['profile-directory','profile-sha256','deployment-directory','wasm-path','wasm-sha256','output','build-output','port','service-port','plan-path','state-dir'];
    const args=process.argv.slice(2), found:Record<string,string>={};
    for(const arg of args){const m=/^--([a-z0-9-]+)=(.+)$/.exec(arg);assert.ok(m&&names.includes(m[1])&&!found[m[1]]);found[m[1]]=m[2];}
    assert.equal(Object.keys(found).length,names.length);assert.ok(process.env.SOLANA_DEVNET_RPC);
    const result=await prepareBrowserChat({profileDirectory:found['profile-directory'],profileSha256:found['profile-sha256'],
      deploymentDirectory:found['deployment-directory'],wasmPath:found['wasm-path'],wasmSha256:found['wasm-sha256'],
      output:found.output,buildOutput:found['build-output'],port:Number(found.port),servicePort:Number(found['service-port']),
      planPath:found['plan-path'],stateDir:found['state-dir'],rpcUrl:process.env.SOLANA_DEVNET_RPC,
      ...(process.env.SOLANA_DEVNET_HISTORY_RPC?{historyRpcUrl:process.env.SOLANA_DEVNET_HISTORY_RPC}:{})});
    console.log(JSON.stringify(result));
  } catch {console.error('Browser devnet packaging failed; inspect reviewed public inputs and private output permissions. No network action was attempted.');process.exitCode=1;}
}
