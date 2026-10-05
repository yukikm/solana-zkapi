/** Read-only receipt collection for the pinned Chrome/Phantom repeat-demo run.
 * No wallet keys, provider calls, AUTH, transaction sends or inference retries. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PublicKey,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import bs58 from 'bs58';
import {buildUploadPlan,compileV0,discriminator,vaultAccounts,verifySignatures,TOKEN_PROGRAM} from '../packages/sdk/src/transport.ts';
import {parseStrictJson} from '../packages/sdk/src/trust.ts';
import {OPERATIONS} from '../packages/sdk/src/layout2.ts';

export type RepeatPhase='withdrawal'|'deposit';
export type ReadRpc=(method:string,params:unknown[])=>Promise<any>;
const ORIGIN='http://127.0.0.1:19180';
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM='64C2qsG8xB5XpnqiJBBDPqJqBc2P8wz73knVhFpi1PDh';
const POOL='3tByNJBBzqBjhHsNdpsq56XXSj7HckGUfyQMNqEBiTZ5';
const OWNER='nHSjCbSd3XD3UwGy5uAAUqEfDf4kBDYaJZ4eF82nCDZ';
const MINT='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MANIFEST='ee851dbfbb1c75b7ff4b5fabe3407ba9c3a38c42bcb7668d722653afcccb4555';
const HISTORICAL='docs/evidence/I10-repeat-demo-withdraw-expired.json';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const safeInteger=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const publicKey=(value:unknown)=>{assert.equal(typeof value,'string');const key=new PublicKey(value as string);assert.equal(key.toBase58(),value);return key;};
const readMethods=new Set(['getGenesisHash','getTransaction','getMultipleAccounts','getBlock']);
let rpcId=0;
const localRead:ReadRpc=async(method,params)=>{
  assert.ok(readMethods.has(method),'read-only RPC allowlist');const id=++rpcId;
  const response=await fetch(ORIGIN+'/rpc',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method,params}),redirect:'error',signal:AbortSignal.timeout(30000)});
  assert.ok(response.ok,'read-only RPC unavailable');const bytes=new Uint8Array(await response.arrayBuffer());assert.ok(bytes.length<=4*1024*1024,'RPC response bound');
  const result=parseStrictJson(bytes) as any;assert.ok(result&&result.jsonrpc==='2.0'&&result.id===id&&!result.error,'read-only RPC failed');return result.result;
};

export function checkedRepeatObservation(input:any,phase:RepeatPhase):any{
  assert.ok(phase==='withdrawal'||phase==='deposit');const observation=input?.state??input;
  assert.ok(observation&&typeof observation==='object'&&!Array.isArray(observation));
  assert.equal(observation.fixture_only,false);assert.equal(observation.wallet,'Phantom');assert.equal(observation.account,OWNER);
  assert.equal(observation.pool,POOL);assert.equal(observation.manifest_hash,MANIFEST);assert.equal(observation.run_id,'openai-ui');
  assert.equal(observation.operation,null);assert.equal(observation.session,null);assert.equal(observation.unresolved_transaction,null);
  assert.equal(observation.wallet_status,phase==='withdrawal'?'closed':'active');
  assert.equal(observation.balance_micro_usdc,phase==='withdrawal'?'999996':'2000000');
  assert.equal(observation.demo_run,phase==='withdrawal'?1:2);assert.equal(observation.saved_demo_runs,observation.demo_run);
  assert.ok(Array.isArray(observation.finalized_transactions));assert.equal(observation.finalized_transactions.length,phase==='withdrawal'?9:4);
  const signatures=new Set<string>();let slot=0;
  for(const receipt of observation.finalized_transactions){assert.ok(receipt&&safeInteger(receipt.slot)&&receipt.slot>=slot);slot=receipt.slot;
    assert.equal(typeof receipt.signature,'string');const raw=bs58.decode(receipt.signature);assert.equal(raw.length,64);assert.equal(bs58.encode(raw),receipt.signature);
    assert.ok(!signatures.has(receipt.signature));signatures.add(receipt.signature);}
  assert.ok(Array.isArray(observation.expired_setup_recoveries)&&Array.isArray(observation.verified_settlements));
  if(phase==='withdrawal'){
    assert.equal(observation.permanent_clearance,true);
    assert.equal(observation.verified_settlements.reduce((n:bigint,s:any)=>{assert.match(s.charge_micro_usdc,/^(0|[1-9][0-9]*)$/);return n+BigInt(s.charge_micro_usdc);},0n),4n);
    assert.ok(observation.expired_setup_recoveries.some((x:any)=>x.signature==='5ngFj1eJAQF2TXLU1jftYp6YJ5W886TpyR1nFdRykfC2AVtUjTMYFmeA7h8P2RqC9Z2fD1yoiu6hZaxQYSeSttLb'));
  }else{assert.equal(observation.permanent_clearance,false);assert.deepEqual(observation.verified_settlements,[]);}
  return structuredClone(observation);
}

interface ObservedTransaction {tx:VersionedTransaction;data:Buffer;report:{signature:string;slot:number;instruction:string;fee_lamports:number;compute_units:number;wire_bytes:number;message_sha256:string}}
async function readTransaction(receipt:{signature:string;slot:number},read:ReadRpc):Promise<ObservedTransaction>{
  const chain=await read('getTransaction',[receipt.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:1}]);
  assert.ok(chain&&chain.meta&&chain.meta.err===null);assert.equal(chain.slot,receipt.slot);assert.equal(chain.transaction?.[1],'base64');
  const wire=Buffer.from(chain.transaction[0],'base64');assert.equal(wire.toString('base64'),chain.transaction[0]);
  const tx=VersionedTransaction.deserialize(wire);assert.equal(tx.version,0);await verifySignatures(tx);
  assert.equal(bs58.encode(tx.signatures[0]),receipt.signature);assert.ok(wire.length<=1232);assert.equal(tx.message.addressTableLookups.length,0);
  assert.equal(tx.message.staticAccountKeys[0].toBase58(),OWNER);assert.equal(tx.signatures.length,1);
  assert.equal(chain.meta.fee,5001);assert.ok(safeInteger(chain.meta.computeUnitsConsumed)&&chain.meta.computeUnitsConsumed>0&&chain.meta.computeUnitsConsumed<=1000000);
  const instructions=tx.message.compiledInstructions;assert.equal(instructions.length,3);
  for(const [i,length,tag] of [[0,5,2],[1,9,3]]){assert.equal(tx.message.staticAccountKeys[instructions[i].programIdIndex].toBase58(),ComputeBudgetProgram.programId.toBase58());
    assert.equal(instructions[i].data.length,length);assert.equal(instructions[i].data[0],tag);}
  assert.equal(Buffer.from(instructions[0].data).readUInt32LE(1),1000000);assert.equal(Buffer.from(instructions[1].data).readBigUInt64LE(1),1n);
  const vault=instructions[2];assert.equal(tx.message.staticAccountKeys[vault.programIdIndex].toBase58(),PROGRAM);const data=Buffer.from(vault.data);
  let name:string|undefined;for(const candidate of ['create_payload','append_payload','seal_payload','execute_payload'])
    if(data.subarray(0,8).equals(Buffer.from(await discriminator(candidate))))name=candidate;
  assert.ok(name);assert.equal(tx.message.staticAccountKeys[vault.accountKeyIndexes[name==='execute_payload'?3:1]].toBase58(),POOL);
  return {tx,data,report:{signature:receipt.signature,slot:chain.slot,instruction:name,fee_lamports:chain.meta.fee,compute_units:chain.meta.computeUnitsConsumed,wire_bytes:wire.length,message_sha256:digest(tx.message.serialize())}};
}

/** Reconstruct the full uploaded payload and reproduce every signed SDK message.
 * Successful finalized execution is the on-chain verification evidence; this
 * collector does not independently prove the circuit or trust UI proof labels. */
