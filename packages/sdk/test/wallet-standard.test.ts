import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountRole } from '@solana/kit';
import { fixtureSigner, signWith, kitAddress, addressBytes, encodeTransaction, decodeTransaction } from './kit-helpers.ts';
import { SYSTEM_PROGRAM, transactionMessage } from '../src/solana.ts';
import { concat,u32,u64 } from '../src/layout2.ts';
import { walletStandardAdapter,type StandardWallet,type StandardAccount } from '../src/wallet-standard.ts';
import { compileV0,signV0 } from '../src/transport.ts';
test('explicit Wallet Standard v0 selection signs exact transaction and fails closed on chain/version/disconnect',async()=>{
  const pair=await fixtureSigner(crypto.getRandomValues(new Uint8Array(32))),chain='solana:devnet';const account:StandardAccount={address:pair.address,publicKey:addressBytes(pair.address),chains:[chain],features:['solana:signTransaction']};
  const wallet:StandardWallet={accounts:[account],features:{'solana:signTransaction':{version:'1.0.0',supportedTransactionVersions:[0],async signTransaction(...inputs){assert.equal(inputs.length,1);assert.equal(inputs[0].account,account);assert.equal(inputs[0].chain,chain);const tx=await signWith(decodeTransaction(inputs[0].transaction),[pair]);return [{signedTransaction:encodeTransaction(tx)}];}}}};
  const adapter=walletStandardAdapter(wallet,account,chain),tx=compileV0({programAddress:SYSTEM_PROGRAM,accounts:[{address:pair.address,role:AccountRole.WRITABLE_SIGNER},{address:kitAddress(new Uint8Array(32).fill(12)),role:AccountRole.WRITABLE}],data:concat(u32(2),u64(1n))},pair.address,kitAddress(new Uint8Array(32).fill(8)));
  assert.equal(transactionMessage(await signV0(tx,[adapter])).version,0);
  assert.throws(()=>walletStandardAdapter(wallet,account,'solana:mainnet'),/v0/);
  wallet.features['solana:signTransaction']!.supportedTransactionVersions=['legacy'];assert.throws(()=>walletStandardAdapter(wallet,account,chain),/v0/);
  wallet.accounts=[];await assert.rejects(adapter.signTransaction(tx),/disconnected/);
});
