/** Actual Chromium dedicated Worker, actual WASM/native proofs and shared verifier. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile,mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
import { NativeProver } from '../src/prover-node.ts';
import { read,json,digest } from './wallet-fixture.ts';
const chrome=process.env.ZKAPI_TEST_CHROME??['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].find(existsSync);
class Cdp {
  socket:WebSocket;next=1;pending=new Map<number,{resolve(v:any):void;reject(e:unknown):void}>();
  constructor(socket:WebSocket){this.socket=socket;socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data)),p=this.pending.get(m.id);if(p){this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});socket.addEventListener('close',()=>{for(const p of this.pending.values())p.reject(Error('browser closed'));});}
  static async connect(url:string){const socket=new WebSocket(url),cdp=new Cdp(socket);await new Promise<void>((resolve,reject)=>{socket.addEventListener('open',()=>resolve(),{once:true});socket.addEventListener('error',reject,{once:true});});return cdp;}
  call(method:string,params:object={}):Promise<any>{const id=this.next++,p=new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));this.socket.send(JSON.stringify({id,method,params}));return p;}
  async evaluate(expression:string){const r=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;}
}
test('real Chromium worker: new RP/WPs/tree proofs, shared receipt verifier, termination/native fallback and no fallback on rejection',{skip:!chrome&&'Chromium required',timeout:180_000},async t=>{
  const wasm=await read('apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm'),hash=digest(wasm);
  const binary=resolve('apps/clientd/prover/target/release/zkapi-client-prover'),native=new NativeProver(binary,digest(await read(binary)));
  const fixture=await json('target/i08-wallet/crypto-fixture.json'),prepare=await json('target/i08/prepare-command.json'),settle=await json('target/i08/settlement-command.json'),expected=await json('target/i08/expected-next-state.json');
  const key=async(name:string)=>{const pk=await read(name==='tree'?'target/i09-challenger/test-tree.pk':`vendor/ethereum-zkapi/protocol/setup/v2/${name}.pk`),vk=await read(name==='tree'?'tests/fixtures/layout2/test-tree.vk':`vendor/ethereum-zkapi/protocol/setup/v2/${name}.vk`);return {bytes_base64:Buffer.from(pk).toString('base64'),pk_sha256:digest(pk),vk_sha256:digest(vk)};};
  const common={context:fixture.context,witness:fixture.witness,state:fixture.state,root:fixture.root,siblings:fixture.siblings};
  const commands={request:{kind:'request',...common,authorization:prepare.prepared.request.authorization,request_time:prepare.prepared.request.quote.body.issued_at,cap:prepare.context.cap_micro_usdc,key:await key('request')},close:{kind:'withdrawal',...common,destination_owner_hex:'07'.repeat(32),clearance:fixture.clearance,mutual:true,key:await key('withdrawal')},escape:{kind:'withdrawal',...common,destination_owner_hex:'07'.repeat(32),clearance:null,mutual:false,key:await key('withdrawal')},tree0:{kind:'tree',context:fixture.context,note:fixture.note,root:fixture.empty_root,siblings:fixture.siblings,op:0,key:await key('tree')},tree1:{kind:'tree',context:fixture.context,note:fixture.note,root:fixture.root,siblings:fixture.siblings,op:1,key:await key('tree')}};
  const javascript:Record<string,string>={};for(const name of ['prover-runtime','prover-worker'])javascript[`/${name}.ts`]=ts.transpileModule(await readFile(resolve(`packages/sdk/src/${name}.ts`),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ES2022}}).outputText;
  let nativeCalls=0;
  const server=createServer(async(req,res)=>{try{
    if(req.url==='/wasm'){res.setHeader('Content-Type','application/wasm');res.end(wasm);}
    else if(req.url==='/data'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({commands,prepare,settle,expected,hash}));}
    else if(req.url==='/native'){nativeCalls++;const parts:Buffer[]=[];for await(const chunk of req)parts.push(Buffer.from(chunk));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await native.run(JSON.parse(Buffer.concat(parts).toString('utf8')))));}
    else if(javascript[req.url!]){res.setHeader('Content-Type','text/javascript');res.end(javascript[req.url!]);}
    else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Local proof verification</title>');}
  }catch{res.statusCode=500;res.end('test bridge rejected');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(r=>server.close(()=>r())));const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const directory=await mkdtemp(join(tmpdir(),'zkapi-wasm-worker-'));const child=spawn(chrome!,['--headless=new','--disable-gpu','--no-first-run','--disable-default-apps','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${directory}`,'about:blank'],{stdio:['ignore','ignore','pipe']});let diagnostics='';child.stderr.on('data',c=>diagnostics=(diagnostics+c).slice(-3000));
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  let port=0;for(let i=0;i<150;i++){try{port=Number((await readFile(join(directory,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{if(child.exitCode!==null)throw Error(diagnostics);await delay(30);}}assert.ok(port);
  const debug=`http://127.0.0.1:${port}`,version=(await(await fetch(`${debug}/json/version`)).json() as any).Browser;t.diagnostic(`Runtime browser: ${version}`);
  const target=await(await fetch(`${debug}/json/new?${encodeURIComponent(origin)}`,{method:'PUT'})).json() as any,cdp=await Cdp.connect(target.webSocketDebuggerUrl);t.after(()=>cdp.socket.close());
  const output=await cdp.evaluate(`(async()=>{
    const {WorkerProver}=await import('/prover-runtime.ts');const data=await(await fetch('/data')).json();const wasm=new Uint8Array(await(await fetch('/wasm')).arrayBuffer());
    const fallback={run:async command=>{const r=await fetch('/native',{method:'POST',body:JSON.stringify(command)});if(!r.ok)throw Error('native rejected');return r.json();}};
    const engine=new WorkerProver(new Worker('/prover-worker.ts',{type:'module'}),wasm,data.hash,{nativeFallback:fallback});
    const results={},timings={};
    for(const [name,command]of Object.entries(data.commands)){const start=performance.now();results[name]=await engine.run(command);timings[name]=performance.now()-start;}
    const original=await engine.run({kind:'verify',command:data.prepare});const next=await engine.run({kind:'verify',command:data.settle});
    const fresh=structuredClone(data.prepare);fresh.prepared.rerandomization=results.request.rerandomization;fresh.prepared.request.public_inputs=results.request.auth.public_inputs;fresh.prepared.request.proof.proof=btoa(String.fromCharCode(...Uint8Array.from(results.request.auth.proof_wire_hex.match(/../g),b=>parseInt(b,16))));
    const freshVerified=await engine.run({kind:'verify',command:fresh});
    let rejects=0;for(const command of [(()=>{const c=structuredClone(data.settle);c.receipts=[];return {kind:'verify',command:c};})(),(()=>{const c=structuredClone(data.commands.request);c.key.pk_sha256='00'.repeat(32);return c;})()]){try{await engine.run(command);}catch{rejects++;}}
    // Interrupt an actual in-flight proof. Only offline crypto is regenerated.
    const running=engine.run(data.commands.request);setTimeout(()=>engine.terminate(),50);const fallbackResult=await running;
    const bad=new WorkerProver(new Worker('/prover-worker.ts',{type:'module'}),wasm,'00'.repeat(32),{nativeFallback:fallback});try{await bad.run({kind:'deposit',note_id:0,amount:'1',expiry:'2'});}catch{rejects++;}bad.terminate();
    return {results,timings,original,next,freshVerified,rejects,fallbackInputs:fallbackResult.auth.public_inputs,heap_bytes:performance.memory?.usedJSHeapSize??null};
  })()`);
  assert.deepEqual(output.original,{verified:true});assert.deepEqual(output.freshVerified,{verified:true});assert.deepEqual(output.next,expected);assert.equal(output.rejects,3);assert.equal(nativeCalls,1);assert.equal(output.fallbackInputs[8],fixture.nullifier);
  const vault=await json('tests/fixtures/vault/genesis-a.json');vault.auth.withdrawal=output.results.close;vault.auth.escape=output.results.escape;vault.trees[0]=output.results.tree0;vault.trees[1]=output.results.tree1;
  await writeFile(resolve('target/i08-wallet/wasm-vault.json'),JSON.stringify(vault,null,2)+'\n');
  await writeFile(resolve('target/i08-wallet/wasm-results.json'),JSON.stringify({scope:'real Chromium dedicated worker, new WASM proofs, shared verifier and actual native fallback',browser:version,wasm_sha256:hash,wasm_bytes:wasm.length,timings_ms:output.timings,js_heap_bytes:output.heap_bytes,native_fallback_calls:nativeCalls,rejections:output.rejects,request_nullifier:output.results.request.auth.public_inputs[8]},null,2)+'\n');
  t.diagnostic(`New WASM proofs (ms): ${JSON.stringify(output.timings)}; actual native fallback calls: ${nativeCalls}`);
});
