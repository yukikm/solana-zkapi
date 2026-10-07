/** Adapter for an explicitly selected and connected Wallet Standard account.
 * Wallet discovery/connect UI stays with the host; v0 support is mandatory. */
import { address } from '@solana/kit';
import { addressFromBytes, encodeTransaction, decodeTransaction } from './solana.ts';
import type { V0Wallet } from './transport.ts';
export interface StandardAccount { address:string;publicKey:Uint8Array;chains:readonly string[];features:readonly string[] }
export interface StandardWallet {
  accounts:readonly StandardAccount[];
  features:Record<string,unknown> & {'solana:signTransaction'?:{
    version:string;supportedTransactionVersions:readonly ('legacy'|0)[];
    signTransaction(...inputs:{transaction:Uint8Array;account:StandardAccount;chain:string}[]):Promise<readonly {signedTransaction:Uint8Array}[]>;
  }};
}
export function walletStandardAdapter(wallet:StandardWallet,account:StandardAccount,chain:string):V0Wallet{
  const publicKey=addressFromBytes(new Uint8Array(account.publicKey)),feature=wallet.features['solana:signTransaction'];
  if(publicKey!==address(account.address)||!wallet.accounts.includes(account)||!account.chains.includes(chain)||!account.features.includes('solana:signTransaction')||!feature?.supportedTransactionVersions.includes(0))throw Error('selected Wallet Standard account must support this chain and v0');
  return {publicKey,supportedTransactionVersions:new Set([0]),async signTransaction(transaction){
    if(!wallet.accounts.includes(account)||!account.chains.includes(chain))throw Error('selected wallet account disconnected');
    const results=await feature.signTransaction({transaction:encodeTransaction(transaction),account,chain});
    if(results.length!==1||!(results[0].signedTransaction instanceof Uint8Array))throw Error('invalid Wallet Standard signing response');
    return decodeTransaction(new Uint8Array(results[0].signedTransaction));
  }};
}
