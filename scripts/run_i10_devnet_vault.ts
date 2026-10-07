/** Explicit TEST-ONLY devnet Vault acceptance. Uses the existing WalletClient,
 * encrypted journal, native prover and finalized transport. Explicit provider plans
 * additionally require the pre-existing bounded campaign; other paths call no provider.
 * Secrets remain in ignored private files and all errors are sanitized. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,open,rename,stat,unlink} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomBytes,randomUUID,createPrivateKey,sign} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createDevnetPinnedFetch,startDevnetFrontend} from './i10_devnet_transport.ts';
import {Connection,Keypair,PublicKey,SystemProgram,TransactionInstruction,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {compileV0,signV0,verifySignatures,connectionTransport,discriminator,recoverAttempt,type Attempt,type V0Wallet} from '../packages/sdk/src/transport.ts';
import {vaultBinding,parseField} from '../packages/sdk/src/encoding.ts';
import {verifyManifest,verifyPoolConfig,manifestDigest,type ArtifactBundle} from '../packages/sdk/src/trust.ts';
import {NoteProver} from '../packages/sdk/src/prover.ts';
import {NativeProver} from '../packages/sdk/src/prover-node.ts';
import {EncryptedJournal,importJournalKey} from '../packages/sdk/src/journal.ts';
import {NativeJournalStore} from '../packages/sdk/src/journal-node.ts';
import {validateNoteJournal,verifiedClientContext,type NoteJournal} from '../packages/sdk/src/control.ts';
import {NativeSessionVerifier} from '../packages/sdk/src/control-node.ts';
import {WalletClient} from '../packages/sdk/src/wallet.ts';
import {SolanaWalletChain} from '../packages/sdk/src/wallet-chain.ts';
import {boundedDevnetSnapshotChain,snapshotWaitStats,type DevnetSnapshotChain} from './i10_devnet_snapshot_chain.ts';
import {runDevnetChallenge,type DevnetChallengeReport,type EscapeReady} from './i10_devnet_challenge.ts';
import {runDevnetClearanceRecovery} from './i10_devnet_clearance_recovery.ts';
import {runDevnetProviderAcceptance,validateProviderSelection,validatePreparedProviderConfig} from './i10_devnet_provider.ts';
import {verifySettledProviderCase,verifyUnstartedProviderCase} from './i10_devnet_provider_recovery.ts';
import {devnetPoolInstance} from './i10_devnet_pool_instance.ts';
import {publicDevnetOptions,loadPublicDevnetProfile,publicDevnetManifestBase} from './i10_public_devnet_profile.ts';
const publicOptions=publicDevnetOptions(process.argv.slice(2));
const ROOT=resolve('.'),DEPLOYMENT=publicOptions?.deployment??resolve('target/i10-devnet-vault');
const poolRun=process.argv.find(arg=>arg.startsWith('--pool='))?.slice(7);
const providerProfile=process.argv.find(arg=>arg.startsWith('--provider-profile='))?.slice(19);
const poolInstance=devnetPoolInstance(process.argv.slice(2),DEPLOYMENT,poolRun,providerProfile);
const OUT=poolInstance.output;
const challengePool=['challenge','challenge-final','challenge-batched','challenge-live'].includes(poolRun??'');
const port=poolRun==='wallet'?18983:poolRun==='wallet-ui'?19183:poolRun==='provider'?Number(process.argv.find(arg=>arg.startsWith('--provider-port='))?.split('=')[1]??(providerProfile==='openai-ui'?'19383':'19283')):challengePool?19083:18883;
const daemonChallenge=process.argv.includes('--daemon-challenge');
const recoverUncertainAuth=process.argv.includes('--recover-stale-uncertain-auth');
const recoverProviderAuth=process.argv.includes('--recover-unaccepted-provider-auth');
const withdrawSettledProvider=process.argv.includes('--withdraw-settled-provider-case');
const withdrawUnstartedProvider=process.argv.includes('--withdraw-unstarted-provider-case');
const providerRecovery=recoverProviderAuth||withdrawSettledProvider||withdrawUnstartedProvider;
const providerPlan=process.argv.find(arg=>arg.startsWith('--provider-plan='))?.slice(16);
const PROVIDER_STATE=resolve('target/i10-provider-acceptance');
const PROVIDER_CONFIGURATION=providerProfile?join(PROVIDER_STATE,'configurations',providerProfile):PROVIDER_STATE;
const mutual=daemonChallenge||!!providerPlan||process.argv.includes('--mutual-close'),RUN=daemonChallenge?join(OUT,'daemon-challenge'):mutual?join(OUT,'mutual-close'):OUT;
const GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MINT='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const ELF=publicOptions?join(DEPLOYMENT,'zkapi_vault.so'):resolve('target/i10-devnet-sbf/zkapi_vault.so'),IDL=join(DEPLOYMENT,'vault-idl.json');
const INDEXER=`https://127.0.0.1:${port+1}`,INDEXER_INTERNAL=`http://127.0.0.1:${port}`;
let stage='preflight';
let lastClearanceHttpStatus:number|undefined;
const invocationId=randomUUID();
const indexerWaitSeconds=Number(process.argv.find(arg=>arg.startsWith('--indexer-wait-seconds='))?.split('=')[1]??'600');
const snapshotWaitSeconds=Number(process.argv.find(arg=>arg.startsWith('--snapshot-wait-seconds='))?.split('=')[1]??'60');
const sha=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex');
const read=async(p:string)=>new Uint8Array(await readFile(p));
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function exists(p:string){try{return(await stat(p)).isFile();}catch{return false;}}
async function durable(p:string,value:unknown){await mkdir(dirname(p),{recursive:true,mode:0o700});const h=await open(p+'.tmp','w',0o600);try{await h.writeFile(JSON.stringify(value,null,2)+'\n');await h.sync();}finally{await h.close();}await rename(p+'.tmp',p);const d=await open(dirname(p),'r');try{await d.sync();}finally{await d.close();}}
async function privateWallet(){const p=process.env.WALLET_PRIVATE_KEY_PATH??process.env.SOLANA_TEST_WALLET_PATH;assert.ok(p);const raw=(await readFile(p.replace(/^~(?=\/)/,homedir()),'utf8')).trim();let v:any;try{v=JSON.parse(raw);}catch{v=raw;}const bytes=typeof v==='string'?bs58.decode(v):Uint8Array.from(v.secretKey??v);return bytes.length===32?Keypair.fromSeed(bytes):Keypair.fromSecretKey(bytes);}
function wallet(k:Keypair):V0Wallet{return{publicKey:k.publicKey,supportedTransactionVersions:new Set([0]),async signTransaction(tx){tx.sign([k]);return tx;}};}
async function command(executable:string,args:string[],env=process.env){return new Promise<void>((ok,no)=>{const p=spawn(executable,args,{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});let text='';p.stdout.on('data',b=>text+=b);p.stderr.on('data',b=>text+=b);p.on('error',()=>no(Error('command unavailable')));p.on('close',code=>{if(code===0)ok();else{const endpoint=process.env.SOLANA_DEVNET_RPC??'';const safe=endpoint?text.split(endpoint).join('[RPC]'):text;void writeFile(join(OUT,'command-failure.log'),safe,{mode:0o600}).then(()=>no(Error('command failed; private local diagnostic retained')));}});});}
async function main(){
 assert.ok(publicOptions?!process.argv.includes('--allow-legacy-devnet-fixtures'):process.argv.includes('--allow-legacy-devnet-fixtures'),'choose public profile pins or explicit historical fixture mode');
 const publicProfile=publicOptions?await loadPublicDevnetProfile(publicOptions.directory,publicOptions.sha256):undefined;
 if(process.argv.includes('--validate-public-profile')){assert.ok(publicProfile,'explicit public profile required');console.log(JSON.stringify({validated:true,scope:'offline public-devnet profile and artifact integrity only',public_profile_sha256:publicProfile.sha256,tree_setup:publicProfile.profile.tree_setup,production_eligible:false,deployment_directory:DEPLOYMENT}));return;}
 assert.ok(poolRun===undefined||['wallet','wallet-ui','provider','challenge','challenge-final','challenge-batched','challenge-live'].includes(poolRun),'known bounded test pool required');
 assert.ok(Number.isSafeInteger(indexerWaitSeconds)&&indexerWaitSeconds>=1&&indexerWaitSeconds<=1800,'bounded indexer wait required');
 assert.ok(Number.isSafeInteger(snapshotWaitSeconds)&&snapshotWaitSeconds>=1&&snapshotWaitSeconds<=1800,'bounded snapshot wait required');
 assert.ok(!providerProfile||(poolRun==='provider'&&/^[a-z][a-z0-9_-]{0,63}$/.test(providerProfile)),'provider profile name required');
 assert.ok(!providerProfile||!process.argv.includes('--lifecycle')||providerPlan,'provider profile lifecycle requires its explicit plan');
 assert.ok(Number.isSafeInteger(port)&&port>=1024&&port<=65530,'bounded listen port required');
 assert.ok(providerProfile!=='openai-ui'||!process.argv.includes('--lifecycle'),'OpenAI UI profile requires browser wallet');
 assert.ok(!daemonChallenge||challengePool,'daemon challenge requires dedicated 600-second test pool');
 assert.ok(!providerPlan||poolRun==='provider'&&!daemonChallenge&&!recoverUncertainAuth,'public provider acceptance requires its dedicated pool');
 assert.ok(!providerRecovery||(providerProfile&&providerPlan&&process.argv.includes('--lifecycle')),'provider recovery requires the explicit existing lifecycle/profile/plan');
 assert.ok([recoverProviderAuth,withdrawSettledProvider,withdrawUnstartedProvider].filter(Boolean).length<=1,'choose one explicit provider recovery path');
 assert.ok(poolRun!=='wallet-ui'||!process.argv.includes('--lifecycle'),'wallet UI pool uses Chrome and Phantom');

 if(recoverUncertainAuth){assert.ok(daemonChallenge&&poolRun==='challenge-batched','existing failed test case required');for(const name of ['balance-before.json','private-journal-key.json','send-observations.json','stale-challenge/private-journal-key.bin'])assert.ok(await exists(join(RUN,name)),'required existing recovery evidence is missing');}
 if(providerRecovery){for(const name of ['balance-before.json','private-journal-key.json','send-observations.json','provider-campaign.json'])assert.ok(await exists(join(RUN,name)),'existing provider recovery state is required');}
 await mkdir(OUT,{recursive:true,mode:0o700});await mkdir(RUN,{recursive:true,mode:0o700});
 if(providerPlan&&process.argv.includes('--lifecycle')){
  const env:NodeJS.ProcessEnv={};for(const name of ['PATH','HOME','LANG','LC_ALL','TMPDIR'])if(process.env[name])env[name]=process.env[name];
  // No deposit/authorization may precede validation of the existing campaign.
  // The coordinator refuses missing state; this path never resets its budget.
  await command('python3',['scripts/provider_demo_budget.py','budget-status','--plan',resolve(providerPlan),'--state-dir',PROVIDER_STATE],env);
  const plan=await json(resolve(providerPlan));
  const execution=providerProfile?validateProviderSelection(plan,await json(join(PROVIDER_CONFIGURATION,'selection.json')),providerProfile):plan;
  assert.deepEqual(await json(join(PROVIDER_CONFIGURATION,'tariffs.json')),execution.models.map((entry:{tariff:unknown})=>entry.tariff),'prepared tariffs must match the selected parent plan');
  validatePreparedProviderConfig(execution,await json(join(PROVIDER_CONFIGURATION,'providers.json')));
 }
 const executionSource=await read('scripts/run_i10_devnet_vault.ts');
 const helperSources=['scripts/i10_devnet_transport.ts','scripts/i10_devnet_snapshot_chain.ts','scripts/i10_devnet_pool_instance.ts',...(publicProfile?['scripts/i10_public_devnet_profile.ts']:[]),...(providerPlan?['scripts/i10_devnet_provider.ts','scripts/provider_acceptance_client.ts','scripts/provider_acceptance.py','scripts/provider_demo_budget.py']:[]),...(withdrawSettledProvider||withdrawUnstartedProvider?['scripts/i10_devnet_provider_recovery.ts','scripts/provider_demo_budget.ts']:[])];
 const executionHelperHashes=Object.fromEntries(await Promise.all(helperSources.map(async path=>[path,sha(await read(path))])));
 const challengeSource=daemonChallenge?await read('scripts/i10_devnet_challenge.ts'):null;
 const endpoint=process.env.SOLANA_DEVNET_RPC;assert.ok(endpoint);assert.equal(new URL(endpoint).protocol,'https:');
 const connection=new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true});
 assert.equal(await connection.getGenesisHash(),GENESIS,'devnet required before private-key access');
 const key=await privateWallet(),owner=key.publicKey;
 if(process.argv.includes('--prepare-challenger-key')){assert.ok(challengePool);await durable(join(OUT,'private-challenger-fee-key.json'),[...key.secretKey]);console.log(JSON.stringify({private_challenger_fee_key_prepared:true,payer:owner.toBase58()}));return;}
 const configFile=join(OUT,'deployment.json'),programFile=join(DEPLOYMENT,'program-keypair.json');
 if(process.argv.includes('--prepare')){
  if(poolRun)await writeFile(join(OUT,'vault-idl.json'),await readFile(IDL),{mode:0o600});
  if(!await exists(programFile))await durable(programFile,[...Keypair.generate().secretKey]);
  const program=Keypair.fromSecretKey(Uint8Array.from(await json(programFile))).publicKey;
  if(!await exists(configFile)){const poolId=randomBytes(32);const pool=PublicKey.findProgramAddressSync([Buffer.from('pool'),poolId],program)[0];await durable(configFile,{schema:1,genesis:GENESIS,program_id:program.toBase58(),initializer:owner.toBase58(),pool_id_hex:poolId.toString('hex'),pool:pool.toBase58(),mint:MINT,token_program:TOKEN,ttl_seconds:'3600',challenge_seconds:challengePool?'600':'60',cap_micro_usdc:'1000000',deposit_micro_usdc:poolRun==='provider'&&providerProfile!=='openai-ui'?'10000000':'1000000',maximum_program_rent_lamports:'4000000000',maximum_transaction_fee_lamports:'10000',created_at_utc:new Date().toISOString(),...(publicProfile?{public_profile_sha256:publicProfile.sha256}: {})});}
  const cfg=await json(configFile);assert.equal(cfg.public_profile_sha256,publicProfile?.sha256,'existing deployment profile cannot change');assert.equal(cfg.program_id,program.toBase58());assert.equal(cfg.initializer,owner.toBase58());assert.equal(cfg.genesis,GENESIS);
  console.log(JSON.stringify({prepared:true,program_id:cfg.program_id,initializer:cfg.initializer,pool:cfg.pool,public_build_env:{ZKAPI_DEVNET_PROGRAM_ID:cfg.program_id,ZKAPI_DEVNET_INITIALIZER:cfg.initializer,...(publicProfile?{ZKAPI_PUBLIC_DEVNET_PROFILE:publicProfile.directory,ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256:publicProfile.sha256}:{ZKAPI_ALLOW_LEGACY_DEVNET_FIXTURES:'1'})}}));return;
 }
 const cfg=await json(configFile),program=new PublicKey(cfg.program_id),pool=new PublicKey(cfg.pool),mint=new PublicKey(MINT);
 assert.equal(cfg.public_profile_sha256,publicProfile?.sha256,'existing deployment profile cannot change');
 assert.equal(cfg.genesis,GENESIS);assert.equal(cfg.initializer,owner.toBase58());assert.equal(cfg.mint,MINT);
 assert.equal(Keypair.fromSecretKey(Uint8Array.from(await json(programFile))).publicKey.toBase58(),cfg.program_id);
 assert.match(cfg.pool_id_hex,/^[0-9a-f]{64}$/);assert.equal(PublicKey.findProgramAddressSync([Buffer.from('pool'),Buffer.from(cfg.pool_id_hex,'hex')],program)[0].toBase58(),cfg.pool);
 const elf=await read(ELF),idl=await read(IDL);assert.equal(JSON.parse(Buffer.from(idl).toString()).address,cfg.program_id);
 const base=publicProfile?publicDevnetManifestBase(publicProfile):await json('target/i05/public-manifest.json');
 const build={schema:publicProfile?2:1,...(publicProfile?{public_profile_sha256:publicProfile.sha256,tree_setup:'single_party_os_random'}:{}),deployment_environment:'devnet',setup_profile:'test_only',program_id:cfg.program_id,deployment_authority:cfg.initializer,genesis_hash:GENESIS,mint:MINT,token_program:TOKEN,idl_sha256:sha(idl),program_sha256:sha(elf),state_key:base.state_key,clearance_key:base.clearance_key,circuit_profile_hash:base.circuit_profile_hash};
 if(publicProfile&&await exists(join(OUT,'build-manifest.json')))assert.deepEqual(await json(join(OUT,'build-manifest.json')),build,'public deployment build cannot change; prepare a new program/pool');
 await durable(join(OUT,'build-manifest.json'),build);
 const buildBytes=await read(join(OUT,'build-manifest.json'));
 const verifyProgram=async()=>{const a=await connection.getAccountInfo(program,'finalized');assert.ok(a?.executable);assert.equal(a.owner.toBase58(),LOADER);assert.equal(a.data.readUInt32LE(0),2);const address=new PublicKey(a.data.subarray(4,36));assert.equal(address.toBase58(),PublicKey.findProgramAddressSync([program.toBytes()],new PublicKey(LOADER))[0].toBase58());const d=await connection.getAccountInfo(address,'finalized');assert.ok(d);assert.equal(d.owner.toBase58(),LOADER);assert.equal(d.data.readUInt32LE(0),3);assert.equal(d.data[12],1);assert.equal(new PublicKey(d.data.subarray(13,45)).toBase58(),cfg.initializer);assert.deepEqual(d.data.subarray(45,45+elf.length),Buffer.from(elf));assert.ok(d.data.subarray(45+elf.length).every(b=>b===0));return{program_data:address.toBase58(),deployed_program_sha256:sha(d.data.subarray(45,45+elf.length)),upgrade_authority:cfg.initializer};};
 if(process.argv.includes('--deploy')){
  stage='deployment';
  const previous=await connection.getAccountInfo(program,'finalized');
  if(previous){const verified=await verifyProgram();console.log(JSON.stringify({already_deployed:true,...verified}));return;}
  const rent=await connection.getMinimumBalanceForRentExemption(elf.length+45);assert.ok(rent<=Number(cfg.maximum_program_rent_lamports));assert.ok(await connection.getBalance(owner,'finalized')>rent*2+10000000);
  const cliWallet=join(OUT,'temporary-cli-wallet.json'),cliConfig=join(OUT,'private-cli.yml'),bufferFile=join(OUT,'deploy-buffer-keypair.json');
  if(!await exists(bufferFile))await durable(bufferFile,[...Keypair.generate().secretKey]);
  const beforeLamports=await connection.getBalance(owner,'finalized');
  await durable(cliWallet,[...key.secretKey]);await writeFile(cliConfig,JSON.stringify({json_rpc_url:endpoint,websocket_url:'',keypair_path:cliWallet,address_labels:{},commitment:'finalized'}),{mode:0o600});
  try{await command('solana',['--config',cliConfig,'program','deploy','--program-id',programFile,'--buffer',bufferFile,'--max-len',String(elf.length),'--with-compute-unit-price','0','--max-sign-attempts','1',ELF]);}finally{await unlink(cliWallet);await unlink(cliConfig);}
  const verified=await verifyProgram(),afterLamports=await connection.getBalance(owner,'finalized');const netCost=beforeLamports-afterLamports;
  const maximumNetCost=rent+await connection.getMinimumBalanceForRentExemption(36)+20000000;assert.ok(netCost>=0&&netCost<=maximumNetCost);
  await durable(join(OUT,'deployed.json'),{...verified,rent_estimate_lamports:String(rent),observed_net_cost_lamports:String(netCost),maximum_net_cost_lamports:String(maximumNetCost),compute_unit_price_micro_lamports:'0',maximum_sign_attempts:1,deployment_fee_bound_scope:'CLI batch deployment, separately bounded from 10000-lamport wallet operation fees',program_sha256:sha(elf),verified_at_utc:new Date().toISOString()});console.log(JSON.stringify({deployed:true,...verified,observed_net_cost_lamports:String(netCost)}));return;
 }
 const verifiedProgram=await verifyProgram();
 const derive=(seed:string)=>PublicKey.findProgramAddressSync([Buffer.from(seed),pool.toBytes()],program)[0];
 const tree=derive('tree'),authority=derive('vault');
 const vault=PublicKey.findProgramAddressSync([authority.toBytes(),new PublicKey(TOKEN).toBytes(),mint.toBytes()],new PublicKey(ATA))[0];
 const u64=(v:string)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(v));return b;};
 const signAndFinalize=async(name:string,instruction:TransactionInstruction)=>{
  const path=join(OUT,name+'-transaction.json');let record:any;
  if(await exists(path))record=await json(path);
  else{const bh=await connection.getLatestBlockhash('finalized');const tx=await signV0(compileV0(instruction,owner,bh.blockhash),[wallet(key)]);const wire=tx.serialize();const fee=(await connection.getFeeForMessage(tx.message,'finalized')).value;assert.ok(fee&&fee<=Number(cfg.maximum_transaction_fee_lamports));assert.ok(wire.length<=1232);record={signature:bs58.encode(tx.signatures[0]),wire_base64:Buffer.from(wire).toString('base64'),wire_sha256:sha(wire),last_valid_block_height:bh.lastValidBlockHeight,prepared_at_utc:new Date().toISOString()};await durable(path,record);assert.equal(await connection.sendRawTransaction(wire,{skipPreflight:false,maxRetries:0,preflightCommitment:'finalized'}),record.signature);}
  const saved=VersionedTransaction.deserialize(Buffer.from(record.wire_base64,'base64'));await verifySignatures(saved);assert.deepEqual(saved.message.serialize(),compileV0(instruction,owner,saved.message.recentBlockhash).message.serialize());assert.equal(sha(saved.serialize()),record.wire_sha256);assert.equal(bs58.encode(saved.signatures[0]),record.signature);
  for(let i=0;i<100;i++){const r=await connection.getTransaction(record.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(r){assert.equal(r.meta?.err,null);assert.ok(r.meta!.fee<=Number(cfg.maximum_transaction_fee_lamports));assert.deepEqual(r.transaction.message.serialize(),saved.message.serialize());await durable(join(OUT,name+'-receipt.json'),{signature:record.signature,slot:r.slot,fee_lamports:String(r.meta!.fee),compute_units:r.meta!.computeUnitsConsumed,wire_sha256:record.wire_sha256});return r.slot;}await sleep(1500);}throw Error('saved signed transaction unresolved; rerun for read-only recovery');
 };
 if(process.argv.includes('--initialize')){
  stage='initialize';
  const existingPool=await connection.getAccountInfo(pool,'finalized');
  assert.ok(!existingPool||await exists(join(OUT,'initialize-transaction.json')),'existing pool without saved initialize attempt');
  const readonly=(pubkey:PublicKey,isSigner=false)=>({pubkey,isSigner,isWritable:false});const writable=(pubkey:PublicKey,isSigner=false)=>({pubkey,isSigner,isWritable:true});const keys=[writable(pool),writable(tree),readonly(authority),readonly(mint),writable(vault),readonly(owner,true),readonly(owner,true),writable(owner,true),readonly(new PublicKey(TOKEN)),readonly(new PublicKey(ATA)),readonly(SystemProgram.programId)];const data=Buffer.concat([Buffer.from(await discriminator('initialize_pool')),Buffer.from(cfg.pool_id_hex,'hex'),Buffer.from(bs58.decode(GENESIS)),Buffer.from(parseField(base.state_key.x)),Buffer.from(parseField(base.state_key.y)),Buffer.from(parseField(base.clearance_key.x)),Buffer.from(parseField(base.clearance_key.y)),u64(cfg.ttl_seconds),u64(cfg.challenge_seconds),u64(cfg.cap_micro_usdc),owner.toBuffer(),owner.toBuffer()]);await signAndFinalize('initialize',new TransactionInstruction({programId:program,keys,data}));
  const init=await json(join(OUT,'initialize-receipt.json'));console.log(JSON.stringify({initialized:true,pool:cfg.pool,slot:init.slot}));return;
 }
 assert.ok(process.argv.includes('--lifecycle')||process.argv.includes('--admin-check')||process.argv.includes('--configure'),'choose --prepare, --deploy, --initialize, --admin-check or --lifecycle');
 stage='manifest';
 const m=structuredClone(base);
 Object.assign(m,{deployment_id:'i10-devnet-'+cfg.program_id+(poolRun?'-'+poolRun:'')+(providerProfile?'-'+providerProfile:'')+poolInstance.deploymentSuffix,deployment_environment:'devnet',genesis_hash:GENESIS,program_id:cfg.program_id,pool:cfg.pool,mint:MINT,token_program:TOKEN,control_api_origin:`https://127.0.0.1:${port+2}`,inference_api_origin:`https://127.0.0.1:${port+3}`,proving_keys_base_url:`https://127.0.0.1:${port+2}/keys`,note_ttl_seconds:cfg.ttl_seconds,challenge_seconds:cfg.challenge_seconds,cap_micro_usdc:cfg.cap_micro_usdc,idl_hash:sha(idl),vault_binding:await vaultBinding(bs58.decode(GENESIS),program.toBytes(),pool.toBytes(),new PublicKey(TOKEN).toBytes(),mint.toBytes()),authorities:{admin:{kind:'devnet_test_single_key',authority:owner.toBase58()},upgrade:{kind:'devnet_test_single_key',authority:owner.toBase58()}},artifact_digests:{vault_idl:sha(idl),vault_program:sha(elf),devnet_build_manifest:sha(buildBytes),...(publicProfile?{public_devnet_profile:publicProfile.sha256}:{})}});
 if(providerPlan){const tariffs=await json(join(PROVIDER_CONFIGURATION,'tariffs.json'));assert.ok(Array.isArray(tariffs)&&tariffs.length>0);m.tariff_hashes=tariffs.map(t=>t.tariff_hash);}
 m.manifest_hash=await manifestDigest(m);
 const distributionKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(key.secretKey.subarray(0,32))]),format:'der',type:'pkcs8'});
 m.manifest_signature=sign(null,Buffer.from(m.manifest_hash,'hex'),distributionKey).toString('base64');if(publicProfile&&await exists(join(OUT,'public-manifest.json')))assert.deepEqual(await json(join(OUT,'public-manifest.json')),m,'public deployment manifest cannot change; preserve journal identity');await durable(join(OUT,'public-manifest.json'),m);
 const manifest=await verifyManifest(new TextEncoder().encode(JSON.stringify(m)),{anchor:{kind:'ed25519',publicKey:owner.toBase58()},expected:{deployment_id:m.deployment_id,deployment_environment:'devnet',genesis_hash:GENESIS,program_id:cfg.program_id,pool:cfg.pool,mint:MINT,token_program:TOKEN,control_api_origin:m.control_api_origin,inference_api_origin:m.inference_api_origin},build:{stateKey:m.state_key,clearanceKey:m.clearance_key,circuitProfileHash:m.circuit_profile_hash,idlHash:m.idl_hash,setupProfile:'test_only',...(publicProfile?{transactionFormats:['v0_buffer','v0_inline_deposit_v1'] as const}:{})}});
 if(process.argv.includes('--admin-check')){
  stage='admin-check';
  assert.equal((await connection.getTokenAccountBalance(vault,'finalized')).value.amount,'0','admin check requires the empty test vault');
  const observed=async(minimum=0)=>{const a=await connection.getAccountInfoAndContext(pool,{commitment:'finalized',minContextSlot:minimum});assert.ok(a.value);return verifyPoolConfig(manifest,GENESIS,{address:cfg.pool,owner:a.value.owner.toBase58(),executable:a.value.executable,lamports:BigInt(a.value.lamports),data:a.value.data,slot:BigInt(a.context.slot),commitment:'finalized'},BigInt(minimum));};
  const done=join(OUT,'admin-results.json');
  if(await exists(done)){const state=await observed();assert.equal(state.paused,false);assert.equal(state.treasuryOwner,cfg.initializer);console.log(JSON.stringify({admin_previously_completed:true,current_pool_unpaused:true}));return;}
  const ix=async(name:string,data:Uint8Array=Buffer.alloc(0))=>new TransactionInstruction({programId:program,keys:[{pubkey:pool,isWritable:true,isSigner:false},{pubkey:owner,isWritable:false,isSigner:true}],data:Buffer.concat([Buffer.from(await discriminator(name)),data])});
  const pauseSlot=await signAndFinalize('admin-pause',await ix('pause'));
  const pauseEvidence=join(OUT,'admin-pause-state.json');
  if(!await exists(pauseEvidence)){const state=await observed(pauseSlot);assert.equal(state.paused,true);await durable(pauseEvidence,{paused:true,slot:state.slot.toString(),treasury_owner:state.treasuryOwner});}
  await signAndFinalize('admin-set-treasury',await ix('set_treasury',owner.toBuffer()));
  const finalSlot=await signAndFinalize('admin-unpause',await ix('unpause'));
  const state=await observed(finalSlot);assert.equal(state.paused,false);assert.equal(state.treasuryOwner,cfg.initializer);
  const rows=[];for(const name of ['admin-pause','admin-set-treasury','admin-unpause'])rows.push(await json(join(OUT,name+'-receipt.json')));
  await durable(done,{passed:true,scope:'actual devnet admin pause -> set_treasury(same existing owner) -> unpause, empty test Vault',rows,pause_observed:await json(pauseEvidence),final_paused:state.paused,treasury_owner:state.treasuryOwner,source_sha256:sha(executionSource),elf_sha256:sha(elf),verified_at_utc:new Date().toISOString(),release_gates_passed:[]});console.log(JSON.stringify({passed:true,admin_transactions:rows.length,final_paused:false}));return;
 }
 const artifact=(name:string,legacy:string)=>publicProfile?Promise.resolve(publicProfile.artifacts[name]):read(legacy);
 const artifacts:ArtifactBundle={idl,requestPk:await artifact('request.pk','vendor/ethereum-zkapi/protocol/setup/v2/request.pk'),requestVk:await artifact('request.vk','vendor/ethereum-zkapi/protocol/setup/v2/request.vk'),withdrawalPk:await artifact('withdrawal.pk','vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.pk'),withdrawalVk:await artifact('withdrawal.vk','vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.vk'),treePk:await artifact('tree.pk','target/i09-challenger/test-tree.pk'),treeVk:await artifact('tree.vk','tests/fixtures/layout2/test-tree.vk'),treeSourceBundle:await artifact('circuit-source.tar','target/i08-wallet/circuit-source.tar'),treeVerifierConstants:await artifact('tree-vk-wire.bin','tests/fixtures/layout2/tree-vk-wire.bin'),additional:{vault_idl:idl,vault_program:elf,devnet_build_manifest:buildBytes,...(publicProfile?{public_devnet_profile:publicProfile.bytes}:{})}};
 const init=await json(join(OUT,'initialize-receipt.json'));
 const indexerConfig=join(OUT,'private-indexer.json');await durable(indexerConfig,{rpc_url:endpoint,program_id:cfg.program_id,pool:cfg.pool,genesis_hash:GENESIS,circuit_profile_hash:m.circuit_profile_hash,start_slot:init.slot,listen:`127.0.0.1:${port}`,public_origin:INDEXER,snapshots_directory:join(OUT,'snapshots')});
 const cert=join(OUT,'tls-cert.pem'),certKey=join(OUT,'tls-key.pem');
 if(!await exists(cert))await command('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',certKey,'-out',cert,'-days','2','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
 if(process.argv.includes('--configure')){console.log(JSON.stringify({configured:true,pool:cfg.pool,indexer_listen_port:port}));return;}
 const ca=await readFile(cert);
 const frontends:Awaited<ReturnType<typeof startDevnetFrontend>>[]=[];
 const frontend=async(listenPort:number,upstream:string,kind:'indexer'|'control'|'inference'='indexer')=>{
  frontends.push(await startDevnetFrontend({port:listenPort,upstreamOrigin:upstream,kind,certificate:ca,key:await readFile(certKey),inferenceApiOrigin:m.inference_api_origin}));
 };
 const installedIndexerHash=sha(await read('services/indexer/target/release/indexerd'));
 const indexer=process.argv.includes('--external-indexer')?null:spawn(resolve('services/indexer/target/release/indexerd'),[indexerConfig],{cwd:ROOT,stdio:['ignore','pipe','pipe']});let indexerLines=0;
 indexer?.stdout.on('data',()=>{});let indexerLogTail='';indexer?.stderr.on('data',chunk=>{const lines=(indexerLogTail+String(chunk)).split('\n');indexerLogTail=lines.pop()!;indexerLines+=lines.filter(line=>line.startsWith('indexer paused:')).length;for(const line of lines)if(/^indexer replay (start|progress): [a-z0-9_= ]+$/.test(line))console.error(line);});
 const directPaths=new Set<string>(),oaVerifierPaths=new Set<string>();
 if(providerPlan){for(const item of (await json(join(PROVIDER_CONFIGURATION,'providers.json'))).direct){const base=String(item.inference_base);assert.equal(new URL(base).protocol,'https:');directPaths.add(base.replace(/\/$/,'')+'/chat/completions');if(item.provider==='oa')oaVerifierPaths.add(String(item.verifier_base)+'/submit_key');}}
 const pinnedFetch=createDevnetPinnedFetch({ca,indexerOrigin:INDEXER,controlOrigin:mutual?m.control_api_origin:undefined,
  inferenceOrigin:providerPlan?m.inference_api_origin:undefined,directChatEndpoints:[...directPaths],oaVerifierEndpoints:[...oaVerifierPaths],onClearanceStatus:status=>{lastClearanceHttpStatus=status;}});
 try{
  await frontend(port+1,INDEXER_INTERNAL);
 if(mutual)await frontend(port+2,`http://127.0.0.1:${port+4}`,'control');
 if(providerPlan)await frontend(port+3,`http://127.0.0.1:${port+4}`,'inference');
  stage='indexer-readiness';let available=false;
  const readinessStarted=performance.now(),readinessDeadline=readinessStarted+indexerWaitSeconds*1000;
  while(performance.now()<readinessDeadline){
   assert.ok(!indexer||indexer.exitCode===null,'indexer process exited');
   const remaining=Math.max(1,Math.ceil(readinessDeadline-performance.now()));
   try{const r=await pinnedFetch(INDEXER+'/zkapi/v1/tree/root',{signal:AbortSignal.timeout(Math.min(10000,remaining))});if(r.ok&&performance.now()<readinessDeadline){available=true;break;}}catch{}
   const pause=readinessDeadline-performance.now();if(pause>0)await sleep(Math.min(2000,pause));
  }
  const readinessElapsedMs=Math.round(performance.now()-readinessStarted);
  assert.ok(available,'indexer readiness deadline');
  stage='native-prover';const proverPath=resolve('apps/clientd/prover/target/release/zkapi-client-prover');
  const verifierPath=resolve('apps/clientd/companion/target/debug/zkapi-client-verify');
  const runtimeBinaries={native_prover:sha(await read(proverPath)),indexer:indexer?installedIndexerHash:null,session_verifier:daemonChallenge||providerPlan?sha(await read(verifierPath)):null};
  const proofArtifacts=Object.fromEntries(Object.entries(artifacts).filter((entry):entry is [string,Uint8Array]=>entry[1] instanceof Uint8Array).map(([name,bytes])=>[name,sha(bytes)]));
  const prover=await NoteProver.create(manifest,artifacts,new NativeProver(proverPath,runtimeBinaries.native_prover));
  const keyFile=join(RUN,'private-journal-key.json');if(!await exists(keyFile))await durable(keyFile,[...randomBytes(32)]);
  const journalKey=await importJournalKey(Uint8Array.from(await json(keyFile)));
  const journal= new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(join(RUN,'journal')),journalKey,{deploymentId:m.deployment_id,pool:m.pool},validateNoteJournal);
  const realChain=new SolanaWalletChain(connection,manifest,INDEXER,{fetch:pinnedFetch});
  const snapshotWait=snapshotWaitStats();
  const chain:DevnetSnapshotChain=boundedDevnetSnapshotChain({chain:realChain,waitMs:snapshotWaitSeconds*1000,stats:snapshotWait,
   createReadChain:abortSignal=>{
    // Both financial and common AUTH snapshot reads share one bounded deadline.
    // Signing, sends, buffer recovery and blockhash acquisition keep their SDK behavior.
    const signal=(other?:AbortSignal|null)=>other?AbortSignal.any([abortSignal,other]):abortSignal;
    const reads=new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:(input,init)=>fetch(input,{...init,signal:signal(init?.signal)})});
    return new SolanaWalletChain(reads,manifest,INDEXER,{fetch:(url,init)=>pinnedFetch(url,{...init,signal:signal(init?.signal)})});
   }});
  const transport=connectionTransport(connection),sendLog=join(RUN,'send-observations.json');
  const sends:any[]=await exists(sendLog)?await json(sendLog):[];
  const rpcFor=(operationJournal:EncryptedJournal<NoteJournal>)=>({...transport,sendRawTransaction:async(bytes:Uint8Array)=>{const tx=VersionedTransaction.deserialize(bytes),signature=bs58.encode(tx.signatures[0]);await verifySignatures(tx);const note=(await operationJournal.read('note'))!.value;const current=note.wallet!.operation;const attempt=current!.attempts.find(a=>a.signature===signature);assert.ok(attempt);assert.equal(attempt.wireHex,Buffer.from(bytes).toString('hex'));assert.ok(bytes.length<=1232);assert.ok(!sends.some(s=>s.signature===signature),'runner refuses automatic resends');const fee=(await connection.getFeeForMessage(tx.message,'finalized')).value;assert.ok(fee&&fee<=Number(cfg.maximum_transaction_fee_lamports));sends.push({signature,kind:attempt.kind,wire_sha256:sha(bytes),wire_bytes:bytes.length,recorded_before_send:true});await durable(sendLog,sends);const returned=await transport.sendRawTransaction(bytes);assert.equal(returned,signature);const fault=join(RUN,'injected-execute-ack-loss.json');if(process.argv.includes('--inject-execute-ack-loss')&&attempt.kind==='execute'&&!await exists(fault)){await durable(fault,{signature,wire_sha256:sha(bytes),simulated_at_client_after_real_send:true});throw Error('explicit lost execute response');}return returned;}});
  const rpc=rpcFor(journal);
  const client=new WalletClient({manifest,prover,journal,chain,rpc,wallets:[wallet(key)],fetch:pinnedFetch});const roles={payer:owner.toBase58(),uploader:owner.toBase58(),feePayer:owner.toBase58(),rentPayer:owner.toBase58(),tokenOwner:owner.toBase58()};
  const userAta=PublicKey.findProgramAddressSync([owner.toBytes(),new PublicKey(TOKEN).toBytes(),mint.toBytes()],new PublicKey(ATA))[0];
  const amount=async(address:PublicKey)=>(await connection.getTokenAccountBalance(address,'finalized')).value.amount;
 const baseline=join(RUN,'balance-before.json');if(!await exists(baseline)){const before=await amount(userAta);assert.ok(BigInt(before)>=BigInt(cfg.deposit_micro_usdc));await durable(baseline,{wallet_micro_usdc:before,vault_micro_usdc:await amount(vault)});}
  if(recoverUncertainAuth){
   assert.ok(daemonChallenge&&poolRun==='challenge-batched','only the existing failed test case can use clearance recovery');
   stage='uncertain-auth-clearance-recovery';
   const stalePath=join(RUN,'stale-challenge');assert.ok(await exists(join(stalePath,'private-journal-key.bin')));
   const staleJournal=new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(join(stalePath,'journal')),await importJournalKey(await read(join(stalePath,'private-journal-key.bin'))),{deploymentId:m.deployment_id,pool:m.pool},validateNoteJournal);
   const recoverySource=await read(resolve('scripts/i10_devnet_clearance_recovery.ts'));
   const recovery=await runDevnetClearanceRecovery({manifest,prover,journal,staleJournal,chain,connection,wallets:[wallet(key)],roles,pinnedFetch,rpcFor});
   const before=await json(baseline),[walletBalance,vaultBalance]=await Promise.all([connection.getTokenAccountBalance(userAta,'finalized'),connection.getTokenAccountBalance(vault,'finalized')]);assert.ok(walletBalance.context.slot>=recovery.closed_slot&&vaultBalance.context.slot>=recovery.closed_slot,'balance observations must follow the closed Note');const after=walletBalance.value.amount,vaultAfter=vaultBalance.value.amount;assert.equal(after,before.wallet_micro_usdc);assert.equal(vaultAfter,before.vault_micro_usdc);
   assert.equal(new Set(sends.map(sent=>sent.signature)).size,sends.length,'each exact signature has one recorded send');
   const rows=[],supersededRows=[];
   for(const sent of sends){
    const tx=await connection.getTransaction(sent.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    const superseded=recovery.superseded_upload_attempts.find(old=>old.signature===sent.signature);
    if(superseded){assert.equal(tx,null,'superseded upload receipt classification changed');assert.equal(sent.kind,superseded.kind);assert.equal(sent.wire_sha256,superseded.wire_sha256);supersededRows.push({...sent,...superseded,receipt_verified:false,fee_lamports:null,compute_units:null});continue;}
    assert.ok(tx?.meta);assert.equal(tx.meta.err,null);assert.ok(tx.meta.fee<=Number(cfg.maximum_transaction_fee_lamports));assert.ok((tx.meta.computeUnitsConsumed??0)>0&&(tx.meta.computeUnitsConsumed??0)<=1000000);rows.push({...sent,slot:tx.slot,fee_lamports:String(tx.meta.fee),compute_units:tx.meta.computeUnitsConsumed,finalized:true});
   }
   assert.equal(supersededRows.length,recovery.superseded_upload_attempts.length,'every expired upload must join a saved send observation');
   assert.equal(rows.length+supersededRows.length,sends.length);
   for(const old of supersededRows)assert.ok(rows.some(row=>row.signature===old.replacement_signature&&row.slot===old.replacement_slot&&row.wire_sha256===old.replacement_wire_sha256),'each expired upload needs its fee/CU-checked finalized replacement');
   for(const receipt of recovery.finalized_attempts)assert.ok(rows.some(row=>row.signature===receipt.signature&&row.slot===receipt.slot&&row.wire_sha256===receipt.wire_sha256),'every saved recovery attempt needs a fee/CU-checked finalized send observation');
   const report={passed:true,scope:'Public devnet permanent clearance and existing stale SDK WalletClient mutual close recover the deposited funds after one uncertain zero-inference AUTH; this is not a daemon challenge pass',program_id:cfg.program_id,pool:cfg.pool,mint:MINT,genesis:GENESIS,recovery,balance_before:before,wallet_after_micro_usdc:after,vault_after_micro_usdc:vaultAfter,balance_observation_slots:{wallet:walletBalance.context.slot,vault:vaultBalance.context.slot},finalized_balance_conservation:true,rows,superseded_upload_rows:supersededRows,automatic_exact_signature_resends:0,verified_upload_renewals:supersededRows.length,source_sha256:sha(executionSource),execution_helper_sha256:executionHelperHashes,recovery_helper_sha256:sha(recoverySource),runtime_binary_sha256:runtimeBinaries,elf_sha256:sha(elf),idl_sha256:sha(idl),verified_at_utc:new Date().toISOString(),live_provider_verified:false,daemon_challenge_verified:false,I10_complete:false,release_gates_passed:[]};
   await durable(join(RUN,'uncertain-auth-clearance-recovery-results.json'),report);console.log(JSON.stringify({passed:true,scope:report.scope,transactions:rows.length,balance_conservation:true}));return;
  }
  // This path only authenticates historical evidence. It never submits an AUTH,
  // advances the stale wallet or treats a persisted observation as current chain state.
  const persistedChallenge=async(main:NoteJournal):Promise<DevnetChallengeReport>=>{
   assert.ok(daemonChallenge&&main.witness&&main.wallet&&main.pending===null);
   assert.equal(main.history.length,1);assert.equal(m.challenge_seconds,'600');
   const ready=await json(join(RUN,'escape-ready.json')) as EscapeReady;
   const report=await json(join(RUN,'challenge-observation.json')) as DevnetChallengeReport;
   const oldKey=await importJournalKey(await read(join(RUN,'stale-challenge/private-journal-key.bin')));
   const oldJournal=new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(join(RUN,'stale-challenge/journal')),oldKey,{deploymentId:m.deployment_id,pool:m.pool},validateNoteJournal);
   const old=(await oldJournal.read('note'))?.value;
   assert.ok(old?.witness&&old.wallet&&old.pending===null);
   assert.deepEqual(old.witness,main.witness);assert.equal(old.history.length,0);
   assert.equal(old.wallet.status,'pending_escape');assert.equal(old.wallet.operation,undefined);assert.equal(old.wallet.history.length,1);
   const settled=main.history[0],request=settled.prepared.request;
   assert.deepEqual(settled.previous,old.state);assert.equal(settled.operations.length,0);assert.equal(settled.settlement.charge_micro_usdc,'0');
   assert.equal(request.authorization.deployment_id,m.deployment_id);assert.equal(request.authorization.pool,cfg.pool);assert.equal(request.authorization.mode,'proxy');
   assert.equal(request.quote.body.provider,'openai');assert.deepEqual(request.quote.body.models,['i05-local-only']);
   const tariff=await json(join(OUT,'local-test-tariff.json'));assert.deepEqual(settled.prepared.tariff,tariff);assert.ok(m.tariff_hashes.includes(tariff.tariff_hash));
   const identity=await prover.inspect(old.witness,old.state);assert.equal(request.public_inputs[8],identity.nullifier);
   const account=await connection.getAccountInfoAndContext(pool,{commitment:'finalized'});assert.ok(account.value);
   const context=await verifiedClientContext(manifest,GENESIS,{address:cfg.pool,owner:account.value.owner.toBase58(),executable:account.value.executable,lamports:BigInt(account.value.lamports),data:account.value.data,slot:BigInt(account.context.slot),commitment:'finalized'},BigInt(account.context.slot),artifacts);
   const verifier=new NativeSessionVerifier(verifierPath,runtimeBinaries.session_verifier!);
   assert.deepEqual(await verifier.settle(context,settled.previous,settled.prepared,settled.settlement,settled.receipts,[]),main.state);
   assert.equal(main.state.balance_micro_usdc,old.state.balance_micro_usdc);assert.notEqual(main.state.anchor,old.state.anchor);
   const escaped=old.wallet.history[0];assert.equal(escaped.kind,'initiate_escape');assert.equal(escaped.destinationOwner,cfg.initializer);
   const executions=escaped.attempts.filter(a=>a.kind==='execute');assert.equal(executions.length,1);const attempt=executions[0] as Attempt;
   assert.equal(attempt.plan.operation,'initiate_escape');assert.equal(attempt.plan.pool,cfg.pool);assert.equal(attempt.plan.programId,cfg.program_id);assert.equal(attempt.plan.expectedNoteId,main.witness.note_id);
   assert.equal('0x'+attempt.plan.expectedRoot,request.public_inputs[3]);
   const receipt=await recoverAttempt(attempt,{...transport,sendRawTransaction:async()=>{throw Error('historical evidence recovery is read-only');}},false);
   assert.ok(receipt.state==='finalized');assert.ok(escaped.finalized.some(row=>row.signature===attempt.signature&&row.slot===receipt.slot));
   const payload=Buffer.from(attempt.plan.payloadHex,'hex');
   const escapedRoot='0x'+payload.subarray(payload.length-608+64,payload.length-608+96).toString('hex');
   assert.deepEqual(Object.keys(ready).sort(),['schema','pool','note_id','request_id','nullifier','escape_signature','escape_slot','deadline','escaped_root','escaped_sequence','historical_request_root','stale_sdk_pending_escape','external_challenger_may_start'].sort());
   assert.equal(ready.schema,1);assert.equal(ready.pool,cfg.pool);assert.equal(ready.note_id,main.witness.note_id);assert.equal(ready.request_id,request.authorization.request_id);assert.equal(ready.nullifier,identity.nullifier);
   assert.equal(ready.escape_signature,attempt.signature);assert.equal(ready.escape_slot,receipt.slot);assert.equal(ready.historical_request_root,request.public_inputs[3]);
   assert.equal(ready.escaped_root,escapedRoot);assert.equal(ready.escaped_sequence,(BigInt(attempt.plan.snapshotSequence)+1n).toString());
   assert.match(ready.deadline,/^[1-9][0-9]{0,19}$/);assert.ok(BigInt(ready.deadline)<=0xffffffffffffffffn);assert.equal(ready.stale_sdk_pending_escape,true);assert.equal(ready.external_challenger_may_start,true);
   const flags={passed:true,inference_operations:0,charge_micro_usdc:'0',signed_successor_verified:true,old_authorization_retained:true,stale_sdk_pending_escape:true,note_active:true,pending_cleared:true,exit_nullifier_consumed:true,challenge_sent_by_helper:false,daemon_receipt_join_required:true,live_provider_verified:false,release_gates_passed:[]};
   for(const [name,value] of Object.entries(flags))assert.deepEqual((report as unknown as Record<string,unknown>)[name],value);
   assert.equal(report.pool,cfg.pool);assert.equal(report.note_id,main.witness.note_id);assert.equal(report.request_id,ready.request_id);assert.equal(report.proof_nullifier,ready.nullifier);
   assert.deepEqual(report.receipt_ids,settled.receipts.map(row=>row.body.receipt_id));assert.equal(report.escape_signature,ready.escape_signature);assert.equal(report.escape_slot,ready.escape_slot);assert.equal(report.escape_deadline,ready.deadline);
   assert.equal(report.historical_request_root,ready.historical_request_root);assert.equal(report.escaped_root,ready.escaped_root);assert.equal(report.escaped_sequence,ready.escaped_sequence);
   assert.equal(report.restored_root,ready.historical_request_root);assert.equal(report.restored_sequence,(BigInt(ready.escaped_sequence)+1n).toString());
   assert.ok(Number.isSafeInteger(report.restored_slot)&&report.restored_slot>=ready.escape_slot);assert.ok(Number.isSafeInteger(report.exit_nullifier_observed_slot)&&report.exit_nullifier_observed_slot>=report.restored_slot);
   const fields=['scope','pool','note_id','request_id','proof_nullifier','receipt_ids','escape_signature','escape_slot','escape_deadline','historical_request_root','escaped_root','escaped_sequence','restored_root','restored_sequence','restored_slot','exit_nullifier_observed_slot',...Object.keys(flags)];
   assert.deepEqual(Object.keys(report).sort(),fields.sort());assert.equal(report.scope,'Public devnet stale SDK escape and externally gated native challenger restoration; exact daemon receipt provenance is joined separately by the caller');
   return report;
  };
  const providerAcceptance=()=>runDevnetProviderAcceptance({manifest,artifacts,prover,journal,chain,connection,pinnedFetch,verifier:{path:verifierPath,sha256:runtimeBinaries.session_verifier!},planPath:providerPlan!,stateDir:PROVIDER_STATE,configurationDir:PROVIDER_CONFIGURATION,runDirectory:RUN});
  let settledProviderRecovery:Awaited<ReturnType<typeof verifySettledProviderCase>>|undefined;
  let unstartedProviderRecovery:ReturnType<typeof verifyUnstartedProviderCase>|undefined;
  const verifySettledRecovery=async()=>{
   const note=(await journal.read('note'))!.value,selection=await json(join(PROVIDER_CONFIGURATION,'selection.json'));
   assert.equal(selection.case_ids.length,1,'one selected settled case required');
   const account=await connection.getAccountInfoAndContext(pool,'finalized');assert.ok(account.value);
   const context=await verifiedClientContext(manifest,GENESIS,{address:cfg.pool,owner:account.value.owner.toBase58(),executable:account.value.executable,lamports:BigInt(account.value.lamports),data:account.value.data,slot:BigInt(account.context.slot),commitment:'finalized'},0n,artifacts);
   const env:NodeJS.ProcessEnv={};for(const name of ['PATH','HOME','LANG','LC_ALL','TMPDIR'])if(process.env[name])env[name]=process.env[name];
   const output=await promisify(execFile)('python3',['scripts/provider_demo_budget.py','budget-status','--plan',resolve(providerPlan!),'--state-dir',PROVIDER_STATE],{cwd:ROOT,env,timeout:30_000,maxBuffer:1_048_576});
   return verifySettledProviderCase({note,context,verifier:new NativeSessionVerifier(verifierPath,runtimeBinaries.session_verifier!),plan:await json(resolve(providerPlan!)),selection,profile:providerProfile!,tariffs:await json(join(PROVIDER_CONFIGURATION,'tariffs.json')),budget:JSON.parse(output.stdout),caseId:selection.case_ids[0]});
  };
  const verifyUnstartedRecovery=async()=>{
   const note=(await journal.read('note'))!.value,selection=await json(join(PROVIDER_CONFIGURATION,'selection.json'));
   assert.equal(selection.case_ids.length,1,'one selected unstarted case required');
   const account=await connection.getAccountInfoAndContext(pool,'finalized');assert.ok(account.value);
   const context=await verifiedClientContext(manifest,GENESIS,{address:cfg.pool,owner:account.value.owner.toBase58(),executable:account.value.executable,lamports:BigInt(account.value.lamports),data:account.value.data,slot:BigInt(account.context.slot),commitment:'finalized'},0n,artifacts);
   const env:NodeJS.ProcessEnv={};for(const name of ['PATH','HOME','LANG','LC_ALL','TMPDIR'])if(process.env[name])env[name]=process.env[name];
   const output=await promisify(execFile)('python3',['scripts/provider_demo_budget.py','budget-status','--plan',resolve(providerPlan!),'--state-dir',PROVIDER_STATE],{cwd:ROOT,env,timeout:30_000,maxBuffer:1_048_576});
   const budget=JSON.parse(output.stdout),campaign=await json(join(RUN,'provider-campaign.json'));
   assert.deepEqual(Object.keys(campaign).sort(),['schema','plan_sha256','campaign_id','manifest_hash','deployment_id','pool','note_id','provider_configuration_sha256','selection','source_sha256'].sort(),'existing campaign evidence shape required');
   const {source_sha256:historicalSources,...identity}=campaign;
   assert.deepEqual(identity,{schema:1,plan_sha256:budget.identity.plan_sha256,campaign_id:budget.identity.campaign_id,manifest_hash:manifest.manifest_hash,deployment_id:manifest.deployment_id,pool:manifest.pool,note_id:'note',provider_configuration_sha256:sha(await read(join(PROVIDER_CONFIGURATION,'providers.json'))),selection},'unstarted failure must belong to this existing pool and campaign');
   assert.deepEqual(Object.keys(historicalSources).sort(),['scripts/provider_acceptance.py','scripts/provider_acceptance_client.ts','scripts/i10_devnet_provider.ts'].sort());
   assert.ok(Object.values(historicalSources).every(value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)),'historical source pins must be preserved');
   return verifyUnstartedProviderCase({note,context,plan:await json(resolve(providerPlan!)),selection,profile:providerProfile!,tariffs:await json(join(PROVIDER_CONFIGURATION,'tariffs.json')),budget,caseId:selection.case_ids[0],failure:await json(join(RUN,`provider-case-${selection.case_ids[0]}-failure.json`)),depositMicroUsdc:cfg.deposit_micro_usdc});
  };
  if(withdrawSettledProvider){stage='settled-provider-recovery-verification';settledProviderRecovery=await verifySettledRecovery();}
  if(withdrawUnstartedProvider){stage='unstarted-provider-recovery-verification';unstartedProviderRecovery=await verifyUnstartedRecovery();}
  stage='wallet-lifecycle';let checkpoint=false,challengeReport:DevnetChallengeReport|undefined;
  for(let i=0;i<600;i++){
   const r=await journal.read('note');
   if(!r){assert.ok(!providerRecovery,'provider recovery cannot create a deposit');await client.beginDeposit('note',cfg.deposit_micro_usdc,roles);continue;}
   const w=r.value.wallet!;
   if(daemonChallenge&&!challengeReport&&(w.operation?.kind==='mutual_close'||w.status==='closed')){
    stage='daemon-challenge-resume-evidence';challengeReport=await persistedChallenge(r.value);stage='wallet-lifecycle';
   }
   if(w.operation){const next=await client.advance('note');if(next.state==='proof_required')await client.resumeProof('note');assert.notEqual(next.state,'rejected');if(next.state==='unknown'&&process.argv.includes('--inject-execute-ack-loss')&&await exists(join(RUN,'injected-execute-ack-loss.json'))){checkpoint=true;break;}await sleep(750);continue;}
   if(w.status==='active'){
    if(process.argv.includes('--deposit-checkpoint')){await durable(join(RUN,'deposit-checkpoint.json'),{deposited:true,invocation_id:invocationId,pool:cfg.pool,note_id:r.value.witness!.note_id,at_utc:new Date().toISOString()});console.log(JSON.stringify({checkpoint:'finalized deposit; journal retained for challenger prewarm',automatic_resends:0}));return;}
    if(daemonChallenge&&!challengeReport){
     stage='daemon-challenge';
     const localTariff=await json(join(OUT,'local-test-tariff.json'));
     challengeReport=await runDevnetChallenge({manifest,artifacts,prover,journal,chain,connection,wallets:[wallet(key)],roles,pinnedFetch,rpcFor,runDirectory:RUN,verifier:{path:verifierPath,sha256:runtimeBinaries.session_verifier!},tariff:localTariff,waitMs:600000});
     stage='wallet-lifecycle';
    }
    if(recoverProviderAuth){
     stage='provider-auth-clearance-recovery';
     {
      const deadline=performance.now()+300_000;
      for(;;){
       try{await client.reconcileUnacceptedAuthorization('note');break;}
       catch(error){
        if((error as Error).message!=='clearance unavailable; saved nullifier retained'||lastClearanceHttpStatus!==503||performance.now()>=deadline)throw error;
        // The same permanent clearance is idempotent; no AUTH or inference is sent.
        await sleep(1000);
       }
      }
     }
     const recovered=(await journal.read('note'))!.value;
     assert.ok(!recovered.pending&&recovered.wallet?.clearedAuthorization&&recovered.wallet.clearance?.phase==='verified','verified permanent clearance and preserved AUTH evidence required');
     stage='wallet-lifecycle';
    }else if(withdrawSettledProvider){stage='settled-provider-recovery-verification';settledProviderRecovery=await verifySettledRecovery();stage='wallet-lifecycle';}
    else if(withdrawUnstartedProvider){stage='unstarted-provider-recovery-verification';unstartedProviderRecovery=await verifyUnstartedRecovery();stage='wallet-lifecycle';}
    else if(providerPlan){stage='provider-acceptance';await providerAcceptance();stage='wallet-lifecycle';}
    await client.beginWithdrawal('note',mutual?'mutual_close':'initiate_escape',owner.toBase58(),roles);continue;
   }
   if(w.status==='pending_escape'){const s=await chain.snapshot(r.value.witness!.note_id,'zero');assert.ok(s.pending);if(BigInt(s.clock)<BigInt(s.pending.deadline)){await sleep(2000);continue;}await client.beginFinalize('note',roles);continue;}
   assert.equal(w.status,'closed');break;
  }
  if(checkpoint){const fault=await json(join(RUN,'injected-execute-ack-loss.json'));await durable(join(RUN,'restart-checkpoint.json'),{stage:'execute_unknown',invocation_id:invocationId,signature:fault.signature,wire_sha256:fault.wire_sha256,fresh_process_required:true});console.log(JSON.stringify({checkpoint:'saved execute result unknown; rerun --lifecycle in a fresh process',automatic_resends:0}));return;}
  const final=(await journal.read('note'))!.value;assert.equal(final.wallet!.status,'closed');assert.equal(final.wallet!.operation,undefined);
  if(daemonChallenge)assert.ok(challengeReport,'daemon challenge evidence required after resume');
  const providerReport=providerPlan&&!providerRecovery?await providerAcceptance():null;
  if(withdrawSettledProvider)settledProviderRecovery=await verifySettledRecovery();
  if(withdrawUnstartedProvider)unstartedProviderRecovery=await verifyUnstartedRecovery();
  if(recoverProviderAuth){
   assert.ok(final.wallet!.clearedAuthorization&&!final.pending,'completed recovery must preserve cleared AUTH evidence');
   await client.reconcileUnacceptedAuthorization('note');
  }
  if(mutual){assert.equal(final.wallet!.history.at(-1)?.kind,'mutual_close');assert.equal(final.wallet!.clearance?.phase,'verified');assert.ok(final.wallet!.clearance?.signature);}
  const finalSlot=Math.max(...final.wallet!.history.flatMap(operation=>operation.finalized.map(receipt=>receipt.slot)));
  assert.ok(Number.isSafeInteger(finalSlot)&&finalSlot>0);
  const before=await json(baseline),[walletBalance,vaultBalance]=await Promise.all([connection.getTokenAccountBalance(userAta,'finalized'),connection.getTokenAccountBalance(vault,'finalized')]);
  assert.ok(walletBalance.context.slot>=finalSlot&&vaultBalance.context.slot>=finalSlot,'balances must follow the finalized withdrawal');
  const after=walletBalance.value.amount,vaultAfter=vaultBalance.value.amount;assert.equal(after,before.wallet_micro_usdc);assert.equal(vaultAfter,before.vault_micro_usdc);
  const rows=[];for(const sent of sends){const tx=await connection.getTransaction(sent.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});assert.ok(tx?.meta);assert.equal(tx.meta.err,null);assert.ok(tx.meta.fee<=Number(cfg.maximum_transaction_fee_lamports));assert.ok((tx.meta.computeUnitsConsumed??0)>0&&(tx.meta.computeUnitsConsumed??0)<=1000000);rows.push({...sent,slot:tx.slot,fee_lamports:String(tx.meta.fee),compute_units:tx.meta.computeUnitsConsumed,finalized:true});}
  let freshRecovery=false;if(await exists(join(RUN,'restart-checkpoint.json'))){const cp=await json(join(RUN,'restart-checkpoint.json')),fault=await json(join(RUN,'injected-execute-ack-loss.json'));assert.notEqual(cp.invocation_id,invocationId);assert.equal(cp.signature,fault.signature);assert.equal(cp.wire_sha256,fault.wire_sha256);const saved=final.wallet!.history.flatMap(op=>op.attempts).find(a=>a.signature===cp.signature);assert.ok(saved);assert.equal(sha(Buffer.from(saved.wireHex,'hex')),cp.wire_sha256);assert.ok(final.wallet!.history.flatMap(op=>op.finalized).some(f=>f.signature===cp.signature));assert.ok(rows.some(r=>r.signature===cp.signature&&r.wire_sha256===cp.wire_sha256));freshRecovery=true;}
  const result={passed:true,provider_acceptance:providerReport,unaccepted_provider_auth_recovered:recoverProviderAuth,settled_provider_recovery:settledProviderRecovery??null,unstarted_provider_recovery:unstartedProviderRecovery??null,balance_observation_slots:{wallet:walletBalance.context.slot,vault:vaultBalance.context.slot},finalized_withdrawal_slot:finalSlot,scope:withdrawUnstartedProvider?'public devnet withdrawal after a verified pre-AUTH quote failure; no provider inference or replay':withdrawSettledProvider?'public devnet withdrawal after a cryptographically verified settled provider case; failed acceptance is retained and inference is never replayed':recoverProviderAuth?'public devnet recovery of an unaccepted AUTH through verified permanent clearance and same-journal mutual close; no provider inference':providerPlan?'public devnet Vault deposit -> selected real provider cases -> verified signed settlement -> mutual close with existing SDK/shared ledger':mutual?'actual public devnet Vault deposit -> signed control clearance -> mutual close with existing SDK WalletClient/native proof/local controld + PG + signerd; no provider':'actual public devnet Vault deposit -> escape -> finalization using existing SDK WalletClient/native proof/encrypted journal/live finalized indexer; no provider',program_id:cfg.program_id,pool:cfg.pool,mint:MINT,genesis:GENESIS,wallet_public_key:owner.toBase58(),deposit_micro_usdc:cfg.deposit_micro_usdc,balance_before:before,wallet_after_micro_usdc:after,vault_after_micro_usdc:vaultAfter,rows,max_transaction_bytes:Math.max(...rows.map(r=>r.wire_bytes)),max_cu:Math.max(...rows.map(r=>r.compute_units??0)),automatic_resends:0,finalized_balance_conservation:true,coherent_snapshot_retries:snapshotWait.retries,snapshot_wait_limit_seconds:snapshotWaitSeconds,snapshot_wait_scope:'Acceptance read-only wait; not a latency/SLO pass or financial retry policy',snapshot_wait_calls:snapshotWait.calls,snapshot_wait_total_elapsed_ms:snapshotWait.totalElapsedMs,snapshot_wait_max_elapsed_ms:snapshotWait.maxElapsedMs,snapshot_wait_timeouts:snapshotWait.timeouts,indexer_retry_log_events:indexer?indexerLines:null,indexer_process_ownership:indexer?'runner':'external; inspect separate indexer log',indexer_readiness_limit_seconds:indexerWaitSeconds,indexer_readiness_elapsed_ms:readinessElapsedMs,encrypted_note_journal:true,runtime_binary_sha256:runtimeBinaries,installed_artifact_sha256:{indexer:installedIndexerHash},helper_source_sha256:challengeSource?sha(challengeSource):null,proof_artifact_sha256:proofArtifacts,lost_execute_ack_recovered_in_fresh_process:freshRecovery,verified_program:verifiedProgram,source_sha256:sha(executionSource),execution_helper_sha256:executionHelperHashes,withdrawal_mode:mutual?'mutual_close':'initiate_escape',daemon_challenge_observation:challengeReport??null,clearance_signature_verified:mutual?final.wallet!.clearance?.phase==='verified':false,elf_sha256:sha(elf),idl_sha256:sha(idl),manifest_sha256:m.manifest_hash,build_manifest_sha256:sha(buildBytes),verified_at_utc:new Date().toISOString(),live_provider_verified:providerReport?.passed===true,wallet_UI_verified:false,I10_complete:false,release_gates_passed:[]};await durable(join(RUN,'runtime-report.json'),result);console.log(JSON.stringify({passed:true,scope:result.scope,transactions:rows.length,max_cu:result.max_cu,balance_conservation:true}));
 }finally{for(const server of frontends){server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}if(indexer&&indexer.exitCode===null){const stopped=new Promise<void>(ok=>indexer.once('exit',()=>ok()));indexer.kill('SIGTERM');await stopped;}}
}
main().catch(error=>{const stack=String(error.stack??'').split('\n');const own=stack.find(line=>line.includes('run_i10_devnet_vault.ts:'))?.match(/\.ts:(\d+):(\d+)/)?.slice(1);const frames=stack.flatMap(line=>{const match=line.match(/\/(i10_devnet_challenge|i10_devnet_clearance_recovery|control|control-node|wallet|wallet-chain|prover-node|journal-node)\.ts:(\d+):(\d+)/);return match?[{file:match[1]+'.ts',line:Number(match[2]),column:Number(match[3])}]:[];});console.error(JSON.stringify({passed:false,stage,error_type:error.name,source_line:own?.[0],source_frames:frames,clearance_http_status:lastClearanceHttpStatus??null,http_status:Number.isInteger(error.status)&&error.status>=100&&error.status<=599?error.status:null,message:'devnet Vault acceptance did not complete; private inputs suppressed'}));process.exitCode=1;});
