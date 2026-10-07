/** Test fixtures using native Kit signers/codecs. Deterministic keys are public test entropy. */
import {address, createKeyPairSignerFromPrivateKeyBytes, partiallySignTransaction, type Address, type KeyPairSigner, type Transaction} from '@solana/kit';
import {addressBytes, addressFromBytes, encodeTransaction, decodeTransaction} from '../src/solana.ts';
export {addressBytes, addressFromBytes, encodeTransaction, decodeTransaction};
export type FixtureSigner = KeyPairSigner & {secretKey:Uint8Array};
export function kitAddress(value:string|Uint8Array):Address {return typeof value==='string'?address(value):addressFromBytes(value);}
export async function fixtureSigner(seed:Uint8Array):Promise<FixtureSigner> {
  const signer=await createKeyPairSignerFromPrivateKeyBytes(seed);
  return {...signer,secretKey:Uint8Array.from([...seed,...addressBytes(signer.address)])};
}
export async function signWith<T extends Transaction>(transaction:T,signers:readonly KeyPairSigner[]):Promise<T> {
  return partiallySignTransaction(signers.map(signer=>signer.keyPair),transaction);
}
export function v0Message(transaction:Transaction) {
  const decoded=readMessage(transaction);
  if(decoded.version!==0)throw Error('fixture expected v0 transaction');
  return {...decoded,instructions:decoded.instructions.map(ix=>({...ix,data:new Uint8Array(ix.data??[]),accountIndices:ix.accountIndices??[]}))};
}
import {transactionMessage as readMessage} from '../src/solana.ts';
