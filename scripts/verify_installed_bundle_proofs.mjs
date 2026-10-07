/** Actual offline native/WASM proof generation from one installed public bundle.
 * Uses installed SDK exports only. Synthetic unfunded witness/quote stay in
 * memory; no service, chain, provider, funding or custody initialization. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function file(path,maximum=512*1024*1024){
  const s=await lstat(path);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.size>0&&s.size<=maximum);
  const bytes=await readFile(path);assert.ok(bytes.length<=maximum);return bytes;
}
async function pinned(path,expected,maximum){assert.match(expected,/^[0-9a-f]{64}$/);const bytes=await file(path,maximum);assert.equal(hash(bytes),expected);return bytes;}
async function installedTree(directory){
  const hashes={};
  async function walk(path,relative=''){
    for(const name of (await readdir(path)).sort()){
      assert.ok(name!=='.'&&name!=='..');const sub=join(path,name),rel=relative?relative+'/'+name:name,s=await lstat(sub);
      assert.ok(!s.isSymbolicLink());if(s.isDirectory())await walk(sub,rel);else{assert.ok(s.isFile());hashes[rel]=hash(await file(sub));}
    }
  }
  await walk(directory);return hashes;
}
function exact(value,keys){assert.ok(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...keys].sort());}
async function verifier(binary,expected,command){
  await pinned(binary,expected,32*1024*1024);
  return new Promise((ok,fail)=>{
    const child=spawn(binary,[],{shell:false,stdio:['pipe','pipe','pipe'],env:{RAYON_NUM_THREADS:'2'}});let size=0,done=false;const chunks=[];
    const finish=error=>{if(done)return;done=true;clearTimeout(timer);if(error){child.kill('SIGKILL');fail(error);}else{try{ok(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{fail(Error('invalid independent verifier output'));}}};
    const timer=setTimeout(()=>finish(Error('independent verifier deadline')),30_000);
    child.on('error',()=>finish(Error('independent verifier unavailable')));child.stdin.on('error',()=>finish(Error('independent verifier input rejected')));
    child.stdout.on('data',b=>{size+=b.length;if(size>1024*1024)finish(Error('independent verifier output bound'));else chunks.push(b);});child.stderr.resume();
    child.on('close',code=>finish(code===0?undefined:Error('independent verifier rejected')));child.stdin.end(JSON.stringify(command));
  });
}
export async function verifyInstalledBundleProofs(configuration,output){
  const c=structuredClone(configuration);
  exact(c,['schema','sdkDirectory','sdkTreeSha256','bundleDirectory','bundleSha256','nativeProverPath','nativeProverSha256','verifierPath','verifierSha256']);assert.equal(c.schema,1);
  const destination=resolve(output);await assert.rejects(lstat(destination),{code:'ENOENT'},'new report directory required');
  const sdk=await realpath(c.sdkDirectory);assert.equal(sdk,resolve(c.sdkDirectory));assert.ok(sdk.split(sep).includes('node_modules'),'an independently installed SDK directory required');
  const before=await installedTree(sdk),treeBytes=Buffer.from(JSON.stringify(before));assert.equal(hash(treeBytes),c.sdkTreeSha256,'independently installed SDK tree hash');
  const pkg=JSON.parse(await file(join(sdk,'package.json'),1024*1024));assert.equal(pkg.name,'@zkapi/solana-sdk');
  const imported={};
  const module=async sub=>{
    const target=pkg.exports[sub]?.import;assert.ok(typeof target==='string'&&/^\.\/dist\/[a-z0-9-]+\.js$/.test(target));
    const path=join(sdk,target);assert.equal(await realpath(path),path);imported[sub]=hash(await file(path,1024*1024));return import(pathToFileURL(path).href);
  };
  const {loadDeploymentAssets}=await module('./deployment'),{NoteProver}=await module('./prover'),{NativeProver}=await module('./prover-node'),{WasmProver}=await module('./prover-runtime');
  const {createCredentials}=await module('./control'),{jcsBytes,sha256Hex}=await module('./trust');
  const directory=await realpath(c.bundleDirectory);assert.equal(directory,resolve(c.bundleDirectory));
  const raw=await pinned(join(directory,'bundle.json'),c.bundleSha256,1024*1024),descriptor=JSON.parse(raw);
  assert.equal(descriptor.schema,2,'complete authenticated notice bundle required');
  const beforeFiles={};
  for(const name of ['bundle.json',...Object.keys(descriptor.files)]){assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);beforeFiles[name]=hash(await file(join(directory,name)));}
  // This URL is an offline namespace. The custom fetch reads only authenticated
  // flat installed files; global fetch is disabled throughout proof generation.
  const namespace='https://offline-bundle.example.com/';let localReads=0;
  const fetcher=async(input,init)=>{
    assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');const url=String(input);assert.ok(url.startsWith(namespace));
    const name=url.slice(namespace.length);assert.match(name,/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);assert.ok(name!=='.'&&name!=='..');localReads++;return new Response(new Uint8Array(await file(join(directory,name))));
  };
  const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('external network forbidden in bundle proof acceptance');};
  try{
    const assets=await loadDeploymentAssets(namespace+'bundle.json',{bundleSha256:c.bundleSha256,fetch:fetcher}),m=assets.verifiedManifest;
    assert.equal(localReads,1+Object.keys(descriptor.files).length);assert.equal(m.deployment_environment,'devnet');assert.equal(m.setup_profile,'test_only');
    assert.ok(Object.keys(assets.notices).length>=5);await pinned(c.nativeProverPath,c.nativeProverSha256,32*1024*1024);
    const native=new NativeProver(resolve(c.nativeProverPath),c.nativeProverSha256),wasm=await WasmProver.create(assets.wasm,assets.wasmSha256);
    const nativeNote=await NoteProver.create(m,assets.artifacts,native),wasmNote=await NoteProver.create(m,assets.artifacts,wasm);
    const empty=await verifier(resolve(c.verifierPath),c.verifierSha256,{kind:'empty_path'});assert.equal(empty.siblings.length,32);
    const deposit=await nativeNote.deposit(0,m.cap_micro_usdc,'3000003600');
    assert.deepEqual(await nativeNote.inspect(deposit.witness,deposit.state),await wasmNote.inspect(deposit.witness,deposit.state));
    const note={note_id:0,registration_commitment:deposit.registration_commitment,deposit_micro_usdc:deposit.witness.deposit_micro_usdc,expiry:deposit.witness.expiry};
    const tariffBody={version:'1',provider:'openrouter',model:'*',pricing_basis:'provider_reported_usd',valid_from:'0',valid_until:'9999999999',rates:[],operator_fee_micro_usdc:'0'};
    const tariff={...tariffBody,tariff_hash:await sha256Hex(jcsBytes(tariffBody))};
    const quoteBody={quote_id:crypto.randomUUID(),deployment_id:m.deployment_id,pool:m.pool,mode:'direct_openrouter',provider:'openrouter',models:['offline-proof-fixture'],tariff_hash:tariff.tariff_hash,
      cap_micro_usdc:m.cap_micro_usdc,issued_at:'3000000000',expires_at:'3000000120',session_ttl_seconds:'60',max_concurrency:'1',control_api_origin:m.control_api_origin,inference_api_origin:m.inference_api_origin};
    const quote={body:quoteBody,quote_hash:await sha256Hex(jcsBytes(quoteBody)),signature:Buffer.alloc(64).toString('base64')};
    const credentials=await createCredentials('direct_openrouter'),proofs={},rows=[];
    const vks={request:assets.artifacts.requestVk,withdrawal:assets.artifacts.withdrawalVk,tree:assets.artifacts.treeVk};
    for(const[engine,prover]of [['native',nativeNote],['wasm',wasmNote]]){
      proofs[engine]={};
      for(const circuit of ['tree','request','withdrawal']){
        const start=performance.now();let proof;
        if(circuit==='tree')proof=await prover.tree(note,empty.root,empty.siblings,0);
        else if(circuit==='request'){
          const prepared=await prover.prepareSession(deposit.witness,deposit.state,proofs[engine].tree.public_inputs[2],empty.siblings,quote,tariff,credentials);
          proof={public_inputs:prepared.request.public_inputs,proof_wire_hex:Buffer.from(prepared.request.proof.proof,'base64').toString('hex')};
        }else proof=await prover.withdrawal(deposit.witness,deposit.state,proofs[engine].tree.public_inputs[2],empty.siblings,m.authorities.admin.authority,null);
        const elapsedMs=performance.now()-start,command={kind:'verify',circuit,vk_hex:Buffer.from(vks[circuit]).toString('hex'),vk_sha256:hash(vks[circuit]),proof};
        assert.equal((await verifier(resolve(c.verifierPath),c.verifierSha256,command)).verified,true);
        const invalidProof=structuredClone(command);invalidProof.proof.proof_wire_hex='00'.repeat(256);await assert.rejects(verifier(resolve(c.verifierPath),c.verifierSha256,invalidProof));
        const invalidInputs=structuredClone(command);invalidInputs.proof.public_inputs[0]='0x'+'00'.repeat(32);await assert.rejects(verifier(resolve(c.verifierPath),c.verifierSha256,invalidInputs));
        const wrongKey=structuredClone(command);wrongKey.vk_sha256='00'.repeat(32);await assert.rejects(verifier(resolve(c.verifierPath),c.verifierSha256,wrongKey));
        proofs[engine][circuit]=proof;rows.push({engine,circuit,publicInputs:proof.public_inputs.length,proofBytes:256,proofSha256:hash(Buffer.from(proof.proof_wire_hex,'hex')),vkSha256:hash(vks[circuit]),independentlyVerified:true,rejections:3,elapsedMs});
        process.stderr.write(JSON.stringify({engine,circuit,independentlyVerified:true,elapsedMs})+'\n');
      }
    }
    assert.deepEqual(proofs.native.tree.public_inputs,proofs.wasm.tree.public_inputs);
    assert.deepEqual(proofs.native.withdrawal.public_inputs,proofs.wasm.withdrawal.public_inputs);
    assert.deepEqual(proofs.native.request.public_inputs.slice(0,10),proofs.wasm.request.public_inputs.slice(0,10)); // Last two points are fresh rerandomizations.
    for(const[name,pin]of Object.entries(beforeFiles))assert.equal(hash(await file(join(directory,name))),pin,'source bundle changed');
    assert.deepEqual(await installedTree(sdk),before,'installed SDK changed');
    const report={schema:1,scope:'New native and bundle-WASM request, escape-withdrawal and tree-insert proofs; independent supplied-VK verification. Offline unfunded genesis witness and synthetic unsigned quote only.',
      sdkVersion:pkg.version,sdkTreeSha256:c.sdkTreeSha256,importedSdkExports:imported,bundleSha256:c.bundleSha256,manifestHash:m.manifest_hash,circuitProfileHash:m.circuit_profile_hash,
      nativeProverSha256:c.nativeProverSha256,wasmSha256:assets.wasmSha256,independentVerifierSha256:c.verifierSha256,notices:Object.fromEntries(Object.entries(assets.notices).map(([n,b])=>[n,{sha256:hash(b),bytes:b.length}])),
      generatedProofs:rows.length,independentVerifications:rows.length,negativeChecks:rows.reduce((n,r)=>n+r.rejections,0),rows,sourceFilesUnchanged:true,
      rpcActions:0,providerActions:0,authorizationSends:0,fundingActions:0,transactionActions:0,remoteQuoteSignatureVerified:false,browserExecuted:false,releaseGatesPassed:[]};
    await mkdir(destination,{mode:0o700});await writeFile(join(destination,'proofs.json'),JSON.stringify(proofs,null,2)+'\n',{flag:'wx',mode:0o600});
    await writeFile(join(destination,'results.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});return report;
  }finally{globalThis.fetch=savedFetch;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length===4&&process.argv[2]==='--sdk-tree-hash'){
      const dir=await realpath(process.argv[3]);console.log(hash(Buffer.from(JSON.stringify(await installedTree(dir)))));
    }else{
      assert.equal(process.argv.length,4,'config and new output directory required');const config=JSON.parse(await file(resolve(process.argv[2]),1024*1024));
      console.log(JSON.stringify(await verifyInstalledBundleProofs(config,process.argv[3]),null,2));
    }
  }catch{console.error('Installed public bundle proof acceptance failed. Preserve the failed observation and verify pinned inputs. No RPC, provider, AUTH or funding action is supported by this script.');process.exitCode=1;}
}
