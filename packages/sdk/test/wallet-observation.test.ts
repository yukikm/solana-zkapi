import {createSolanaRpcWithFetch} from '../src/solana.ts';
import {transactionSignature} from '../src/solana.ts';
import {kitAddress, fixtureSigner, signWith, decodeTransaction} from './kit-helpers.ts';
/** Observation-only wallet fixtures, with real v0 signatures and durable
 * encryption. Synthetic prover/chain responses do not establish SBF acceptance. */
/** Observation-only wallet fixtures, with real v0 signatures and durable
 * encryption. Synthetic prover/chain responses do not establish SBF acceptance. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import bs58 from 'bs58';
import { WalletClient, type WalletOptions } from '../src/wallet.ts';
import { NoteProver } from '../src/prover.ts';
import { EncryptedJournal, importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { validateNoteJournal, type NoteJournal, type PrivateState } from '../src/control.ts';
import { encodeLayout2Args } from '../src/layout2.ts';
import { buildUploadPlan, snapshotPlan, prepareAttempt, prepareFinalizationAttempt, vaultAccounts, fetchFinalizedBuffer,
  type Attempt, type FinalizationAttempt, type FinalizedReceipt, type TransportRpc, type V0Wallet } from '../src/transport.ts';
import type { WalletSnapshot } from '../src/wallet-chain.ts';
import type { VerifiedManifest } from '../src/trust.ts';
const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/vault/genesis-a.json', import.meta.url), 'utf8'));
const key = (value:string) => kitAddress(Buffer.from(value,'hex'));
const field = (value:number) => '0x'+value.toString(16).padStart(64,'0');

async function setup(t:TestContext,kind:'deposit'|'mutual_close'|'initiate_escape'|'finalize_escape'='deposit',failedKind:'create'|'execute'='execute') {
  const directory=await mkdtemp(join(tmpdir(),'zkapi-wallet-recovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await NativeJournalStore.open(directory),aes=await importJournalKey(new Uint8Array(32).fill(14));
  const open=()=>new EncryptedJournal<NoteJournal>(store,aes,{deploymentId:'fixture',pool:key(fixture.pool)},validateNoteJournal);
  const journal=open(),pair=(await fixtureSigner(new Uint8Array(32).fill(1)));
  const wallet:V0Wallet={publicKey:pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(tx){tx = await signWith(tx, [pair]);return tx;}};
  const owner=pair.address,destination=key(fixture.destination_owner),roles={uploader:owner,rentPayer:owner,feePayer:owner,payer:owner,tokenOwner:owner};
  const manifest={program_id:key(fixture.program_id),pool:key(fixture.pool),mint:key(fixture.mint),note_ttl_seconds:String(fixture.ttl)} as unknown as VerifiedManifest;
  const state:PrivateState={balance_micro_usdc:String(fixture.deposit),balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(1),state_signature:null};
  const witness={secret:field(2),note_id:0,deposit_micro_usdc:String(fixture.deposit),expiry:String(fixture.expiry)};
  const nullifier=fixture.auth.escape.public_inputs[11],clearance={nullifier,phase:'verified' as const,signature:{r_x:field(9),r_y:field(10),s:field(11)}};
  const snapshot:WalletSnapshot={root:fixture.trees[0].public_inputs[1],siblings:Array(32).fill(field(0)),slot:100,sequence:'2',nextNoteId:1,clock:String(fixture.now+86400),paused:false,treasuryOwner:owner,
    note:{note_id:0,registration_commitment:'0x'+fixture.commitment,deposit_micro_usdc:witness.deposit_micro_usdc,expiry:witness.expiry,status:kind==='finalize_escape'?'pending_escape':'active'},
    pending:{nullifier,balance_micro_usdc:state.balance_micro_usdc,destinationOwner:destination,deadline:String(fixture.now)}};
  const operation=kind==='deposit'?'deposit':kind==='initiate_escape'?'initiate_escape':'mutual_close';
  const financial=(await vaultAccounts({programId:key(fixture.program_id),pool:key(fixture.pool),mint:key(fixture.mint),payer:pair.address,tokenOwner:pair.address,operation:kind,noteId:0,destinationOwner:key(fixture.destination_owner),treasuryOwner:pair.address,nullifier:Buffer.from(nullifier.slice(2),'hex')}));
  const payload=operation==='deposit'?encodeLayout2Args({operation,expectedId:0,expectedRoot:fixture.trees[0].public_inputs[1],expiry:BigInt(fixture.expiry),commitment:'0x'+fixture.commitment,amount:BigInt(fixture.deposit),tree:fixture.trees[0]}):encodeLayout2Args({operation,auth:kind==='initiate_escape'?fixture.auth.escape:fixture.auth.withdrawal,tree:fixture.trees[1]});
  const plan=await buildUploadPlan({programId:key(fixture.program_id),pool:key(fixture.pool),uploader:pair.address,rentPayer:pair.address,feePayer:pair.address,nonce:new Uint8Array(32).fill(2),expires:BigInt(fixture.now+3600),operation,payload,financial,snapshot:{slot:20,sequence:1n}});
  const oldHash={blockhash:kitAddress(new Uint8Array(32).fill(7)),lastValidBlockHeight:100};
  const attempt=kind==='finalize_escape'?await prepareFinalizationAttempt({programId:plan.programId,pool:plan.pool,noteId:0,feePayer:pair.address,financial,snapshot:plan.snapshot},oldHash,[wallet],{save:async()=>{}}):await prepareAttempt(plan,plan.steps.find(s=>s.kind===failedKind)!,oldHash,[wallet],{save:async()=>{}});
  const makeReceipt=(a:Attempt|FinalizationAttempt,err:unknown|null):FinalizedReceipt=>({signature:a.signature,message:new Uint8Array(decodeTransaction(Buffer.from(a.wireHex,'hex')).messageBytes),slot:80,err});
  let receipt:FinalizedReceipt|null=makeReceipt(attempt,{InstructionError:[1,{Custom:6011}]});
  let absent=false,minimumBufferSlot:number|undefined,minimumSnapshotSlot:number|undefined;
  const rpc:TransportRpc={signatureStatus:async()=>null,finalizedReceipt:async()=>receipt,finalizedBlockHeight:async()=>50,sendRawTransaction:async bytes=>transactionSignature(decodeTransaction(bytes))};
  let rebaseCalls=0;
  const prover={inspect:async()=>({nullifier,registration_commitment:'0x'+fixture.commitment}),verifyClearance:async()=>{},
    rebaseDeposit:async(w:typeof witness,noteId:number,expiry:string)=>{rebaseCalls++;return {witness:{...w,note_id:noteId,expiry},state,registration_commitment:'0x'+fixture.commitment};},
    tree:async(note:{note_id:number})=>{const proof=structuredClone(fixture.trees[operation==='deposit'?0:1]);proof.public_inputs[3]=field(note.note_id);return proof;},withdrawal:async()=>fixture.auth.withdrawal} as unknown as NoteProver;
  const options:WalletOptions={manifest,journal,prover,rpc,wallets:[wallet],chain:{snapshot:async(_id,_path,min)=>{minimumSnapshotSlot=min;return structuredClone(snapshot);},buffer:async(_plan,min)=>{minimumBufferSlot=min;return absent?null:{address:plan.buffer,owner:plan.programId,data:new Uint8Array(),slot:100,commitment:'finalized'};},blockhash:async()=>({blockhash:kitAddress(new Uint8Array(32).fill(8)),lastValidBlockHeight:200})}};
  await journal.create('note',{schema:1,state,witness,pending:null,history:[],wallet:{status:kind==='deposit'?'unfunded':kind==='finalize_escape'?'pending_escape':'active',history:[],...(kind==='mutual_close'?{clearance}:{}),operation:{id:crypto.randomUUID(),kind,phase:'ready',current:attempt.signature,roles,destinationOwner:kind==='deposit'?undefined:destination,step:plan.steps.findIndex(s=>s.kind===failedKind),attempts:[attempt],finalized:[],...(kind==='finalize_escape'?{finalization:(attempt as FinalizationAttempt).finalization}:{plan:snapshotPlan(plan)})}}});
  return {options,journal,plan,snapshot,attempt,client:new WalletClient(options),restart:()=>new WalletClient({...options,journal:open()}),setAbsent:()=>{absent=true;},setReceipt:(value:FinalizedReceipt|null)=>{receipt=value;},makeReceipt,getMinimumBufferSlot:()=>minimumBufferSlot,getMinimumSnapshotSlot:()=>minimumSnapshotSlot,getRebaseCalls:()=>rebaseCalls};
}

function observeOnly(h:Awaited<ReturnType<typeof setup>>) {
  const forbidden:string[]=[];
  const fail=(name:string)=>{forbidden.push(name);throw Error('unexpected '+name);};
  h.options.wallets=[{...h.options.wallets[0],signTransaction:async()=>fail('sign')}];
  h.options.rpc.sendRawTransaction=async()=>fail('send');
  h.options.chain.blockhash=async()=>fail('blockhash');
  h.options.chain.buffer=async()=>fail('buffer refresh');
  h.options.fetch=async()=>fail('HTTP write');
  for(const key of ['tree','withdrawal','rebaseDeposit','deposit'] as const)
    (h.options.prover as any)[key]=async()=>fail('prove');
  return {client:new WalletClient(h.options),forbidden};
}
for(const kind of ['deposit','mutual_close','initiate_escape','finalize_escape'] as const) {
  test(`observation commits finalized ${kind} with the exact saved signature and existing bindings`,async t=>{
    const h=await setup(t,kind),{client,forbidden}=observeOnly(h);
    h.setReceipt(h.makeReceipt(h.attempt,null));
    h.snapshot.note!.status=kind==='deposit'?'active':kind==='initiate_escape'?'pending_escape':'closed';
    const before=(await h.journal.read('note'))!;
    assert.deepEqual(await client.observe('note',h.attempt.signature),{state:'complete'});
    const after=(await h.journal.read('note'))!;
    assert.equal(after.value.wallet!.status,h.snapshot.note!.status);
    assert.equal(after.value.wallet!.operation,undefined);
    assert.equal(after.value.wallet!.history.at(-1)!.finalized.at(-1)!.signature,h.attempt.signature);
    assert.deepEqual(after.value.witness,before.value.witness);
    assert.deepEqual(after.value.wallet!.clearance,before.value.wallet!.clearance);
    assert.equal(h.getMinimumSnapshotSlot(),80);
    assert.deepEqual(await client.observe('note',h.attempt.signature),{state:'changed'});
    assert.deepEqual(forbidden,[]);
  });
}
for(const state of ['pending','unknown','expired_reconcile_required'] as const) {
  test(`observation leaves ${state} upload bytes and journal revision unchanged without signing or sending`,async t=>{
    const h=await setup(t,'mutual_close','create'),{client,forbidden}=observeOnly(h);
    h.setReceipt(null);
    h.options.rpc.signatureStatus=async()=>state==='pending'?{confirmationStatus:'confirmed',slot:70,err:null}:null;
    if(state==='unknown')h.options.rpc.finalizedReceipt=async()=>{throw Error('RPC unavailable');};
    h.options.rpc.finalizedBlockHeight=async()=>200;
    const before=await h.journal.read('note');
    assert.equal((await client.observe('note',h.attempt.signature)).state,state);
    assert.deepEqual(await h.journal.read('note'),before);
    assert.deepEqual(forbidden,[]);
  });
}
test('a live unobserved signature is never resent by observation',async t=>{
  const h=await setup(t),{client,forbidden}=observeOnly(h);h.setReceipt(null);
  const before=await h.journal.read('note');
  assert.equal((await client.observe('note',h.attempt.signature)).state,'pending');
  assert.deepEqual(await h.journal.read('note'),before);assert.deepEqual(forbidden,[]);
});
test('signature fence and unsigned next step stop observation without network work',async t=>{
  const h=await setup(t,'mutual_close','create'),{client,forbidden}=observeOnly(h);
  h.options.rpc.signatureStatus=async()=>{throw Error('should not read another signature');};
  const before=await h.journal.read('note');
  assert.deepEqual(await client.observe('note','another-signature'),{state:'changed'});
  assert.deepEqual(await h.journal.read('note'),before);
  h.options.rpc.signatureStatus=async()=>null;h.setReceipt(h.makeReceipt(h.attempt,null));
  assert.deepEqual(await client.observe('note',h.attempt.signature),{state:'ready'});
  const after=await h.journal.read('note');
  assert.equal(after!.value.wallet!.operation!.current,undefined);
  assert.equal(after!.value.wallet!.operation!.step,before!.value.wallet!.operation!.step+1);
  assert.deepEqual(await client.observe('note',h.attempt.signature),{state:'changed'});
  assert.deepEqual(await h.journal.read('note'),after);assert.deepEqual(forbidden,[]);
  assert.throws(()=>client.observe('note',undefined as unknown as string),/expected saved signature/);
});
test('wrong signed receipt cannot clear an operation',async t=>{
  const h=await setup(t,'mutual_close'),{client,forbidden}=observeOnly(h);
  const receipt=h.makeReceipt(h.attempt,null);receipt.message[0]^=1;h.setReceipt(receipt);
  const before=await h.journal.read('note');
  assert.equal((await client.observe('note',h.attempt.signature)).state,'unknown');
  assert.deepEqual(await h.journal.read('note'),before);assert.deepEqual(forbidden,[]);
});
for(const invalid of ['slot','status','witness','snapshot-failure','escape-pending'] as const) {
  test(`invalid ${invalid} after a successful receipt preserves the complete original journal`,async t=>{
    const h=await setup(t,invalid==='escape-pending'?'initiate_escape':'mutual_close'),{client,forbidden}=observeOnly(h);
    h.setReceipt(h.makeReceipt(h.attempt,null));h.snapshot.note!.status=invalid==='escape-pending'?'pending_escape':'closed';
    if(invalid==='slot')h.snapshot.slot=79;
    if(invalid==='status')h.snapshot.note!.status='active';
    if(invalid==='witness')h.snapshot.note!.expiry='1';
    if(invalid==='snapshot-failure')h.options.chain.snapshot=async()=>{throw Error('indexer unavailable');};
    if(invalid==='escape-pending')h.snapshot.pending!.balance_micro_usdc='1';
    const before=await h.journal.read('note');
    await assert.rejects(client.observe('note',h.attempt.signature));
    assert.deepEqual(await h.journal.read('note'),before);assert.deepEqual(forbidden,[]);
  });
}
test('finalized rejection is saved for explicit review, without retries or new proving',async t=>{
  const h=await setup(t,'mutual_close'),{client,forbidden}=observeOnly(h);
  const before=(await h.journal.read('note'))!.value;
  assert.equal((await client.observe('note',h.attempt.signature)).state,'rejected');
  const after=(await h.journal.read('note'))!.value;
  assert.equal(after.wallet!.operation!.phase,'failed');assert.equal(after.wallet!.operation!.current,undefined);
  assert.deepEqual(after.wallet!.operation!.attempts,before.wallet!.operation!.attempts);
  assert.deepEqual(after.wallet!.clearance,before.wallet!.clearance);assert.deepEqual(forbidden,[]);
});
test('observation rechecks its signature after acquiring the journal lock',async t=>{
  const h=await setup(t,'mutual_close'),{client,forbidden}=observeOnly(h);
  let observed:ReturnType<WalletClient['observe']>|undefined;
  await h.journal.withNoteLock('note',async()=>{
    observed=client.observe('note',h.attempt.signature);
    const r=(await h.journal.read('note'))!;
    delete r.value.wallet!.operation!.current;r.value.wallet!.operation!.phase='failed';
    await h.journal.compareAndSwap('note',r.revision,r.value);
  });
  const before=await h.journal.read('note');
  assert.deepEqual(await observed,{state:'changed'});assert.deepEqual(await h.journal.read('note'),before);
  assert.deepEqual(forbidden,[]);
});
test('a failed durable commit leaves the saved final transaction available for later observation',async t=>{
  const h=await setup(t,'mutual_close'),{client,forbidden}=observeOnly(h);
  h.setReceipt(h.makeReceipt(h.attempt,null));h.snapshot.note!.status='closed';
  const before=await h.journal.read('note');
  const save=t.mock.method(h.journal,'compareAndSwap',async()=>{throw Error('disk full');});
  await assert.rejects(client.observe('note',h.attempt.signature),/disk full/);
  assert.deepEqual(await h.journal.read('note'),before);
  save.mock.restore();
  assert.deepEqual(await client.observe('note',h.attempt.signature),{state:'complete'});
  assert.deepEqual(forbidden,[]);
});
