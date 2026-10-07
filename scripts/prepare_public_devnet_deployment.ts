/** Offline, new-only public-origin preparation for a declared pre-deployment
 * staging profile. Supports an explicitly observed deployed program with an
 * uninitialized Pool. Never migrates an active Pool, initializes state or uses RPC.
 * The operator's staging declaration is provenance, not proof of chain absence. */
import assert from 'node:assert/strict';
import {lstat,readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {signBytes,getProgramDerivedAddress} from '@solana/kit';
import bs58 from 'bs58';
import {vaultBinding} from '../packages/sdk/src/encoding.ts';
import {loadDeploymentAssets} from '../packages/sdk/src/deployment.ts';
import {loadPublicDeploymentProfile,PUBLIC_PROFILE_SDK_VERSION,type PublicDeploymentProfile} from '../packages/sdk/src/public-profile.ts';
import {jcsBytes,manifestDigest,parseStrictJson,sha256Hex,verifyManifest,verifyEd25519,type ManifestTrustPolicy} from '../packages/sdk/src/trust.ts';
import {loadPublicDevnetProfile,publicDevnetManifestBase,PROFILE_FIELDS} from './i10_public_devnet_profile.ts';
import {signerFromSecret,parseAddress} from './solana-kit.ts';
import {packageDeploymentAssets} from './package_sdk_distribution_assets.mjs';

export interface PublicDeploymentPreparation {
  schema:1;
  sourceBundlePath:string;
  sourceBundleSha256:string;
  sourceDeploymentPath:string;
  sourceDeploymentSha256:string;
  publicSetupDirectory:string;
  publicSetupSha256:string;
  stagingDeclarationPath:string;
  stagingDeclarationSha256:string;
  expected:{deploymentId:string;programId:string;pool:string;manifestHash:string};
  manifestAuthorityKeyPath:string;
  publicOrigin:string;
  assetsBaseUrl:string;
  profileUrl:string;
  privateRpcUrl:string;
  indexerListen:string;
  snapshotsDirectory:string;
  startSlot:number;
  consumer:{id:string;revision:number;model:PublicDeploymentProfile['models'][number];streaming:boolean;tools:boolean};
}
const requiredNoticeNames=['Apache-2.0.txt','PROVENANCE.md','ethereum-VENDORED-045b444.md','mingyech-README-8b2d4e3.md','mingyech-setup-README-8b2d4e3.md'] as const;
const artifactNames=['idl','requestPk','requestVk','withdrawalPk','withdrawalVk','treePk','treeVk','treeSourceBundle','treeVerifierConstants'] as const;
function fields(value:any,required:readonly string[],optional:readonly string[]=[]){
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'configuration object required');
  assert.ok(required.every(k=>Object.hasOwn(value,k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k)),'exact configuration fields required');
}
function publicUrl(value:string,origin=false){
  const u=new URL(value),h=u.hostname;
  assert.ok(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&h.includes('.')&&!h.endsWith('.')
    && !['localhost','local','internal','invalid'].some(x=>h===x||h.endsWith('.'+x))&&!h.startsWith('[')&&!/^\d+(?:\.\d+){3}$/.test(h),'public HTTPS hostname required');
  assert.equal(origin?u.origin:u.href,value,'canonical public URL required');return u;
}
async function bytes(path:string,maximum=512*1024*1024){
  const s=await lstat(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=maximum,'bounded regular file required');
  const b=await readFile(path);assert.ok(b.length<=maximum);return new Uint8Array(b);
}
async function pinnedJson(path:string,hash:string){
  assert.match(hash,/^[0-9a-f]{64}$/);const b=await bytes(path,1024*1024);assert.equal(await sha256Hex(b),hash,'independent input hash mismatch');return JSON.parse(JSON.stringify(parseStrictJson(b))) as any;
}
function validate(c:PublicDeploymentPreparation){
  fields(c,['schema','sourceBundlePath','sourceBundleSha256','sourceDeploymentPath','sourceDeploymentSha256','publicSetupDirectory','publicSetupSha256','stagingDeclarationPath','stagingDeclarationSha256','expected','manifestAuthorityKeyPath','publicOrigin','assetsBaseUrl','profileUrl','privateRpcUrl','indexerListen','snapshotsDirectory','startSlot','consumer']);
  assert.equal(c.schema,1);fields(c.expected,['deploymentId','programId','pool','manifestHash']);
  fields(c.consumer,['id','revision','model','streaming','tools']);
  publicUrl(c.publicOrigin,true);publicUrl(c.assetsBaseUrl);publicUrl(c.profileUrl);
  assert.ok(c.assetsBaseUrl.endsWith('/'),'asset directory URL must end in /');
  assert.ok(c.profileUrl!==c.assetsBaseUrl+'bundle.json'&&!c.profileUrl.startsWith(c.assetsBaseUrl),'profile must be outside asset directory');
  const rpc=new URL(c.privateRpcUrl);assert.ok(rpc.protocol==='https:'&&!rpc.username&&!rpc.password&&!rpc.hash,'private HTTPS RPC required');
  assert.match(c.indexerListen,/^127\.0\.0\.1:[0-9]{1,5}$/);const port=Number(c.indexerListen.split(':')[1]);assert.ok(port>=1024&&port<=65535);
  assert.equal(resolve(c.snapshotsDirectory),c.snapshotsDirectory,'absolute snapshot directory required');
  assert.ok(Number.isSafeInteger(c.startSlot)&&c.startSlot>=0,'reviewed initialization/replay slot required');
  assert.equal(typeof c.consumer.streaming,'boolean');assert.equal(typeof c.consumer.tools,'boolean');
  assert.equal(c.consumer.model.provider,'openrouter');assert.deepEqual(c.consumer.model.apis,['chat']);
  assert.equal(c.consumer.model.tariff.provider,'openrouter');assert.equal(c.consumer.model.tariff.model,'*');
  assert.equal(c.consumer.model.tariff.pricing_basis,'provider_reported_usd');assert.deepEqual(c.consumer.model.tariff.rates,[]);
}

