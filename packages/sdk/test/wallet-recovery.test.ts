import {createSolanaRpcWithFetch} from '../src/solana.ts';
import {transactionSignature} from '../src/solana.ts';
import {kitAddress, fixtureSigner, signWith, decodeTransaction} from './kit-helpers.ts';
/** Wallet recovery state-machine fixtures, with real v0 signatures and durable
 * encryption. Synthetic prover/chain responses do not establish SBF acceptance. */
/** Wallet recovery state-machine fixtures, with real v0 signatures and durable
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

async function setup(t:TestContext,kind:'deposit'|'mutual_close'|'finalize_escape'='deposit',failedKind:'create'|'execute'='execute') {
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
  const operation=kind==='deposit'?'deposit':'mutual_close';
  const financial=(await vaultAccounts({programId:key(fixture.program_id),pool:key(fixture.pool),mint:key(fixture.mint),payer:pair.address,tokenOwner:pair.address,operation:kind,noteId:0,destinationOwner:key(fixture.destination_owner),treasuryOwner:pair.address,nullifier:Buffer.from(nullifier.slice(2),'hex')}));
  const payload=operation==='deposit'?encodeLayout2Args({operation,expectedId:0,expectedRoot:fixture.trees[0].public_inputs[1],expiry:BigInt(fixture.expiry),commitment:'0x'+fixture.commitment,amount:BigInt(fixture.deposit),tree:fixture.trees[0]}):encodeLayout2Args({operation,auth:fixture.auth.withdrawal,tree:fixture.trees[1]});
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
  await journal.create('note',{schema:1,state,witness,pending:null,history:[],wallet:{status:kind==='deposit'?'unfunded':kind==='finalize_escape'?'pending_escape':'active',history:[],...(kind==='mutual_close'?{clearance}:{}),operation:{id:crypto.randomUUID(),kind,phase:'failed',roles,destinationOwner:kind==='deposit'?undefined:destination,step:plan.steps.findIndex(s=>s.kind===failedKind),attempts:[attempt],finalized:[],...(kind==='finalize_escape'?{finalization:(attempt as FinalizationAttempt).finalization}:{plan:snapshotPlan(plan)})}}});
  return {journal,plan,snapshot,attempt,client:new WalletClient(options),restart:()=>new WalletClient({...options,journal:open()}),setAbsent:()=>{absent=true;},setReceipt:(value:FinalizedReceipt|null)=>{receipt=value;},makeReceipt,getMinimumBufferSlot:()=>minimumBufferSlot,getMinimumSnapshotSlot:()=>minimumSnapshotSlot,getRebaseCalls:()=>rebaseCalls};
}

test('explicit rejected deposit retry retains secret, closes the old buffer and rechecks next ID/expiry',async t=>{
  const h=await setup(t),before=(await h.journal.read('note'))!.value;
  await assert.rejects(h.client.advance('note'),/explicit review/);
  h.setReceipt(null);await assert.rejects(h.client.retryRejected('note'),/exact rejection/);
  assert.equal((await h.journal.read('note'))!.value.wallet!.operation!.phase,'failed');
  h.setReceipt(h.makeReceipt(h.attempt,{InstructionError:[1,{Custom:6011}]}));
  await h.restart().retryRejected('note');assert.equal(h.getMinimumBufferSlot(),80);
  assert.equal((await h.journal.read('note'))!.value.wallet!.operation!.phase,'closing_stale');
  h.setReceipt(null);await h.client.advance('note');
  const close=(await h.journal.read('note'))!.value.wallet!.operation!.attempts.at(-1)!;assert.equal(close.kind,'close');
  h.setReceipt(h.makeReceipt(close,null));assert.deepEqual(await h.client.advance('note'),{state:'proof_required'});
  await h.client.resumeProof('note');const after=(await h.journal.read('note'))!.value;
  assert.equal(after.witness!.secret,before.witness!.secret);assert.equal(after.witness!.note_id,1);assert.notEqual(after.witness!.expiry,before.witness!.expiry);
  assert.equal(h.getRebaseCalls(),1);assert.equal(after.wallet!.operation!.plan!.expectedNoteId,1);
  assert.notEqual(after.wallet!.operation!.plan!.nonceHex,Buffer.from(h.plan.nonce).toString('hex'));
});

test('rejected create with finalized absent buffer can reprove; withdrawal retains clearance and destination',async t=>{
  const deposit=await setup(t,'deposit','create');deposit.setAbsent();await deposit.client.retryRejected('note');
  assert.equal(deposit.getMinimumBufferSlot(),80);assert.equal((await deposit.journal.read('note'))!.value.wallet!.operation!.phase,'proving');
  const withdrawal=await setup(t,'mutual_close'),before=(await withdrawal.journal.read('note'))!.value;
  await withdrawal.client.retryRejected('note');const after=(await withdrawal.journal.read('note'))!.value;
  assert.deepEqual(after.wallet!.clearance,before.wallet!.clearance);assert.equal(after.wallet!.operation!.destinationOwner,before.wallet!.operation!.destinationOwner);
  assert.deepEqual(after.witness,before.witness);assert.equal(after.wallet!.operation!.phase,'closing_stale');
});

test('explicit rejected finalize retry rechecks deadline and saved pending destination/balance at the receipt slot',async t=>{
  const h=await setup(t,'finalize_escape');h.snapshot.clock=String(fixture.now-1);
  await assert.rejects(h.client.retryRejected('note'),/not ready/);h.snapshot.clock=String(fixture.now);
  h.snapshot.pending!.destinationOwner=(await fixtureSigner(crypto.getRandomValues(new Uint8Array(32)))).address;await assert.rejects(h.client.retryRejected('note'),/not ready/);
  h.snapshot.pending!.destinationOwner=key(fixture.destination_owner);await h.client.retryRejected('note');
  assert.equal(h.getMinimumSnapshotSlot(),80);const op=(await h.journal.read('note'))!.value.wallet!.operation!;
  assert.equal(op.phase,'ready');assert.equal(op.finalization!.snapshotSlot,100);assert.equal(op.attempts.length,1);
});

test('finalized buffer absence must be observed at or after the requested rejection slot',async t=>{
  const h=await setup(t);let observedSlot=79;
  const connection=createSolanaRpcWithFetch('https://rpc.invalid', (async(_url,init)=>{const request=JSON.parse(String(init!.body));assert.equal(request.params[1].minContextSlot,80);return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{context:{slot:observedSlot},value:null}}),{headers:{'Content-Type':'application/json'}});}) as typeof fetch);
  await assert.rejects(fetchFinalizedBuffer(connection,h.plan,80),/stale finalized/);observedSlot=80;
  assert.equal(await fetchFinalizedBuffer(connection,h.plan,80),null);
});
