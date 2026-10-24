/** Real-proof native/WASM fixture and released .15 encrypted journal recovery.
 * Fixture keys/credentials are public test data. No RPC or provider is contacted.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WasmProver} from '../src/prover-runtime.ts';
import {ProverSessionVerifier} from '../src/control-prover.ts';
import {ControlClient,validateNoteJournal,type NoteJournal} from '../src/control.ts';
import {EncryptedJournal,importJournalKey} from '../src/journal.ts';
import {NativeJournalStore} from '../src/journal-node.ts';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
test('signed direct waiver: WASM agreement and .15 journal advances only after verification, without replay',async t=>{
  const fixture=JSON.parse(await readFile(resolve(process.env.ZKAPI_DIRECT_WAIVER_FIXTURE_DIR??'target/direct-waiver-verifier','direct-waiver-verifier.json'),'utf8'));
  const wasmBytes=await readFile(resolve(process.env.ZKAPI_TEST_WASM_PROVER??'apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm'));
  const wasm=await WasmProver.create(wasmBytes,hash(wasmBytes));
  assert.deepEqual(await wasm.run({kind:'verify',command:fixture.success}),fixture.expected);
  for(const command of fixture.rejected)await assert.rejects(wasm.run({kind:'verify',command}));
  const archive=await readFile(resolve(process.env.ZKAPI_PREVIOUS_SDK_ARCHIVE??'target/zkapi-solana-sdk-0.2.0-devnet.15.tgz'));
  assert.equal(hash(archive),'976fd54b7fdcbafea75870728c018d50d821bdc5e5137e4a8b8e7b3c77f15f98');
  const dir=await mkdtemp(join(tmpdir(),'zkapi-waiver-journal-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  execFileSync('tar',['-xzf',resolve(process.env.ZKAPI_PREVIOUS_SDK_ARCHIVE??'target/zkapi-solana-sdk-0.2.0-devnet.15.tgz'),'-C',dir,'package/package.json','package/dist/journal.js']);
  const old=await import(pathToFileURL(join(dir,'package/dist/journal.js')).href);
  assert.equal(JSON.parse(await readFile(join(dir,'package/package.json'),'utf8')).version,'0.2.0-devnet.15');
  const c=fixture.success, key=await importJournalKey(new Uint8Array(32).fill(61));
  const scope={deploymentId:c.context.deployment_id,pool:c.context.pool};
  const store=await NativeJournalStore.open(join(dir,'journal'));
  const original=new old.EncryptedJournal(store,key,scope,validateNoteJournal);
  const journal=new EncryptedJournal<NoteJournal>(store,key,scope,validateNoteJournal);
  const pending={prepared:c.prepared,exactRequest:JSON.stringify(c.prepared.request),phase:'closing',closeRequested:true,
    serverState:'ISSUANCE_UNKNOWN',recovery:{reason_code:'provider_key_absent',requires_operator_action:true},operations:[]};
  const initial={schema:1,state:c.state,pending,history:[]};
  await original.create('valid',initial);await original.create('invalid',initial);
  let invalid=false;const calls:{method:string;path:string}[]=[];
  const http:typeof fetch=async(input,init)=>{
    const u=new URL(String(input));calls.push({method:init!.method!,path:u.pathname});
    assert.equal(init!.method,'GET','recovery must not send AUTH, inference or withdrawal');
    if(u.pathname.endsWith('/receipts'))return Response.json(u.search?{receipts:[],next_cursor:null}:{receipts:(invalid?fixture.rejected.at(-1):c).receipts,next_cursor:'1'});
    assert.equal(u.pathname,'/zkapi/v1/sessions/'+c.prepared.request.authorization.request_id);
    return Response.json({request_id:c.prepared.request.authorization.request_id,mode:'direct_openrouter',state:'SETTLED',
      cap_micro_usdc:c.context.cap_micro_usdc,settlement:c.settlement});
  };
  const client=new ControlClient({context:c.context,journal,verifier:new ProverSessionVerifier(wasm),fetch:http,allowLoopbackHttp:true});
  const storageKey=hash(new TextEncoder().encode(JSON.stringify(['zkapi-client-journal-v1',scope.deploymentId,scope.pool,'invalid'])));
  const before=await journal.read('invalid'), encrypted=await store.read(storageKey);assert.ok(encrypted);
  invalid=true;await assert.rejects(client.recover('invalid'));
  assert.deepEqual(await journal.read('invalid'),before);assert.deepEqual(await store.read(storageKey),encrypted);
  invalid=false;await client.recover('valid');
  const final=(await journal.read('valid'))!;
  assert.equal(final.value.pending,null);assert.deepEqual(final.value.state,fixture.expected);
  assert.equal(final.value.state.balance_micro_usdc,c.state.balance_micro_usdc);
  assert.equal(final.value.history.length,1);assert.deepEqual(final.value.history[0].receipts,c.receipts);
  assert.equal(final.value.history[0].receipts[0].body.observed_nano_usdc,null);
  assert.deepEqual((await original.read('valid')).value,final.value,'old journal codec still reads successor');
  assert.equal(calls.length,6);assert.ok(calls.every(call=>call.method==='GET'));
});