function validateNoticeNames(notices:Record<string,unknown>,additionalCount:number){
  const names=Object.keys(notices);assert.ok(requiredNoticeNames.every(name=>Object.hasOwn(notices,name)),'all five reviewed upstream notices required');
  const core=new Set(['bundle.json','manifest.json','prover.wasm',...artifactNames.map(n=>n+'.bin'),...Array.from({length:additionalCount},(_,i)=>'additional-'+i+'.bin')]);
  const reserved=new Set([...core].map(name=>name.toLowerCase()));
  assert.ok(names.length<=32&&new Set(names.map(name=>name.toLowerCase())).size===names.length
    &&names.every(name=>/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/.test(name)&&!reserved.has(name.toLowerCase())),'notice filename collision');
}
async function manifestKey(path:string){
  const info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o077)===0&&info.uid===process.getuid?.(),'private authority key owner/mode required');
  const secret=parseStrictJson(await bytes(path,4096));
  assert.ok(Array.isArray(secret)&&[32,64].includes(secret.length)&&secret.every(n=>Number.isInteger(n)&&Number(n)>=0&&Number(n)<=255),'Ed25519 private key byte array required');
  return signerFromSecret(Uint8Array.from(secret as number[]));
}

type StagingProvenance = {
  noDeploymentOrFundingOrServiceState?:true;
  initialState?:'program_deployed_pool_uninitialized';
  noPoolFundingOrServiceState?:true;
  finalizedProgramVerification?:{path:string;sha256:string};
};
const provenanceFields=['noDeploymentOrFundingOrServiceState','initialState','noPoolFundingOrServiceState','finalizedProgramVerification'] as const;
function stagingProvenance(c:StagingProvenance):StagingProvenance {
  if(Object.hasOwn(c,'noDeploymentOrFundingOrServiceState')){
    assert.equal(c.noDeploymentOrFundingOrServiceState,true,'pre-deployment-only declaration required');
    assert.ok(provenanceFields.slice(1).every(k=>!Object.hasOwn(c,k)),'staging provenance modes cannot mix');
    return {noDeploymentOrFundingOrServiceState:true};
  }
  assert.equal(c.initialState,'program_deployed_pool_uninitialized','explicit staging state required');
  assert.equal(c.noPoolFundingOrServiceState,true,'no existing Pool financial/service state required');
  fields(c.finalizedProgramVerification,['path','sha256']);
  assert.equal(typeof c.finalizedProgramVerification!.path,'string');
  assert.match(c.finalizedProgramVerification!.sha256,/^[0-9a-f]{64}$/);
  return {initialState:c.initialState,noPoolFundingOrServiceState:true,finalizedProgramVerification:c.finalizedProgramVerification};
}
async function verifyFinalizedProgramEvidence(provenance:StagingProvenance,deployment:any,program:Uint8Array){
  if(!provenance.finalizedProgramVerification)return;
  const pin=provenance.finalizedProgramVerification,e=await pinnedJson(pin.path,pin.sha256);
  fields(e,['schema','kind','observed_at_utc','context_slot','program_id','program_data','deployment_slot','upgrade_authority','program_sha256','program_bytes','program_account_sha256','program_data_account_sha256','pool','pool_absent','commitment','genesis','chain_writes','provider_actions']);
  assert.equal(e.schema,1);assert.equal(e.kind,'independent_finalized_program_account_verification');
  assert.equal(e.commitment,'finalized');assert.equal(e.pool_absent,true,'existing Pool cannot be staged');
  assert.equal(e.chain_writes,0);assert.equal(e.provider_actions,0);
  for(const field of ['context_slot','deployment_slot']){assert.match(e[field],/^(0|[1-9][0-9]*)$/);assert.ok(BigInt(e[field])<=0xffffffffffffffffn);}
  assert.ok(BigInt(e.deployment_slot)<=BigInt(e.context_slot),'deployment must precede finalized observation');
  assert.equal(new Date(e.observed_at_utc).toISOString(),e.observed_at_utc,'canonical evidence time');
  for(const field of ['program_id','pool','genesis'])assert.equal(e[field],deployment[field],'finalized deployment identity');
  assert.equal(e.upgrade_authority,deployment.initializer,'finalized upgrade authority');
  assert.equal(e.program_sha256,await sha256Hex(program),'finalized program bytes');assert.equal(e.program_bytes,program.length);
  for(const field of ['program_account_sha256','program_data_account_sha256'])assert.match(e[field],/^[0-9a-f]{64}$/);
  const programData=(await getProgramDerivedAddress({programAddress:parseAddress('BPFLoaderUpgradeab1e11111111111111111111111'),seeds:[bs58.decode(deployment.program_id)]}))[0];
  assert.equal(e.program_data,programData,'finalized ProgramData PDA');
}

