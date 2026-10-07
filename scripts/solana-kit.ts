/** Native Kit helpers for operational scripts. No retry, implicit send, or
 * compatibility classes; returned transactions remain Kit Transaction values. */
import { address, createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes,
  partiallySignTransaction, signature, type Address, type KeyPairSigner, type Rpc,
  type SolanaRpcApi } from '@solana/kit';
import { addressBytes, addressFromBytes, decodeTransaction, transactionSignature } from '../packages/sdk/src/solana.ts';
import { decodeRpcAccount, safeRpcNumber } from '../packages/sdk/src/solana-rpc.ts';
import type { V0Wallet } from '../packages/sdk/src/transport.ts';

export { addressBytes, addressFromBytes, decodeTransaction, safeRpcNumber };
export function parseAddress(value: string | Uint8Array): Address { return typeof value==='string'?address(value):addressFromBytes(value); }
export function signerFromSecret(value: Uint8Array, extractable = false): Promise<KeyPairSigner> {
  const bytes = new Uint8Array(value);
  return bytes.length===32?createKeyPairSignerFromPrivateKeyBytes(bytes,extractable):createKeyPairSignerFromBytes(bytes,extractable);
}
export async function getSignerSecretBytes(signer: KeyPairSigner): Promise<Uint8Array> {
  const jwk=await crypto.subtle.exportKey('jwk',signer.keyPair.privateKey);
  if(typeof jwk.d!=='string')throw Error('private Ed25519 key unavailable');
  const seed=Buffer.from(jwk.d,'base64url');if(seed.length!==32)throw Error('private Ed25519 key width');
  return new Uint8Array(Buffer.concat([seed,addressBytes(signer.address)]));
}
export function signerWallet(signer: KeyPairSigner): V0Wallet {
  return {publicKey:signer.address,supportedTransactionVersions:new Set([0]),
    signTransaction:transaction=>partiallySignTransaction([signer.keyPair],transaction)};
}
export async function getAccountAtContext(rpc:Rpc<SolanaRpcApi>,key:Address,minimumSlot=0) {
  if(!Number.isSafeInteger(minimumSlot)||minimumSlot<0)throw Error('invalid minimum account slot');
  const result=await rpc.getAccountInfo(key,{commitment:'finalized',encoding:'base64',minContextSlot:BigInt(minimumSlot)}).send();
  const slot=safeRpcNumber(result.context.slot,'account slot');if(slot<minimumSlot)throw Error('stale finalized account');
  const value=decodeRpcAccount(result.value);
  return {context:{slot},value:value&&{...value,data:Buffer.from(value.data)}};
}
export async function getAccount(rpc:Rpc<SolanaRpcApi>,key:Address) { return (await getAccountAtContext(rpc,key)).value; }
export async function getFinalizedTransaction(rpc:Rpc<SolanaRpcApi>,id:string) {
  const result=await rpc.getTransaction(signature(id),{commitment:'finalized',encoding:'base64',maxSupportedTransactionVersion:0}).send();
  if(!result)return null;
  if(result.transaction[1]!=='base64')throw Error('invalid transaction encoding');
  const wire=Buffer.from(result.transaction[0],'base64');if(wire.toString('base64')!==result.transaction[0])throw Error('invalid transaction base64');
  const transaction=decodeTransaction(wire),slot=safeRpcNumber(result.slot,'transaction slot');
  if(transactionSignature(transaction)!==id)throw Error('transaction signature mismatch');
  const meta=result.meta&&{...result.meta,fee:safeRpcNumber(result.meta.fee,'transaction fee'),
    computeUnitsConsumed:result.meta.computeUnitsConsumed===undefined?undefined:safeRpcNumber(result.meta.computeUnitsConsumed,'compute units')};
  return {...result,transaction,slot,meta};
}
export async function getFinalizedBlock(rpc:Rpc<SolanaRpcApi>,slot:number) {
  if(!Number.isSafeInteger(slot)||slot<0)throw Error('invalid block slot');
  return rpc.getBlock(BigInt(slot),{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:1}).send();
}
export async function latestBlockhash(rpc:Rpc<SolanaRpcApi>) {
  const {value}=await rpc.getLatestBlockhash({commitment:'finalized'}).send();
  return {...value,lastValidBlockHeight:safeRpcNumber(value.lastValidBlockHeight,'last valid block height')};
}
export async function tokenBalance(rpc:Rpc<SolanaRpcApi>,account:Address) {
  const result=await rpc.getTokenAccountBalance(account,{commitment:'finalized'}).send();
  return {...result,context:{slot:safeRpcNumber(result.context.slot,'token balance slot')}};
}
/** System instruction 2 (transfer), restricted to the explicit smoke's zero
 * lamport self-transfer. Wire bytes match the Solana System Program ABI. */
export function zeroSelfTransfer(payer:Address) {
  const data=new Uint8Array(12);new DataView(data.buffer).setUint32(0,2,true);
  return {programAddress:address('11111111111111111111111111111111'),
    accounts:[{address:payer,role:3 as const},{address:payer,role:1 as const}],data};
}
