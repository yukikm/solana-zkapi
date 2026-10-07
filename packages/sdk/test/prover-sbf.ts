import {fixtureSigner, signWith, kitAddress} from './kit-helpers.ts';
/** Consume newly generated Chromium WASM proof bytes in the actual Vault SBF.
 * In-memory recording here is test scaffolding; durable wallet storage is tested separately. */
/** Consume newly generated Chromium WASM proof bytes in the actual Vault SBF.
 * In-memory recording here is test scaffolding; durable wallet storage is tested separately. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve } from 'node:path';

import { json } from './wallet-fixture.ts';
import { buildUploadPlan,prepareAttempt,vaultAccounts,prepareFinalizationAttempt,type V0Wallet,type Attempt } from '../src/transport.ts';
import { encodeLayout2Args,fromHex,type Operation } from '../src/layout2.ts';
test('new real WASM WP and tree proofs execute through actual SDK v0 buffers in Vault SBF',{timeout:30_000},async t=>{
  const f=await json('target/i08-wallet/wasm-vault.json');
  const wallet=async(seed:number):Promise<V0Wallet>=>{const pair=(await fixtureSigner(new Uint8Array(32).fill(seed)));return {publicKey:pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(tx){tx = await signWith(tx, [pair]);return tx;}};};
  const payer=await wallet(1),uploader=await wallet(10),programId=kitAddress(fromHex(f.program_id,32)),pool=kitAddress(fromHex(f.pool,32)),mint=kitAddress(fromHex(f.mint,32));
  for(const mode of ['close','escape'] as const){
    const child=spawn(resolve('tests/svm/target/debug/wallet'),[],{stdio:['pipe','pipe','pipe']});const pending:{resolve(v:any):void;reject(e:unknown):void}[]=[];let stderr='';child.stderr.on('data',b=>stderr+=b);
    createInterface({input:child.stdout}).on('line',line=>pending.shift()!.resolve(JSON.parse(line)));child.on('exit',code=>{for(const p of pending)p.reject(Error(`SBF ${code}: ${stderr}`));});
    const call=(c:object)=>new Promise<any>((resolve,reject)=>{pending.push({resolve,reject});child.stdin.write(JSON.stringify(c)+'\n');});
    const done=()=>new Promise<void>(resolve=>{child.on('exit',()=>resolve());child.stdin.end();});
    try{
      const blockhash=await call({kind:'blockhash'});let nonce=0;
      const accounts=async(operation:Operation|'finalize_escape')=>(await vaultAccounts({programId,pool,mint,payer:payer.publicKey,noteId:0,operation,tokenOwner:payer.publicKey,destinationOwner:kitAddress(new Uint8Array(32).fill(7)),treasuryOwner:kitAddress(new Uint8Array(32).fill(8)),nullifier:fromHex(f.auth.escape.public_inputs[11].slice(2),32)}));
      for(const operation of ['deposit',mode==='close'?'mutual_close':'initiate_escape'] as const){
        const payload=operation==='deposit'?encodeLayout2Args({operation,expectedId:0,expectedRoot:f.trees[0].public_inputs[1],expiry:BigInt(f.expiry),commitment:'0x'+f.commitment,amount:BigInt(f.deposit),tree:f.trees[0]}):encodeLayout2Args({operation,auth:f.auth[mode==='close'?'withdrawal':'escape'],tree:f.trees[1]});
        const plan=await buildUploadPlan({programId,pool,uploader:uploader.publicKey,rentPayer:payer.publicKey,feePayer:payer.publicKey,nonce:new Uint8Array(32).fill(++nonce),expires:3000003600n,operation,payload,financial:await accounts(operation),snapshot:{slot:100,sequence:0n}});
        for(const step of plan.steps){let recorded:Attempt|undefined;const attempt=await prepareAttempt(plan,step,blockhash,[payer,uploader],{save:async a=>{recorded=a;}});assert.equal(recorded!.wireHex,attempt.wireHex);await call({kind:'send',base64:Buffer.from(attempt.wireHex,'hex').toString('base64')});const receipt=await call({kind:'receipt',signature:attempt.signature});assert.equal(receipt.err,null,`${mode}/${step.kind}: ${JSON.stringify(receipt.err)}`);}
      }
      if(mode==='escape'){
        const pending=await call({kind:'snapshot',note_id:0});await call({kind:'clock',time:Number(pending.pending.deadline)});
        const attempt=await prepareFinalizationAttempt({programId,pool,noteId:0,feePayer:payer.publicKey,financial:await accounts('finalize_escape'),snapshot:{slot:100,sequence:2n}},blockhash,[payer],{save:async()=>{}});
        await call({kind:'send',base64:Buffer.from(attempt.wireHex,'hex').toString('base64')});assert.equal((await call({kind:'receipt',signature:attempt.signature})).err,null);
      }
      const final=await call({kind:'snapshot',note_id:0});assert.equal(final.note.status,'closed');const report=await call({kind:'report',name:`wasm-${mode}`});assert.equal(report.vault_micro_usdc,0);assert.equal(report.destination_micro_usdc,5000000);t.diagnostic(`WASM ${mode} SBF: ${report.rows.length} transactions, max ${report.max_cu} CU / ${report.max_transaction_bytes} bytes`);
    }finally{await done();}
  }
});
