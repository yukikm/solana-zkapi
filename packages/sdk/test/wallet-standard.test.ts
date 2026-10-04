import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair,PublicKey,SystemProgram,VersionedTransaction } from '@solana/web3.js';
import { walletStandardAdapter,type StandardWallet,type StandardAccount } from '../src/wallet-standard.ts';
import { compileV0,signV0 } from '../src/transport.ts';
test('explicit Wallet Standard v0 selection signs exact transaction and fails closed on chain/version/disconnect',async()=>{
  const pair=Keypair.generate(),chain='solana:devnet';const account:StandardAccount={address:pair.publicKey.toBase58(),publicKey:pair.publicKey.toBytes(),chains:[chain],features:['solana:signTransaction']};
  const wallet:StandardWallet={accounts:[account],features:{'solana:signTransaction':{version:'1.0.0',supportedTransactionVersions:[0],async signTransaction(...inputs){assert.equal(inputs.length,1);assert.equal(inputs[0].account,account);assert.equal(inputs[0].chain,chain);const tx=VersionedTransaction.deserialize(inputs[0].transaction);tx.sign([pair]);return [{signedTransaction:tx.serialize()}];}}}};
  const adapter=walletStandardAdapter(wallet,account,chain),tx=compileV0(SystemProgram.transfer({fromPubkey:pair.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1}),pair.publicKey,new PublicKey(new Uint8Array(32).fill(8)).toBase58());
  assert.equal((await signV0(tx,[adapter])).version,0);
  assert.throws(()=>walletStandardAdapter(wallet,account,'solana:mainnet'),/v0/);
  wallet.features['solana:signTransaction']!.supportedTransactionVersions=['legacy'];assert.throws(()=>walletStandardAdapter(wallet,account,chain),/v0/);
  wallet.accounts=[];await assert.rejects(adapter.signTransaction(tx),/disconnected/);
});
