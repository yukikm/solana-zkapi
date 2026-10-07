/** Offline synthetic staging metadata only. No funded state, real setup,
 * listeners, network calls, provider credentials or transactions. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,readFile,writeFile,rm,mkdir,copyFile,lstat,readdir,chmod,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {address,getAddressEncoder,getProgramDerivedAddress,createKeyPairSignerFromPrivateKeyBytes,signBytes} from '@solana/kit';
import {publicProfileFixture} from '../packages/sdk/test/public-profile-fixture.ts';
import {jcsBytes,manifestDigest,sha256Hex,verifyManifest} from '../packages/sdk/src/trust.ts';
import {PROFILE_FIELDS,loadPublicDevnetProfile,publicDevnetManifestBase,profileSha} from './i10_public_devnet_profile.ts';
import {packageDeploymentAssets} from './package_sdk_distribution_assets.mjs';
import {preparePublicDevnetDeployment,stagePublicDevnetDeployment,type PublicDeploymentPreparation,type InitialPublicStagingPreparation} from './prepare_public_devnet_deployment.ts';

async function fixture(t:TestContext){
  const dir=await mkdtemp(join(tmpdir(),'zkapi-offline-public-emitter-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const setupDir=join(dir,'setup');await mkdir(setupDir);
  const original=JSON.parse(await readFile('tests/fixtures/layout2/profile.json','utf8')),artifactHashes:Record<string,string>={};
  for(const[file,key]of [['tree.pk','pk_hash'],['tree.vk','vk_hash'],['tree-vk-wire.bin','verifier_constants_hash'],['circuit-source.tar','source_bundle_hash']]){
    const b=Buffer.from('synthetic non-deployable '+file);await writeFile(join(setupDir,file),b);original.tree_proof_artifacts[key]=profileSha(b);artifactHashes[file]=profileSha(b);
  }
  for(const file of ['request.pk','request.vk','withdrawal.pk','withdrawal.vk']){await copyFile('vendor/ethereum-zkapi/protocol/setup/v2/'+file,join(setupDir,file));artifactHashes[file]=profileSha(await readFile(join(setupDir,file)));}
  const circuit=Object.fromEntries(PROFILE_FIELDS.map(k=>[k,original[k]]));original.circuit_profile_hash=profileSha(jcsBytes(circuit));
  const circuitBytes=jcsBytes({...circuit,circuit_profile_hash:original.circuit_profile_hash});await writeFile(join(setupDir,'profile.json'),circuitBytes);artifactHashes['profile.json']=profileSha(circuitBytes);
  const field=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
  Object.assign(original,{schema:1,kind:'public_devnet',tree_setup:'single_party_os_random',production_eligible:false,limitations:['Synthetic fixture; no sound setup or public deployment'],
    state_key:{x:field(2),y:field(3)},clearance_key:{x:field(4),y:field(5)},quote_public_key:(await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(41))).address,
    receipt_public_key:(await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(42))).address,artifact_hashes:artifactHashes});
  const publicSetupBytes=jcsBytes(original),setupHash=profileSha(publicSetupBytes);await writeFile(join(setupDir,'public-profile.json'),publicSetupBytes);
  const loaded=await loadPublicDevnetProfile(setupDir,setupHash),f=await publicProfileFixture();
  const seed=new Uint8Array(32).fill(61),key=await createKeyPairSignerFromPrivateKeyBytes(seed),keyPath=join(dir,'authority.json');
  await writeFile(keyPath,JSON.stringify([...seed]),{mode:0o600});
  const program=Buffer.from('synthetic ELF'),idl=new Uint8Array(await readFile('docs/contracts/zkapi_vault.json'));
  const build={schema:2,public_profile_sha256:setupHash,tree_setup:'single_party_os_random',deployment_environment:'devnet',setup_profile:'test_only',program_id:f.manifest.program_id,
    deployment_authority:key.address,genesis_hash:f.manifest.genesis_hash,mint:f.manifest.mint,token_program:f.manifest.token_program,idl_sha256:await sha256Hex(idl),program_sha256:await sha256Hex(program),
    state_key:original.state_key,clearance_key:original.clearance_key,circuit_profile_hash:original.circuit_profile_hash};
  const buildBytes=jcsBytes(build),authority={kind:'devnet_test_single_key',authority:key.address};
  const manifest:any={...f.manifest,...publicDevnetManifestBase(loaded),idl_hash:await sha256Hex(idl),tariff_hashes:f.manifest.tariff_hashes,
    control_api_origin:'https://127.0.0.1:18885',inference_api_origin:'https://127.0.0.1:18886',proving_keys_base_url:'https://127.0.0.1:18885/keys',
    authorities:{admin:authority,upgrade:authority},artifact_digests:{vault_idl:await sha256Hex(idl),vault_program:await sha256Hex(program),devnet_build_manifest:await sha256Hex(buildBytes),public_devnet_profile:setupHash}};
  manifest.manifest_hash=await manifestDigest(manifest);manifest.manifest_signature=Buffer.from(await signBytes(key.keyPair.privateKey,Buffer.from(manifest.manifest_hash,'hex'))).toString('base64');
  const trust={anchor:{kind:'ed25519',publicKey:key.address},expected:{...f.trust.expected,control_api_origin:manifest.control_api_origin,inference_api_origin:manifest.inference_api_origin},
    build:{stateKey:manifest.state_key,clearanceKey:manifest.clearance_key,circuitProfileHash:manifest.circuit_profile_hash,idlHash:manifest.idl_hash,setupProfile:'test_only',transactionFormats:manifest.transaction_formats}};
  const input=join(dir,'input');await mkdir(input);
  const save=async(name:string,value:Uint8Array)=>{const path=join(input,name);await writeFile(path,value);return path;};
  const artifacts:any={idl:await save('idl',idl),additional:{vault_idl:await save('idl-extra',idl),vault_program:await save('program',program),devnet_build_manifest:await save('build',buildBytes),public_devnet_profile:join(setupDir,'public-profile.json')}};
  for(const[name,file]of Object.entries({requestPk:'request.pk',requestVk:'request.vk',withdrawalPk:'withdrawal.pk',withdrawalVk:'withdrawal.vk',treePk:'tree.pk',treeVk:'tree.vk',treeSourceBundle:'circuit-source.tar',treeVerifierConstants:'tree-vk-wire.bin'}))artifacts[name]=join(setupDir,file);
  const wasm=new Uint8Array([0,97,115,109,1,0,0,0]);
  const decision=JSON.parse(await readFile('deploy/public-devnet/upstream-setup-distribution.json','utf8')),notices:any={};
  const noticesDirectory=join(dir,'notices');await mkdir(noticesDirectory);
  for(const name of Object.keys(decision.notices)){const path=join(noticesDirectory,name);await copyFile('deploy/public-devnet/upstream-notices/'+name,path);notices[name]=path;}
  await save('distribution-decision.json',jcsBytes(decision));
  const configPath=await save('assets.json',jcsBytes({schema:1,trust,manifest:await save('manifest.json',jcsBytes(manifest)),artifacts,wasm:{path:await save('prover.wasm',wasm),sha256:await sha256Hex(wasm)},notices}));
  const sourceBundle=join(dir,'source-bundle'),packaged=await packageDeploymentAssets(configPath,sourceBundle);
  const deployment={schema:1,genesis:manifest.genesis_hash,program_id:manifest.program_id,initializer:key.address,pool_id_hex:Buffer.alloc(32,17).toString('hex'),pool:manifest.pool,mint:manifest.mint,token_program:manifest.token_program,
    ttl_seconds:manifest.note_ttl_seconds,challenge_seconds:manifest.challenge_seconds,cap_micro_usdc:manifest.cap_micro_usdc,deposit_micro_usdc:'1000000',maximum_program_rent_lamports:'4000000000',maximum_transaction_fee_lamports:'10000',created_at_utc:'2026-10-07T00:00:00Z',public_profile_sha256:setupHash};
  const deploymentBytes=jcsBytes(deployment),sourceDeploymentPath=await save('deployment.json',deploymentBytes);
  const expected={deploymentId:manifest.deployment_id,programId:manifest.program_id,pool:manifest.pool,manifestHash:manifest.manifest_hash};
  const declaration={schema:1,kind:'public_devnet_predeployment',expected,sourceBundleSha256:packaged.bundleSha256,sourceDeploymentSha256:await sha256Hex(deploymentBytes),publicSetupSha256:setupHash,noDeploymentOrFundingOrServiceState:true};
  const declarationBytes=jcsBytes(declaration),declarationPath=await save('staging.json',declarationBytes);
  const config:PublicDeploymentPreparation={schema:1,sourceBundlePath:join(sourceBundle,'bundle.json'),sourceBundleSha256:packaged.bundleSha256,
    sourceDeploymentPath,sourceDeploymentSha256:await sha256Hex(deploymentBytes),publicSetupDirectory:setupDir,publicSetupSha256:setupHash,stagingDeclarationPath:declarationPath,stagingDeclarationSha256:await sha256Hex(declarationBytes),
    expected,manifestAuthorityKeyPath:keyPath,publicOrigin:'https://d123fixture.cloudfront.net',assetsBaseUrl:'https://d123fixture.cloudfront.net/releases/staging-1/',profileUrl:'https://d123fixture.cloudfront.net/profiles/staging-1.json',
    privateRpcUrl:'https://rpc.operator.example.com/?api-key=PRIVATE_FIXTURE',indexerListen:'127.0.0.1:18883',snapshotsDirectory:join(dir,'snapshots'),startSlot:0,
    consumer:{id:'staging-fixture',revision:1,model:f.profile.models[0],streaming:true,tools:false}};
  return{dir,config,manifest,trust,expected,declaration,keyPath,output:join(dir,'prepared')};
}

test('offline emitter signs canonical generated HTTPS origins and verifies complete profile/trust joins',async t=>{
  const f=await fixture(t),before=await readFile(f.config.sourceBundlePath),keyBefore=await readFile(f.keyPath);
  const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('network forbidden');};t.after(()=>{globalThis.fetch=savedFetch;});
  const report=await preparePublicDevnetDeployment(f.config,f.output);assert.equal(report.networkActions,0);assert.equal(report.transactionActions,0);assert.equal(report.chainCompatible,false);
  const m=JSON.parse(await readFile(join(f.output,'public-manifest.json'),'utf8')),trust=JSON.parse(await readFile(join(f.output,'trust.json'),'utf8'));
  await verifyManifest(jcsBytes(m),trust);assert.equal(m.control_api_origin,f.config.publicOrigin);assert.equal(m.inference_api_origin,f.config.publicOrigin);assert.equal(m.proving_keys_base_url,f.config.assetsBaseUrl);
  for(const key of Object.keys(f.manifest).filter(k=>!['control_api_origin','inference_api_origin','proving_keys_base_url','manifest_hash','manifest_signature'].includes(k)))assert.deepEqual(m[key],f.manifest[key],key);
  const profile=JSON.parse(await readFile(join(f.output,'consumer-profile.json'),'utf8'));assert.equal(profile.rpcUrl,f.config.publicOrigin+'/rpc');assert.equal(profile.bundle.url,f.config.assetsBaseUrl+'bundle.json');
  assert.equal(profile.bundle.sha256,report.bundleSha256);assert.deepEqual(trust.build,f.trust.build);
  const descriptor=JSON.parse(await readFile(join(f.output,'assets','bundle.json'),'utf8'));assert.equal(descriptor.schema,2);assert.equal(Object.keys(descriptor.notices).length,5);
  for(const name of Object.keys(descriptor.notices))assert.deepEqual(await readFile(join(f.output,'assets',name)),await readFile(join(f.dir,'notices',name)));
  const privateConfig=JSON.parse(await readFile(join(f.output,'private-indexer.json'),'utf8'));assert.equal(privateConfig.public_origin,f.config.publicOrigin);assert.equal(privateConfig.rpc_url,f.config.privateRpcUrl);
  assert.deepEqual(await readFile(f.config.sourceBundlePath),before);assert.deepEqual(await readFile(f.keyPath),keyBefore);
  assert.equal((await lstat(f.output)).mode&0o077,0);
  for(const name of await readdir(join(f.output,'assets'))){const b=await readFile(join(f.output,'assets',name));assert.ok(!b.includes('PRIVATE_FIXTURE'));assert.ok(!b.includes(f.keyPath));assert.ok(!b.includes('https://127.0.0.1'));}
  await assert.rejects(preparePublicDevnetDeployment(f.config,f.output),/output must not exist/);
});

test('offline emitter refuses altered source and setup pins, missing staging assertion and output reuse before writes',async t=>{
  const f=await fixture(t);
  for(const patch of [{sourceBundleSha256:'00'.repeat(32)},{publicSetupSha256:'00'.repeat(32)},{sourceDeploymentSha256:'00'.repeat(32)},{expected:{...f.expected,pool:f.expected.programId}}]){
    await assert.rejects(preparePublicDevnetDeployment({...f.config,...patch},f.output));await assert.rejects(lstat(f.output),{code:'ENOENT'});
  }
  const declaration={...f.declaration,noDeploymentOrFundingOrServiceState:false},b=jcsBytes(declaration);await writeFile(f.config.stagingDeclarationPath,b);
  await assert.rejects(preparePublicDevnetDeployment({...f.config,stagingDeclarationSha256:await sha256Hex(b)},f.output),/pre-deployment-only/);await assert.rejects(lstat(f.output),{code:'ENOENT'});
});

test('offline emitter rejects placeholder/private origins and mismatched manifest authority before output',async t=>{
  const f=await fixture(t);
  for(const origin of ['https://control.invalid','http://api.example.com','https://127.0.0.1','https://localhost','https://api.example.com/','https://api.example.com?key=x']){
    await assert.rejects(preparePublicDevnetDeployment({...f.config,publicOrigin:origin},f.output));await assert.rejects(lstat(f.output),{code:'ENOENT'});
  }
  await writeFile(f.keyPath,JSON.stringify([...new Uint8Array(32).fill(62)]));await assert.rejects(preparePublicDevnetDeployment(f.config,f.output),/existing manifest authority/);await assert.rejects(lstat(f.output),{code:'ENOENT'});
});

test('offline emitter requires private signing-key permissions and exact accepted configuration',async t=>{
  const f=await fixture(t);await chmod(f.keyPath,0o644);
  await assert.rejects(preparePublicDevnetDeployment(f.config,f.output),/private authority/);
  await assert.rejects(preparePublicDevnetDeployment({...f.config,allowFunding:true} as any,f.output),/exact configuration/);
  await assert.rejects(lstat(f.output),{code:'ENOENT'});
});

async function initialConfig(f:Awaited<ReturnType<typeof fixture>>):Promise<InitialPublicStagingPreparation>{
  const c=f.config,buildManifestPath=join(f.dir,'input','build'),wasmPath=join(f.dir,'input','prover.wasm');
  const distributionDecisionPath=join(f.dir,'input','distribution-decision.json');
  return{schema:1,noDeploymentOrFundingOrServiceState:true,distributionDecisionPath,distributionDecisionSha256:await sha256Hex(await readFile(distributionDecisionPath)),noticesDirectory:join(f.dir,'notices'),publicSetupDirectory:c.publicSetupDirectory,publicSetupSha256:c.publicSetupSha256,
    deploymentPath:c.sourceDeploymentPath,deploymentSha256:c.sourceDeploymentSha256,buildManifestPath,buildManifestSha256:await sha256Hex(await readFile(buildManifestPath)),
    idlPath:join(f.dir,'input','idl'),programPath:join(f.dir,'input','program'),wasmPath,wasmSha256:await sha256Hex(await readFile(wasmPath)),
    expected:{deploymentId:c.expected.deploymentId,programId:c.expected.programId,pool:c.expected.pool},manifestAuthorityKeyPath:c.manifestAuthorityKeyPath,
    publicOrigin:c.publicOrigin,assetsBaseUrl:c.assetsBaseUrl,profileUrl:c.profileUrl,privateRpcUrl:c.privateRpcUrl,indexerListen:c.indexerListen,snapshotsDirectory:c.snapshotsDirectory,startSlot:c.startSlot,consumer:c.consumer};
}
test('initial staging authors a signed complete public deployment offline without any prior manifest or bundle input',async t=>{
  const f=await fixture(t),config=await initialConfig(f),out=join(f.dir,'initial-staging');
  await rm(join(f.dir,'source-bundle'),{recursive:true});await rm(join(f.dir,'input','manifest.json'));
  const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('network forbidden');};t.after(()=>{globalThis.fetch=savedFetch;});
  const report=await stagePublicDevnetDeployment(config,out);assert.equal(report.stagingAuthoredOffline,true);assert.equal(report.chainCompatible,false);assert.equal(report.networkActions,0);
  const manifest=JSON.parse(await readFile(join(out,'prepared','public-manifest.json'),'utf8'));
  const trust=JSON.parse(await readFile(join(out,'prepared','trust.json'),'utf8'));await verifyManifest(jcsBytes(manifest),trust);
  assert.equal(manifest.program_id,config.expected.programId);assert.equal(manifest.pool,config.expected.pool);assert.equal(manifest.control_api_origin,config.publicOrigin);
  assert.equal(manifest.manifest_hash,report.manifestHash);assert.equal(report.sourceBuildManifestSha256,config.buildManifestSha256);
  await assert.rejects(stagePublicDevnetDeployment(config,out),/output must not exist/);
});
test('initial staging rejects wrong expected program, pinned build roles and deployment joins before output',async t=>{
  const f=await fixture(t),config=await initialConfig(f),out=join(f.dir,'initial-staging');
  await assert.rejects(stagePublicDevnetDeployment({...config,expected:{...config.expected,programId:config.expected.pool}},out));await assert.rejects(lstat(out),{code:'ENOENT'});
  const build=JSON.parse(await readFile(config.buildManifestPath,'utf8'));
  for(const patch of [{state_key:{x:'0x'+'00'.repeat(31)+'07',y:'0x'+'00'.repeat(31)+'08'}},{program_id:config.expected.pool},{deployment_authority:config.expected.programId}]){
    const b=jcsBytes({...build,...patch});await writeFile(config.buildManifestPath,b);
    await assert.rejects(stagePublicDevnetDeployment({...config,buildManifestSha256:await sha256Hex(b)},out));await assert.rejects(lstat(out),{code:'ENOENT'});
  }
});
test('initial staging requires exact IDL/ELF pins, original authority and explicit predeployment declaration',async t=>{
  const f=await fixture(t),config=await initialConfig(f),out=join(f.dir,'initial-staging');
  await assert.rejects(stagePublicDevnetDeployment({...config,noDeploymentOrFundingOrServiceState:false} as any,out));
  await writeFile(config.manifestAuthorityKeyPath,JSON.stringify([...new Uint8Array(32).fill(62)]));await assert.rejects(stagePublicDevnetDeployment(config,out),/staging manifest authority/);
  await writeFile(config.programPath,'changed ELF');await assert.rejects(stagePublicDevnetDeployment(config,out));await assert.rejects(lstat(out),{code:'ENOENT'});
});

test('schema two source notice mutation and notice/core filename collisions fail before output',async t=>{
  const f=await fixture(t),source=join(f.dir,'source-bundle');
  const notice=join(source,'Apache-2.0.txt'),original=await readFile(notice);await writeFile(notice,'mutated notice');
  await assert.rejects(preparePublicDevnetDeployment(f.config,f.output));await assert.rejects(lstat(f.output),{code:'ENOENT'});await writeFile(notice,original);
  const d=JSON.parse(await readFile(f.config.sourceBundlePath,'utf8')),collision=Buffer.from('collision fixture');
  await writeFile(join(source,'COLLISION.txt'),collision);d.notices['manifest.json']='COLLISION.txt';d.files['COLLISION.txt']={sha256:await sha256Hex(collision),bytes:collision.length};
  const b=jcsBytes(d);await writeFile(f.config.sourceBundlePath,b);const sourceBundleSha256=await sha256Hex(b);
  const declaration=jcsBytes({...f.declaration,sourceBundleSha256});await writeFile(f.config.stagingDeclarationPath,declaration);
  await assert.rejects(preparePublicDevnetDeployment({...f.config,sourceBundleSha256,stagingDeclarationSha256:await sha256Hex(declaration)},f.output),/notice filename collision/);
  await assert.rejects(lstat(f.output),{code:'ENOENT'});
});
test('initial staging rejects changed notices and missing or colliding reviewed decision entries before writes',async t=>{
  const f=await fixture(t),c=await initialConfig(f),out=join(f.dir,'initial-staging');
  const notice=join(c.noticesDirectory,'PROVENANCE.md'),original=await readFile(notice);await writeFile(notice,'changed provenance');
  await assert.rejects(stagePublicDevnetDeployment(c,out));await assert.rejects(lstat(out),{code:'ENOENT'});await writeFile(notice,original);
  const decision=JSON.parse(await readFile(c.distributionDecisionPath,'utf8'));decision.notices['manifest.json']=decision.notices['PROVENANCE.md'];delete decision.notices['PROVENANCE.md'];
  const b=jcsBytes(decision);await writeFile(c.distributionDecisionPath,b);
  await assert.rejects(stagePublicDevnetDeployment({...c,distributionDecisionSha256:await sha256Hex(b)},out),/exact reviewed notice map/);await assert.rejects(lstat(out),{code:'ENOENT'});
});

test('initial staging preserves all source-specific pinned extra notices alongside the mandatory five',async t=>{
  const f=await fixture(t),c=await initialConfig(f),out=join(f.dir,'initial-staging'),extra:NonNullable<InitialPublicStagingPreparation['additionalNotices']>={};
  for(const name of ['PROJECT-LICENSE.txt','SOURCE-LICENSE.txt','SOURCE-NOTICES.txt','WASM-LICENSE.txt','WASM-NOTICES.txt']){
    const data=Buffer.from('Synthetic source-specific reviewed bytes for '+name),path=join(f.dir,name);await writeFile(path,data);extra[name]={path,sha256:await sha256Hex(data),bytes:data.length};
  }
  const report=await stagePublicDevnetDeployment({...c,additionalNotices:extra},out);
  for(const base of [join(out,'source-bundle'),join(out,'prepared','assets')]){
    const descriptor=JSON.parse(await readFile(join(base,'bundle.json'),'utf8'));assert.equal(descriptor.schema,2);assert.equal(Object.keys(descriptor.notices).length,10);
    for(const[name,entry]of Object.entries(extra))assert.deepEqual(await readFile(join(base,name)),await readFile(entry.path));
  }
  for(const[name,entry]of Object.entries(extra))assert.equal(report.noticeSha256[name],entry.sha256);
});
test('extra notice mutation, symlink, size, mandatory replacement and case-insensitive collisions fail before staging output',async t=>{
  const f=await fixture(t),c=await initialConfig(f),out=join(f.dir,'initial-staging'),path=join(f.dir,'extra-notice.txt'),data=Buffer.from('Synthetic extra notice');await writeFile(path,data);
  const entry={path,sha256:await sha256Hex(data),bytes:data.length};
  for(const additionalNotices of [
    {'PROJECT-LICENSE.txt':{...entry,sha256:'00'.repeat(32)}}, {'PROJECT-LICENSE.txt':{...entry,bytes:1024*1024+1}},
    {'Apache-2.0.txt':entry}, {'apache-2.0.TXT':entry}, {'Manifest.json':entry}, {'../escape':entry},
    Object.fromEntries(Array.from({length:28},(_,i)=>['extra-'+i+'.txt',entry])),
  ]){await assert.rejects(stagePublicDevnetDeployment({...c,additionalNotices},out));await assert.rejects(lstat(out),{code:'ENOENT'});}
  const linked=join(f.dir,'linked-notice');await symlink(path,linked);
  await assert.rejects(stagePublicDevnetDeployment({...c,additionalNotices:{'PROJECT-LICENSE.txt':{...entry,path:linked}}},out));await assert.rejects(lstat(out),{code:'ENOENT'});
});

async function deployedConfig(f:Awaited<ReturnType<typeof fixture>>){
  const old=await initialConfig(f),{noDeploymentOrFundingOrServiceState,...rest}=old;
  const d=JSON.parse(await readFile(old.deploymentPath,'utf8')),program=await readFile(old.programPath);
  const evidence={schema:1,kind:'independent_finalized_program_account_verification',observed_at_utc:'2026-10-07T12:00:00.000Z',context_slot:'12',deployment_slot:'10',
    program_id:d.program_id,program_data:(await getProgramDerivedAddress({programAddress:address('BPFLoaderUpgradeab1e11111111111111111111111'),seeds:[getAddressEncoder().encode(address(d.program_id))]}))[0],
    upgrade_authority:d.initializer,program_sha256:await sha256Hex(program),program_bytes:program.length,program_account_sha256:'11'.repeat(32),program_data_account_sha256:'22'.repeat(32),
    pool:d.pool,pool_absent:true,commitment:'finalized',genesis:d.genesis,chain_writes:0,provider_actions:0};
  const path=join(f.dir,'finalized-program.json'),b=jcsBytes(evidence);await writeFile(path,b);
  const c:InitialPublicStagingPreparation={...rest,initialState:'program_deployed_pool_uninitialized',noPoolFundingOrServiceState:true,finalizedProgramVerification:{path,sha256:await sha256Hex(b)}};
  return {c,evidence,path};
}
test('already deployed program has explicit uninitialized Pool provenance and pinned finalized evidence',async t=>{
  const f=await fixture(t),{c}=await deployedConfig(f),out=join(f.dir,'deployed-staging');
  const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('network forbidden')};t.after(()=>{globalThis.fetch=savedFetch});
  const report=await stagePublicDevnetDeployment(c,out);
  assert.equal(report.initialState,'program_deployed_pool_uninitialized');assert.equal(report.finalizedProgramVerificationSha256,c.finalizedProgramVerification!.sha256);
  assert.equal(report.chainCompatible,false);assert.equal(report.networkActions,0);
  const declaration=JSON.parse(await readFile(join(out,'staging-declaration.json'),'utf8'));
  assert.equal(declaration.kind,'public_devnet_program_deployed_pool_uninitialized');assert.equal(Object.hasOwn(declaration,'noDeploymentOrFundingOrServiceState'),false);
  const prepared=JSON.parse(await readFile(join(out,'private-preparation-config.json'),'utf8'));
  await writeFile(c.finalizedProgramVerification!.path,'changed saved observation');
  await assert.rejects(preparePublicDevnetDeployment(prepared,join(f.dir,'second-output')));
});
test('deployed staging rejects existing Pool, wrong finalized bytes/authority/identity and stale or unpinned cuts',async t=>{
  const f=await fixture(t),{c,evidence,path}=await deployedConfig(f),out=join(f.dir,'deployed-staging');
  for(const patch of [{pool_absent:false},{program_sha256:'00'.repeat(32)},{upgrade_authority:c.expected.programId},{program_id:c.expected.pool},{pool:c.expected.programId},{commitment:'confirmed'},{context_slot:'9'},{program_data:c.expected.programId},{chain_writes:1}]){
    const b=jcsBytes({...evidence,...patch});await writeFile(path,b);
    await assert.rejects(stagePublicDevnetDeployment({...c,finalizedProgramVerification:{path,sha256:await sha256Hex(b)}},out));await assert.rejects(lstat(out),{code:'ENOENT'});
  }
  const b=jcsBytes(evidence);await writeFile(path,b);
  await assert.rejects(stagePublicDevnetDeployment({...c,finalizedProgramVerification:{path,sha256:'00'.repeat(32)}},out));
});
test('staging cannot mix undeployed/deployed provenance or accept a reused budget or service-state input',async t=>{
  const f=await fixture(t),{c}=await deployedConfig(f),out=join(f.dir,'deployed-staging');
  for(const patch of [{noDeploymentOrFundingOrServiceState:true},{noPoolFundingOrServiceState:false},{initialState:'existing_pool'},
    {budgetStatePath:'/private/existing-budget.json'},{serviceStateDirectory:'/private/existing-service'}]){
    await assert.rejects(stagePublicDevnetDeployment({...c,...patch} as any,out));await assert.rejects(lstat(out),{code:'ENOENT'});
  }
});