export async function preparePublicDevnetDeployment(configuration:PublicDeploymentPreparation,output:string){
  const c=structuredClone(configuration);validate(c);const destination=resolve(output);
  // Fail before reading signing material when an output already exists. mkdir
  // below is still exclusive, protecting the final create against racing calls.
  await assert.rejects(lstat(destination),{code:'ENOENT'},'output must not exist');
  const declaration=await pinnedJson(c.stagingDeclarationPath,c.stagingDeclarationSha256);
  fields(declaration,['schema','kind','expected','sourceBundleSha256','sourceDeploymentSha256','publicSetupSha256'],provenanceFields);
  const provenance=stagingProvenance(declaration);
  assert.equal(declaration.schema,1);assert.equal(declaration.kind,provenance.initialState?'public_devnet_program_deployed_pool_uninitialized':'public_devnet_predeployment');
  assert.deepEqual(declaration.expected,c.expected);assert.equal(declaration.sourceBundleSha256,c.sourceBundleSha256);
  assert.equal(declaration.sourceDeploymentSha256,c.sourceDeploymentSha256);assert.equal(declaration.publicSetupSha256,c.publicSetupSha256);
  const descriptor=resolve(c.sourceBundlePath),sourceUrl=c.assetsBaseUrl+'bundle.json';
  const localFetch:typeof fetch=async(input,init)=>{
    assert.equal(init?.method??'GET','GET');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    const url=String(input);assert.ok(url.startsWith(c.assetsBaseUrl),'unexpected offline asset request');
    const name=url.slice(c.assetsBaseUrl.length);assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);assert.ok(name!=='.'&&name!=='..');
    return new Response(await bytes(url===sourceUrl?descriptor:join(dirname(descriptor),name)));
  };
  const assets=await loadDeploymentAssets(sourceUrl,{bundleSha256:c.sourceBundleSha256,fetch:localFetch});
  const original=assets.verifiedManifest;validateNoticeNames(assets.notices,Object.keys(assets.artifacts.additional??{}).length);
  assert.deepEqual({deploymentId:original.deployment_id,programId:original.program_id,pool:original.pool,manifestHash:original.manifest_hash},c.expected,'source deployment pins mismatch');
  assert.equal(original.deployment_environment,'devnet');assert.equal(original.setup_profile,'test_only');assert.equal(original.cap_micro_usdc,'1000000');
  assert.equal(original.genesis_hash,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  assert.equal(original.mint,'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  const deployment=await pinnedJson(c.sourceDeploymentPath,c.sourceDeploymentSha256);
  fields(deployment,['schema','genesis','program_id','initializer','pool_id_hex','pool','mint','token_program','ttl_seconds','challenge_seconds','cap_micro_usdc','deposit_micro_usdc','maximum_program_rent_lamports','maximum_transaction_fee_lamports','created_at_utc','public_profile_sha256']);
  assert.equal(deployment.schema,1);assert.equal(deployment.genesis,original.genesis_hash);
  for(const field of ['program_id','pool','mint','token_program','challenge_seconds','cap_micro_usdc'])assert.equal(deployment[field],original[field as keyof typeof original]);
  assert.equal(deployment.ttl_seconds,original.note_ttl_seconds);assert.equal(deployment.public_profile_sha256,c.publicSetupSha256);
  assert.match(deployment.pool_id_hex,/^[0-9a-f]{64}$/);
  assert.equal((await getProgramDerivedAddress({programAddress:parseAddress(original.program_id),seeds:[Buffer.from('pool'),Buffer.from(deployment.pool_id_hex,'hex')]}))[0],original.pool,'Pool PDA must match staging seed');
  const setup=await loadPublicDevnetProfile(c.publicSetupDirectory,c.publicSetupSha256);
  for(const field of [...PROFILE_FIELDS,'circuit_profile_hash','state_key','clearance_key','quote_public_key','receipt_public_key'])assert.deepEqual(jcsBytes(original[field as keyof typeof original] as any),jcsBytes(setup.profile[field]),'public setup/manifest join');
  assert.equal(original.artifact_digests.public_devnet_profile,c.publicSetupSha256);
  assert.deepEqual(assets.artifacts.additional!.public_devnet_profile,setup.bytes);
  const buildBytes=assets.artifacts.additional!.devnet_build_manifest,program=assets.artifacts.additional!.vault_program;
  assert.ok(buildBytes&&program,'authenticated build/program artifacts required');const build=JSON.parse(JSON.stringify(parseStrictJson(buildBytes))) as any;
  assert.equal(build.schema,2);assert.equal(build.public_profile_sha256,c.publicSetupSha256);assert.equal(build.tree_setup,'single_party_os_random');
  assert.equal(build.program_id,original.program_id);assert.equal(build.genesis_hash,original.genesis_hash);
  assert.equal(build.deployment_environment,'devnet');assert.equal(build.setup_profile,'test_only');assert.equal(build.mint,original.mint);assert.equal(build.token_program,original.token_program);
  assert.equal(build.idl_sha256,original.idl_hash);assert.equal(build.program_sha256,await sha256Hex(program));
  for(const field of ['state_key','clearance_key','circuit_profile_hash'])assert.deepEqual(build[field],setup.profile[field]);
  assert.ok(original.tariff_hashes.includes(c.consumer.model.tariff.tariff_hash),'selected tariff must already be authenticated');
  const key=await manifestKey(c.manifestAuthorityKeyPath);
  for(const role of ['admin','upgrade'] as const){const a=original.authorities[role];assert.ok('kind' in a&&a.kind==='devnet_test_single_key');assert.equal(a.authority,key.address,'existing manifest authority required');}
  await verifyFinalizedProgramEvidence(provenance,deployment,program);
  assert.equal(build.deployment_authority,key.address);assert.equal(deployment.initializer,key.address);
  await verifyEd25519(key.address,Buffer.from(original.manifest_hash,'hex'),original.manifest_signature);
  if(assets.trust.anchor.kind==='ed25519')assert.equal(assets.trust.anchor.publicKey,key.address,'existing distribution signer required');
  const manifest={...structuredClone(original),control_api_origin:c.publicOrigin,inference_api_origin:c.publicOrigin,proving_keys_base_url:c.assetsBaseUrl};
  manifest.manifest_hash=await manifestDigest(manifest);
  manifest.manifest_signature=Buffer.from(await signBytes(key.keyPair.privateKey,Buffer.from(manifest.manifest_hash,'hex'))).toString('base64');
  const trust:ManifestTrustPolicy={anchor:{kind:'ed25519',publicKey:key.address},expected:{...assets.trust.expected,control_api_origin:c.publicOrigin,inference_api_origin:c.publicOrigin},build:structuredClone(assets.trust.build)};
  await verifyManifest(jcsBytes(manifest),trust);
  // Public SDK profile validation happens before publishing profile.json. A
  // failed output remains owner-private and cannot be reused automatically.
  await mkdir(destination,{mode:0o700});
  const put=async(name:string,value:Uint8Array)=>writeFile(join(destination,name),value,{flag:'wx',mode:0o600});
  const json=async(name:string,value:unknown)=>put(name,jcsBytes(value as any));
  await json('public-manifest.json',manifest);await json('trust.json',trust);await json('deployment.json',deployment);
  await put('build-manifest.json',buildBytes);await put('vault-idl.json',assets.artifacts.idl);await put('zkapi_vault.so',program);
  const paths:any={additional:{}};
  for(const name of artifactNames){const file='input-'+name+'.bin';await put(file,assets.artifacts[name]);paths[name]=file;}
  let index=0;
  for(const[name,value]of Object.entries(assets.artifacts.additional??{})){const file='input-additional-'+index+++'.bin';await put(file,value);paths.additional[name]=file;}
  await put('input-prover.wasm',assets.wasm);
  const noticePaths:Record<string,string>={};let noticeIndex=0;
  for(const[name,value]of Object.entries(assets.notices)){const file='input-notice-'+noticeIndex+++'.bin';await put(file,value);noticePaths[name]=file;}
  const packager={schema:1,manifest:'public-manifest.json',trust,artifacts:paths,wasm:{path:'input-prover.wasm',sha256:assets.wasmSha256},notices:noticePaths};
  await json('public-assets-config.json',packager);
  const packaged=await packageDeploymentAssets(join(destination,'public-assets-config.json'),join(destination,'assets'));
  const profile:PublicDeploymentProfile={schema:1,id:c.consumer.id,revision:c.consumer.revision,sdkVersions:[PUBLIC_PROFILE_SDK_VERSION],protocolLayoutVersion:2,
    bundle:{url:sourceUrl,sha256:packaged.bundleSha256},rpcUrl:c.publicOrigin+'/rpc',indexerOrigin:c.publicOrigin,mode:'direct_openrouter',
    models:[c.consumer.model],modelCapabilities:{[c.consumer.model.id]:{streaming:c.consumer.streaming,tools:c.consumer.tools}},
    directProviderBases:{direct_openrouter:'https://openrouter.ai/api/v1'},preparationCommitment:'finalized'};
  const profileBytes=jcsBytes(profile as any),profileSha256=await sha256Hex(profileBytes);
  const outputFetch:typeof fetch=async(input,init)=>{
    assert.equal(init?.method??'GET','GET');assert.equal(init?.credentials,'omit');assert.equal(init?.redirect,'error');
    if(String(input)===c.profileUrl)return new Response(new Uint8Array(profileBytes));
    const url=String(input);assert.ok(url.startsWith(c.assetsBaseUrl));const name=url.slice(c.assetsBaseUrl.length);
    assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);assert.ok(name!=='.'&&name!=='..');return new Response(await bytes(join(destination,'assets',name)));
  };
  const loaded=await loadPublicDeploymentProfile(c.profileUrl,{profileSha256,fetch:outputFetch});
  assert.equal(loaded.assets.verifiedManifest.manifest_hash,manifest.manifest_hash);
  assert.deepEqual({...loaded.assets.notices},{...assets.notices},'all authenticated notice bytes must survive repackage');
  await put('consumer-profile.json',profileBytes);
  await json('private-indexer.json',{rpc_url:c.privateRpcUrl,program_id:manifest.program_id,pool:manifest.pool,genesis_hash:manifest.genesis_hash,circuit_profile_hash:manifest.circuit_profile_hash,
    start_slot:c.startSlot,listen:c.indexerListen,public_origin:c.publicOrigin,snapshots_directory:c.snapshotsDirectory});
  const report={schema:1,kind:'predeployment_public_origin_preparation',sourceBundleSha256:c.sourceBundleSha256,publicSetupSha256:c.publicSetupSha256,
    stagingDeclarationSha256:c.stagingDeclarationSha256,sourceDeploymentSha256:c.sourceDeploymentSha256,sourceManifestHash:original.manifest_hash,manifestHash:manifest.manifest_hash,
    deploymentId:manifest.deployment_id,programId:manifest.program_id,pool:manifest.pool,profileSha256,bundleSha256:packaged.bundleSha256,
    networkActions:0,transactionActions:0,providerActions:0,serviceActions:0,chainCompatible:false,
    initialState:provenance.initialState??'undeployed',finalizedProgramVerificationSha256:provenance.finalizedProgramVerification?.sha256??null,
    requiredBeforeBootstrap:'Independently verify finalized program/Pool/build, initialization slot and absence of existing financial state. Never use this output for an active or funded Pool migration.'};
  await json('preparation-report.json',report);return report;
}
/** Initial staging authoring uses only independently pinned public build/setup
 * inputs and the explicit manifest-authority key. It never reads a transaction
 * wallet, discovers .env, queries a chain, or declares a Pool initialized. */
