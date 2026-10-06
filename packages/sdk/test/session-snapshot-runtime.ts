/** Explicit real native/WASM command regression; requires freshly built binaries.
 * Not included in the artifact-free default SDK unit suite. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeProver } from '../src/prover-node.ts';
import { WasmProver } from '../src/prover-runtime.ts';

test('actual native and WASM reconstruct the original real-proof fixture root and reject tampering', {timeout:120_000}, async t=>{
  const binary=resolve(process.env.ZKAPI_TEST_NATIVE_PROVER??'apps/clientd/prover/target/release/zkapi-client-prover');
  const wasmPath=resolve(process.env.ZKAPI_TEST_WASM_PROVER??'apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm');
  const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
  const native=new NativeProver(binary,hash(await readFile(binary)));
  const wasmBytes=await readFile(wasmPath),wasm=await WasmProver.create(wasmBytes,hash(wasmBytes));
  const f=JSON.parse(await readFile(resolve('tests/fixtures/layout2/a.json'),'utf8'));
  const command={kind:'snapshot_path',root:f.auth.request.public_inputs[3],next_note_id:'1',note_id:f.id,
    active_notes:[{note_id:String(f.id),commitment:'0x'+f.commitment,deposit_micro_usdc:String(f.deposit),expiry:String(f.expiry)}]};
  const start=performance.now(),expected=await native.run(command) as any;
  assert.equal(expected.root,command.root);assert.equal(expected.note_id,f.id);assert.equal(expected.siblings.length,32);
  assert.deepEqual(await wasm.run(command),expected);
  for(const engine of [native,wasm])for(const mutate of [
    (c:typeof command)=>{c.root='0x'+'00'.repeat(32);},
    (c:typeof command)=>{c.active_notes[0].deposit_micro_usdc='1';},
    (c:typeof command)=>{c.active_notes=[];},
    (c:typeof command)=>{c.active_notes.push({...c.active_notes[0]});},
    (c:typeof command)=>{c.note_id=1;},
  ]) {const changed=structuredClone(command);mutate(changed);await assert.rejects(engine.run(changed));}
  // A rejected command must leave each local engine usable for the next request.
  assert.deepEqual(await native.run(command),expected);assert.deepEqual(await wasm.run(command),expected);
  t.diagnostic(JSON.stringify({native_sha256:hash(await readFile(binary)),wasm_sha256:hash(wasmBytes),wasm_bytes:wasmBytes.length,elapsed_ms:performance.now()-start}));
});
