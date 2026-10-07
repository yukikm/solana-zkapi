/** One deliberate 0.5 Devnet SOL fee-payer transfer, durably saved before send.
 * An existing attempt is observed only. No exact-signature resend or rebase. */
import assert from 'node:assert/strict';
import {readFile,open,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {createSolanaRpc,type Base64EncodedWireTransaction,type TransactionMessageBytesBase64} from '@solana/kit';
import bs58 from 'bs58';
import {signerFromSecret,signerWallet,parseAddress,latestBlockhash,getFinalizedTransaction} from './solana-kit.ts';
import {SYSTEM_PROGRAM,encodeTransaction,decodeTransaction,transactionSignature,transactionBlockhash} from '../packages/sdk/src/solana.ts';
import {compileV0,signV0,verifySignatures} from '../packages/sdk/src/transport.ts';

const amount=500_000_000n, genesis='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
async function save(path:string,value:unknown){
  const file=await open(path,'wx',0o600);
  try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
  const directory=await open(resolve(path,'..'),'r');try{await directory.sync();}finally{await directory.close();}
}
async function exists(path:string){try{return(await stat(path)).isFile();}catch{return false;}}
async function main(){
  assert.equal(process.argv.length,3,'explicit prepared fee-payer directory required');
  const directory=resolve(process.argv[2]), prepared=JSON.parse(await readFile(join(directory,'preparation.json'),'utf8'));
  const destination=parseAddress(prepared.payer),owner=parseAddress(prepared.initializer);
  const endpoint=process.env.SOLANA_DEVNET_RPC;assert.ok(endpoint);assert.equal(new URL(endpoint).protocol,'https:');
  const rpc=createSolanaRpc(endpoint);assert.equal(await rpc.getGenesisHash().send(),genesis);
  const path=join(directory,'funding-attempt.json');
  const data=Buffer.alloc(12);data.writeUInt32LE(2,0);data.writeBigUInt64LE(amount,4);
  const instruction={programAddress:SYSTEM_PROGRAM,accounts:[{address:owner,role:3 as const},{address:destination,role:1 as const}],data};
  let record:any;
  if(await exists(path))record=JSON.parse(await readFile(path,'utf8'));
  else{
    const recipientBefore=(await rpc.getBalance(destination,{commitment:'finalized'}).send()).value;
    assert.equal(recipientBefore,0n,'new fee payer only');
    const p=process.env.WALLET_PRIVATE_KEY_PATH??process.env.SOLANA_TEST_WALLET_PATH;assert.ok(p);
    const text=(await readFile(p.replace(/^~(?=\/)/,homedir()),'utf8')).trim();let value:any;try{value=JSON.parse(text);}catch{value=text;}
    const signer=await signerFromSecret(typeof value==='string'?bs58.decode(value):Uint8Array.from(value.secretKey??value),true);
    assert.equal(signer.address,owner);const block=await latestBlockhash(rpc);
    const priorityFeeMicroLamports=1000n;
    const tx=await signV0(compileV0(instruction,owner,block.blockhash,priorityFeeMicroLamports),[signerWallet(signer)]);await verifySignatures(tx);
    const fee=(await rpc.getFeeForMessage(Buffer.from(tx.messageBytes).toString('base64') as TransactionMessageBytesBase64,{commitment:'finalized'}).send()).value;
    assert.ok(fee!==null&&fee>0n&&fee<=10_000n);const wire=encodeTransaction(tx);assert.ok(wire.length<=1232);
    record={schema:1,source:owner,destination,amount_lamports:amount.toString(),genesis,
      signature:transactionSignature(tx),wire_base64:Buffer.from(wire).toString('base64'),wire_sha256:hash(wire),
      last_valid_block_height:block.lastValidBlockHeight,priority_fee_micro_lamports:priorityFeeMicroLamports.toString(),
      prepared_at:new Date().toISOString(),max_send_attempts:1};
    await save(path,record);
    // Record possible send before the call; a lost response never permits retry.
    await save(join(directory,'funding-send-intent.json'),{signature:record.signature,recorded_at:new Date().toISOString()});
    assert.equal(await rpc.sendTransaction(record.wire_base64 as Base64EncodedWireTransaction,
      {encoding:'base64',skipPreflight:false,maxRetries:0n,preflightCommitment:'finalized'}).send(),record.signature);
  }
  assert.equal(record.source,owner);assert.equal(record.destination,destination);assert.equal(record.amount_lamports,amount.toString());
  assert.equal(record.genesis,genesis);const tx=decodeTransaction(Buffer.from(record.wire_base64,'base64'));await verifySignatures(tx);
  const savedPriority=BigInt(record.priority_fee_micro_lamports??'0');assert.ok(savedPriority===0n||savedPriority===1000n);
  assert.deepEqual(tx.messageBytes,compileV0(instruction,owner,transactionBlockhash(tx),savedPriority).messageBytes);
  assert.equal(transactionSignature(tx),record.signature);assert.equal(hash(encodeTransaction(tx)),record.wire_sha256);
  for(let attempt=0;attempt<100;attempt++){
    const finalized=await getFinalizedTransaction(rpc,record.signature);
    if(finalized){
      assert.equal(finalized.meta?.err,null);assert.ok(finalized.meta!.fee<=10_000);
      assert.deepEqual(finalized.transaction.messageBytes,tx.messageBytes);
      const receipt={schema:1,signature:record.signature,source:owner,destination,amount_lamports:amount.toString(),
        slot:finalized.slot,fee_lamports:String(finalized.meta!.fee),wire_sha256:record.wire_sha256,automatic_resends:0};
      if(!await exists(join(directory,'funding-receipt.json')))await save(join(directory,'funding-receipt.json'),receipt);
      console.log(JSON.stringify(receipt));return;
    }
    await new Promise(r=>setTimeout(r,1500));
  }
  throw Error('saved send remains unresolved; read-only observation required');
}
main().catch(()=>{console.error('Devnet fee funding stopped; retain saved attempt and inspect privately. No automatic resend.');process.exitCode=1;});
