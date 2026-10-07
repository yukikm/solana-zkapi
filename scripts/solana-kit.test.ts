/** Offline Kit script adapters: lossless RPC integers and exact signed wires. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getBase58Decoder} from '@solana/kit';
import {compileV0,signV0,verifySignatures} from '../packages/sdk/src/transport.ts';
import {createSolanaRpcWithFetch,encodeTransaction,transactionSignature} from '../packages/sdk/src/solana.ts';
import {getAccountAtContext,getFinalizedTransaction,getSignerSecretBytes,parseAddress,signerFromSecret,signerWallet,zeroSelfTransfer} from './solana-kit.ts';

const key=parseAddress(new Uint8Array(32).fill(17));
test('native Kit operational signer preserves the 64-byte Solana keypair and validates imported public key',async()=>{
  const seed=new Uint8Array(32).fill(79), signer=await signerFromSecret(seed,true), bytes=await getSignerSecretBytes(signer);
  assert.equal(bytes.length,64);assert.deepEqual(bytes.slice(0,32),seed);
  assert.equal((await signerFromSecret(bytes)).address,signer.address);
  bytes[63]^=1;await assert.rejects(signerFromSecret(bytes));
});

test('operational account observation uses explicit finalized minimum and preserves full u64 balances',async()=>{
  let calls=0, slot=12;
  const rpc=createSolanaRpcWithFetch('https://rpc.invalid',async(_url,init)=>{
    calls++;const request=JSON.parse(String(init?.body));
    assert.equal(request.method,'getAccountInfo');assert.equal(request.params[1].commitment??'finalized','finalized');
    assert.equal(request.params[1].minContextSlot,11);assert.equal(request.params[1].encoding,'base64');
    return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"context":{"slot":${slot}},"value":{"owner":"${key}","executable":false,"lamports":18446744073709551615,"data":["AQID","base64"]}}}`);
  });
  const account=await getAccountAtContext(rpc,key,11);
  assert.equal(account.value!.lamports,0xffffffffffffffffn);assert.deepEqual(account.value!.data,Buffer.from([1,2,3]));
  slot=10;await assert.rejects(getAccountAtContext(rpc,key,11),/stale/);assert.equal(calls,2);
});

test('operational finalized receipt returns exact native Kit transaction and refuses mismatched signature or unsafe slot',async()=>{
  const signer=await signerFromSecret(new Uint8Array(32).fill(80));
  const transaction=await signV0(compileV0(zeroSelfTransfer(signer.address),signer.address,key),[signerWallet(signer)]);
  const wire=encodeTransaction(transaction),id=transactionSignature(transaction);let slot='12',calls=0;
  const rpc=createSolanaRpcWithFetch('https://rpc.invalid',async(_url,init)=>{
    calls++;const request=JSON.parse(String(init?.body));assert.equal(request.method,'getTransaction');
    assert.equal(request.params[1].encoding,'base64');assert.equal(request.params[1].maxSupportedTransactionVersion,0);
    return new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"slot":${slot},"version":0,"transaction":["${Buffer.from(wire).toString('base64')}","base64"],"meta":{"err":null,"fee":5000,"computeUnitsConsumed":450}}}`);
  });
  const receipt=await getFinalizedTransaction(rpc,id);assert.ok(receipt);
  assert.deepEqual(encodeTransaction(receipt.transaction),wire);await verifySignatures(receipt.transaction);
  assert.equal(receipt.slot,12);assert.equal(receipt.meta!.fee,5000);assert.equal(receipt.meta!.computeUnitsConsumed,450);
  const other=getBase58Decoder().decode(new Uint8Array(64).fill(1));
  await assert.rejects(getFinalizedTransaction(rpc,other),/signature mismatch/);
  slot='9007199254740993';await assert.rejects(getFinalizedTransaction(rpc,id),/transaction slot/);assert.equal(calls,3);
});
