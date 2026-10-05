/** Offline state-machine/serialization tests. Real Ed25519 and durable storage;
 * synthetic proof/chain fixtures do not establish SBF or Phantom acceptance. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keypair,PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {WalletClient,type WalletOptions} from '../src/wallet.ts';
import {EncryptedJournal,importJournalKey,type AtomicJournalStore} from '../src/journal.ts';
import {NativeJournalStore} from '../src/journal-node.ts';
import {validateNoteJournal,type NoteJournal,type PrivateState} from '../src/control.ts';
import {compactDepositPayload,expandCompactDepositPayload,encodeLayout2Args} from '../src/layout2.ts';
import {buildInlineDepositPlan,compileV0,prepareInlineDepositAttempt,restoreInlineDepositPlan,snapshotInlineDepositPlan,vaultAccounts,type InlineDepositAttempt,type FinalizedReceipt,type SignatureStatus,type V0Wallet} from '../src/transport.ts';
import {manifestDigest,sha256Hex,verifyManifest,type Manifest,type VerifiedManifest} from '../src/trust.ts';
import type {NoteProver} from '../src/prover.ts';
import type {WalletSnapshot} from '../src/wallet-chain.ts';
const read=(path:string)=>readFileSync(new URL('../../../'+path,import.meta.url));
const fixture=JSON.parse(read('tests/fixtures/vault/genesis-a.json').toString());
const profile=JSON.parse(read('tests/fixtures/layout2/profile.json').toString());
const key=(value:string)=>new PublicKey(Buffer.from(value,'hex'));
const pk=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const field=(n:number|bigint)=>'0x'+n.toString(16).padStart(64,'0');
const pair=Keypair.fromSeed(new Uint8Array(32).fill(1)),owner=pair.publicKey.toBase58();
const blockhash={blockhash:pk(7),lastValidBlockHeight:100};
const payload=()=>encodeLayout2Args({operation:'deposit',expectedId:0,expectedRoot:fixture.trees[0].public_inputs[1],expiry:BigInt(fixture.expiry),commitment:'0x'+fixture.commitment,amount:BigInt(fixture.deposit),tree:fixture.trees[0]});
async function manifest(inline=true,variant=false):Promise<VerifiedManifest>{
  const idl=read('docs/contracts/zkapi_vault.json'),authority={authority:pk(20),program_id:pk(21),config_hash:'77'.repeat(32),threshold:2 as const,members:[pk(22),pk(23),pk(24)]};
  const m:Manifest={...profile,deployment_id:'compact-test',deployment_environment:'local',manifest_hash:'00'.repeat(32),manifest_signature:Buffer.alloc(64).toString('base64'),
    genesis_hash:key(fixture.genesis).toBase58(),program_id:key(fixture.program_id).toBase58(),pool:key(fixture.pool).toBase58(),mint:key(fixture.mint).toBase58(),token_program:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',decimals:6,
    vault_binding:fixture.trees[0].public_inputs[0],state_key:{x:fixture.auth.escape.public_inputs[4],y:fixture.auth.escape.public_inputs[5]},clearance_key:{x:fixture.auth.escape.public_inputs[6],y:fixture.auth.escape.public_inputs[7]},quote_public_key:pk(30),receipt_public_key:pk(31),transaction_formats:inline?['v0_buffer','v0_inline_deposit_v1']:['v0_buffer'],cap_micro_usdc:variant?'2000000':'1000000',note_ttl_seconds:String(fixture.ttl),challenge_seconds:'86400',control_api_origin:'http://127.0.0.1:8788',inference_api_origin:'http://127.0.0.1:8789',proving_keys_base_url:'http://127.0.0.1:8788/keys',idl_hash:await sha256Hex(idl),api_endpoints:['/zkapi/v1/config'],tariff_hashes:[],artifact_digests:{vault_idl:await sha256Hex(idl)},db_schema_version:'2',authorities:{admin:authority,upgrade:{...authority,authority:pk(25)}}};
  const raw={...m,manifest_hash:await manifestDigest(m)};
  return verifyManifest(new TextEncoder().encode(JSON.stringify(raw)),{anchor:{kind:'hash',sha256:raw.manifest_hash},expected:{deployment_id:m.deployment_id,deployment_environment:m.deployment_environment,genesis_hash:m.genesis_hash,program_id:m.program_id,pool:m.pool,mint:m.mint,token_program:m.token_program,control_api_origin:m.control_api_origin,inference_api_origin:m.inference_api_origin},build:{stateKey:m.state_key,clearanceKey:m.clearance_key,circuitProfileHash:m.circuit_profile_hash,idlHash:m.idl_hash,setupProfile:m.setup_profile,transactionFormats:['v0_buffer','v0_inline_deposit_v1']}});
}
async function setup(t:TestContext,inline=true,begin=true){
  const dir=await mkdtemp(join(tmpdir(),'zkapi-inline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const native=await NativeJournalStore.open(dir),aes=await importJournalKey(new Uint8Array(32).fill(14));
  const behavior={failCommit:false,loseCommitAck:false,failProof:false,loseSendAck:false,receipt:null as FinalizedReceipt|null,status:null as SignatureStatus|null,height:50,blockhash:{...blockhash}};
  const counts={sign:0,send:0,rebase:0,proof:0,blockhash:0};
  const store:AtomicJournalStore={read:k=>native.read(k),withLock:(k,a)=>native.withLock(k,a),compareAndSwap:async(k,r,n)=>{if(behavior.failCommit)throw Error('disk full');await native.compareAndSwap(k,r,n);if(behavior.loseCommitAck){behavior.loseCommitAck=false;throw Error('commit ACK lost');}}};
  const m=await manifest(inline),open=()=>new EncryptedJournal<NoteJournal>(store,aes,{deploymentId:m.deployment_id,pool:m.pool},validateNoteJournal),journal=open();
  const state:PrivateState={balance_micro_usdc:String(fixture.deposit),balance_blinding:field(3),note_leaf:field(4),commitment:{x:field(5),y:field(6)},anchor:field(1),state_signature:null};
  const snapshot:WalletSnapshot={root:fixture.trees[0].public_inputs[1],siblings:Array(32).fill(field(0)),slot:20,sequence:'1',nextNoteId:0,clock:String(fixture.now),paused:false,treasuryOwner:owner};
  const prover={deposit:async(note_id:number,amount:string,expiry:string)=>({state:structuredClone(state),witness:{secret:field(2),note_id,deposit_micro_usdc:amount,expiry}}),inspect:async()=>({registration_commitment:'0x'+fixture.commitment}),
    rebaseDeposit:async(w:NoteJournal['witness'],note_id:number,expiry:string)=>{counts.rebase++;return {state:structuredClone(state),witness:{...w!,note_id,expiry}};},
    tree:async(note:{note_id:number;expiry:string},root:string)=>{counts.proof++;const persisted=await open().read('note');assert.ok(persisted?.value.witness,'secret is durable before tree proof');if(behavior.failProof)throw Error('proof interrupted');const p=structuredClone(fixture.trees[0]);p.public_inputs[1]=root;p.public_inputs[3]=field(note.note_id);p.public_inputs[8]=field(BigInt(note.expiry));return p;}} as unknown as NoteProver;
  const wallet:V0Wallet={publicKey:pair.publicKey,supportedTransactionVersions:new Set([0]),async signTransaction(tx){counts.sign++;tx.sign([pair]);return tx;}};
  const options:WalletOptions={manifest:m,prover,journal,wallets:[wallet],priorityFeeMicroLamports:1n,chain:{snapshot:async()=>structuredClone(snapshot),buffer:async()=>{throw Error('inline must not consult a buffer');},bufferObservation:async()=>{throw Error('inline must not consult buffer absence');},blockhash:async()=>{counts.blockhash++;return {...behavior.blockhash};}},rpc:{signatureStatus:async()=>behavior.status,finalizedReceipt:async()=>behavior.receipt,finalizedBlockHeight:async()=>behavior.height,sendRawTransaction:async bytes=>{counts.send++;const saved=(await open().read('note'))!.value.wallet!.operation!;assert.equal(saved.current,bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]));assert.equal(saved.attempts.at(-1)!.wireHex,Buffer.from(bytes).toString('hex'));if(behavior.loseSendAck)throw Error('send ACK lost');return saved.current!;}}};
  const client=new WalletClient(options),restart=()=>new WalletClient({...options,journal:open()});
  const roles={tokenOwner:owner,payer:owner,feePayer:owner,...(!inline?{uploader:owner,rentPayer:owner}:{})};
  if(begin)await client.beginDeposit('note',String(fixture.deposit),roles);
  const signed=async()=>{const a=(await open().read('note'))!.value.wallet!.operation!.attempts.at(-1)!;assert.equal(a.kind,'deposit_inline');return a as InlineDepositAttempt;};
  const receipt=async(err:unknown=null)=>{const a=await signed();return {signature:a.signature,message:VersionedTransaction.deserialize(Buffer.from(a.wireHex,'hex')).message.serialize(),slot:30,err};};
  const fund=async()=>{const r=(await open().read('note'))!;snapshot.slot=30;snapshot.note={note_id:r.value.witness!.note_id,registration_commitment:'0x'+fixture.commitment,deposit_micro_usdc:String(fixture.deposit),expiry:r.value.witness!.expiry,status:'active'};behavior.receipt=await receipt();};
  return {client,restart,options,journal,open,behavior,counts,snapshot,roles,signed,receipt,fund};
}

test('compact encoding exactly expands original canonical proof and refuses mismatched redundant fields',()=>{
  const original=payload(),binding=fixture.trees[0].public_inputs[0],compact=compactDepositPayload(original,binding);
  assert.equal(compact.length,436);assert.deepEqual(expandCompactDepositPayload(compact,binding),original);
  for(const index of [0,1,3,4,6,7,8,9]){const bad=original.slice();bad[84+index*32+31]^=1;assert.throws(()=>compactDepositPayload(bad,binding),/differ/);}
  for(const offset of [4,44,84,116,148]){const bad=compact.slice();bad.fill(255,offset,offset+32);assert.throws(()=>expandCompactDepositPayload(bad,binding));}
  for(const bad of [compact.slice(1),new Uint8Array(437),original])assert.throws(()=>expandCompactDepositPayload(bad,binding),/length/);
});

test('compact self-pay and independent payer plans use one financial instruction and 1007/1103/1199 bytes',async()=>{
  for(const [rent,fee,bytes,count] of [[1,1,1007,1],[2,2,1103,2],[2,3,1199,3]]){
    const wallets=[1,2,3].map(n=>Keypair.fromSeed(new Uint8Array(32).fill(n)));
    const plan=await buildInlineDepositPlan({deploymentId:'fixture',manifestHash:'12'.repeat(32),vaultBinding:fixture.trees[0].public_inputs[0],programId:key(fixture.program_id),pool:key(fixture.pool),feePayer:wallets[fee-1].publicKey,payload:payload(),financial:vaultAccounts({programId:key(fixture.program_id),pool:key(fixture.pool),mint:key(fixture.mint),operation:'deposit',noteId:0,tokenOwner:wallets[0].publicKey,payer:wallets[rent-1].publicKey}),snapshot:{slot:20,sequence:1n},priorityFeeMicroLamports:1n});
    assert.equal(plan.steps.length,1);assert.equal(plan.steps[0].kind,'deposit_inline');assert.equal(plan.steps[0].instruction.data.length,444);
    const tx=compileV0(plan.steps[0].instruction,plan.feePayer,blockhash.blockhash,1n);assert.equal(tx.serialize().length,bytes);assert.equal(tx.signatures.length,count);
    const record=snapshotInlineDepositPlan(plan);assert.equal('buffer' in record,false);assert.equal('nonceHex' in record,false);assert.equal('uploader' in record,false);
    assert.deepEqual(snapshotInlineDepositPlan(await restoreInlineDepositPlan(record)),record);
  }
});

test('normal inline deposit signs once, sends once, binds finalized receipt and note, and remains schema 2',async t=>{
  const h=await setup(t),initial=(await h.open().read('note'))!;assert.equal(initial.value.schema,2);assert.equal(initial.value.wallet!.operation!.transport,'v0_inline_deposit_v1');
  assert.deepEqual(await h.client.advance('note'),{state:'pending'});assert.deepEqual(h.counts,{sign:1,send:1,rebase:0,proof:1,blockhash:1});
  await h.fund();assert.deepEqual(await h.restart().advance('note'),{state:'complete'});
  const done=(await h.open().read('note'))!;assert.equal(done.value.schema,2);assert.equal(done.value.wallet!.status,'active');assert.equal(done.value.wallet!.history[0].finalized.length,1);assert.equal(h.counts.sign,1);assert.equal(h.counts.send,1);
});

test('schema 1 buffer deposit stays buffer and read-only open never rewrites its schema or transport',async t=>{
  const h=await setup(t,false),before=await h.journal.read('note');assert.equal(before!.value.schema,1);assert.equal(before!.value.wallet!.operation!.transport,undefined);assert.ok(before!.value.wallet!.operation!.plan);
  assert.deepEqual(await h.open().read('note'),before);assert.equal(h.counts.sign,0);assert.equal(h.counts.send,0);
});

test('failed signed CAS sends nothing; restart can sign once again only when commit did not happen',async t=>{
  const h=await setup(t),before=await h.open().read('note');h.behavior.failCommit=true;
  await assert.rejects(h.client.advance('note'),/disk full/);assert.equal(h.counts.send,0);assert.deepEqual(await h.open().read('note'),before);
  h.behavior.failCommit=false;await h.restart().advance('note');assert.equal(h.counts.sign,2);assert.equal(h.counts.send,1);
});

test('lost durable commit ACK and unknown send never auto resend; explicit recovery sends only exact saved bytes',async t=>{
  for(const boundary of ['commit','send']){
    const h=await setup(t);if(boundary==='commit')h.behavior.loseCommitAck=true;else h.behavior.loseSendAck=true;
    if(boundary==='commit')await assert.rejects(h.client.advance('note'),/commit ACK/);else assert.deepEqual(await h.client.advance('note'),{state:'unknown'});
    const before=(await h.open().read('note'))!,count=h.counts.send;h.behavior.loseSendAck=false;
    await h.restart().advance('note');await h.restart().advance('note');assert.equal(h.counts.sign,1);assert.equal(h.counts.send,count);assert.deepEqual(await h.open().read('note'),before);
    await h.restart().resendIdenticalDeposit('note');assert.equal(h.counts.send,count+1);assert.equal(h.counts.sign,1);assert.deepEqual(await h.open().read('note'),before);
  }
});

test('expired, confirmed, mismatched receipt and RPC disagreement cannot rebase, fallback or sign again',async t=>{
  for(const fault of ['expired','confirmed','wrong-message','disagreement']){
    const h=await setup(t);await h.client.advance('note');const before=await h.open().read('note');
    if(fault==='expired')h.behavior.height=101;
    if(fault==='confirmed')h.behavior.status={slot:30,confirmationStatus:'confirmed',err:null};
    if(fault==='wrong-message'){h.behavior.receipt=await h.receipt();h.behavior.receipt.message=new Uint8Array(10);}
    if(fault==='disagreement'){h.behavior.receipt=await h.receipt();h.behavior.status={slot:31,confirmationStatus:'finalized',err:null};}
    h.snapshot.nextNoteId=9;await h.restart().advance('note');
    await assert.rejects(h.restart().retryRejected('note'));await assert.rejects(h.restart().resumeProof('note'));await assert.rejects(h.restart().reconcileExpiredCreation('note'));
    assert.deepEqual(await h.open().read('note'),before);assert.equal(h.counts.sign,1);assert.equal(h.counts.send,1);assert.equal(h.counts.rebase,0);
  }
});

test('exact finalized stale rejection requires explicit retry; reproof preserves operation, secret and amount',async t=>{
  const h=await setup(t);await h.client.advance('note');const before=(await h.open().read('note'))!;
  h.behavior.receipt=await h.receipt({InstructionError:[2,{Custom:6007}]});assert.equal((await h.client.advance('note')).state,'rejected');
  await assert.rejects(h.restart().advance('note'),/explicit review/);await assert.rejects(h.restart().resumeProof('note'));
  await h.restart().retryRejected('note');h.snapshot.slot=30;h.snapshot.nextNoteId=1;h.snapshot.clock=String(fixture.now+86400);
  await h.restart().resumeProof('note');const after=(await h.open().read('note'))!;
  assert.equal(after.value.wallet!.operation!.id,before.value.wallet!.operation!.id);assert.equal(after.value.witness!.secret,before.value.witness!.secret);assert.equal(after.value.witness!.deposit_micro_usdc,before.value.witness!.deposit_micro_usdc);assert.equal(after.value.witness!.note_id,1);assert.deepEqual(after.value.wallet!.operation!.attempts,before.value.wallet!.operation!.attempts);
  assert.equal(h.counts.sign,1);assert.equal(h.counts.send,1);assert.equal(h.counts.rebase,1);assert.equal(after.value.wallet!.operation!.rejectedInline!.length,1);
});

test('unsigned pre-sign snapshot race rebuilds same secret without a signature or send',async t=>{
  const h=await setup(t),before=(await h.open().read('note'))!;h.snapshot.slot=21;h.snapshot.nextNoteId=1;
  assert.deepEqual(await h.client.advance('note'),{state:'ready'});assert.equal(h.counts.sign,0);assert.equal(h.counts.send,0);assert.equal(h.counts.blockhash,0);
  const after=(await h.open().read('note'))!;assert.equal(after.value.witness!.secret,before.value.witness!.secret);assert.equal(after.value.witness!.note_id,1);
});

test('unsigned reproof preserves an explicitly selected fee through a proof crash and reopen',async t=>{
  const h=await setup(t);await h.client.setUnsentPriorityFee('note',0n);
  h.snapshot.slot=21;h.snapshot.nextNoteId=1;h.behavior.failProof=true;
  await assert.rejects(h.client.advance('note'),/proof interrupted/);
  h.behavior.failProof=false;
  const changedDefaults=new WalletClient({...h.options,journal:h.open(),priorityFeeMicroLamports:999n});
  await changedDefaults.resumeProof('note');
  const plan=(await h.open().read('note'))!.value.wallet!.operation!.inlinePlan!;
  assert.equal(plan.priorityFeeMicroLamports,undefined,'explicit zero price must survive a new client default');
  await changedDefaults.advance('note');
  assert.equal((await h.signed()).plan.priorityFeeMicroLamports,undefined);
  assert.equal(h.counts.sign,1);assert.equal(h.counts.send,1);
});

test('fee selected before the first proof remains durable when proving is interrupted',async t=>{
  const h=await setup(t,true,false);h.behavior.failProof=true;
  await assert.rejects(h.client.beginDeposit('note',String(fixture.deposit),h.roles),/proof interrupted/);
  h.behavior.failProof=false;
  const changedDefaults=new WalletClient({...h.options,journal:h.open(),priorityFeeMicroLamports:999n});
  await changedDefaults.resumeProof('note');await changedDefaults.advance('note');
  assert.equal((await h.signed()).plan.priorityFeeMicroLamports,'1');
});

test('older inline journals retain their plan fee through unsigned and rejected reproof',async t=>{
  for(const signed of [false,true]){
    const h=await setup(t);await h.client.setUnsentPriorityFee('note',7n);
    if(signed){await h.client.advance('note');h.behavior.receipt=await h.receipt({InstructionError:[2,{Custom:6007}]});await h.client.advance('note');}
    const legacy=(await h.open().read('note'))!;
    assert.equal(legacy.value.wallet!.operation!.transport,'v0_inline_deposit_v1');
    delete (legacy.value.wallet!.operation as {priorityFeeMicroLamports?:string}).priorityFeeMicroLamports;
    await h.journal.compareAndSwap('note',legacy.revision,legacy.value);
    h.snapshot.slot=30;h.snapshot.nextNoteId=1;
    const changedDefaults=new WalletClient({...h.options,journal:h.open(),priorityFeeMicroLamports:999n});
    if(signed){await changedDefaults.retryRejected('note');await changedDefaults.resumeProof('note');}
    else await changedDefaults.advance('note');
    const op=(await h.open().read('note'))!.value.wallet!.operation!;
    assert.equal(op.inlinePlan!.priorityFeeMicroLamports,'7');
    assert.equal(h.counts.sign,signed?1:0);assert.equal(h.counts.send,signed?1:0);
  }
});

test('inline fee journal rejects noncanonical values and disagreement with saved plans or attempts',async t=>{
  const h=await setup(t);await h.client.advance('note');
  const before=(await h.open().read('note'))!.value;
  for(const fee of ['00','-1','1.5','18446744073709551616','2']){
    const changed=structuredClone(before);(changed.wallet!.operation as {priorityFeeMicroLamports?:string}).priorityFeeMicroLamports=fee;
    assert.throws(()=>validateNoteJournal(changed));
  }
  const changed=structuredClone(before),op=changed.wallet!.operation!;
  assert.equal(op.transport,'v0_inline_deposit_v1');
  if(op.transport!=='v0_inline_deposit_v1')throw Error('inline operation required');
  op.priorityFeeMicroLamports='2';op.inlinePlan!.priorityFeeMicroLamports='2';
  assert.throws(()=>validateNoteJournal(changed),/attempt priority fee changed/);
});

test('receipt before final CAS crash recovers without sending; absent/other/stale Note never activates',async t=>{
  const h=await setup(t);await h.client.advance('note');h.behavior.receipt=await h.receipt();const before=await h.open().read('note');
  await assert.rejects(h.restart().advance('note'),/stale finalized financial snapshot/);assert.deepEqual(await h.open().read('note'),before);
  await h.fund();h.snapshot.note!.registration_commitment=field(999);await assert.rejects(h.restart().advance('note'),/does not match/);assert.deepEqual(await h.open().read('note'),before);
  await h.fund();h.behavior.failCommit=true;await assert.rejects(h.restart().advance('note'),/disk full/);h.behavior.failCommit=false;
  assert.deepEqual(await h.restart().advance('note'),{state:'complete'});assert.equal(h.counts.sign,1);assert.equal(h.counts.send,1);
});

test('schema 2 refuses buffer fields, downgrade, mixed attempts and wire substitution before persistence',async t=>{
  const h=await setup(t);await h.client.advance('note');const value=(await h.open().read('note'))!.value;
  const cases=[(v:any)=>v.schema=1,(v:any)=>v.wallet.operation.plan={},(v:any)=>v.wallet.operation.roles.uploader=owner,(v:any)=>v.wallet.operation.inlinePlan.nonceHex='00'.repeat(32),(v:any)=>v.wallet.operation.attempts[0].buffer=owner,(v:any)=>v.wallet.operation.attempts[0].kind='execute',(v:any)=>v.wallet.operation.attempts[0].wireHex='00',(v:any)=>{delete v.wallet.operation.current;},(v:any)=>v.wallet.operation.inlineContext.manifestHash='33'.repeat(32),(v:any)=>v.unknown=true,(v:any)=>v.wallet.unknown=true,(v:any)=>{delete v.wallet.operation.current;v.wallet.operation.finalized=[{signature:v.wallet.operation.attempts[0].signature,slot:30}];}];
  for(const mutate of cases){const changed=structuredClone(value);mutate(changed);assert.throws(()=>validateNoteJournal(changed));}
});

test('two wallet clients share one lock and persisted attempt; only one prompts and dispatches',async t=>{
  const h=await setup(t);await Promise.all([h.client.advance('note'),h.restart().advance('note')]);assert.equal(h.counts.sign,1);assert.equal(h.counts.send,1);assert.equal((await h.open().read('note'))!.value.wallet!.operation!.attempts.length,1);
});

test('wallet rejection and message mutation cannot persist or dispatch a financial attempt',async t=>{
  for(const mutate of [false,true]){const h=await setup(t),before=await h.open().read('note');const bad:V0Wallet={publicKey:pair.publicKey,supportedTransactionVersions:new Set([0]),async signTransaction(tx){if(!mutate)throw Error('user rejected');tx.message.recentBlockhash=pk(8);tx.sign([pair]);return tx;}};
    await assert.rejects(new WalletClient({...h.options,wallets:[bad]}).advance('note'),mutate?/changed transaction/:/user rejected/);assert.equal(h.counts.send,0);assert.deepEqual(await h.open().read('note'),before);}
});

test('ambiguous legacy roles and unverified capability are rejected before witness persistence',async t=>{
  const h=await setup(t,true,false);
  await assert.rejects(h.client.beginDeposit('note',String(fixture.deposit),{...h.roles,uploader:pk(9),rentPayer:owner}),/ambiguous/);
  const forged={...h.options.manifest} as VerifiedManifest;await assert.rejects(new WalletClient({...h.options,manifest:forged}).beginDeposit('note',String(fixture.deposit),h.roles),/not verified/);
  assert.equal(await h.open().read('note'),null);assert.equal(h.counts.proof,0);
});


test('a different verified manifest cannot replace pins on an unresolved operation, even with exact receipt',async t=>{
  const h=await setup(t);await h.client.advance('note');await h.fund();const before=await h.open().read('note');
  const changed=await manifest(true,true),client=new WalletClient({...h.options,manifest:changed,journal:h.open()});
  for(const action of [()=>client.advance('note'),()=>client.resendIdenticalDeposit('note'),()=>client.retryRejected('note'),()=>client.resumeProof('note')])await assert.rejects(action(),/pins changed/);
  assert.deepEqual(await h.open().read('note'),before);assert.equal(h.counts.send,1);assert.equal(h.counts.sign,1);assert.equal(h.counts.rebase,0);
});

test('proof crash retains witness and chosen inline transport; only explicit resume invokes proof again',async t=>{
  const h=await setup(t,true,false);h.behavior.failProof=true;
  await assert.rejects(h.client.beginDeposit('note',String(fixture.deposit),h.roles),/proof interrupted/);
  const before=(await h.open().read('note'))!;assert.equal(before.value.schema,2);assert.equal(before.value.wallet!.operation!.phase,'proving');assert.equal(h.counts.sign,0);assert.equal(h.counts.send,0);
  assert.deepEqual(await h.restart().advance('note'),{state:'proof_required'});assert.deepEqual(await h.open().read('note'),before);
  h.behavior.failProof=false;await h.restart().resumeProof('note');assert.equal((await h.open().read('note'))!.value.witness!.secret,before.value.witness!.secret);
});

test('post-deposit withdrawal still uses buffer with schema 2 and preserves inline history',async t=>{
  const h=await setup(t);await h.client.advance('note');await h.fund();await h.client.advance('note');const before=(await h.open().read('note'))!;
  const prover={...h.options.prover,inspect:async()=>({registration_commitment:'0x'+fixture.commitment,nullifier:fixture.auth.escape.public_inputs[11]}),tree:async()=>structuredClone(fixture.trees[1]),withdrawal:async()=>structuredClone(fixture.auth.escape)} as unknown as NoteProver;
  await new WalletClient({...h.options,prover}).beginWithdrawal('note','initiate_escape',key(fixture.destination_owner).toBase58(),{payer:owner,feePayer:owner,uploader:owner,rentPayer:owner});
  const after=(await h.open().read('note'))!;assert.equal(after.value.schema,2);assert.deepEqual(after.value.wallet!.history,before.value.wallet!.history);assert.equal(after.value.wallet!.operation!.kind,'initiate_escape');assert.ok(after.value.wallet!.operation!.plan);assert.equal(after.value.wallet!.operation!.inlinePlan,undefined);
  const changed=structuredClone(after.value);(changed.wallet!.operation as {priorityFeeMicroLamports?:string}).priorityFeeMicroLamports='1';
  assert.throws(()=>validateNoteJournal(changed),/unknown journal field/);
});


test('journal cannot hide an older unknown signed attempt behind a new current or finalized attempt',async t=>{
  const h=await setup(t);await h.client.advance('note');const original=(await h.open().read('note'))!.value,old=await h.signed();
  const plan=await restoreInlineDepositPlan(old.plan),wallet:V0Wallet={publicKey:pair.publicKey,supportedTransactionVersions:new Set([0]),async signTransaction(tx){tx.sign([pair]);return tx;}};
  const second=await prepareInlineDepositAttempt(plan,{blockhash:pk(8),lastValidBlockHeight:200},[wallet],{save:async()=>{}});
  const changed=structuredClone(original),op=changed.wallet!.operation!;op.attempts.push(second);op.current=second.signature;
  assert.throws(()=>validateNoteJournal(changed),/unresolved inline/);
  delete op.current;op.finalized=[{signature:second.signature,slot:30}];changed.wallet!.history.push(op);delete changed.wallet!.operation;changed.wallet!.status='active';
  assert.throws(()=>validateNoteJournal(changed),/unresolved inline/);
});


for (const scenario of ['mutual_close','initiate_escape','fallback'] as const) test('schema 2 full lifecycle and encrypted reopen '+scenario,async t=>{
  const h=await setup(t);await h.client.advance('note');await h.fund();await h.client.advance('note');
  const deposited=(await h.open().read('note'))!.value;
  const nullifier=fixture.auth.escape.public_inputs[11],destination=key(fixture.destination_owner).toBase58();
  const roles={payer:owner,feePayer:owner,uploader:owner,rentPayer:owner};
  const failClearance=scenario==='fallback';
  const prover={...h.options.prover,inspect:async()=>({registration_commitment:'0x'+fixture.commitment,nullifier}),
    tree:async()=>structuredClone(fixture.trees[1]),withdrawal:async()=>structuredClone(fixture.auth[scenario==='mutual_close'?'withdrawal':'escape']),verifyClearance:async()=>{}} as unknown as NoteProver;
  const opts={...h.options,prover,fetch:async()=>{if(failClearance)throw Error('clearance unavailable');return new Response(JSON.stringify({nullifier,signature:{r_x:field(9),r_y:field(10),s:field(11)}}));}};
  const client=()=>new WalletClient({...opts,journal:h.open()});
  h.snapshot.root=fixture.trees[1].public_inputs[1];
  if(scenario==='fallback'){
    await assert.rejects(client().beginWithdrawal('note','mutual_close',destination,roles),/clearance unavailable/);
    await client().fallbackToEscape('note');
  } else await client().beginWithdrawal('note',scenario,destination,roles);
  const drive=async(terminal:'closed'|'pending_escape')=>{
    for(let i=0;i<10;i++){
      h.behavior.receipt=null;
      const before=(await h.open().read('note'))!;
      assert.equal(before.value.schema,2);
      assert.equal((await client().advance('note')).state,'pending');
      const current=(await h.open().read('note'))!.value.wallet!.operation!.attempts.at(-1)!;
      assert.equal(current.schema,1);
      h.snapshot.slot++;
      h.behavior.receipt={signature:current.signature,message:VersionedTransaction.deserialize(Buffer.from(current.wireHex,'hex')).message.serialize(),slot:h.snapshot.slot,err:null};
      if(current.kind==='execute'||current.kind==='finalize'){
        h.snapshot.note!.status=terminal;
        if(terminal==='pending_escape')h.snapshot.pending={nullifier,balance_micro_usdc:deposited.state.balance_micro_usdc,destinationOwner:destination,deadline:h.snapshot.clock};
      }
      const result=await client().advance('note');
      const record=(await h.open().read('note'))!;assert.equal(record.value.schema,2);
      assert.deepEqual(record.value.wallet!.history[0],deposited.wallet!.history[0]);
      if(result.state==='complete')return;
      assert.equal(result.state,'ready');
    }
    assert.fail('lifecycle failed to complete');
  };
  await drive(scenario==='mutual_close'?'closed':'pending_escape');
  if(scenario!=='mutual_close'){
    assert.equal((await h.open().read('note'))!.value.wallet!.status,'pending_escape');
    await client().beginFinalize('note',roles);await drive('closed');
  }
  const done=(await h.open().read('note'))!.value;
  assert.equal(done.wallet!.status,'closed');assert.equal(done.wallet!.operation,undefined);
  assert.deepEqual(done.witness,deposited.witness);
  t.diagnostic('preserved inline history with '+done.wallet!.history.length+' completed/cancelled operations, '+h.counts.sign+' signatures');
});
