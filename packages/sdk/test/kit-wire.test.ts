/** Immutable pre-migration wires captured before replacing the transport. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {address, getCompiledTransactionMessageEncoder, type TransactionMessageBytes, type Transaction} from '@solana/kit';
import {fixtureSigner,signWith} from './kit-helpers.ts';
import {decodeTransaction,encodeTransaction,transactionMessage,transactionSignature,createSolanaRpcWithFetch} from '../src/solana.ts';
import {compileV0,restorePlan,restoreInlineDepositPlan,closePayload,finalizeEscape,verifySignatures,recoverAttempt,recoverFinalizationAttempt,recoverInlineDepositAttempt,signV0,connectionTransport,type V0Wallet,type FinancialAccounts,type Attempt,type FinalizationAttempt,type InlineDepositAttempt,type TransportRpc} from '../src/transport.ts';
const golden=JSON.parse(readFileSync(new URL('../../../tests/fixtures/kit/transport-wire-v1.json',import.meta.url),'utf8'));
const signers=await Promise.all([1,10,11,12,13].map(seed=>fixtureSigner(new Uint8Array(32).fill(seed))));
const wallets:V0Wallet[]=signers.map(pair=>({publicKey:pair.address,supportedTransactionVersions:new Set([0]),signTransaction:tx=>signWith(tx,[pair])}));
for(const [index,entry] of golden.entries.entries()) test(`Kit preserves signed wire and old-journal recovery ${index+1}: ${entry.operation}/${entry.kind}`,async()=>{
  let tx:Transaction,attempt:Attempt|FinalizationAttempt|InlineDepositAttempt;
  const wire=Buffer.from(entry.wireHex,'hex'),base={wireHex:entry.wireHex,blockhash:golden.blockhash.blockhash,lastValidBlockHeight:golden.blockhash.lastValidBlockHeight,signature:transactionSignature(decodeTransaction(wire))};
  if(entry.kind==='deposit_inline'){
    const plan=await restoreInlineDepositPlan(entry.plan);tx=compileV0(plan.steps[0].instruction,plan.feePayer,base.blockhash,plan.priorityFeeMicroLamports);
    attempt={...base,schema:2,kind:'deposit_inline',transport:'v0_inline_deposit_v1',plan:entry.plan};
  }else if(entry.kind==='finalize'){
    const accounts=Object.fromEntries(Object.entries(entry.financial).map(([name,value])=>[name,address(value as string)])) as FinancialAccounts;
    const reference=golden.entries[0].plan,step=await finalizeEscape(address(reference.programId),accounts,0);tx=compileV0(step.instruction,address(reference.feePayer),base.blockhash);
    attempt={...base,schema:1,kind:'finalize',finalization:{programId:reference.programId,pool:reference.pool,noteId:0,feePayer:reference.feePayer,financial:entry.financial,snapshotSlot:27,snapshotSequence:'3'}};
  }else{
    const plan=await restorePlan(entry.plan);assert.equal(plan.buffer,entry.buffer);assert.equal(plan.bump,entry.bump);
    const step=entry.kind==='close'?await closePayload(plan):plan.steps.find(step=>step.kind===entry.kind&&step.offset===entry.offset)!;
    tx=compileV0(step.instruction,plan.feePayer,base.blockhash,plan.priorityFeeMicroLamports);
    attempt={...base,schema:1,kind:entry.kind,planDigest:Buffer.from(plan.digest).toString('hex'),buffer:entry.buffer,plan:entry.plan,...(entry.kind==='close'?{closer:entry.plan.uploader}:{})};
  }
  assert.equal(Buffer.from(tx.messageBytes).toString('hex'),entry.messageHex);
  const signed=await signV0(tx,wallets.filter(wallet=>Object.hasOwn(tx.signatures,wallet.publicKey)));
  assert.equal(Buffer.from(encodeTransaction(signed)).toString('hex'),entry.wireHex);
  await verifySignatures(decodeTransaction(wire));
  const rpc:TransportRpc={signatureStatus:async()=>null,finalizedReceipt:async()=>({message:new Uint8Array(signed.messageBytes),signature:base.signature,err:null,slot:80}),finalizedBlockHeight:async()=>50,sendRawTransaction:async()=>{throw Error('old journal must never send');}};
  const recovered=attempt.kind==='deposit_inline'?await recoverInlineDepositAttempt(attempt,rpc):attempt.kind==='finalize'?await recoverFinalizationAttempt(attempt as FinalizationAttempt,rpc):await recoverAttempt(attempt as Attempt,rpc);
  assert.deepEqual(recovered,{state:'finalized',slot:80});
});
test('Kit signature map identity, ordering, duplicate accounts and canonical encoding are checked',async()=>{
  const original=decodeTransaction(Buffer.from(golden.entries[0].wireHex,'hex')),entries=Object.entries(original.signatures);
  assert.ok(entries.length>1);
  assert.deepEqual(encodeTransaction({...original,signatures:Object.fromEntries([...entries].reverse())}),encodeTransaction(original));
  const substituted=Object.fromEntries(entries.map(([key,signature],i)=>[i===0?signers[2].address:key,signature]));
  assert.throws(()=>encodeTransaction({...original,signatures:substituted}),/signature map/);
  await assert.rejects(verifySignatures({...original,signatures:substituted}),/signature count|signature map/);
  const swapped=Object.fromEntries(entries.map(([key],i)=>[key,entries[(i+1)%entries.length][1]]));
  await assert.rejects(verifySignatures({...original,signatures:swapped}),/invalid wallet signature/);
  assert.throws(()=>decodeTransaction(Uint8Array.from([...encodeTransaction(original),0])),/noncanonical|codec|length/);
  const message=transactionMessage(original),duplicates=[...message.staticAccounts];duplicates[duplicates.length-1]=duplicates[0];
  const duplicate={...original,messageBytes:getCompiledTransactionMessageEncoder().encode({...message,staticAccounts:duplicates}) as TransactionMessageBytes};
  assert.throws(()=>encodeTransaction(duplicate),/signature map/);
  const badHeader={...original,messageBytes:getCompiledTransactionMessageEncoder().encode({...message,header:{...message.header,numReadonlySignerAccounts:message.header.numSignerAccounts+1}}) as TransactionMessageBytes};
  assert.throws(()=>encodeTransaction(badHeader),/account header/);
});
test('custom Kit RPC keeps full u64 precision and exact explicit commitments',async()=>{
  const requests:any[]=[];
  const rpc=createSolanaRpcWithFetch('http://localhost:8899',async(_url,init)=>{
    const payload=JSON.parse(String(init!.body));requests.push(payload);
    return new Response(`{"jsonrpc":"2.0","id":"${payload.id}","result":{"context":{"slot":9007199254740993},"value":18446744073709551615}}`);
  });
  const response=await rpc.getBalance(signers[0].address,{commitment:'finalized'}).send();
  assert.equal(response.context.slot,9007199254740993n);assert.equal(response.value,18446744073709551615n);
  assert.equal(requests[0].params[1].commitment,'finalized');assert.equal(requests.length,1);
});

test('Kit RPC finalized base64 receipts retain Anchor error codes and reject unsafe slots',async()=>{
  const entry=golden.entries.find((item:any)=>item.kind==='execute'&&item.operation==='deposit');
  const signed=decodeTransaction(Buffer.from(entry.wireHex,'hex'));
  let slot='80';const rpc=createSolanaRpcWithFetch('http://localhost:8899',async(_url,init)=>{
    const payload=JSON.parse(String(init!.body));
    let result=payload.method==='getSignatureStatuses'?'{"context":{"slot":80},"value":[null]}':`{"slot":${slot},"meta":{"err":{"InstructionError":[1,{"Custom":6006}]}},"transaction":["${Buffer.from(entry.wireHex,'hex').toString('base64')}","base64"]}`;
    return new Response(`{"jsonrpc":"2.0","id":"${payload.id}","result":${result}}`);
  });
  const plan=await restorePlan(entry.plan),attempt:Attempt={schema:1,kind:'execute',wireHex:entry.wireHex,blockhash:golden.blockhash.blockhash,lastValidBlockHeight:100,signature:transactionSignature(signed),buffer:entry.buffer,plan:entry.plan,planDigest:Buffer.from(plan.digest).toString('hex')};
  assert.deepEqual(await recoverAttempt(attempt,connectionTransport(rpc)),{state:'rejected',slot:80,error:{InstructionError:[1,{Custom:6006}]},needsNewProof:true});
  slot='9007199254740993';assert.deepEqual(await recoverAttempt(attempt,connectionTransport(rpc)),{state:'unknown'});
});
