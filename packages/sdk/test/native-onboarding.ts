/** Installed-native local onboarding acceptance. All keys, custody and upstream
 * responses belong to this fresh test run; it never accepts a real provider. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDeploymentAssets } from '../src/deployment.ts';
import { validateClientConfiguration, validateClientSelectionPins } from '../src/client.ts';
import { apiOperationPath, validateNoteJournal, type ApiTariff, type NoteJournal } from '../src/control.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { unlockJournalKey } from '../src/secret-custody.ts';
import { jcsBytes, sha256Hex, type ArtifactBundle, type ManifestTrustPolicy, type Manifest } from '../src/trust.ts';
import type { WalletRoles } from '../src/wallet.ts';

type Options = {
  runDir: string; installation: string; manifest: Manifest; trust: ManifestTrustPolicy; artifacts: ArtifactBundle;
  tariff: ApiTariff; rpcOrigin: string; roles: WalletRoles; walletSeed: Uint8Array; destinationOwner: string;
  call(value: object): Promise<any>; calls: Record<string,number>;
  invalidJsonBarrier?: { observed: Promise<void>; release(): void };
  fault?: 'lost_response' | 'upstream_timeout';
  lostResponseBarrier?: { observed: Promise<void>; release(): void };
};
const jsonFile = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
function loopback(value: string): void {
  const u = new URL(value); assert.equal(u.protocol,'http:'); assert.ok(['127.0.0.1','[::1]'].includes(u.hostname));
  assert.equal(u.username,''); assert.equal(u.password,''); assert.equal(u.search,''); assert.equal(u.hash,'');
}
async function command(binary: string, args: string[], input = '') {
  const child = spawn(binary,args,{stdio:['pipe','pipe','pipe'],env:{PATH:join(resolve(binary),'..')}});
  let stdout='',stderr='';
  child.stdout.on('data',bytes=>{stdout+=bytes;assert.ok(stdout.length<=1024*1024);});
  child.stderr.on('data',bytes=>{stderr+=bytes;assert.ok(stderr.length<=64*1024);});
  child.stdin.end(input);
  const timer=setTimeout(()=>child.kill('SIGKILL'),950_000);
  try { const [code]=await once(child,'exit');return {code,stdout,stderr}; } finally {clearTimeout(timer);}
}
export async function runNativeOnboarding(o: Options) {
  assert.equal(o.manifest.deployment_environment,'local');
  for(const origin of [o.rpcOrigin,o.manifest.control_api_origin,o.manifest.inference_api_origin,o.tariff.api.origin])loopback(origin);
  assert.ok(resolve(o.runDir).startsWith(resolve('target/general-api-local')+'/'));
  if(!o.fault)assert.ok(o.invalidJsonBarrier,'native interruption requires a fixture barrier');
  if(o.fault==='lost_response')assert.ok(o.lostResponseBarrier,'native lost downstream response requires a persisted-usage barrier');
  if(o.fault==='upstream_timeout')assert.equal(o.tariff.api.timeout_seconds,'1');
  const charge=o.fault==='upstream_timeout'?0:250, withdrawal=5000000-charge;
  validateClientConfiguration('proxy',[],[{tariff:o.tariff}]);await validateClientSelectionPins({models:[],services:[{tariff:o.tariff}]},o.manifest);
  const work=join(o.runDir,'native-onboarding-'+(o.fault??'main'));await mkdir(work,{mode:0o700});
  const bundleDir=join(work,'bundle');await mkdir(bundleDir,{mode:0o700});
  const files:Record<string,{sha256:string;bytes:number}>={}, content=new Map<string,Uint8Array>();
  const add=async(name:string,bytes:Uint8Array)=>{files[name]={sha256:await sha256Hex(bytes),bytes:bytes.length};content.set('/'+name,bytes);await writeFile(join(bundleDir,name),bytes,{mode:0o600,flag:'wx'});return name;};
  const manifestName=await add('manifest.json',jcsBytes(o.manifest)), artifactPaths:any={additional:{}};
  for(const [name,bytes]of Object.entries(o.artifacts))if(name!=='additional')artifactPaths[name]=await add(name+'.bin',bytes as Uint8Array);
  let index=0;for(const [name,bytes]of Object.entries(o.artifacts.additional))artifactPaths.additional[name]=await add(`additional-${index++}.bin`,bytes);
  const wasm=await readFile(process.env.ZKAPI_TEST_WASM??process.env.ZKAPI_TEST_WASM_PROVER!);
  const wasmPath=await add('prover.wasm',wasm), wasmHash=await sha256Hex(wasm);
  const notice=await readFile(join(o.installation,'THIRD_PARTY_NOTICES.md'));await add('NOTICE.txt',notice);
  const descriptor=jcsBytes({schema:2,trust:o.trust,manifest:manifestName,artifacts:artifactPaths,wasm:{path:wasmPath,sha256:wasmHash},files,notices:{'NOTICE.txt':'NOTICE.txt'}});
  await writeFile(join(bundleDir,'bundle.json'),descriptor,{mode:0o600,flag:'wx'});content.set('/bundle.json',descriptor);
  const assetsServer=createServer((req,res)=>{assert.equal(req.method,'GET');const bytes=content.get(req.url!);if(!bytes){res.writeHead(404);res.end();return;}res.end(bytes);});
  await new Promise<void>(resolve=>assetsServer.listen(0,'127.0.0.1',resolve));
  const bundleUrl=`http://127.0.0.1:${(assetsServer.address() as any).port}/bundle.json`, bundleHash=await sha256Hex(descriptor);
  let child:ChildProcess|undefined, daemonDiagnostic='';
  const stop=async(signal:NodeJS.Signals='SIGTERM')=>{if(child?.exitCode===null&&child.signalCode===null){const done=once(child,'exit');if(signal==='SIGKILL')process.kill(-child.pid!,signal);else child.kill(signal);await done;}};
  try {
    const assets=await loadDeploymentAssets(bundleUrl,{bundleSha256:bundleHash});
    assert.equal(assets.verifiedManifest.manifest_hash,o.manifest.manifest_hash);
    const localInputs={schema:1,kind:'local_fixture',bundle:{url:bundleUrl,sha256:bundleHash},manifestHash:o.manifest.manifest_hash,
      rpcUrl:o.rpcOrigin+'/rpc',indexerOrigin:o.rpcOrigin,mode:'proxy',models:[],services:[{tariff:o.tariff}]};
    await jsonFile(join(work,'local-inputs.json'),localInputs);
    const routes=[{origin:o.manifest.control_api_origin,prefix:'/zkapi/v1'},{origin:o.rpcOrigin,prefix:'/rpc'},
      {origin:o.rpcOrigin,prefix:'/zkapi/v1/tree'},{origin:o.manifest.inference_api_origin,prefix:apiOperationPath(o.tariff.api)}];
    const {materializeNativeInputs}=await import(pathToFileURL(join(o.installation,'tools/public-devnet-consumer/native-inputs.mjs')).href);
    const receipt=await materializeNativeInputs({assets,selection:{deployment:{manifest:assets.manifest,trust:assets.trust,artifacts:assets.artifacts},mode:'proxy',models:[],services:[{tariff:o.tariff}]},
      rpcUrl:localInputs.rpcUrl,indexerOrigin:o.rpcOrigin,network:{mode:'direct',allow_local_http:true,routes},receipt:{kind:'local_fixture',bundleSha256:bundleHash}},join(work,'inputs'));
    const release=join(o.installation,'release.json'),releaseHash=await sha256Hex(await readFile(release)),node=join(o.installation,'bin/node'),clientd=join(o.installation,'bin/clientd');
    const initialCalls=JSON.stringify(o.calls);
    const validation=await command(node,[join(o.installation,'apps/clientd/runtime.ts'),'--validate-config','--distribution',release,'--distribution-sha256',releaseHash,'--runtime-config',receipt.runtime,'--runtime-sha256',receipt.runtimeSha256]);
    assert.equal(validation.code,0,validation.stderr);assert.equal(validation.stderr,'');
    const validated=JSON.parse(validation.stdout);assert.deepEqual(validated.models,[]);assert.equal(validated.operations.length,1);assert.equal(validated.networkActions,0);assert.equal(validated.custodyInitialized,false);
    assert.equal(JSON.stringify(o.calls),initialCalls);
    const profile=join(work,'profile'),free=createServer();await new Promise<void>(resolve=>free.listen(0,'127.0.0.1',resolve));
    const listen=`127.0.0.1:${(free.address() as any).port}`;await new Promise<void>(resolve=>free.close(()=>resolve()));
    const setup=await command(clientd,['setup','--profile',profile,'--distribution',release,'--sha256',releaseHash,'--runtime-config',receipt.runtime,'--runtime-sha256',receipt.runtimeSha256,'--network-config',receipt.network,'--listen',listen]);
    assert.equal(setup.code,0,setup.stderr);assert.equal(JSON.parse(setup.stdout).api_base_url,'http://'+listen+'/zkapi/v1');
    await assert.rejects(stat(join(profile,'custody.json')));await assert.rejects(stat(join(profile,'openclaw-agent')));
    const config=JSON.parse(await readFile(join(profile,'runtime.json'),'utf8'));
    const passphrase='fresh synthetic native onboarding passphrase';
    const seed=Buffer.from(o.walletSeed.slice(0,32)).toString('base64');
    const start=async(initialize:boolean)=>{
      child=spawn(clientd,['run',profile],{stdio:['pipe','pipe','pipe'],detached:true,env:{PATH:join(o.installation,'bin')}});
      child.stderr!.on('data',bytes=>{daemonDiagnostic+=bytes;assert.ok(daemonDiagnostic.length<64*1024);});
      child.stdin!.end(JSON.stringify({passphrase,wallet_seed_base64:seed,initialize_key:initialize})+'\n');
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('native startup timeout')),300_000);
        child!.stdout!.once('data',()=>{clearTimeout(timer);resolve();});child!.once('exit',code=>{clearTimeout(timer);reject(Error('native startup failed '+code+': '+daemonDiagnostic));});});
    };
    const request=async(action:string,body?:unknown,allowError=false)=>{
      const result=await command(clientd,['request',profile,action],body===undefined?'':JSON.stringify(body));
      if(!allowError)assert.equal(result.code,0,result.stderr);return {...result,value:result.stdout?JSON.parse(result.stdout):undefined};
    };
    const drive=async()=>{for(let i=0;i<100;i++){const result=(await request('wallet',{action:'advance'})).value;if(result.state==='complete')return;
      if(result.state==='proof_required')await request('wallet',{action:'prove'});assert.notEqual(result.state,'rejected');}throw Error('native wallet did not complete');};
    const settle=async()=>{
      await request('close');
      for(let i=0;i<180;i++){const state=(await request('recover')).value;if(state.phase==='ready'&&!state.recovery_required)return;await new Promise(resolve=>setTimeout(resolve,50));}
      throw Error('native signed settlement did not complete');
    };
    await start(true);
    const apis=(await request('apis')).value;assert.deepEqual(apis.apis,[o.tariff.api]);
    assert.equal((await request('status')).value.phase,'unfunded');
    const management=(await readFile(join(profile,'management-token'),'utf8')).trim(),apiToken=(await readFile(join(profile,'inference-token'),'utf8')).trim();
    for(const [path,token]of [['/zkapi/v1/apis',management],['/admin/status',apiToken]]){
      const response=await fetch('http://'+listen+path,{headers:{Authorization:'Bearer '+token},redirect:'error'});assert.equal(response.status,401);await response.arrayBuffer();
    }
    const availability=await request('model-availability',undefined,true);assert.notEqual(availability.code,0);assert.equal(availability.value.error.code,'unsupported_for_profile');
    assert.equal(JSON.stringify(o.calls),initialCalls);
    await request('wallet',{action:'deposit',amount:'5000000',roles:o.roles});await drive();
    assert.equal((await request('status')).value.balance_micro_usdc,'5000000');
    const api=(variant:string,id:string,body?:string)=>command(clientd,['api',profile,'--service',o.tariff.api.service,'--operation',o.tariff.api.operation,'--operation-id',id],body??JSON.stringify({query:'GENERAL_API_PRIVATE_QUERY',variant}));
    const invalid=await api('success','00112233-4455-4677-8899-aabbccddeeff','{');assert.notEqual(invalid.code,0);assert.equal(JSON.stringify(o.calls),initialCalls);
    const accepted:{id:string;variant:string}[]=[];
    const variants=o.fault==='lost_response'?['success']:o.fault==='upstream_timeout'?['upstream_timeout']:['success','http_error','invalid_json'];
    for(const variant of variants){
      const id=crypto.randomUUID();accepted.push({id,variant});
      if(variant==='invalid_json'||o.fault==='lost_response'){
        const barrier=o.fault==='lost_response'?o.lostResponseBarrier!:o.invalidJsonBarrier!;
        const pending=api(variant,id);await barrier.observed;
        await stop('SIGKILL');barrier.release();const result=await pending;assert.notEqual(result.code,0);
        await start(false);await settle();
        const duplicate=await api(variant,id);assert.notEqual(duplicate.code,0);assert.equal(o.calls[variant],1);
      }else{
        const result=await api(variant,id);
        if(variant==='success'){assert.equal(result.code,0,result.stderr+result.stdout);assert.equal(JSON.parse(result.stdout).items[0].id,'catalog-42');}else assert.notEqual(result.code,0);
        const duplicate=await api(variant,id);assert.notEqual(duplicate.code,0);assert.equal(o.calls[variant],1);await settle();
      }
    }
    assert.deepEqual(o.calls,Object.fromEntries(variants.map(variant=>[variant,1])));
    assert.equal((await request('status')).value.balance_micro_usdc,String(withdrawal));
    await request('wallet',{action:'withdraw',mode:'mutual_close',destination_owner:o.destinationOwner,roles:o.roles});await drive();await stop();
    const raw=await unlockJournalKey(config.custody,new TextEncoder().encode(passphrase)),key=await importJournalKey(raw);raw.fill(0);
    const journal=new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(config.journal),key,{deploymentId:o.manifest.deployment_id,pool:o.manifest.pool},validateNoteJournal);
    const final=(await journal.read(config.note_id))!.value;assert.equal(final.wallet!.status,'closed');assert.equal(final.pending,null);assert.equal(final.history.length,variants.length);
    const cases=accepted.map(({id,variant})=>{const history=final.history.find(h=>h.operations.some(operation=>operation.id===id))!;assert.ok(history);
      assert.equal(history.settlement.charge_micro_usdc,variant==='success'?'250':'0');assert.equal(history.receipts.length,1);
      const receipt=history.receipts.find(receipt=>receipt.body.operation_id===id)!;assert.ok(receipt);assert.equal(receipt.body.charged_nano_usdc,variant==='success'?'250000':'0');
      return {variant,operation_id:id,request_id:history.prepared.request.authorization.request_id,charged_nano_usdc:receipt.body.charged_nano_usdc,operation_state:['invalid_json','upstream_timeout'].includes(variant)?'WAIVED_OPERATOR_LOSS':'DONE',receipt_verified:true};});
    const report=await o.call({kind:'report',name:'general-api',report_path:join(work,'vault-sbf-results.json')});
    assert.equal(report.vault_micro_usdc,0);assert.equal(report.destination_micro_usdc,withdrawal);assert.equal(report.treasury_micro_usdc,charge);
    assert.equal(report.source_micro_usdc+report.destination_micro_usdc+report.vault_micro_usdc+report.treasury_micro_usdc,100000000);assert.ok(report.rows.every((row:any)=>row.error===null));
    const journalBytes=Buffer.concat(await Promise.all((await readdir(config.journal)).map(name=>readFile(join(config.journal,name)).catch(()=>Buffer.alloc(0))))).toString();
    for(const secret of ['GENERAL_API_PRIVATE_QUERY','GENERAL_API_PRIVATE_RESULT',final.witness!.secret])assert.equal(journalBytes.includes(secret),false);
    for(const secret of [passphrase,seed,management,apiToken])assert.equal(daemonDiagnostic.includes(secret),false);
    return {passed:true,scope:'installed native commands with real proofs/signatures/Vault SBF and synthetic provider/RPC finality',cases,provider_calls:o.calls,
      encrypted_journal:true,request_proof_verified:true,receipts_verified:true,signed_successor_verified:true,request_body_has_no_model:true,
      duplicates_not_replayed:true,invalid_requests_no_egress:true,restarted_journal_recovery:o.fault!=='upstream_timeout',automatic_api_replays:0,
      ...(o.fault==='lost_response'?{lost_downstream_response_recovered:true}:o.fault==='upstream_timeout'?{upstream_timeout_waived:true}:{}),
      deposit_micro_usdc:'5000000',total_charge_micro_usdc:String(charge),generic_charge_micro_usdc:String(charge),legacy_charge_micro_usdc:'0',withdrawal_micro_usdc:String(withdrawal),
      balance_conservation:true,chain:report,offline_configuration_validated:true,custody_preserved_on_restart:o.fault!=='upstream_timeout',native_commands_executed:true,
      live_provider_verified:false,public_rpc_verified:false,release_gates_passed:[]};
  } finally {
    o.invalidJsonBarrier?.release();o.lostResponseBarrier?.release();await stop();
    await new Promise<void>(resolve=>{assetsServer.close(()=>resolve());assetsServer.closeAllConnections();});
  }
}