export async function verifyRepeatUploadGroup(group:ObservedTransaction[],operation:'deposit'|'mutual_close',amount:bigint,
  context={program:new PublicKey(PROGRAM),pool:new PublicKey(POOL),owner:new PublicKey(OWNER),mint:new PublicKey(MINT)}){
  const expectedNames=operation==='deposit'?['create_payload','append_payload','seal_payload','execute_payload']
    :['create_payload','append_payload','append_payload','seal_payload','execute_payload'];
  assert.deepEqual(group.map(x=>x.report.instruction),expectedNames);
  const create=group[0].data;assert.equal(create.length,85);assert.equal(create[8],OPERATIONS[operation].op);
  const length=create.readUInt32LE(9);assert.equal(length,OPERATIONS[operation].bytes);const chunks:Buffer[]=[];let offset=0;
  for(const part of group.slice(1,-2)){assert.equal(part.data.readUInt32LE(8),offset);const size=part.data.readUInt32LE(12);
    assert.ok(size>0&&part.data.length===16+size);chunks.push(part.data.subarray(16));offset+=size;}
  const payload=Buffer.concat(chunks);assert.equal(payload.length,length);assert.equal(digest(payload),create.subarray(13,45).toString('hex'));
  assert.equal(group.at(-2)!.data.length,8);assert.equal(group.at(-1)!.data.length,40);assert.ok(group.at(-1)!.data.subarray(8).equals(create.subarray(13,45)));
  const field=(start:number)=>BigInt('0x'+payload.subarray(start,start+32).toString('hex'));
  const noteId=operation==='deposit'?payload.readUInt32LE(0):Number(field(8*32));assert.ok(safeInteger(noteId)&&noteId<=0xffffffff);
  assert.equal(operation==='deposit'?payload.readBigUInt64LE(76):field(9*32),amount);
  assert.equal(field(length-608+96),BigInt(noteId));
  const financial=vaultAccounts({programId:context.program,pool:context.pool,mint:context.mint,payer:context.owner,tokenOwner:context.owner,
    destinationOwner:context.owner,treasuryOwner:context.owner,noteId,operation,
    ...(operation==='mutual_close'?{nullifier:payload.subarray(11*32,12*32)}:{})});
  const plan=await buildUploadPlan({programId:context.program,pool:context.pool,uploader:context.owner,rentPayer:context.owner,feePayer:context.owner,
    nonce:create.subarray(45,77),expires:create.readBigUInt64LE(77),operation,payload,financial,snapshot:{slot:0,sequence:0n},priorityFeeMicroLamports:1n});
  assert.equal(plan.steps.length,group.length);
  for(const [index,entry] of group.entries())assert.ok(Buffer.from(compileV0(plan.steps[index].instruction,context.owner,entry.tx.message.recentBlockhash,1n).message.serialize()).equals(Buffer.from(entry.tx.message.serialize())),'signed message differs from exact reconstructed SDK plan');
  return {operation,note_id:noteId,amount_micro_usdc:amount.toString(),buffer:plan.buffer.toBase58(),payload_sha256:digest(payload),financial,
    ...(operation==='deposit'?{registration_commitment:payload.subarray(44,76).toString('hex'),expiry:payload.readBigUInt64LE(36).toString()}: {})};
}

