import {v0Message as transactionMessage} from './kit-helpers.ts';
import {getCompiledTransactionMessageEncoder,type TransactionMessageBytes} from '@solana/kit';
import {transactionSignature} from '../src/solana.ts';
import {kitAddress, fixtureSigner, encodeTransaction, signWith, decodeTransaction} from './kit-helpers.ts';
/** Offline encrypted-journal checks. Public fixture proofs and chain data;
 * no wallet UI, RPC, provider, or real financial transaction is used. */
/** Offline encrypted-journal checks. Public fixture proofs and chain data;
 * no wallet UI, RPC, provider, or real financial transaction is used. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import bs58 from 'bs58';
import {WalletClient,type WalletOptions} from '../src/wallet.ts';
import {EncryptedJournal,importJournalKey} from '../src/journal.ts';
import {NativeJournalStore} from '../src/journal-node.ts';
import {validateNoteJournal,type NoteJournal,type PrivateState} from '../src/control.ts';
import {restorePlan,snapshotPlan,compileV0,prepareAttempt,type V0Wallet} from '../src/transport.ts';
import type {NoteProver} from '../src/prover.ts';
import type {VerifiedManifest} from '../src/trust.ts';
import type {WalletSnapshot} from '../src/wallet-chain.ts';

const fixture=JSON.parse(readFileSync(new URL('../../../tests/fixtures/vault/genesis-a.json',import.meta.url),'utf8'));
const key=(value:string)=>kitAddress(Buffer.from(value,'hex'));
const field=(value:number)=>'0x'+value.toString(16).padStart(64,'0');
const blockhash={blockhash:kitAddress(new Uint8Array(32).fill(7)),lastValidBlockHeight:100};
async function setup(t:TestContext,price?:bigint){
  const directory=await mkdtemp(join(tmpdir(),'zkapi-wallet-fee-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await NativeJournalStore.open(directory),aes=await importJournalKey(new Uint8Array(32).fill(14));
  const open=()=>new EncryptedJournal<NoteJournal>(store,aes,{deploymentId:'fixture',pool:key(fixture.pool)},validateNoteJournal);
  const journal=open(),pair=(await fixtureSigner(new Uint8Array(32).fill(1))),owner=pair.address;
  const roles={uploader:owner,rentPayer:owner,feePayer:owner,payer:owner,tokenOwner:owner};
  const state:PrivateState={balance_micro_usdc:String(fixture.deposit),balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(1),state_signature:null};
  const manifest={program_id:key(fixture.program_id),pool:key(fixture.pool),mint:key(fixture.mint),note_ttl_seconds:String(fixture.ttl)} as unknown as VerifiedManifest;
  const snapshot:WalletSnapshot={root:fixture.trees[0].public_inputs[1],siblings:Array(32).fill(field(0)),slot:20,sequence:'1',nextNoteId:0,clock:String(fixture.now),paused:false,treasuryOwner:owner};
  let chainCalls=0,signCalls=0;
  const prover={deposit:async(note_id:number,amount:string,expiry:string)=>({state:structuredClone(state),witness:{secret:field(2),note_id,deposit_micro_usdc:amount,expiry}}),inspect:async()=>({registration_commitment:'0x'+fixture.commitment}),tree:async()=>structuredClone(fixture.trees[0])} as unknown as NoteProver;
  const wallet:V0Wallet={publicKey:pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(){signCalls++;throw Error('fee selection must not sign');}};
  const options:WalletOptions={manifest,prover,journal,wallets:[wallet],priorityFeeMicroLamports:price,
    chain:{snapshot:async()=>{chainCalls++;return structuredClone(snapshot);},buffer:async()=>{throw Error('must not read buffer');},blockhash:async()=>{throw Error('must not obtain blockhash');}},
    rpc:{signatureStatus:async()=>{throw Error('must not read signature');},finalizedReceipt:async()=>{throw Error('must not read receipt');},finalizedBlockHeight:async()=>{throw Error('must not read height');},sendRawTransaction:async()=>{throw Error('must not send');}}};
  const client=new WalletClient(options);options.priorityFeeMicroLamports=99n;
  await client.beginDeposit('note',String(fixture.deposit),roles);
  return {client,journal,open,options,pair,calls:()=>({chainCalls,signCalls})};
}

test('future plans snapshot the configured u64 fee while omitted and zero preserve legacy serialization',async t=>{
  for(const price of [undefined,0n,1n]){
    const h=await setup(t,price),record=(await h.journal.read('note'))!,saved=record.value.wallet!.operation!.plan!;
    assert.equal(saved.priorityFeeMicroLamports,price===1n?'1':undefined,'caller option mutation cannot reprice this client');
    const plan=await restorePlan(saved);assert.deepEqual(snapshotPlan(plan),saved);
    for(const step of plan.steps){
      const tx=compileV0(step.instruction,plan.feePayer,blockhash.blockhash,plan.priorityFeeMicroLamports);
      assert.ok(encodeTransaction(tx).length<=1232);assert.equal(transactionMessage(tx).instructions.length,price===1n?3:2);
      if(price===1n){const data=transactionMessage(tx).instructions[1].data;assert.equal(data[0],3);assert.equal(new DataView(data.buffer,data.byteOffset,data.byteLength).getBigUint64(1,true),1n);}
      else assert.deepEqual(encodeTransaction(tx),encodeTransaction(compileV0(step.instruction,plan.feePayer,blockhash.blockhash)));
    }
  }
});

test('explicit unsent repricing persists only the plan fee and survives restart without changing proof or operation',async t=>{
  const h=await setup(t),before=(await h.journal.read('note'))!,calls=h.calls();
  await h.client.setUnsentPriorityFee('note',1n);
  const after=(await h.open().read('note'))!;
  assert.equal(after.revision,before.revision+1);
  const expected=structuredClone(before.value);expected.wallet!.operation!.plan!.priorityFeeMicroLamports='1';
  assert.deepEqual(after.value,expected,'nonce, payload, financial accounts, roles, operation ID, witness and private state are retained');
  assert.deepEqual(h.calls(),calls,'repricing performs no chain call or signature request');
  const plan=await restorePlan(after.value.wallet!.operation!.plan!);
  assert.deepEqual(snapshotPlan(plan),after.value.wallet!.operation!.plan);
  for(const step of plan.steps)assert.ok(encodeTransaction(compileV0(step.instruction,plan.feePayer,blockhash.blockhash,1n)).length<=1232);
});

test('same selected fee is a no-op and explicit zero restores original bytes without a journal reset',async t=>{
  const h=await setup(t),original=(await h.journal.read('note'))!;
  await h.client.setUnsentPriorityFee('note',0n);assert.deepEqual(await h.journal.read('note'),original);
  await h.client.setUnsentPriorityFee('note',1n);const priced=(await h.journal.read('note'))!;
  await h.client.setUnsentPriorityFee('note',1n);assert.deepEqual(await h.journal.read('note'),priced);
  await h.client.setUnsentPriorityFee('note',0n);const reset=(await h.journal.read('note'))!;
  assert.equal(reset.revision,original.revision+2);assert.deepEqual(reset.value,original.value);
});

test('signed, current, finalized, advanced, non-ready, resolved and pending-session states cannot be repriced',async t=>{
  const h=await setup(t),base=(await h.journal.read('note'))!.value,plan=await restorePlan(base.wallet!.operation!.plan!);
  const signer:V0Wallet={publicKey:h.pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(tx){tx = await signWith(tx, [h.pair]);return tx;}};
  const attempt=await prepareAttempt(plan,plan.steps[0],blockhash,[signer],{save:async()=>{}});
  const cases:[string,(v:NoteJournal)=>void][]=[
    ['signed',v=>{v.wallet!.operation!.attempts=[attempt];}],
    ['current',v=>{v.wallet!.operation!.attempts=[attempt];v.wallet!.operation!.current=attempt.signature;}],
    ['finalized',v=>{v.wallet!.operation!.finalized=[{signature:attempt.signature,slot:20}];}],
    ['advanced',v=>{v.wallet!.operation!.step=1;}],
    ...(['proving','stale','closing_stale','failed'] as const).map(phase=>[phase,(v:NoteJournal)=>{v.wallet!.operation!.phase=phase;}] as [string,(v:NoteJournal)=>void]),
    ['resolved',v=>{v.wallet!.status='closed';}],['wrong active status',v=>{v.wallet!.status='active';}],
    ['absent operation',v=>{delete v.wallet!.operation;}],['absent plan',v=>{delete v.wallet!.operation!.plan;}],
    ['finalization',v=>{v.wallet!.operation!.kind='finalize_escape';}],
    ['different plan operation',v=>{v.wallet!.operation!.kind='mutual_close';v.wallet!.status='active';}],
    ['pending session',v=>{const request={authorization:{request_id:crypto.randomUUID()}};v.pending={phase:'prepared',prepared:{request,control_token:'fixture',proxy_token:null},exactRequest:JSON.stringify(request),operations:[]} as unknown as NoteJournal['pending'];}],
  ];
  for(const [name,change] of cases){
    const id='blocked-'+name,value=structuredClone(base);change(value);await h.journal.create(id,value);const before=await h.journal.read(id);
    await assert.rejects(h.client.setUnsentPriorityFee(id,1n),/unsent ready upload required/,name);
    assert.deepEqual(await h.journal.read(id),before,name+' leaves exact journal unchanged');
  }
});

test('constructor and explicit repricing reject invalid runtime types and out-of-u64 fees before writes',async t=>{
  const h=await setup(t),before=await h.journal.read('note');
  for(const price of [-1n,1n<<64n,1,'1',NaN,null]){
    assert.throws(()=>new WalletClient({...h.options,priorityFeeMicroLamports:price as bigint}),/invalid u64/);
    await assert.rejects(h.client.setUnsentPriorityFee('note',price as bigint),/invalid u64/);
    assert.deepEqual(await h.journal.read('note'),before);
  }
});

test('wallet-added priority fee is rejected; explicit same-plan fee then signs exact bytes and persists before send',async t=>{
  const h=await setup(t),before=(await h.journal.read('note'))!;
  let signatures=0,sends=0,reviewedMessage:Uint8Array|undefined;
  const wallet:V0Wallet={publicKey:h.pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(transaction){
    signatures++;
    reviewedMessage=new Uint8Array(transaction.messageBytes);
    const alreadyPriced=transactionMessage(transaction).instructions.some(ix=>(transactionMessage(transaction).staticAccounts[ix.programAddressIndex] === 'ComputeBudget111111111111111111111111111111')&&ix.data?.[0]===3);
    if(!alreadyPriced){
      const message=transactionMessage(transaction),data=Buffer.alloc(9);data[0]=3;data.writeBigUInt64LE(375000n,1);
      const programAddressIndex=message.staticAccounts.indexOf(kitAddress('ComputeBudget111111111111111111111111111111'));
      const changed={...message,instructions:[{programAddressIndex,data},...message.instructions]};
      transaction={...transaction,messageBytes:getCompiledTransactionMessageEncoder().encode(changed) as TransactionMessageBytes};
    }
    transaction = await signWith(transaction, [h.pair]);return transaction;
  }};
  const client=new WalletClient({...h.options,priorityFeeMicroLamports:1n,wallets:[wallet],
    chain:{...h.options.chain,blockhash:async()=>blockhash},rpc:{signatureStatus:async()=>null,finalizedReceipt:async()=>null,finalizedBlockHeight:async()=>50,
      sendRawTransaction:async bytes=>{
        sends++;
        const persisted=(await h.open().read('note'))!,op=persisted.value.wallet!.operation!;
        assert.equal(persisted.revision,before.revision+2,'fee selection and signed attempt each committed before send');
        assert.equal(op.attempts.length,1);assert.equal(op.plan!.priorityFeeMicroLamports,'1');
        assert.equal(op.attempts[0].wireHex,Buffer.from(bytes).toString('hex'));
        const signed=decodeTransaction(bytes);
        assert.deepEqual(new Uint8Array(signed.messageBytes),reviewedMessage,'wallet preserved exact reviewed message');
        assert.equal(op.current,transactionSignature(signed));
        return op.current!;
      }}});
  await assert.rejects(client.advance('note'),/wallet changed transaction message/);
  assert.equal(signatures,1);assert.equal(sends,0);assert.deepEqual(await h.journal.read('note'),before);
  await client.setUnsentPriorityFee('note',1n);
  assert.deepEqual(await client.advance('note'),{state:'pending'});
  assert.equal(signatures,2);assert.equal(sends,1);
  await assert.rejects(client.setUnsentPriorityFee('note',2n),/unsent ready upload required/);
});
