/** Source-distributed offline registration CLI. Never opens credential/DSN/state files. */
import {lstat,readFile,mkdir,writeFile,readdir,chmod} from 'node:fs/promises';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseStrictJson,jcsBytes,sha256Hex} from '../packages/sdk/src/trust.ts';
import {loadPublicDeploymentProfile,PUBLIC_PROFILE_SDK_VERSION} from '../packages/sdk/src/public-profile.ts';
import {stagePublicDevnetDeployment,type InitialPublicStagingPreparationV2} from './prepare_public_devnet_deployment.ts';
import {RegistrationError,requireConfig,exact,canonicalPath,validatePin,validateApiProject,compileApiServices,validateStagingConsumer,validateOperator,renderOperatorConfiguration,selectedTariffHashes,REGISTRATION_CONTRACT_VERSION,type ApiProject,type OperatorPreparation,type PinnedFile,type RenderArtifacts} from './api_registration.ts';
const run=promisify(execFile),ZERO={networkActions:0,providerActions:0,transactionActions:0,serviceActions:0};
function safeError(error:unknown,fallback:'invalid_schema'|'artifact_verification_failed'='artifact_verification_failed'):RegistrationError{
 if(error instanceof RegistrationError)return error;
 if((error as any)?.code==='EEXIST')return new RegistrationError('output_exists','output','exclusive new output required');
 if(['ENOENT','EACCES','EIO','ENOTDIR'].includes((error as any)?.code))return new RegistrationError('artifact_verification_failed','input','input file unavailable');
 const message=error instanceof Error?error.message:'';
 if(/authority|initializer|signer/i.test(message))return new RegistrationError('authority_mismatch','authority','public authority binding failed');
 if(/provenance|declaration|staging state|existing Pool/i.test(message))return new RegistrationError('staging_provenance_required','staging','reviewed unused staging provenance required');
 if(/hash|pin|digest/i.test(message))return new RegistrationError('pin_mismatch','inputs','independent artifact binding failed');
 return new RegistrationError(fallback,'configuration','offline validation failed');
}
async function readRegular(path:string,max=512*1024*1024,privateOnly=false){
 canonicalPath(path);const s=await lstat(path);requireConfig(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=max,'artifact_verification_failed','input','bounded regular file required');
 if(privateOnly)requireConfig((s.mode&0o077)===0&&s.uid===process.getuid?.(),'unsafe_path','input','owner-private file required');
 const data=new Uint8Array(await readFile(path));requireConfig(data.length===s.size&&data.length<=max,'artifact_verification_failed','input','input size changed');return data;
}
async function jsonFile(path:string,privateOnly=false){try{return JSON.parse(JSON.stringify(parseStrictJson(await readRegular(path,1024*1024,privateOnly))));}catch(e){throw safeError(e,'invalid_schema');}}
async function pinned(pin:PinnedFile,privateOnly=false){validatePin(pin,'pin');const b=await readRegular(pin.path,1024*1024,privateOnly);requireConfig(await sha256Hex(b)===pin.sha256,'pin_mismatch','input','independent input digest mismatch');return JSON.parse(JSON.stringify(parseStrictJson(b)));}
async function assertSafeAncestors(path:string){canonicalPath(path);for(let p=path;p!==dirname(p);p=dirname(p)){try{const s=await lstat(p);requireConfig(!s.isSymbolicLink()&&(p===path||s.isDirectory()),'unsafe_path','output','symlink or non-directory ancestor forbidden');}catch(e){if((e as any).code!=='ENOENT')throw e;}}}
async function newOutput(path:string){await assertSafeAncestors(path);try{await lstat(path);throw new RegistrationError('output_exists','output','exclusive new output required');}catch(e){if((e as any).code!=='ENOENT')throw e;}}
async function put(root:string,name:string,value:Uint8Array){await writeFile(join(root,name),value,{flag:'wx',mode:0o600});}
async function putJson(root:string,name:string,value:unknown){await put(root,name,jcsBytes(value as any));}
export async function validateRegistration(configPath:string){
 const project=await jsonFile(configPath,true) as ApiProject;validateApiProject(project);
 const staging=await pinned(project.staging,true) as InitialPublicStagingPreparationV2,operator=await pinned(project.operator,true) as OperatorPreparation;
 requireConfig(staging.schema===2,'invalid_schema','staging.schema','schema two required');requireConfig(staging.consumer?.mode==='proxy'&&Array.isArray(staging.consumer?.services)&&staging.consumer.services.length===0,'provider_config_mismatch','staging.consumer','empty proxy registration template required');
 // Validate destination-host references lexically without opening signing material.
 for(const field of ['distributionDecisionPath','noticesDirectory','publicSetupDirectory','deploymentPath','buildManifestPath','idlPath','programPath','wasmPath','manifestAuthorityKeyPath'] as const)canonicalPath(staging[field],'staging.'+field);
 if(staging.finalizedProgramVerification!==undefined)validatePin(staging.finalizedProgramVerification,'staging.finalizedProgramVerification');
 if(staging.additionalNotices!==undefined){
  requireConfig(staging.additionalNotices!==null&&typeof staging.additionalNotices==='object'&&!Array.isArray(staging.additionalNotices),'invalid_schema','staging.additionalNotices','notice map required');
  for(const entry of Object.values(staging.additionalNotices))canonicalPath(entry?.path,'staging.additionalNotices.path');
 }
 // The cap is read only from the independently pinned deployment, never from a duplicated project field.
 const deployment=await pinned({path:staging.deploymentPath,sha256:staging.deploymentSha256});
 const services=await compileApiServices(project.services,deployment.cap_micro_usdc);staging.consumer={...staging.consumer,services};validateStagingConsumer(staging.consumer);validateOperator(operator,staging.consumer);
 requireConfig(String(PUBLIC_PROFILE_SDK_VERSION)!=='0.2.0-devnet.8','invalid_schema','sdkVersion','distinct unpublished schema two build required');
 try{await stagePublicDevnetDeployment(staging,join(dirname(configPath),'.validation-no-output'),{validateOnly:true});}catch(e){throw safeError(e);}
 // Pin and inspect only the public binary bytes; no execution or credential reads during validate.
 const inspection=await readRegular(operator.inspectionBinary.path);requireConfig(await sha256Hex(inspection)===operator.inspectionBinary.sha256,'pin_mismatch','inspectionBinary','inspection binary digest mismatch');
 return{project,staging,operator,inputHashes:{project:await sha256Hex(await readRegular(configPath,1024*1024,true)),staging:project.staging.sha256,operator:project.operator.sha256},summary:{schema:1,complete:false,validated:true,operations:services.map(s=>({service:s.tariff.api.service,operation:s.tariff.api.operation,tariffHash:s.tariff.tariff_hash})),models:staging.consumer.models.length,services:services.length,publicInputs:{publicSetupSha256:staging.publicSetupSha256,buildManifestSha256:staging.buildManifestSha256,wasmSha256:staging.wasmSha256},...ZERO}};
}
function artifactPaths(root:string,descriptor:any):RenderArtifacts{
 const path=(name:string)=>{requireConfig(typeof name==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(name)&&Object.hasOwn(descriptor.files,name),'artifact_verification_failed','bundle','inventoried artifact required');return root+'/public/assets/'+name;};
 return{manifest:path(descriptor.manifest),idl:path(descriptor.artifacts.idl),program:path(descriptor.artifacts.additional.vault_program),buildManifest:path(descriptor.artifacts.additional.devnet_build_manifest),publicProfile:path(descriptor.artifacts.additional.public_devnet_profile),treePk:path(descriptor.artifacts.treePk),buildManifestHash:descriptor.files[descriptor.artifacts.additional.devnet_build_manifest].sha256,publicProfileHash:descriptor.files[descriptor.artifacts.additional.public_devnet_profile].sha256};
}
async function inspect(operator:OperatorPreparation,output:string,manifest:any,selection:any){
 const binary=await readRegular(operator.inspectionBinary.path);requireConfig(await sha256Hex(binary)===operator.inspectionBinary.sha256,'pin_mismatch','inspectionBinary','inspection binary digest mismatch');
 let stdout:string;try{({stdout}=await run(operator.inspectionBinary.path,['inspect-config',join(output,'private/control.json'),'--input-root',output,'--target-root',operator.targetRoot],{env:{PATH:process.env.PATH??'',LANG:'C'},encoding:'utf8',timeout:30000,maxBuffer:1024*1024}));}catch{throw new RegistrationError('artifact_verification_failed','inspection','public configuration inspection failed');}
 let result:any;try{result=parseStrictJson(new TextEncoder().encode(stdout));}catch{throw new RegistrationError('artifact_verification_failed','inspection','invalid inspection response');}
 exact(result,['schema','manifestHash','tariffHashes','operations','signer'],[],'inspection');requireConfig(result.schema===1&&result.manifestHash===manifest.manifest_hash,'artifact_verification_failed','inspection','manifest mismatch');requireConfig(JSON.stringify([...result.tariffHashes].sort())===JSON.stringify(selectedTariffHashes(selection)),'artifact_verification_failed','inspection','tariff mismatch');
 requireConfig(Buffer.from(jcsBytes(result.operations)).equals(Buffer.from(jcsBytes(selection.services.map((s:any)=>s.tariff.api)))),'artifact_verification_failed','inspection','operation descriptor mismatch');
 requireConfig(result.signer&&typeof result.signer==='object'&&!Array.isArray(result.signer),'artifact_verification_failed','inspection.signer','signer config required');return result;
}
async function copyTree(source:string,destination:string){await mkdir(destination,{mode:0o700});for(const name of (await readdir(source)).sort()){const p=join(source,name),s=await lstat(p);requireConfig(!s.isSymbolicLink(),'unsafe_path','output','symlink forbidden');if(s.isDirectory())await copyTree(p,join(destination,name));else await put(destination,name,await readRegular(p));}}
interface InventoryEntry{path:string;bytes:number;sha256:string;classification:'public'|'private'}
async function treeFiles(root:string,sub=''):Promise<string[]>{const result:string[]=[];for(const name of(await readdir(join(root,sub))).sort()){requireConfig(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)&&name!=='.'&&name!=='..','unsafe_path','inventory','safe relative entry required');const p=sub?sub+'/'+name:name,s=await lstat(join(root,p));requireConfig(!s.isSymbolicLink(),'unsafe_path','inventory','symlink forbidden');if(s.isDirectory())result.push(...await treeFiles(root,p));else{requireConfig(s.isFile(),'unsafe_path','inventory','regular files required');result.push(p);}}requireConfig(new Set(result.map(s=>s.toLowerCase())).size===result.length,'unsafe_path','inventory','case collision forbidden');return result;}
async function roundTrip(root:string,normalized:any){
 exact(normalized,['schema','project','staging','operator','inputHashes']);requireConfig(normalized.schema===1,'invalid_schema','provenance','schema one required');validateApiProject(normalized.project);validateStagingConsumer(normalized.staging.consumer);validateOperator(normalized.operator,normalized.staging.consumer);exact(normalized.inputHashes,['project','staging','operator']);for(const digest of Object.values(normalized.inputHashes))requireConfig(typeof digest==='string'&&/^[0-9a-f]{64}$/.test(digest),'pin_mismatch','provenance','input hash required');
 const profile=await jsonFile(join(root,'public/profile.json')),bytes=await readRegular(join(root,'public/profile.json'),1024*1024),descriptor=await jsonFile(join(root,'public/assets/bundle.json'));
 const url=normalized.staging.profileUrl,base=normalized.staging.assetsBaseUrl,map=new Map<string,string>([[url,'public/profile.json'],[base+'bundle.json','public/assets/bundle.json']]);for(const name of Object.keys(descriptor.files))map.set(base+name,'public/assets/'+name);
 const fetcher:typeof fetch=async(input,init)=>{requireConfig((init?.method??'GET')==='GET'&&init?.credentials==='omit'&&init?.redirect==='error','artifact_verification_failed','roundTrip','read-only fixture fetch required');const path=map.get(String(input));requireConfig(path,'artifact_verification_failed','roundTrip','unexpected URL');return new Response(await readRegular(join(root,path)));};
 const loaded=await loadPublicDeploymentProfile(url,{profileSha256:await sha256Hex(bytes),fetch:fetcher});
 const c=normalized.staging.consumer,compiled=await compileApiServices(normalized.project.services,loaded.assets.verifiedManifest.cap_micro_usdc);requireConfig(Buffer.from(jcsBytes(compiled as any)).equals(Buffer.from(jcsBytes(c.services))),'artifact_verification_failed','services','declaration price and tariff mismatch');
 requireConfig(Buffer.from(jcsBytes(Object.fromEntries(Object.keys(c).map(k=>[k,profile[k]])))).equals(Buffer.from(jcsBytes(c))),'artifact_verification_failed','profile','consumer selection mismatch');
 requireConfig(profile.schema===2&&profile.mode==='proxy'&&Buffer.from(jcsBytes(profile.services)).equals(Buffer.from(jcsBytes(c.services)))&&Buffer.from(jcsBytes(profile.models)).equals(Buffer.from(jcsBytes(c.models))),'artifact_verification_failed','profile','selection binding mismatch');
 requireConfig(profile.indexerOrigin===normalized.operator.indexer.publicOrigin,'artifact_verification_failed','profile','indexer binding mismatch');
 const artifacts=artifactPaths(normalized.operator.targetRoot,descriptor),rendered=renderOperatorConfiguration({operator:normalized.operator,manifest:loaded.assets.verifiedManifest,selection:c,declarations:normalized.project.services,artifacts,rpcUrl:profile.rpcUrl,network:'devnet'});
 const files={'control.json':rendered.control,'dispatcher.json':rendered.dispatcher,'indexer.json':rendered.indexer,'challenger.json':rendered.challenger,'signer-inputs.json':rendered.signerInputs,'startup.json':rendered.startup,'frontend-routes.json':rendered.routes};
 for(const[name,value]of Object.entries(files))requireConfig(Buffer.from(await readRegular(join(root,'private',name))).equals(Buffer.from(jcsBytes(value as any))),'artifact_verification_failed','private','generated configuration mismatch');
 const inspection=await inspect(normalized.operator,root,loaded.assets.verifiedManifest,c);requireConfig(Buffer.from(await readRegular(join(root,'private/signer.json'))).equals(Buffer.from(jcsBytes(inspection.signer))),'artifact_verification_failed','signer','inspected signer mismatch');
 return{profileSha256:await sha256Hex(bytes),bundleSha256:profile.bundle.sha256,manifestHash:loaded.assets.verifiedManifest.manifest_hash};
}
export async function prepareRegistration(configPath:string,output:string){
 await newOutput(output);const checked=await validateRegistration(configPath);await newOutput(output);
 await mkdir(output,{mode:0o700});await mkdir(join(output,'provenance'),{mode:0o700});
 // Any failure preserves this private incomplete tree. Signing can only begin after exclusive output creation.
 try{
  const staging=join(output,'provenance/staging');await stagePublicDevnetDeployment(checked.staging,staging);
  for(const name of await treeFiles(staging))await chmod(join(staging,name),0o600);
  await mkdir(join(output,'public'),{mode:0o700});await copyTree(join(staging,'prepared/assets'),join(output,'public/assets'));await mkdir(join(output,'private'),{mode:0o700});
  const profile=await jsonFile(join(staging,'prepared/consumer-profile.json'));profile.indexerOrigin=checked.operator.indexer.publicOrigin;await putJson(output,'public/profile.json',profile);
  const descriptor=await jsonFile(join(output,'public/assets/bundle.json')),manifest=await jsonFile(join(output,'public/assets',descriptor.manifest)),artifacts=artifactPaths(checked.operator.targetRoot,descriptor);
  const normalized={schema:1,project:checked.project,staging:checked.staging,operator:checked.operator,inputHashes:checked.inputHashes};await putJson(output,'provenance/normalized-inputs.json',normalized);
  const rendered=renderOperatorConfiguration({operator:checked.operator,manifest,selection:checked.staging.consumer,declarations:checked.project.services,artifacts,rpcUrl:profile.rpcUrl,network:'devnet'});
  for(const[name,value]of Object.entries({'control.json':rendered.control,'dispatcher.json':rendered.dispatcher,'indexer.json':rendered.indexer,'challenger.json':rendered.challenger,'signer-inputs.json':rendered.signerInputs,'startup.json':rendered.startup,'frontend-routes.json':rendered.routes}))await putJson(output,'private/'+name,value);
  const inspected=await inspect(checked.operator,output,manifest,checked.staging.consumer);await putJson(output,'private/signer.json',inspected.signer);
  const hashes=await roundTrip(output,normalized),report={...checked.summary,...hashes,complete:true,chainCompatible:false,registrationContractVersion:REGISTRATION_CONTRACT_VERSION};await putJson(output,'preparation-report.json',report);
  const entries:InventoryEntry[]=[];for(const name of await treeFiles(output)){const data=await readRegular(join(output,name));entries.push({path:name,bytes:data.length,sha256:await sha256Hex(data),classification:name.startsWith('public/')?'public':'private'});}
  const inventory=jcsBytes({schema:1,registrationContractVersion:REGISTRATION_CONTRACT_VERSION,inputHashes:checked.inputHashes,files:entries});await put(output,'inventory.json',inventory);const inventorySha256=await sha256Hex(inventory);await putJson(output,'complete.json',{schema:1,inventorySha256});return{...report,inventorySha256};
 }catch(e){throw safeError(e);}
}
export async function verifyRegistration(directory:string,inventorySha256:string){
 await assertSafeAncestors(directory);requireConfig(/^[0-9a-f]{64}$/.test(inventorySha256),'pin_mismatch','inventorySha256','independently reviewed digest required');
 let completion:any,inventory:any;try{completion=await jsonFile(join(directory,'complete.json'));inventory=await jsonFile(join(directory,'inventory.json'));}catch{throw new RegistrationError('incomplete_output','complete','complete inventory required');}
 exact(completion,['schema','inventorySha256']);requireConfig(completion.schema===1&&completion.inventorySha256===inventorySha256,'pin_mismatch','complete','inventory digest mismatch');requireConfig(await sha256Hex(await readRegular(join(directory,'inventory.json'),1024*1024))===inventorySha256,'pin_mismatch','inventory','independent inventory digest mismatch');
 exact(inventory,['schema','registrationContractVersion','inputHashes','files']);requireConfig(inventory.schema===1&&inventory.registrationContractVersion===REGISTRATION_CONTRACT_VERSION&&Array.isArray(inventory.files)&&inventory.files.length>0&&inventory.files.length<=1024,'invalid_schema','inventory','supported bounded inventory required');
 const actualFiles=await treeFiles(directory);
 const listed:string[]=[];for(const e of inventory.files){exact(e,['path','bytes','sha256','classification']);requireConfig(typeof e.path==='string'&&e.path.split('/').every((p:string)=>/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p)&&p!=='.'&&p!=='..')&&!['inventory.json','complete.json'].includes(e.path),'unsafe_path','inventory.path','safe inventoried relative path required');requireConfig(e.classification===(e.path.startsWith('public/')?'public':'private'),'artifact_verification_failed','inventory.classification','publication boundary mismatch');const b=await readRegular(join(directory,e.path));requireConfig(e.bytes===b.length&&e.sha256===await sha256Hex(b),'artifact_verification_failed','inventory.file','file size or digest mismatch');listed.push(e.path);}
 requireConfig(new Set(listed.map(p=>p.toLowerCase())).size===listed.length,'unsafe_path','inventory','duplicate or case-colliding path');requireConfig(JSON.stringify([...listed,'inventory.json','complete.json'].sort())===JSON.stringify(actualFiles.sort()),'artifact_verification_failed','inventory','exact file set required');
 const normalized=await jsonFile(join(directory,'provenance/normalized-inputs.json')),hashes=await roundTrip(directory,normalized);requireConfig(Buffer.from(jcsBytes(normalized.inputHashes)).equals(Buffer.from(jcsBytes(inventory.inputHashes))),'pin_mismatch','inventory.inputHashes','input provenance mismatch');return{schema:1,complete:true,verified:true,inventorySha256,...hashes,...ZERO};
}
export async function initRegistration(output:string){await newOutput(output);const template={schema:1,target:'devnet-new',staging:{path:'/REPLACE/private/staging.json',sha256:'REPLACE_WITH_INDEPENDENT_SHA256'},operator:{path:'/REPLACE/private/operator.json',sha256:'REPLACE_WITH_INDEPENDENT_SHA256'},services:[{api:{version:'1',service:'weather',operation:'lookup',method:'POST',origin:'https://weather.example',path:'/v1/current',request_max_bytes:'4096',response_max_bytes:'65536',timeout_seconds:'30',billing:'http_2xx_json'},priceMicroUsdc:'REPLACE_WITH_INTEGER_MICRO_USDC',validFrom:'REPLACE_WITH_UNIX_SECONDS',validUntil:'REPLACE_WITH_UNIX_SECONDS',credentialFile:'/REPLACE/private/weather-api-key'}]};await put(dirname(output),output.slice(dirname(output).length+1),jcsBytes(template));return{schema:1,complete:false,templateCreated:true,...ZERO};}
export async function registrationMain(args:readonly string[]){const [command,...rest]=args;const expected=command==='init'?['--output']:command==='validate'?['--config']:command==='prepare'?['--config','--output']:command==='verify'?['--directory','--inventory-sha256']:[];requireConfig(expected.length>0&&rest.length===expected.length*2,'invalid_schema','arguments','supported command and exact flags required');const flags:Record<string,string>={};for(let i=0;i<rest.length;i+=2){requireConfig(expected.includes(rest[i])&&!Object.hasOwn(flags,rest[i])&&typeof rest[i+1]==='string'&&!rest[i+1].startsWith('--'),'invalid_schema','arguments','exact command flags required');flags[rest[i]]=rest[i+1];}if(command==='init')return initRegistration(flags['--output']);if(command==='validate')return(await validateRegistration(flags['--config'])).summary;if(command==='prepare')return prepareRegistration(flags['--config'],flags['--output']);return verifyRegistration(flags['--directory'],flags['--inventory-sha256']);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{console.log(JSON.stringify(await registrationMain(process.argv.slice(2))));}catch(e){const error=safeError(e);console.error(JSON.stringify({schema:1,error:{code:error.code,field:error.field,reason:error.reason},...ZERO}));process.exitCode=['artifact_verification_failed','incomplete_output'].includes(error.code)?1:2;}}
