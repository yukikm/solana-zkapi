import {createSolanaRpcWithFetch} from '../src/solana.ts';
import {transactionSignature} from '../src/solana.ts';
import {fixtureSigner, signWith, decodeTransaction, kitAddress} from './kit-helpers.ts';
/** The production WalletClient against actual Vault SBF. Only RPC/finality envelopes
 * and clearance HTTP are local adapters; proofs, signatures, bytes and Vault execute are real. */
/** The production WalletClient against actual Vault SBF. Only RPC/finality envelopes
 * and clearance HTTP are local adapters; proofs, signatures, bytes and Vault execute are real. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';

import bs58 from 'bs58';
import { WalletClient } from '../src/wallet.ts';
import { NoteProver } from '../src/prover.ts';
import { NativeProver } from '../src/prover-node.ts';
import { EncryptedJournal,importJournalKey } from '../src/journal.ts';
import { NativeJournalStore } from '../src/journal-node.ts';
import { validateNoteJournal,type NoteJournal,ControlClient } from '../src/control.ts';
import { restorePlan,type TransportRpc,type V0Wallet } from '../src/transport.ts';
import { SolanaWalletChain } from '../src/wallet-chain.ts';
import { read,digest,walletFixture } from './wallet-fixture.ts';

test('wallet actual SBF: durable witness/finality, rejection, lost sends, stale expiry/root, clearance, escape and finalize', {timeout:240_000},async t=>{
  const {manifest,artifacts}=await walletFixture();
  const executable=resolve('apps/clientd/prover/target/release/zkapi-client-prover');
  const prover=await NoteProver.create(manifest,artifacts,new NativeProver(executable,digest(await read(executable))));
  const svm=spawn(resolve('tests/svm/target/debug/wallet'),[],{stdio:['pipe','pipe','pipe']});let stderr='';svm.stderr.on('data',b=>stderr+=b);
  const pending:{resolve(v:any):void;reject(e:unknown):void}[]=[];
  createInterface({input:svm.stdout}).on('line',line=>{const p=pending.shift();if(p){try{p.resolve(JSON.parse(line));}catch(e){p.reject(e);}}});
  svm.on('exit',code=>{for(const p of pending.splice(0))p.reject(Error(`SBF exited ${code}: ${stderr}`));});
  const call=(value:object)=>new Promise<any>((resolve,reject)=>{pending.push({resolve,reject});svm.stdin.write(JSON.stringify(value)+'\n');});
  t.after(async()=>{if(svm.exitCode===null){const done=once(svm,'exit');svm.stdin.end();await done;}});
  const directory=await mkdtemp(join(tmpdir(),'zkapi-wallet-sbf-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const key=await importJournalKey(crypto.getRandomValues(new Uint8Array(32))),store=await NativeJournalStore.open(directory);
  const open=()=>new EncryptedJournal<NoteJournal>(store,key,{deploymentId:manifest.deployment_id,pool:manifest.pool},validateNoteJournal);let journal=open();
  let rejectWallet=false,loseSend=false,hideReceipt=false;const sent:string[]=[];const ids=['note','interference','escape'];
  const wallet=async(seed:number):Promise<V0Wallet>=>{const pair=(await fixtureSigner(new Uint8Array(32).fill(seed)));return {publicKey:pair.address,supportedTransactionVersions:new Set([0]),async signTransaction(tx){if(rejectWallet)throw Error('test wallet rejected');tx = await signWith(tx, [pair]);return tx;}};};
  const payer=await wallet(1),uploader=await wallet(10);const roles={uploader:uploader.publicKey,rentPayer:payer.publicKey,feePayer:payer.publicKey,payer:payer.publicKey,tokenOwner:payer.publicKey};
  let badGenesis=false,badOwner=false,badRoot=false,badFork=false;
  const fixtureFetch:typeof fetch=async(url,init)=>{
    if(String(url).startsWith('http://127.0.0.1:18889')){
      const path=new URL(String(url)).pathname;
      const value=path.endsWith('/root')?await call({kind:'root'}):await call({kind:'path',note_id:Number(path.split('/')[5])});
      if(badRoot)(value.snapshot??value).root='0x'+'00'.repeat(32);
      return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
    }
    const body=JSON.parse(String(init!.body));let result:any;const args=body.params;
    switch(body.method){
      case 'getGenesisHash':result=badGenesis?bs58.encode(new Uint8Array(32).fill(9)):manifest.genesis_hash;break;
      case 'getBlock':assert.equal(args[1].commitment,'finalized');result={blockhash:bs58.encode(new Uint8Array(32).fill(badFork?9:1)),previousBlockhash:bs58.encode(new Uint8Array(32).fill(1)),parentSlot:args[0]-1,blockTime:3000000000,blockHeight:args[0]};break;
      case 'getMultipleAccounts':assert.equal(args[1].commitment,'finalized');result=await call({kind:'accounts',addresses:args[0]});if(badOwner)result.value[1].owner=bs58.encode(new Uint8Array(32).fill(9));break;
      case 'getAccountInfo':{const cut=await call({kind:'accounts',addresses:[args[0]]});result={context:cut.context,value:cut.value[0]};break;}
      case 'getLatestBlockhash':result={context:{slot:100},value:await call({kind:'blockhash'})};break;
      default:throw Error('unexpected test RPC '+body.method);
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'Content-Type':'application/json'}});
  };
  const connection=createSolanaRpcWithFetch('http://127.0.0.1:18888', fixtureFetch);
  const chain=new SolanaWalletChain(connection,manifest,'http://127.0.0.1:18889',{fetch:fixtureFetch,allowLoopbackHttp:true});
  badGenesis=true;await assert.rejects(chain.snapshot(),/genesis/);badGenesis=false;
  badOwner=true;await assert.rejects(chain.snapshot(),/finalized account/);badOwner=false;
  badRoot=true;await assert.rejects(chain.snapshot(),/indexer root/);badRoot=false;
  badFork=true;await assert.rejects(chain.snapshot(),/finalized cut/);badFork=false;

  const rpc:TransportRpc={signatureStatus:async()=>null,finalizedBlockHeight:async()=>100,finalizedReceipt:async(signature)=>{if(hideReceipt)return null;const v=await call({kind:'receipt',signature});return v?{...v,message:new Uint8Array(Buffer.from(v.message,'base64'))}:null;},sendRawTransaction:async(bytes)=>{
    const signature=transactionSignature(decodeTransaction(bytes));let durable=false;
    for(const id of ids){const r=await journal.read(id);durable ||= !!r?.value.wallet?.operation?.attempts.some(a=>a.signature===signature&&a.wireHex===Buffer.from(bytes).toString('hex'));}
    assert.equal(durable,true,'signed bytes must be encrypted/durable before SBF execution');sent.push(signature);
    const result=await call({kind:'send',base64:Buffer.from(bytes).toString('base64')});if(loseSend){loseSend=false;throw Error('test response lost');}return result.signature;
  }};
  let clearanceRequests:string[]=[];let loseClearance=true,clearanceUnavailable=false;
  const fetcher:typeof fetch=async(_url,init)=>{
    const input=JSON.parse(String(init!.body));clearanceRequests.push(input.nullifier);
    if(clearanceUnavailable)throw Error('test clearance unavailable');
    const signed=await new Promise<string>((resolve,reject)=>{const child=spawn(resolvePath('apps/clientd/prover/target/release/examples/test_clearance'),[],{stdio:['pipe','pipe','pipe']});let result='';child.stdout.on('data',b=>result+=b);child.stderr.resume();child.on('close',code=>code===0?resolve(result):reject(Error('test signer')));child.stdin.end(JSON.stringify({nullifier:input.nullifier,vault_binding:manifest.vault_binding}));});
    if(loseClearance){loseClearance=false;throw Error('test clearance response lost');}return new Response(signed,{headers:{'Content-Type':'application/json'}});
  };
  const options=()=>({manifest,prover,journal,chain,rpc,wallets:[payer,uploader],fetch:fetcher});let client=new WalletClient(options());
  const drive=async(id:string)=>{for(let i=0;i<60;i++){const result=await client.advance(id);if(result.state==='complete')return;if(result.state==='proof_required')await client.resumeProof(id);else if(result.state==='rejected')assert.equal(result.needsNewProof,true);}throw Error('wallet did not finish');};
  await call({kind:'clock',time:3000067199});await client.beginDeposit('note','5000000',roles);
  const initial=(await journal.read('note'))!;assert.equal(initial.value.wallet!.status,'unfunded');const secret=initial.value.witness!.secret;
  rejectWallet=true;await assert.rejects(client.advance('note'),/wallet rejected/);assert.equal((await journal.read('note'))!.value.wallet!.operation!.attempts.length,0);rejectWallet=false;
  loseSend=true;assert.equal((await client.advance('note')).state,'unknown');const current=(await journal.read('note'))!.value.wallet!.operation!.current!;assert.ok(current);
  journal=open();client=new WalletClient(options());await client.advance('note');assert.equal(sent.filter(s=>s===current).length,1,'restart queries finalized receipt before replay');
  while(true){const r=(await journal.read('note'))!,op=r.value.wallet!.operation!,plan=await restorePlan(op.plan!);if(plan.steps[op.step].kind==='execute'&&!op.current)break;await client.advance('note');}
  await call({kind:'clock',time:3000067201});await client.advance('note');const stale=await client.advance('note');assert.equal(stale.state,'rejected');if(stale.state==='rejected')assert.equal(stale.needsNewProof,true);
  assert.equal((await journal.read('note'))!.value.wallet!.status,'unfunded');await drive('note');const deposited=(await journal.read('note'))!;assert.equal(deposited.value.witness!.secret,secret);assert.notEqual(deposited.value.witness!.expiry,initial.value.witness!.expiry);assert.equal(deposited.value.wallet!.status,'active');
  const destination=kitAddress(new Uint8Array(32).fill(7));
  await assert.rejects(client.beginWithdrawal('note','mutual_close',destination,roles),/clearance response lost/);assert.equal((await journal.read('note'))!.value.wallet!.clearance!.phase,'requested');
  await client.resumeProof('note');assert.equal(clearanceRequests.length,2);assert.equal(clearanceRequests[0],clearanceRequests[1]);
  const closeBefore=(await journal.read('note'))!.value.wallet!.operation!.plan!;
  await client.advance('note');await assert.rejects(client.fallbackToEscape('note'),/signed withdrawal/);
  await client.beginDeposit('interference','1000000',roles);await drive('interference');
  await drive('note');const closed=(await journal.read('note'))!;assert.equal(closed.value.wallet!.status,'closed');assert.equal(closed.value.wallet!.clearance!.nullifier,clearanceRequests[0]);
  const closes=closed.value.wallet!.history.at(-1)!.attempts.filter(a=>a.kind==='execute') as any[];assert.equal(closes.length,2);assert.notEqual(closes[0].planDigest,closes[1].planDigest);assert.notEqual(closes[1].plan.expectedRoot,closeBefore.expectedRoot);
  await client.beginDeposit('escape','5000000',roles);await drive('escape');clearanceUnavailable=true;
  await assert.rejects(client.beginWithdrawal('escape','mutual_close',destination,roles),/clearance unavailable/);
  const reserved=(await journal.read('escape'))!.value.wallet!.clearance!.nullifier;
  await client.fallbackToEscape('escape');const fallback=(await journal.read('escape'))!;
  assert.equal(fallback.value.wallet!.clearance!.nullifier,reserved);assert.equal(fallback.value.wallet!.clearance!.phase,'requested');
  assert.equal(fallback.value.wallet!.history.at(-1)!.phase,'cancelled');assert.equal(fallback.value.wallet!.operation!.kind,'initiate_escape');
  assert.equal(fallback.value.wallet!.operation!.destinationOwner,destination);await drive('escape');
  assert.equal((await journal.read('escape'))!.value.wallet!.status,'pending_escape');await assert.rejects(client.beginFinalize('escape',roles),/challenge period/);
  const s=await chain.snapshot((await journal.read('escape'))!.value.witness!.note_id,'zero');await call({kind:'clock',time:Number(s.pending!.deadline)});await client.beginFinalize('escape',roles);
  hideReceipt=true;loseSend=true;await client.advance('escape');const finalAttempt=(await journal.read('escape'))!.value.wallet!.operation!.current!;await client.advance('escape');assert.equal(sent.filter(x=>x===finalAttempt).length,2,'unresolved finalize resends only identical signed bytes');hideReceipt=false;await drive('escape');
  const report=await call({kind:'report'});assert.equal(report.vault_micro_usdc,1000000);assert.equal(report.destination_micro_usdc,10000000);assert.ok(report.rows.filter((row:any)=>row.error!==null).length===2);assert.ok(report.max_cu<=1000000&&report.max_transaction_bytes<=1232);
  t.diagnostic(`Actual SBF: ${report.rows.length} signed transactions, ${report.max_cu} CU maximum, ${report.max_transaction_bytes} bytes maximum`);
});
function resolvePath(path:string):string{return resolve(path);}