export interface InitialPublicStagingPreparation extends StagingProvenance {
  schema:1;
  distributionDecisionPath:string;
  distributionDecisionSha256:string;
  noticesDirectory:string;
  /** Source-specific reviewed notices; never inferred from an older binary. */
  additionalNotices?:Record<string,{path:string;sha256:string;bytes:number}>;
  publicSetupDirectory:string;
  publicSetupSha256:string;
  deploymentPath:string;
  deploymentSha256:string;
  buildManifestPath:string;
  buildManifestSha256:string;
  idlPath:string;
  programPath:string;
  wasmPath:string;
  wasmSha256:string;
  expected:{deploymentId:string;programId:string;pool:string};
  manifestAuthorityKeyPath:string;
  publicOrigin:string;
  assetsBaseUrl:string;
  profileUrl:string;
  privateRpcUrl:string;
  indexerListen:string;
  snapshotsDirectory:string;
  startSlot:number;
  consumer:PublicDeploymentPreparation['consumer'];
}
export async function stagePublicDevnetDeployment(configuration:InitialPublicStagingPreparation,output:string){
  const c=structuredClone(configuration),destination=resolve(output);
  fields(c,['schema','distributionDecisionPath','distributionDecisionSha256','noticesDirectory','publicSetupDirectory','publicSetupSha256','deploymentPath','deploymentSha256','buildManifestPath','buildManifestSha256','idlPath','programPath','wasmPath','wasmSha256','expected','manifestAuthorityKeyPath','publicOrigin','assetsBaseUrl','profileUrl','privateRpcUrl','indexerListen','snapshotsDirectory','startSlot','consumer'],['additionalNotices',...provenanceFields]);
  fields(c.expected,['deploymentId','programId','pool']);assert.equal(c.schema,1);
  const provenance=stagingProvenance(c);
  await assert.rejects(lstat(destination),{code:'ENOENT'},'output must not exist');
  publicUrl(c.publicOrigin,true);publicUrl(c.assetsBaseUrl);publicUrl(c.profileUrl);
  const setup=await loadPublicDevnetProfile(c.publicSetupDirectory,c.publicSetupSha256);
  const decision=await pinnedJson(c.distributionDecisionPath,c.distributionDecisionSha256);
  assert.equal(decision.schema,1);assert.equal(decision.selected_license,'Apache-2.0');
  assert.deepEqual(Object.keys(decision.notices).sort(),[...requiredNoticeNames].sort(),'exact reviewed notice map required');
  const noticeBytes:Record<string,Uint8Array>={};
  for(const[name,entry]of Object.entries(decision.notices) as [string,any][]){
    const b=await bytes(join(c.noticesDirectory,name),1024*1024);assert.equal(b.length,entry.bytes);assert.equal(await sha256Hex(b),entry.sha256,'reviewed notice hash');noticeBytes[name]=b;
  }
  const upstreamFiles={requestPk:'request.pk',requestVk:'request.vk',withdrawalPk:'withdrawal.pk',withdrawalVk:'withdrawal.vk'};
  assert.deepEqual(Object.keys(decision.files).sort(),Object.keys(upstreamFiles).map(n=>n+'.bin').sort(),'exact upstream setup decisions');
  for(const[name,file]of Object.entries(upstreamFiles)){
    const entry=decision.files[name+'.bin'],b=setup.artifacts[file];assert.equal(entry.decision,'approved');assert.equal(entry.selected_license,'Apache-2.0');
    assert.equal(entry.sha256,await sha256Hex(b));assert.equal(entry.bytes,b.length);assert.deepEqual([...entry.notices].sort(),[...requiredNoticeNames].sort(),'setup notice requirements');
  }
  if(c.additionalNotices!==undefined){
    assert.ok(c.additionalNotices&&typeof c.additionalNotices==='object'&&!Array.isArray(c.additionalNotices),'additional notice map required');
    validateNoticeNames({...noticeBytes,...c.additionalNotices},4);
    for(const[name,entry]of Object.entries(c.additionalNotices)){
      assert.ok(!Object.hasOwn(noticeBytes,name),'mandatory notices cannot be replaced');fields(entry,['path','sha256','bytes']);
      assert.equal(typeof entry.path,'string');assert.match(entry.sha256,/^[0-9a-f]{64}$/);
      assert.ok(Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&entry.bytes<=1024*1024,'additional notice size');
      const b=await bytes(entry.path,1024*1024);assert.equal(b.length,entry.bytes);assert.equal(await sha256Hex(b),entry.sha256,'additional reviewed notice hash');noticeBytes[name]=b;
    }
  }
  validateNoticeNames(noticeBytes,4);
  assert.ok(Object.values(noticeBytes).reduce((n,b)=>n+b.length,0)<=4*1024*1024,'total notice size');
  const deployment=await pinnedJson(c.deploymentPath,c.deploymentSha256),build=await pinnedJson(c.buildManifestPath,c.buildManifestSha256);
  fields(deployment,['schema','genesis','program_id','initializer','pool_id_hex','pool','mint','token_program','ttl_seconds','challenge_seconds','cap_micro_usdc','deposit_micro_usdc','maximum_program_rent_lamports','maximum_transaction_fee_lamports','created_at_utc','public_profile_sha256']);
  assert.equal(deployment.schema,1);assert.equal(deployment.public_profile_sha256,c.publicSetupSha256);
  assert.equal(deployment.program_id,c.expected.programId);assert.equal(deployment.pool,c.expected.pool);
  assert.match(deployment.pool_id_hex,/^[0-9a-f]{64}$/);
  assert.equal((await getProgramDerivedAddress({programAddress:parseAddress(deployment.program_id),seeds:[Buffer.from('pool'),Buffer.from(deployment.pool_id_hex,'hex')]}))[0],deployment.pool,'staging Pool PDA');
  assert.equal(deployment.genesis,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  assert.equal(deployment.mint,'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  assert.equal(deployment.token_program,'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  assert.equal(build.schema,2);assert.equal(build.public_profile_sha256,c.publicSetupSha256);assert.equal(build.tree_setup,'single_party_os_random');
  assert.equal(build.deployment_environment,'devnet');assert.equal(build.setup_profile,'test_only');
  for(const field of ['program_id','mint','token_program'])assert.equal(build[field],deployment[field],'staging build/deployment join');
  assert.equal(build.genesis_hash,deployment.genesis);assert.equal(build.deployment_authority,deployment.initializer);
  for(const field of ['state_key','clearance_key','circuit_profile_hash'])assert.deepEqual(build[field],setup.profile[field],'staging build/setup join');
  const idl=await bytes(c.idlPath),program=await bytes(c.programPath),wasm=await bytes(c.wasmPath),buildBytes=await bytes(c.buildManifestPath);
  assert.equal(await sha256Hex(idl),build.idl_sha256);assert.equal(await sha256Hex(program),build.program_sha256);
  assert.equal((parseStrictJson(idl) as any).address,deployment.program_id,'IDL program address');
  assert.equal(await sha256Hex(buildBytes),c.buildManifestSha256);assert.equal(await sha256Hex(wasm),c.wasmSha256);assert.ok(WebAssembly.validate(wasm));
  await verifyFinalizedProgramEvidence(provenance,deployment,program);
  const key=await manifestKey(c.manifestAuthorityKeyPath);assert.equal(key.address,deployment.initializer,'staging manifest authority');
  const authority={kind:'devnet_test_single_key' as const,authority:key.address};
  const manifest:any={...publicDevnetManifestBase(setup),deployment_id:c.expected.deploymentId,deployment_environment:'devnet',genesis_hash:deployment.genesis,
    program_id:deployment.program_id,pool:deployment.pool,mint:deployment.mint,token_program:deployment.token_program,
    control_api_origin:c.publicOrigin,inference_api_origin:c.publicOrigin,proving_keys_base_url:c.assetsBaseUrl,
    note_ttl_seconds:deployment.ttl_seconds,challenge_seconds:deployment.challenge_seconds,cap_micro_usdc:deployment.cap_micro_usdc,
    idl_hash:build.idl_sha256,vault_binding:await vaultBinding(...[deployment.genesis,deployment.program_id,deployment.pool,deployment.token_program,deployment.mint].map(bs58.decode) as [Uint8Array,Uint8Array,Uint8Array,Uint8Array,Uint8Array]),
    authorities:{admin:authority,upgrade:authority},tariff_hashes:[c.consumer.model.tariff.tariff_hash],
    artifact_digests:{vault_idl:build.idl_sha256,vault_program:build.program_sha256,devnet_build_manifest:c.buildManifestSha256,public_devnet_profile:c.publicSetupSha256}};
  manifest.manifest_hash=await manifestDigest(manifest);manifest.manifest_signature=Buffer.from(await signBytes(key.keyPair.privateKey,Buffer.from(manifest.manifest_hash,'hex'))).toString('base64');
  const trust:ManifestTrustPolicy={anchor:{kind:'ed25519',publicKey:key.address},expected:{deployment_id:manifest.deployment_id,deployment_environment:'devnet',genesis_hash:deployment.genesis,program_id:deployment.program_id,pool:deployment.pool,mint:deployment.mint,token_program:deployment.token_program,control_api_origin:c.publicOrigin,inference_api_origin:c.publicOrigin},
    build:{stateKey:build.state_key,clearanceKey:build.clearance_key,circuitProfileHash:build.circuit_profile_hash,idlHash:build.idl_sha256,setupProfile:'test_only',transactionFormats:['v0_buffer','v0_inline_deposit_v1']}};
  await verifyManifest(jcsBytes(manifest),trust);
  const expected={...c.expected,manifestHash:manifest.manifest_hash};
  const preparedConfig:PublicDeploymentPreparation={schema:1,sourceBundlePath:join(destination,'source-bundle','bundle.json'),sourceBundleSha256:'00'.repeat(32),
    sourceDeploymentPath:join(destination,'deployment.json'),sourceDeploymentSha256:c.deploymentSha256,publicSetupDirectory:c.publicSetupDirectory,publicSetupSha256:c.publicSetupSha256,
    stagingDeclarationPath:join(destination,'staging-declaration.json'),stagingDeclarationSha256:'00'.repeat(32),expected,manifestAuthorityKeyPath:c.manifestAuthorityKeyPath,
    publicOrigin:c.publicOrigin,assetsBaseUrl:c.assetsBaseUrl,profileUrl:c.profileUrl,privateRpcUrl:c.privateRpcUrl,indexerListen:c.indexerListen,snapshotsDirectory:c.snapshotsDirectory,startSlot:c.startSlot,consumer:c.consumer};
  validate(preparedConfig);
  await mkdir(destination,{mode:0o700});
  const put=async(name:string,value:Uint8Array)=>{const path=join(destination,name);await writeFile(path,value,{flag:'wx',mode:0o600});return path;};
  const json=async(name:string,value:unknown)=>put(name,jcsBytes(value as any));
  await put('deployment.json',await bytes(c.deploymentPath,1024*1024));
  const manifestPath=await json('staging-manifest.json',manifest);
  const artifactPaths:any={idl:await put('vault-idl.json',idl),additional:{vault_idl:join(destination,'vault-idl.json'),vault_program:await put('zkapi_vault.so',program),devnet_build_manifest:await put('build-manifest.json',buildBytes),public_devnet_profile:await put('public-profile.json',setup.bytes)}};
  for(const[name,file]of Object.entries({requestPk:'request.pk',requestVk:'request.vk',withdrawalPk:'withdrawal.pk',withdrawalVk:'withdrawal.vk',treePk:'tree.pk',treeVk:'tree.vk',treeSourceBundle:'circuit-source.tar',treeVerifierConstants:'tree-vk-wire.bin'}))artifactPaths[name]=await put('setup-'+name+'.bin',setup.artifacts[file]);
  const noticePaths:Record<string,string>={};let noticeIndex=0;
  for(const[name,value]of Object.entries(noticeBytes))noticePaths[name]=await put('source-notice-'+noticeIndex+++'.bin',value);
  await put('distribution-decision.json',await bytes(c.distributionDecisionPath,1024*1024));
  const packagerPath=await json('source-assets-config.json',{schema:1,manifest:manifestPath,trust,artifacts:artifactPaths,wasm:{path:await put('prover.wasm',wasm),sha256:c.wasmSha256},notices:noticePaths});
  const packaged=await packageDeploymentAssets(packagerPath,join(destination,'source-bundle'));
  preparedConfig.sourceBundleSha256=packaged.bundleSha256;
  const declaration={schema:1,kind:provenance.initialState?'public_devnet_program_deployed_pool_uninitialized':'public_devnet_predeployment',expected,sourceBundleSha256:packaged.bundleSha256,sourceDeploymentSha256:c.deploymentSha256,publicSetupSha256:c.publicSetupSha256,...provenance};
  const declarationBytes=jcsBytes(declaration);await put('staging-declaration.json',declarationBytes);preparedConfig.stagingDeclarationSha256=await sha256Hex(declarationBytes);
  await json('private-preparation-config.json',preparedConfig);
  const report=await preparePublicDevnetDeployment(preparedConfig,join(destination,'prepared'));
  const stagingReport={...report,stagingAuthoredOffline:true,sourceBuildManifestSha256:c.buildManifestSha256,distributionDecisionSha256:c.distributionDecisionSha256,noticeSha256:Object.fromEntries(await Promise.all(Object.entries(noticeBytes).map(async([name,b])=>[name,await sha256Hex(b)])))};
  await json('staging-report.json',stagingReport);return stagingReport;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const staging=process.argv[2]==='--stage';assert.equal(process.argv.length,staging?5:4,'configuration and new output directory required');
    const input=resolve(process.argv[staging?3:2]),info=await lstat(input);assert.ok(info.isFile()&&(info.mode&0o077)===0&&info.uid===process.getuid?.(),'private configuration required');
    const config=parseStrictJson(await bytes(input,1024*1024)) as any;
    const report=staging?await stagePublicDevnetDeployment(config,process.argv[4]):await preparePublicDevnetDeployment(config,process.argv[3]);
    console.log(JSON.stringify(report,null,2));
  }catch{console.error('Public Devnet offline preparation failed. Check staging provenance, independent pins, authority, exact origins and a new output directory. No network action was attempted.');process.exitCode=1;}
}