export async function collectPhantomRepeat(input:any,phase:RepeatPhase,read:ReadRpc=localRead){
  const observation=checkedRepeatObservation(input,phase);assert.equal(await read('getGenesisHash',[]),GENESIS);
  const transactions:ObservedTransaction[]=[];for(const receipt of observation.finalized_transactions)transactions.push(await readTransaction(receipt,read));
  const groups=phase==='withdrawal'?[await verifyRepeatUploadGroup(transactions.slice(0,4),'deposit',1000000n),await verifyRepeatUploadGroup(transactions.slice(4),'mutual_close',999996n)]
    :[await verifyRepeatUploadGroup(transactions,'deposit',2000000n)];
  if(phase==='withdrawal')assert.equal(groups[0].note_id,groups[1].note_id);else assert.equal(groups[0].note_id,1);
  const final=groups.at(-1)!,owner=new PublicKey(OWNER),mint=new PublicKey(MINT);
  const walletAta=vaultAccounts({programId:new PublicKey(PROGRAM),pool:new PublicKey(POOL),mint,payer:owner,tokenOwner:owner,operation:'deposit',noteId:final.note_id}).source;
  const addresses=[walletAta,final.financial.vault,final.financial.note,new PublicKey(POOL),final.financial.tree];
  const lastSlot=transactions.at(-1)!.report.slot;
  const cut=await read('getMultipleAccounts',[addresses.map(x=>x.toBase58()),{encoding:'base64',commitment:'finalized',minContextSlot:lastSlot}]);
  assert.ok(cut&&safeInteger(cut.context?.slot)&&cut.context.slot>=lastSlot&&Array.isArray(cut.value)&&cut.value.length===addresses.length);
  const block=await read('getBlock',[cut.context.slot,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:1}]);
  assert.ok(block&&safeInteger(block.blockHeight));publicKey(block.blockhash);
  const bytes=(index:number,program:string,length:number)=>{const account=cut.value[index];assert.ok(account&&account.executable===false&&account.owner===program&&account.data?.[1]==='base64');
    const b=Buffer.from(account.data[0],'base64');assert.equal(b.toString('base64'),account.data[0]);assert.equal(b.length,length);return b;};
  const tokens=[bytes(0,TOKEN_PROGRAM.toBase58(),165),bytes(1,TOKEN_PROGRAM.toBase58(),165)];
  for(const b of tokens){assert.ok(b.subarray(0,32).equals(mint.toBuffer()));assert.equal(b[108],1);}
  assert.ok(tokens[0].subarray(32,64).equals(owner.toBuffer()));assert.ok(tokens[1].subarray(32,64).equals(final.financial.vaultAuthority.toBuffer()));
  const amounts=tokens.map(b=>b.readBigUInt64LE(64).toString());assert.deepEqual(amounts,phase==='withdrawal'?['38010000','0']:['36010000','2000000']);
  const note=bytes(2,PROGRAM,63),pool=bytes(3,PROGRAM,422),tree=bytes(4,PROGRAM,66);
  for(const [b,name] of [[note,'Note'],[pool,'PoolConfig'],[tree,'TreeState']] as const){assert.ok(b.subarray(0,8).equals(Buffer.from(await discriminator(name,'account'))));assert.equal(b[8],2);}
  assert.ok(pool.subarray(10,42).equals(publicKey(GENESIS).toBuffer()));assert.ok(pool.subarray(42,74).equals(mint.toBuffer()));
  assert.ok(pool.subarray(74,106).equals(TOKEN_PROGRAM.toBuffer()));assert.equal(pool[106],6);assert.ok(pool.subarray(171,203).equals(owner.toBuffer()));assert.equal(pool.readBigUInt64LE(347),1000000n);
  assert.equal(note.readUInt32LE(10),final.note_id);assert.equal(note[62],phase==='withdrawal'?3:1);
  const deposited=groups[0];assert.equal(note.readBigUInt64LE(46).toString(),deposited.amount_micro_usdc);
  assert.equal(note.subarray(14,46).toString('hex'),deposited.registration_commitment);assert.equal(note.readBigUInt64LE(54).toString(),deposited.expiry);
  assert.equal(tree.readBigUInt64LE(58).toString(),phase==='withdrawal'?'0':'2000000');
  return {schema:1,observed_at_utc:new Date().toISOString(),scope:`Independent read-only finalized receipts for the pinned Phantom repeat-demo ${phase} phase`,passed:true,phase,
    pool:POOL,account:OWNER,manifest_hash:MANIFEST,demo_run:observation.demo_run,transactions:transactions.map(x=>x.report),
    uploads:groups.map(({financial,...publicGroup})=>publicGroup),finalized_count:transactions.length,
    new_phase_finalized_count:phase==='withdrawal'?5:4,max_compute_units:Math.max(...transactions.map(x=>x.report.compute_units)),
    max_wire_bytes:Math.max(...transactions.map(x=>x.report.wire_bytes)),total_finalized_fee_lamports:transactions.reduce((n,x)=>n+x.report.fee_lamports,0),
    finalized_balance_cut_slot:cut.context.slot,finalized_balance_cut_blockhash:block.blockhash,finalized_balance_cut_block_height:block.blockHeight,
    wallet_micro_usdc:amounts[0],vault_micro_usdc:amounts[1],note_id:final.note_id,note_status:phase==='withdrawal'?'closed':'active',
    note_deposit_micro_usdc:note.readBigUInt64LE(46).toString(),outstanding_deposits_micro_usdc:tree.readBigUInt64LE(58).toString(),
    wallet_owner_is_treasury_owner:true,prior_sdk_verified_charge_micro_usdc:'4',
    charge_evidence:'docs/evidence/I10-phantom-openai-success-observation.json',
    charge_note:'The wallet also owns the treasury. Its aggregate token balance includes both the remaining note payout and the separately verified 4-micro-USDC charge.',
    expired_setup_recoveries:observation.expired_setup_recoveries,historical_expired_withdrawal_observation:HISTORICAL,
    historical_unverified_create_signature:'5ngFj1eJAQF2TXLU1jftYp6YJ5W886TpyR1nFdRykfC2AVtUjTMYFmeA7h8P2RqC9Z2fD1yoiu6hZaxQYSeSttLb',
    historical_attempt_fee_lamports:null,send_count:null,automatic_resends:null,
    prior_charge_signature_independently_reverified_by_this_collector:false,new_provider_inference_verified:false,full_i10:false,release_gates_passed:[]};
}

async function main(){
  const args=process.argv.slice(2);assert.equal(args.length,6);const values=new Map<string,string>();
  for(let i=0;i<args.length;i+=2){assert.ok(['--observation','--phase','--output'].includes(args[i])&&!values.has(args[i])&&args[i+1]);values.set(args[i],args[i+1]);}
  const input=values.get('--observation')!,phase=values.get('--phase')!;assert.ok(phase==='withdrawal'||phase==='deposit');
  const source=await readFile(input),report=await collectPhantomRepeat(parseStrictJson(source),phase);
  const historical=await readFile(HISTORICAL);
  const output={...report,observation_sha256:digest(source),historical_expired_withdrawal_observation_sha256:digest(historical)};
  await writeFile(values.get('--output')!,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({passed:true,phase,finalized_count:report.finalized_count,new_phase_finalized_count:report.new_phase_finalized_count,
    max_compute_units:report.max_compute_units,max_wire_bytes:report.max_wire_bytes,wallet_micro_usdc:report.wallet_micro_usdc,vault_micro_usdc:report.vault_micro_usdc}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Phantom repeat receipt collection failed; no success report written.');process.exitCode=1;});
