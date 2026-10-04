/** Real Go process + installed SDK runtime + native proof + actual Vault SBF.
 * JSON-RPC/indexer envelopes are local deterministic adapters, not public RPC. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import {walletFixture} from './wallet-fixture.ts';
import {manifestDigest} from '../src/trust.ts';

test('installed Go clientd drives encrypted native wallet deposit and withdrawal through actual SBF',{timeout:240_000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'zkapi-clientd-sbf-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await mkdir(join(directory,'journal'),{mode:0o700});
  const svm=spawn(resolve('tests/svm/target/debug/wallet'),[],{stdio:['pipe','pipe','pipe']});svm.stderr.resume();
  const queue:{resolve(v:any):void;reject(e:unknown):void}[]=[];createInterface({input:svm.stdout}).on('line',line=>{const p=queue.shift();if(p){try{p.resolve(JSON.parse(line));}catch(e){p.reject(e);}}});svm.on('exit',()=>{for(const p of queue.splice(0))p.reject(Error('SBF stopped'));});
  const call=(value:object)=>new Promise<any>((resolve,reject)=>{queue.push({resolve,reject});svm.stdin.write(JSON.stringify(value)+'\n');});
  t.after(async()=>{if(svm.exitCode===null){const exited=once(svm,'exit');svm.stdin.end();await exited;}});
  const {manifest:base,artifacts}=await walletFixture();const manifest=structuredClone(base) as any;
  let hideReceipt=false;let sends=0;const sent:string[]=[];
  const upstream=createServer(async(req,res)=>{try{
    const parts:Buffer[]=[];for await(const chunk of req)parts.push(chunk);const body=Buffer.concat(parts);
    let result:any;
    if(req.url==='/rpc'){
      const rpc=JSON.parse(body.toString()),a=rpc.params;
      switch(rpc.method){
        case'getGenesisHash':result=manifest.genesis_hash;break;
        case'getBlock':result={blockhash:bs58.encode(new Uint8Array(32).fill(1)),previousBlockhash:bs58.encode(new Uint8Array(32).fill(1)),parentSlot:a[0]-1,blockTime:3000000000,blockHeight:a[0]};break;
        case'getMultipleAccounts':result=await call({kind:'accounts',addresses:a[0]});break;
        case'getAccountInfo':{const cut=await call({kind:'accounts',addresses:[a[0]]});result={context:cut.context,value:cut.value[0]};break;}
        case'getLatestBlockhash':result={context:{slot:100},value:await call({kind:'blockhash'})};break;
        case'getSignatureStatuses':result={context:{slot:100},value:[null]};break;
        case'getBlockHeight':result=100;break;
        case'getTransaction':{const receipt=await call({kind:'receipt',signature:a[0]});result=hideReceipt?null:receipt?.rpc??null;break;}
        case'sendTransaction':{sends++;const sentResult=await call({kind:'send',base64:a[0]});result=sentResult.signature;sent.push(result);break;}
        default:throw Error('unexpected RPC '+rpc.method);
      }
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));return;
    }
    if(req.url==='/zkapi/v1/tree/root')result=await call({kind:'root'});
    else if(req.url?.startsWith('/zkapi/v1/tree/notes/'))result=await call({kind:'path',note_id:Number(req.url.split('/')[5])});
    else if(req.url==='/zkapi/v1/withdraw/clearance'){
      const input=JSON.parse(body.toString());result=await new Promise<any>((resolve,reject)=>{const child=spawn(resolvePath('apps/clientd/prover/target/release/examples/test_clearance'));let output='';child.stdout.on('data',b=>output+=b);child.stderr.resume();child.on('close',code=>code===0?resolve(JSON.parse(output)):reject(Error('clearance fixture failed')));child.stdin.end(JSON.stringify({nullifier:input.nullifier,vault_binding:manifest.vault_binding}));});
    }else{res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch{res.writeHead(500);res.end('{"error":"fixture failed"}');}});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>upstream.close(()=>resolve())));const port=(upstream.address() as any).port,origin=`http://127.0.0.1:${port}`;
  manifest.control_api_origin=origin;manifest.inference_api_origin=origin;manifest.proving_keys_base_url=origin+'/keys';manifest.manifest_hash=await manifestDigest(manifest);
  const manifestPath=join(directory,'manifest.json');await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});
  const artifactPaths:any={additional:{}};for(const[name,value]of Object.entries(artifacts))if(name!=='additional'){const path=join(directory,name);await writeFile(path,value as Uint8Array);artifactPaths[name]=path;}for(const[name,value]of Object.entries(artifacts.additional)){const path=join(directory,'additional-'+name);await writeFile(path,value);artifactPaths.additional[name]=path;}
  const built=JSON.parse(await readFile('target/i08-clientd/distribution-result.json','utf8')),release=JSON.parse(await readFile(built.distribution,'utf8')),installed=resolve('target/i08-clientd/distribution');
  const policy={anchor:{kind:'hash',sha256:manifest.manifest_hash},expected:{deployment_id:manifest.deployment_id,deployment_environment:manifest.deployment_environment,genesis_hash:manifest.genesis_hash,program_id:manifest.program_id,pool:manifest.pool,mint:manifest.mint,token_program:manifest.token_program,control_api_origin:origin,inference_api_origin:origin},build:{stateKey:manifest.state_key,clearanceKey:manifest.clearance_key,circuitProfileHash:manifest.circuit_profile_hash,idlHash:manifest.idl_hash,setupProfile:manifest.setup_profile}};
  const tariffPath=join(directory,'tariff.json');await writeFile(tariffPath,JSON.stringify(JSON.parse(await readFile('target/i08/prepare-command.json','utf8')).prepared.tariff));
  const runtime={manifest:manifestPath,policy,artifacts:artifactPaths,verifier:{path:join(installed,'bin/zkapi-client-verify'),sha256:release.files['bin/zkapi-client-verify']},prover:{path:join(installed,'bin/zkapi-client-prover'),sha256:release.files['bin/zkapi-client-prover']},journal:join(directory,'journal'),custody:join(directory,'custody.json'),note_id:'local-note',mode:'proxy',models:['fixture'],tariff:tariffPath,rpc:origin+'/rpc',indexer:origin};
  const runtimePath=join(directory,'runtime.json');await writeFile(runtimePath,JSON.stringify(runtime));
  const free=createServer();await new Promise<void>(resolve=>free.listen(0,'127.0.0.1',resolve));const listenPort=(free.address() as any).port;await new Promise<void>(resolve=>free.close(()=>resolve()));
  const config={distribution:built.distribution,distribution_sha256:built.distribution_sha256,node:built.node,node_sha256:built.node_sha256,runtime:built.runtime,runtime_sha256:built.runtime_sha256,runtime_config:runtimePath,listen:`127.0.0.1:${listenPort}`,network:{mode:'direct',routes:[{origin,prefix:'/'}],allow_local_http:true}};
  const configPath=join(directory,'config.json');await writeFile(configPath,JSON.stringify(config));
  const secrets={inference_token:'i'.repeat(40),management_token:'m'.repeat(40),passphrase:'isolated local fixture passphrase',wallet_seed_base64:Buffer.alloc(32,1).toString('base64')};
  let child:ReturnType<typeof spawn>|undefined;let diagnostics='';
  const start=async(initialize:boolean)=>{child=spawn(join(installed,'bin/clientd'),['serve',configPath],{stdio:['pipe','pipe','pipe']});child.stderr!.on('data',b=>diagnostics+=b);child.stdin!.end(JSON.stringify({...secrets,initialize_key:initialize})+'\n');await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('startup timeout '+diagnostics)),30_000);child!.stdout!.once('data',()=>{clearTimeout(timeout);resolve();});child!.once('exit',code=>{clearTimeout(timeout);reject(Error('clientd exit '+code+' '+diagnostics));});});};
  const stop=async(signal:NodeJS.Signals='SIGTERM')=>{if(child?.exitCode===null&&child?.signalCode===null){const done=once(child,'exit');child.kill(signal);await done;}};t.after(()=>stop());
  await start(true);
  const request=async(path:string,body?:unknown,credential='m')=>{const response=await fetch(`http://127.0.0.1:${listenPort}${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential.repeat(40),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result as any;};
  assert.equal((await request('/v1/models',undefined,'i')).data[0].id,'fixture');
  const payer=Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58(),roles={payer,uploader:payer,feePayer:payer,rentPayer:payer,tokenOwner:payer};
  await request('/admin/wallet',{action:'deposit',amount:'5000000',roles});
  // Abruptly kill only the Go supervisor while its SDK owns the journal lock
  // and the first transaction remains unknown. Pipe EOF must stop that SDK so
  // the replacement can open the same state and recover the exact signed bytes.
  hideReceipt=true;await request('/admin/wallet',{action:'advance'});assert.equal(sends,1);await stop('SIGKILL');hideReceipt=false;await start(false);
  const drive=async()=>{for(let i=0;i<60;i++){const result=await request('/admin/wallet',{action:'advance'});if(result.state==='complete')return;if(result.state==='proof_required')await request('/admin/wallet',{action:'prove'});}throw Error('wallet did not finish');};
  await drive();assert.equal(sent.filter(x=>x===sent[0]).length,1,'restart recovered finalized exact bytes before replay');
  assert.equal((await request('/admin/status')).balance_micro_usdc,'5000000');
  await request('/admin/wallet',{action:'withdraw',mode:'mutual_close',destination_owner:bs58.encode(new Uint8Array(32).fill(7)),roles});await drive();
  await stop();const report=await call({kind:'report',name:'clientd'});assert.equal(report.destination_micro_usdc,5000000);assert.equal(report.vault_micro_usdc,0);assert.ok(report.max_cu<=1000000&&report.max_transaction_bytes<=1232);
  for(const secret of [secrets.passphrase,secrets.wallet_seed_base64,secrets.inference_token,secrets.management_token])assert.equal(diagnostics.includes(secret),false);
  t.diagnostic(`Go→SDK→native→Vault: ${report.rows.length} signed tx, max ${report.max_cu} CU / ${report.max_transaction_bytes} bytes`);
});
function resolvePath(path:string){return resolve(path);}
