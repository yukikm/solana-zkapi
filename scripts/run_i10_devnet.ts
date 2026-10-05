/** Explicit public DEVNET transport smoke. Never deploys a program or contacts mainnet.
 * A new run signs one zero-lamport self-transfer using the existing SDK v0 signer.
 * Verification reopens the durable public wire record in a fresh process and does
 * not load the private key or resend. This is NOT Vault/provider/wallet-UI E2E. */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, open, rename} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve, join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {Keypair, PublicKey, SystemProgram, VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {compileV0, signV0, verifySignatures} from '../packages/sdk/src/transport.ts';

const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MINT='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const MAX_FEE_LAMPORTS=10000;
const OUT=resolve('target/i10-devnet');
const endpoint=process.env.SOLANA_DEVNET_RPC;
let callId=0;
async function rpc(method:string,params:unknown[]=[],url=endpoint!):Promise<any>{
 const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++callId,method,params}),signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw new Error(`RPC ${method} HTTP ${response.status}`);
 const body=await response.json();
 if(body.error)throw new Error(`RPC ${method} error ${body.error.code}`);
 return body.result;
}
async function durable(path:string,value:object){
 const handle=await open(path+'.tmp','w',0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
 await rename(path+'.tmp',path);
 const parent=await open(resolve(path,'..'),'r');try{await parent.sync();}finally{await parent.close();}
}
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
async function main(){
 assert.ok(endpoint,'SOLANA_DEVNET_RPC required');
 assert.equal(new URL(endpoint).protocol,'https:','public RPC must use HTTPS');
 await mkdir(OUT,{recursive:true,mode:0o700});
 assert.equal(await rpc('getGenesisHash'),GENESIS,'refusing any non-devnet chain');
 if(process.argv.includes('--verify')){
  const pointer=JSON.parse(await readFile(join(OUT,'latest.json'),'utf8'));
  const directory=resolve(OUT,pointer.run);
  assert.ok(directory.startsWith(OUT+'/run-'));
  const record=JSON.parse(await readFile(join(directory,'transaction.json'),'utf8'));
  assert.equal(record.genesis,GENESIS);
  const wire=Buffer.from(record.wire_base64,'base64');
  assert.equal(sha(wire),record.wire_sha256);
  const transaction=VersionedTransaction.deserialize(wire);
  const payer=new PublicKey(record.wallet_public_key);
  assert.ok(wire.length<=1232);
  assert.equal(record.max_fee_lamports,MAX_FEE_LAMPORTS);
  assert.equal(transaction.message.staticAccountKeys[0].toBase58(),payer.toBase58());
  const expected=compileV0(SystemProgram.transfer({fromPubkey:payer,toPubkey:payer,lamports:0}),payer,transaction.message.recentBlockhash);
  assert.deepEqual(transaction.message.serialize(),expected.message.serialize(),'only the declared zero self-transfer is accepted');
  await verifySignatures(transaction);
  assert.equal(bs58.encode(transaction.signatures[0]),record.signature);
  const deadline=Date.now()+120000;let receipt:any=null;
  while(Date.now()<deadline){
   receipt=await rpc('getTransaction',[record.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
   if(receipt)break;
   await new Promise(r=>setTimeout(r,1500));
  }
  assert.ok(receipt,'finalized receipt not yet available; rerun --verify, do not resend');
  assert.equal(receipt.version,0);assert.equal(receipt.meta.err,null);
  assert.equal(receipt.transaction[0],record.wire_base64,'finalized wire must match saved signed bytes exactly');
  assert.ok(Number.isSafeInteger(receipt.meta.fee)&&receipt.meta.fee>0&&receipt.meta.fee<=MAX_FEE_LAMPORTS);
  assert.equal(receipt.meta.preBalances[0]-receipt.meta.postBalances[0],receipt.meta.fee,'zero transfer changes payer only by fee');
  const result={passed:true,scope:'public devnet native keypair + existing SDK compileV0/signV0 + real finalized exact-wire receipt; zero-lamport self-transfer only',genesis:GENESIS,rpc_host:new URL(endpoint!).hostname,wallet_public_key:record.wallet_public_key,signature:record.signature,slot:receipt.slot,transaction_bytes:wire.length,compute_units:receipt.meta.computeUnitsConsumed,fee_lamports:String(receipt.meta.fee),wire_sha256:record.wire_sha256,persisted_before_send:true,fresh_process_verification:true,verification_loads_private_key:false,automatic_resends:0,simulation:record.simulation,preflight:record.preflight,source_sha256:record.source_sha256,verified_at_utc:new Date().toISOString(),Vault_E2E_verified:false,wallet_UI_verified:false,live_provider_verified:false,I10_complete:false,release_gates_passed:[]};
  Object.assign(result,{verification_source_sha256:sha(await readFile('scripts/run_i10_devnet.ts'))});
  await durable(join(directory,'results.json'),result);await durable(join(OUT,'runtime-report.json'),result);
  console.log(JSON.stringify(result));return;
 }
 assert.ok(process.argv.includes('--new'),'Use --new for one explicit devnet test or --verify for existing signed bytes');
 const source=process.env.WALLET_PRIVATE_KEY_PATH??process.env.SOLANA_TEST_WALLET_PATH;
 assert.ok(source,'wallet path setting required');
 const raw=(await readFile(source.replace(/^~(?=\/)/,homedir()),'utf8')).trim();
 let value:any;try{value=JSON.parse(raw);}catch{value=raw;}
 const secret=typeof value==='string'?bs58.decode(value):Uint8Array.from(value.secretKey??value);
 const key=secret.length===32?Keypair.fromSeed(secret):Keypair.fromSecretKey(secret);
 const wallet=key.publicKey.toBase58();
 const balance=await rpc('getBalance',[wallet,{commitment:'finalized'}]);assert.ok(balance.value>=10000);
 const mint=await rpc('getAccountInfo',[MINT,{encoding:'jsonParsed',commitment:'finalized'}]);
 assert.equal(mint.value.owner,'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');assert.equal(mint.value.data.parsed.info.decimals,6);
 const program=JSON.parse(await readFile('target/i05/public-manifest.json','utf8')).program_id;
 const programAccount=await rpc('getAccountInfo',[program,{encoding:'base64',commitment:'finalized'}]);
 const latest=await rpc('getLatestBlockhash',[{commitment:'finalized'}]);
 const tx=await signV0(compileV0(SystemProgram.transfer({fromPubkey:key.publicKey,toPubkey:key.publicKey,lamports:0}),key.publicKey,latest.value.blockhash),[{publicKey:key.publicKey,supportedTransactionVersions:new Set([0]),async signTransaction(t){t.sign([key]);return t;}}]);
 secret.fill(0);
 const wire=tx.serialize(),signature=bs58.encode(tx.signatures[0]);
 const fee=await rpc('getFeeForMessage',[Buffer.from(tx.message.serialize()).toString('base64'),{commitment:'finalized'}]);
 assert.ok(Number.isSafeInteger(fee.value)&&fee.value>0&&fee.value<=10000);
 const simulation=await rpc('simulateTransaction',[Buffer.from(wire).toString('base64'),{encoding:'base64',sigVerify:true,commitment:'confirmed'}]);
 assert.equal(simulation.value.err,null,'devnet simulation must succeed before send');
 const run='run-'+randomUUID(),directory=join(OUT,run);await mkdir(directory,{mode:0o700});
 const record={genesis:GENESIS,wallet_public_key:wallet,signature,wire_base64:Buffer.from(wire).toString('base64'),wire_sha256:sha(wire),last_valid_block_height:latest.value.lastValidBlockHeight,max_fee_lamports:10000,created_at_utc:new Date().toISOString(),simulation:{success:true,units_consumed:simulation.value.unitsConsumed},preflight:{balance_lamports:String(balance.value),devnet_usdc_mint:MINT,devnet_usdc_decimals:6,vault_program:program,vault_program_exists:!!programAccount.value},source_sha256:Object.fromEntries(await Promise.all(['scripts/run_i10_devnet.ts','packages/sdk/src/transport.ts','package-lock.json'].map(async p=>[p,sha(await readFile(p))])))};
 await durable(join(directory,'transaction.json'),record);await durable(join(OUT,'latest.json'),{run});
 // One submission only. A timeout/unknown result is resolved via --verify.
 const returned=await rpc('sendTransaction',[record.wire_base64,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0}]);
 assert.equal(returned,signature);
 console.log(JSON.stringify({submitted:true,signature,transaction_bytes:wire.length,fee_lamports:String(fee.value),next:'--verify in a fresh process; no resend'}));
}
main().catch(error=>{console.error(JSON.stringify({passed:false,error_type:error.name,message:/^(RPC |refusing|finalized receipt|devnet simulation)/.test(error.message)?error.message:'devnet acceptance check failed; secret details suppressed'}));process.exitCode=1;});
