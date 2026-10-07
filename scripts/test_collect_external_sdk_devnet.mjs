/** Offline collector validation; synthetic signatures do not establish live acceptance. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AccountRole, createKeyPairSignerFromPrivateKeyBytes, getAddressDecoder, getAddressEncoder, getCompiledTransactionMessageDecoder, getTransactionEncoder, getSignatureFromTransaction, partiallySignTransaction} from '@solana/kit';
const keyBytes = value => Buffer.from(getAddressEncoder().encode(value));
import bs58 from 'bs58';
import {compileV0,discriminator,TOKEN_PROGRAM,buildUploadPlan,vaultAccounts,financialMetas} from '@zkapi/solana-sdk/transport';
import {validatePublicReports,verifyTransactionRecord,decodeTokenAccount,publicRpc,verifyLifecycleInstructions,verifyTokenMovements} from './collect_external_sdk_devnet.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const pair=await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(17)), pool=(await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(18))).address;
const program=(await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(19))).address,mint=(await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(20))).address;
const manifest={program_id:program,pool:pool,mint:mint};
async function fixture(){
  const ix={programAddress:program,accounts:[{address:pool,role:AccountRole.WRITABLE}],data:Buffer.from(await discriminator('deposit_compact_v1'))};
  const tx=await partiallySignTransaction([pair.keyPair],compileV0(ix,pair.address,getAddressDecoder().decode(new Uint8Array(32).fill(21))));const wire=getTransactionEncoder().encode(tx);
  const observed={signature:getSignatureFromTransaction(tx),wireSha256:sha(wire),bytes:wire.length,sendRecordedAt:'2026-10-07T00:00:00.000Z'};
  const receipt={signature:observed.signature,slot:17,kind:'deposit'};
  const names=getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts.length;
  const chain={slot:17,blockTime:1791324000,transaction:[Buffer.from(wire).toString('base64'),'base64'],meta:{err:null,fee:5000,computeUnitsConsumed:100,loadedAddresses:{readonly:[],writable:[]},preBalances:Array(names).fill(10000),postBalances:Array(names).fill(5000),preTokenBalances:[],postTokenBalances:[]}};
  return {observed,receipt,chain};
}
test('exact finalized signed bytes match saved dispatch; digest, signature, CU and Pool substitutions are rejected',async()=>{
  const f=await fixture();assert.equal((await verifyTransactionRecord(f.chain,f.observed,f.receipt,manifest,pair.address)).exact_recorded_wire_matches,true);
  await assert.rejects(verifyTransactionRecord(f.chain,{...f.observed,wireSha256:'00'.repeat(32)},f.receipt,manifest));
  await assert.rejects(verifyTransactionRecord({...f.chain,slot:18},f.observed,f.receipt,manifest));
  await assert.rejects(verifyTransactionRecord({...f.chain,meta:{...f.chain.meta,computeUnitsConsumed:1000001}},f.observed,f.receipt,manifest));
  await assert.rejects(verifyTransactionRecord(f.chain,f.observed,f.receipt,{...manifest,pool:mint}));
  const wire=Buffer.from(f.chain.transaction[0],'base64');wire[1]^=1;
  const changed={...f.observed,wireSha256:sha(wire),signature:bs58.encode(wire.subarray(1,65))};
  await assert.rejects(verifyTransactionRecord({...f.chain,transaction:[wire.toString('base64'),'base64']},changed,{...f.receipt,signature:changed.signature},manifest));
});
test('cumulative reports do not double count sends; changed dispatch, duplicate and still-active outcomes fail',async()=>{
  const f=await fixture();const value={command:'withdraw',completedAt:'2026-10-07T00:01:00.000Z',status:{noteId:'note',mode:'direct_openrouter',wallet:'closed',session:null,walletOperation:null},authSends:0,inferenceSends:0,transactions:[f.observed],finalized:[f.receipt]};
  const reports=[{name:'deposit-result.json',sha256:'11'.repeat(32),value:{...value,command:'deposit',completedAt:'2026-10-07T00:00:00.000Z',status:{...value.status,wallet:'active'}}},{name:'withdraw-result.json',sha256:'22'.repeat(32),value}];
  assert.equal(validatePublicReports(reports).dispatch.size,1);
  const altered=structuredClone(reports);altered[0].value.transactions=[{...altered[0].value.transactions[0],wireSha256:'00'.repeat(32)}];assert.throws(()=>validatePublicReports(altered));
  assert.throws(()=>validatePublicReports([{...reports[1],value:{...value,transactions:[f.observed,f.observed]}}]));
  assert.throws(()=>validatePublicReports([reports[0]]));
});
test('SPL account bytes require exact token owner, mint and initialized state',()=>{
  const bytes=Buffer.alloc(165);keyBytes(mint).copy(bytes,0);keyBytes(pair.address).copy(bytes,32);bytes.writeBigUInt64LE(2000000n,64);bytes[108]=1;
  const account={owner:TOKEN_PROGRAM,executable:false,data:[bytes.toString('base64'),'base64']};
  assert.equal(decodeTokenAccount(account,mint,pair.address),'2000000');
  assert.throws(()=>decodeTokenAccount(account,pool,pair.address));
  assert.throws(()=>decodeTokenAccount(account,mint,pool));
  bytes[108]=2;assert.throws(()=>decodeTokenAccount({...account,data:[bytes.toString('base64'),'base64']},mint,pair.address));
});
test('collector transport rejects write RPCs before dispatch and sends no credentials or redirects',async()=>{
  let calls=0;const read=publicRpc('http://127.0.0.1:4174',async(url,init)=>{calls++;assert.equal(url,'http://127.0.0.1:4174/rpc');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.deepEqual(Object.keys(init.headers).sort(),['Content-Type','Origin']);const request=JSON.parse(init.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:'public'}));});
  await assert.rejects(read('sendTransaction',[]));await assert.rejects(read('requestAirdrop',[]));assert.equal(calls,0);
  assert.equal(await read('getGenesisHash',[]),'public');assert.equal(calls,1);
  assert.throws(()=>publicRpc('https://remote.invalid'));
});

test('public mutual-close payload reconstructs amount and rejects relabelled operation, changed chunks and destination',async()=>{
  const deposit=await vaultAccounts({programId:program,pool,mint,noteId:0,payer:pair.address,tokenOwner:pair.address,operation:'deposit'});
  const compact=Buffer.alloc(436);compact.writeBigUInt64LE(2000000n,76);compact.writeBigUInt64LE(1791417600n,36);
  const payload=Buffer.alloc(1312);payload.writeBigUInt64BE(1900000n,9*32+24);
  const withdrawal=await vaultAccounts({programId:program,pool,mint,noteId:0,payer:pair.address,destinationOwner:pair.address,treasuryOwner:pair.address,operation:'mutual_close',nullifier:new Uint8Array(32)});
  const plan=await buildUploadPlan({programId:program,pool,uploader:pair.address,rentPayer:pair.address,feePayer:pair.address,nonce:new Uint8Array(32),expires:1000n,operation:'mutual_close',payload,financial:withdrawal,snapshot:{slot:1,sequence:0n}});
  const names={create:'create_payload',append:'append_payload',seal:'seal_payload',execute:'execute_payload'};
  const transactions=[{instruction:'deposit_compact_v1',fee_payer:pair.address,instructionDetail:{data:Buffer.concat([Buffer.from(await discriminator('deposit_compact_v1')),compact]),accounts:[...financialMetas(deposit),{address:pair.address}].map(meta=>meta.address)}},
    ...plan.steps.map(step=>({instruction:names[step.kind],fee_payer:pair.address,instructionDetail:{data:Buffer.from(step.instruction.data),accounts:step.instruction.accounts.map(meta=>meta.address)}}))];
  assert.equal(verifyLifecycleInstructions(transactions).withdrawal_payload_return_micro_usdc,'1900000');
  const previous=transactions[1].instructionDetail.data[8];transactions[1].instructionDetail.data[8]=2;assert.throws(()=>verifyLifecycleInstructions(transactions));transactions[1].instructionDetail.data[8]=previous;
  transactions[2].instructionDetail.data[16]^=1;assert.throws(()=>verifyLifecycleInstructions(transactions));transactions[2].instructionDetail.data[16]^=1;
  transactions.at(-1).instructionDetail.accounts[12]=pool;assert.throws(()=>verifyLifecycleInstructions(transactions));
});

test('deposit and withdrawal token deltas match decoded amounts, including a shared wallet/treasury ATA',()=>{
  const lifecycle={deposit_micro_usdc:'2000000',withdrawal_payload_return_micro_usdc:'1999900',source_token_account:'wallet',vault_token_account:'vault',destination_token_account:'wallet',treasury_token_account:'wallet'};
  const row=(address,before,after)=>({address,before_micro_usdc:before,after_micro_usdc:after,delta_micro_usdc:String(BigInt(after)-BigInt(before))});
  const transactions=[{token_balances:[row('wallet','36010000','34010000'),row('vault','0','2000000')]},{token_balances:[]},{token_balances:[row('wallet','34010000','36010000'),row('vault','2000000','0')]}];
  const result=verifyTokenMovements(transactions,lifecycle);assert.equal(result.combined_destination_and_treasury,true);assert.equal(result.wallet_after_withdrawal_micro_usdc,'36010000');
  transactions.at(-1).token_balances[0]=row('wallet','34010000','36009999');assert.throws(()=>verifyTokenMovements(transactions,lifecycle));
  transactions.at(-1).token_balances=[row('wallet','34010000','36009900'),row('vault','2000000','0'),row('treasury','0','100')];
  assert.equal(verifyTokenMovements(transactions,{...lifecycle,treasury_token_account:'treasury'}).combined_destination_and_treasury,false);
  assert.throws(()=>verifyTokenMovements(transactions,{...lifecycle,withdrawal_payload_return_micro_usdc:'1999800',treasury_token_account:'treasury'}));
});
