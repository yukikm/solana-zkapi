/** Installed-native local onboarding acceptance. All keys, custody and upstream
 * responses belong to this fresh test run; it never accepts a real provider. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
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
import {NATIVE_AGENT_GROUPS,runNativeAgentCase,type NativeAgentOptions} from './native-agent-driver.ts';
import type { WalletRoles } from '../src/wallet.ts';

type Options = {
  nativeAgent?:NativeAgentOptions;
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
  assert.ok(['target/general-api-local','target/gateway-native-local'].some(base=>resolve(o.runDir).startsWith(resolve(base)+'/')));
  const gateway=o.tariff.api.version==='2';
  const gatewayConfiguration=gateway?{capabilities:['finite_http_v1'] as ['finite_http_v1'],mounts:[{prefix:'',service:o.tariff.api.service,operation:o.tariff.api.operation,binding_hash:await sha256Hex(jcsBytes(o.tariff.api))}]}:undefined;
  if(!o.fault&&!o.nativeAgent)assert.ok(o.invalidJsonBarrier,'native interruption requires a fixture barrier');
  if(o.fault==='lost_response')assert.ok(o.lostResponseBarrier,'native lost downstream response requires a persisted-usage barrier');
  if(o.fault==='upstream_timeout')assert.equal(o.tariff.api.version==='2'?o.tariff.api.limits.execution_seconds:o.tariff.api.timeout_seconds,'1');
  const charge=o.fault==='upstream_timeout'?0:250, withdrawal=5000000-charge;
  validateClientConfiguration('proxy',[],[{tariff:o.tariff}]);await validateClientSelectionPins({models:[],services:[{tariff:o.tariff}]},o.manifest,undefined,o.trust.build.gatewayAdapters);
  const work=join(o.runDir,'native-onboarding-'+(o.nativeAgent?o.nativeAgent.kind+'-'+o.nativeAgent.group:o.fault??'main'));await mkdir(work,{mode:0o700});
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
      rpcUrl:o.rpcOrigin+'/rpc',indexerOrigin:o.rpcOrigin,mode:'proxy',models:[],services:[{tariff:o.tariff}],...(gatewayConfiguration?{gateway:gatewayConfiguration}:{})};
    await jsonFile(join(work,'local-inputs.json'),localInputs);
    const routes=[{origin:o.manifest.control_api_origin,prefix:'/zkapi/v1'},{origin:o.rpcOrigin,prefix:'/rpc'},
      {origin:o.rpcOrigin,prefix:'/zkapi/v1/tree'},{origin:o.manifest.inference_api_origin,prefix:apiOperationPath(o.tariff.api)}];
    const {materializeNativeInputs}=await import(pathToFileURL(join(o.installation,'tools/public-devnet-consumer/native-inputs.mjs')).href);
    const receipt=await materializeNativeInputs({assets,selection:{deployment:{manifest:assets.manifest,trust:assets.trust,artifacts:assets.artifacts},mode:'proxy',models:[],services:[{tariff:o.tariff}],...(gatewayConfiguration?{gateway:gatewayConfiguration}:{})},
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
      for(let i=0;i<(o.nativeAgent?1800:180);i++){const state=(await request('recover')).value;if(state.phase==='ready'&&!state.recovery_required)return;await new Promise(resolve=>setTimeout(resolve,50));}
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
    if(o.nativeAgent){
      assert.equal(gateway,true);assert.equal(o.fault,undefined);assert.ok(o.nativeAgent.group&&[1,2,3].includes(o.nativeAgent.group));
      const group=o.nativeAgent.group!,names=NATIVE_AGENT_GROUPS[group],expectedOperations=group===1?8:3;
      const initialCatalog=await(await fetch(o.manifest.control_api_origin+'/zkapi/v1/catalog')).json();assert.equal(initialCatalog.apis?.length,1);
      const rawKey=await unlockJournalKey(config.custody,new TextEncoder().encode(passphrase)),journalKey=await importJournalKey(rawKey);rawKey.fill(0);
      const journal=new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(config.journal),journalKey,{deploymentId:o.manifest.deployment_id,pool:o.manifest.pool},validateNoteJournal);
      const matrix:any[]=[],cases:any[]=[];let expectedCharge=0,settledSessions=0;
      const invalid=await fetch('http://'+listen+'/unregistered-operation',{method:'POST',headers:{Authorization:'Bearer '+apiToken,'Content-Type':'application/json'},body:'{}'});assert.ok(invalid.status>=400);await invalid.arrayBuffer();assert.equal(JSON.stringify(o.calls),initialCalls);
      for(const name of names){
        const outcome=await runNativeAgentCase({...o.nativeAgent,name,directory:join(work,'native-agent'),endpoint:'http://'+listen,token:apiToken});
        if(!outcome.expected_charge_micro_usdc){const before=JSON.stringify(o.calls);await request('close');await outcome.assertRecoveryHold();await stop('SIGKILL');await start(false);await outcome.assertRecoveryHold();assert.equal(JSON.stringify(o.calls),before,'new-ID retry after settlement/restart must not dispatch');}
        await settle();
        const value=(await journal.read(config.note_id))!.value;assert.equal(value.pending,null);assert.equal(value.history.length,settledSessions+outcome.expected_operations);
        const histories=value.history.slice(settledSessions);settledSessions=value.history.length;assert.equal(histories.reduce((n,h)=>n+h.operations.length,0),outcome.expected_operations);assert.equal(histories.reduce((n,h)=>n+h.receipts.length,0),outcome.expected_operations);assert.equal(histories.reduce((n,h)=>n+Number(h.settlement.charge_micro_usdc),0),outcome.expected_charge_micro_usdc);
        for(const history of histories)for(const operation of history.operations){assert.equal(operation.invocationVersion,'2');assert.match(operation.operationHmac!,/^[0-9a-f]{64}$/);assert.equal(operation.bodyBase64,'');assert.equal(operation.bodySha256,undefined);const receipt=history.receipts.find(receipt=>receipt.body.operation_id===operation.id)!;assert.ok(receipt);assert.equal(receipt.body.charged_nano_usdc,outcome.expected_charge_micro_usdc?'2000':'0');const body=receipt.body as any;assert.equal(body.reason,outcome.expected_charge_micro_usdc?'metered':'waived_unknown');assert.equal(body.evidence_kind,outcome.expected_charge_micro_usdc?'PROXY_USAGE':'UNKNOWN_OPERATOR_LOSS');if(!outcome.expected_charge_micro_usdc){assert.equal(body.observed_nano_usdc,null);assert.equal(body.operator_loss_nano_usdc,null);assert.deepEqual(body.usage,[]);}cases.push({variant:name,operation_id:operation.id,request_id:history.prepared.request.authorization.request_id,charged_nano_usdc:body.charged_nano_usdc,operation_state:outcome.expected_charge_micro_usdc?'DONE':'WAIVED_OPERATOR_LOSS',receipt_verified:true});}
        const callsBefore=JSON.stringify(o.calls);await outcome.assertDuplicateRejected(histories.flatMap(h=>h.operations.map(operation=>operation.id)));assert.equal(JSON.stringify(o.calls),callsBefore,'settled duplicate must not reach provider');
        const {assertDuplicateRejected:_,assertRecoveryHold:__,...evidence}=outcome;matrix.push(evidence);expectedCharge+=outcome.expected_charge_micro_usdc;
      }
      assert.equal(expectedCharge,group===1?10:0);assert.deepEqual(o.calls,Object.fromEntries(names.map(name=>[name,name==='tool'||name==='subsequent_turn'?2:1])));
      const finalCatalog=await(await fetch(o.manifest.control_api_origin+'/zkapi/v1/catalog')).json();assert.deepEqual(finalCatalog.apis??[],[],'three unknown operations must suspend provider admission');
      const expectedWithdrawal=5000000-expectedCharge;assert.equal((await request('status')).value.balance_micro_usdc,String(expectedWithdrawal));
      await request('wallet',{action:'withdraw',mode:'mutual_close',destination_owner:o.destinationOwner,roles:o.roles});await drive();await stop();
      const final=(await journal.read(config.note_id))!.value;assert.equal(final.schema,3);assert.equal(final.wallet!.status,'closed');assert.equal(final.pending,null);assert.equal(final.history.length,expectedOperations);
      const report=await o.call({kind:'report',name:'general-api',report_path:join(work,'vault-sbf-results.json')});assert.equal(report.vault_micro_usdc,0);assert.equal(report.destination_micro_usdc,expectedWithdrawal);assert.equal(report.treasury_micro_usdc,expectedCharge);assert.equal(report.source_micro_usdc+report.destination_micro_usdc+report.vault_micro_usdc+report.treasury_micro_usdc,100000000);assert.ok(report.rows.every((row:any)=>row.error===null));
      const journalBytes=Buffer.concat(await Promise.all((await readdir(config.journal)).map(name=>readFile(join(config.journal,name)).catch(()=>Buffer.alloc(0))))).toString();for(const secret of ['CODEX_TEXT_FIXTURE_OK','CODEX_TOOL_FIXTURE_OK','CLAUDE_CODE_FIXTURE_OK','CLAUDE_CODE_TOOL_FIXTURE_OK',final.witness!.secret])assert.equal(journalBytes.includes(secret),false);for(const secret of [passphrase,seed,management,apiToken])assert.equal(daemonDiagnostic.includes(secret),false);
      return {passed:true,scope:'actual pinned native agents through installed clientd, shared SDK/control/dispatcher/ledger, real proofs/signatures/Vault SBF; synthetic provider/RPC finality',native_agent:o.nativeAgent.kind,native_agent_group:group,provider_circuit_breaker_preserved:true,provider_admission_resets:0,native_agent_matrix:matrix,cases,provider_calls:o.calls,encrypted_journal:true,request_proof_verified:true,receipts_verified:true,signed_successor_verified:true,finite_http_gateway:true,raw_query_headers_preserved:true,original_request_bytes_preserved:true,unknown_usage_not_zero:true,no_automatic_provider_replay:true,no_native_retry_or_fallback:matrix.every(r=>r.client_profile_compatible),client_profile_compatible:matrix.every(r=>r.client_profile_compatible),native_client_compatibility:matrix.every(r=>r.client_profile_compatible),native_client_limitations:o.nativeAgent.kind==='claude'&&group===1?['Claude Code2.1.220 retries a thinking capability400 despite retries0; the durable gateway hold rejects the second native attempt before authorization or provider dispatch.']:[],duplicates_not_replayed:true,invalid_requests_no_egress:true,restarted_journal_recovery:true,automatic_api_replays:0,deposit_micro_usdc:'5000000',total_charge_micro_usdc:String(expectedCharge),generic_charge_micro_usdc:String(expectedCharge),legacy_charge_micro_usdc:'0',withdrawal_micro_usdc:String(expectedWithdrawal),balance_conservation:true,chain:report,offline_configuration_validated:true,custody_preserved_on_restart:true,native_commands_executed:true,live_provider_verified:false,public_rpc_verified:false,release_gates_passed:[]};
    }
    const rawGateway=(id:string,body:string,path?:string):Promise<{code:number;stdout:string;stderr:string;headers:string[];trailers:string[]}>=>(new Promise(resolve=>{
      assert.equal(o.tariff.api.version,'2');const api=o.tariff.api as import('../src/gateway.ts').ApiBindingV2,route=api.routes.find(route=>route.method==='POST')!;assert.ok(route);
      const target=path??route.path+'?tag=a&tag=b%2f&empty=',headers=['Host',listen,'Authorization','Bearer '+apiToken,'Idempotency-Key',id,'Content-Type','application/json','Content-Length',String(Buffer.byteLength(body)),'X-Gateway-Test','one','X-Gateway-Test','two'];
      const req=httpRequest({hostname:'127.0.0.1',port:Number(listen.split(':')[1]),method:'POST',path:target,headers},res=>{const chunks:Buffer[]=[];res.on('data',bytes=>chunks.push(bytes));res.on('end',()=>resolve({code:res.statusCode!>=200&&res.statusCode!<300?0:1,stdout:Buffer.concat(chunks).toString(),stderr:'',headers:res.rawHeaders,trailers:res.rawTrailers}));res.on('error',()=>resolve({code:1,stdout:'',stderr:'gateway interrupted',headers:res.rawHeaders,trailers:[]}));});
      req.on('error',()=>resolve({code:1,stdout:'',stderr:'gateway interrupted',headers:[],trailers:[]}));req.end(body);
    }));
    const api=(variant:string,id:string,body?:string)=>gateway?rawGateway(id,body??JSON.stringify({query:'GENERAL_API_PRIVATE_QUERY',variant})):command(clientd,['api',profile,'--service',o.tariff.api.service,'--operation',o.tariff.api.operation,'--operation-id',id],body??JSON.stringify({query:'GENERAL_API_PRIVATE_QUERY',variant}));
    const invalid=gateway?await rawGateway('00112233-4455-4677-8899-aabbccddeeff','{}','/unregistered-operation'):await api('success','00112233-4455-4677-8899-aabbccddeeff','{');assert.notEqual(invalid.code,0);assert.equal(JSON.stringify(o.calls),initialCalls);
    const accepted:{id:string;variant:string}[]=[];
    const variants=o.fault==='lost_response'?['success']:o.fault==='upstream_timeout'?['upstream_timeout']:['success','http_error',gateway?'truncated':'invalid_json'];
    for(const variant of variants){
      const id=crypto.randomUUID();accepted.push({id,variant});
      if(variant==='invalid_json'||variant==='truncated'||o.fault==='lost_response'){
        const barrier=o.fault==='lost_response'?o.lostResponseBarrier!:o.invalidJsonBarrier!;
        const pending=api(variant,id);await barrier.observed;
        await stop('SIGKILL');barrier.release();const result=await pending;assert.notEqual(result.code,0);
        await start(false);await settle();
        const duplicate=await api(variant,id);assert.notEqual(duplicate.code,0);assert.equal(o.calls[variant],1);
      }else{
        const result=await api(variant,id);
        if(variant==='success'){assert.equal(result.code,0,result.stderr+result.stdout);assert.equal(JSON.parse(result.stdout).items[0].id,'catalog-42');if(gateway){assert.ok('headers' in result);const resultHeaders=result.headers as string[];assert.deepEqual(resultHeaders.flatMap((name,n)=>n%2===0&&name.toLowerCase()==='x-gateway-result'?[resultHeaders[n+1]]:[]),['first',Buffer.from([128,255]).toString('latin1')]);const resultTrailers=('trailers' in result?result.trailers:[]) as string[];assert.deepEqual(resultTrailers.flatMap((name,n)=>n%2===0&&name.toLowerCase()==='x-gateway-checksum'?[resultTrailers[n+1]]:[]),['fixture-complete']);}}else assert.notEqual(result.code,0);
        const duplicate=await api(variant,id);assert.notEqual(duplicate.code,0);assert.equal(o.calls[variant],1);await settle();
      }
    }
    assert.deepEqual(o.calls,Object.fromEntries(variants.map(variant=>[variant,1])));
    assert.equal((await request('status')).value.balance_micro_usdc,String(withdrawal));
    await request('wallet',{action:'withdraw',mode:'mutual_close',destination_owner:o.destinationOwner,roles:o.roles});await drive();await stop();
    const raw=await unlockJournalKey(config.custody,new TextEncoder().encode(passphrase)),key=await importJournalKey(raw);raw.fill(0);
    const journal=new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(config.journal),key,{deploymentId:o.manifest.deployment_id,pool:o.manifest.pool},validateNoteJournal);
    const final=(await journal.read(config.note_id))!.value;assert.equal(final.wallet!.status,'closed');if(gateway){assert.equal(final.schema,3);for(const h of final.history)for(const op of h.operations){assert.equal(op.invocationVersion,'2');assert.match(op.operationHmac!,/^[0-9a-f]{64}$/);assert.equal(op.bodyBase64,'');assert.equal(op.bodySha256,undefined);}}assert.equal(final.pending,null);assert.equal(final.history.length,variants.length);
    const cases=accepted.map(({id,variant})=>{const history=final.history.find(h=>h.operations.some(operation=>operation.id===id))!;assert.ok(history);
      assert.equal(history.settlement.charge_micro_usdc,variant==='success'?'250':'0');assert.equal(history.receipts.length,1);
      const receipt=history.receipts.find(receipt=>receipt.body.operation_id===id)!;assert.ok(receipt);assert.equal(receipt.body.charged_nano_usdc,variant==='success'?'250000':'0');
      return {variant,operation_id:id,request_id:history.prepared.request.authorization.request_id,charged_nano_usdc:receipt.body.charged_nano_usdc,operation_state:['invalid_json','truncated','upstream_timeout'].includes(variant)?'WAIVED_OPERATOR_LOSS':'DONE',receipt_verified:true};});
    const report=await o.call({kind:'report',name:'general-api',report_path:join(work,'vault-sbf-results.json')});
    assert.equal(report.vault_micro_usdc,0);assert.equal(report.destination_micro_usdc,withdrawal);assert.equal(report.treasury_micro_usdc,charge);
    assert.equal(report.source_micro_usdc+report.destination_micro_usdc+report.vault_micro_usdc+report.treasury_micro_usdc,100000000);assert.ok(report.rows.every((row:any)=>row.error===null));
    const journalBytes=Buffer.concat(await Promise.all((await readdir(config.journal)).map(name=>readFile(join(config.journal,name)).catch(()=>Buffer.alloc(0))))).toString();
    for(const secret of ['GENERAL_API_PRIVATE_QUERY','GENERAL_API_PRIVATE_RESULT',final.witness!.secret])assert.equal(journalBytes.includes(secret),false);
    for(const secret of [passphrase,seed,management,apiToken])assert.equal(daemonDiagnostic.includes(secret),false);
    return {passed:true,scope:'installed native commands with real proofs/signatures/Vault SBF and synthetic provider/RPC finality',cases,provider_calls:o.calls,
      encrypted_journal:true,request_proof_verified:true,receipts_verified:true,signed_successor_verified:true,request_body_has_no_model:true,...(gateway?{finite_http_gateway:true,raw_query_headers_preserved:true}:{}),
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
