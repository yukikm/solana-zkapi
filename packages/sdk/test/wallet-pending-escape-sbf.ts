/** Fresh native proofs + production SDK journal/wallet + actual Vault SBF.
 * AUTH admission, inference failure, RPC finality and clock are local fixtures;
 * no provider or public chain is contacted. All signing keys here are test keys. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Connection,Keypair,PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {NoteProver} from '../src/prover.ts';
import {NativeProver} from '../src/prover-node.ts';
import {ProverSessionVerifier} from '../src/control-prover.ts';
import {ControlClient,createCredentials,validateNoteJournal,type NoteJournal,type Quote,type Tariff,type VerificationContext} from '../src/control.ts';
import {EncryptedJournal,importJournalKey} from '../src/journal.ts';
import {NativeJournalStore} from '../src/journal-node.ts';
import {WalletClient} from '../src/wallet.ts';
import {SolanaWalletChain} from '../src/wallet-chain.ts';
import {jcsBytes,manifestDigest,sha256Hex,verifyManifest,type ArtifactBundle,type Manifest} from '../src/trust.ts';
import type {TransportRpc,V0Wallet} from '../src/transport.ts';

const read=async(path:string)=>new Uint8Array(await readFile(resolve(path)));
const json=async(path:string)=>JSON.parse(await readFile(resolve(path),'utf8'));
const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();

test('pending accepted AUTH and lost inference ACK escape through real proofs/SBF without replay',{timeout:300_000},async t=>{
  const elf=resolve(process.env.ZKAPI_TEST_VAULT_ELF??'target/i04-sbf/zkapi_vault.so');
  const svmPath=resolve(process.env.ZKAPI_TEST_WALLET_SVM??'tests/svm/target/debug/wallet');
  const proverPath=resolve(process.env.ZKAPI_TEST_NATIVE_PROVER??'apps/clientd/prover/target/release/zkapi-client-prover');
  const fixture=await json('tests/fixtures/vault/genesis-a.json'),profile=await json('tests/fixtures/layout2/profile.json');
  const idl=await read('docs/contracts/zkapi_vault.json');
  const quoteKey=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
  const quotePublic=bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw',quoteKey.publicKey)));
  const receiptKey=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair;
  const receiptPublic=bs58.encode(new Uint8Array(await crypto.subtle.exportKey('raw',receiptKey.publicKey)));
  const tariffBody:Omit<Tariff,'tariff_hash'>={version:'1',provider:'openai',model:'local-no-provider',pricing_basis:'fixed_usage_rates',
    valid_from:'2999999999',valid_until:'3000001000',rates:[{unit:'input_tokens',nano_usdc_numerator:'1',unit_denominator:'1'},{unit:'output_tokens',nano_usdc_numerator:'1',unit_denominator:'1'}],operator_fee_micro_usdc:'0'};
  const tariff:Tariff={...tariffBody,tariff_hash:await sha256Hex(jcsBytes(tariffBody))};
  const pair=Keypair.fromSeed(new Uint8Array(32).fill(1)),owner=pair.publicKey.toBase58();
  const authority={authority:owner,program_id:key(20),config_hash:'11'.repeat(32),threshold:2 as const,members:[key(21),key(22),key(23)]};
  const inputs=fixture.auth.escape.public_inputs as string[];
  const m:Manifest={...profile,deployment_id:'pending-escape-local-sbf',manifest_hash:'00'.repeat(32),manifest_signature:Buffer.alloc(64).toString('base64'),
    genesis_hash:bs58.encode(Buffer.from(fixture.genesis,'hex')),program_id:bs58.encode(Buffer.from(fixture.program_id,'hex')),pool:bs58.encode(Buffer.from(fixture.pool,'hex')),
    mint:key(4),token_program:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',decimals:6,vault_binding:inputs[2],
    state_key:{x:inputs[4],y:inputs[5]},clearance_key:{x:inputs[6],y:inputs[7]},quote_public_key:quotePublic,receipt_public_key:receiptPublic,
    deployment_environment:'local',transaction_formats:['v0_buffer'],cap_micro_usdc:'1000000',note_ttl_seconds:'2592000',challenge_seconds:'86400',
    control_api_origin:'http://127.0.0.1:18886',inference_api_origin:'http://127.0.0.1:18887',proving_keys_base_url:'http://127.0.0.1:18886/keys',
    idl_hash:await sha256Hex(idl),api_endpoints:['/zkapi/v1/config'],tariff_hashes:[tariff.tariff_hash],artifact_digests:{vault_idl:await sha256Hex(idl)},db_schema_version:'2',
    authorities:{admin:authority,upgrade:{...authority,authority:key(25)}}};
  const manifestHash=await manifestDigest(m),manifest=await verifyManifest(jcsBytes({...m,manifest_hash:manifestHash}),{
    anchor:{kind:'hash',sha256:manifestHash},expected:{deployment_id:m.deployment_id,deployment_environment:m.deployment_environment,genesis_hash:m.genesis_hash,
      program_id:m.program_id,pool:m.pool,mint:m.mint,token_program:m.token_program,control_api_origin:m.control_api_origin,inference_api_origin:m.inference_api_origin},
    build:{stateKey:m.state_key,clearanceKey:m.clearance_key,circuitProfileHash:m.circuit_profile_hash,idlHash:m.idl_hash,setupProfile:m.setup_profile}});
  const artifacts:ArtifactBundle={idl,requestPk:await read('vendor/ethereum-zkapi/protocol/setup/v2/request.pk'),requestVk:await read('vendor/ethereum-zkapi/protocol/setup/v2/request.vk'),
    withdrawalPk:await read('vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.pk'),withdrawalVk:await read('vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.vk'),
    treePk:await read('target/i09-challenger/test-tree.pk'),treeVk:await read('tests/fixtures/layout2/test-tree.vk'),treeSourceBundle:await read('target/i08-wallet/circuit-source.tar'),
    treeVerifierConstants:await read('tests/fixtures/layout2/tree-vk-wire.bin'),additional:{vault_idl:idl}};
  const engine=new NativeProver(proverPath,await sha256Hex(await read(proverPath))),prover=await NoteProver.create(manifest,artifacts,engine);
  const svm=spawn(svmPath,[elf],{stdio:['pipe','pipe','pipe']});let stderr='';svm.stderr.on('data',b=>stderr+=b);
  const queue:{resolve(v:any):void;reject(e:unknown):void}[]=[];
  createInterface({input:svm.stdout}).on('line',line=>{const p=queue.shift();if(p){try{p.resolve(JSON.parse(line));}catch(e){p.reject(e);}}});
  svm.on('exit',code=>{for(const p of queue.splice(0))p.reject(Error(`SBF exit ${code}: ${stderr}`));});
  const call=(command:object)=>new Promise<any>((resolve,reject)=>{queue.push({resolve,reject});svm.stdin.write(JSON.stringify(command)+'\n');});
  t.after(async()=>{if(svm.exitCode===null){const done=once(svm,'exit');svm.stdin.end();await done;}});
  const directory=await mkdtemp(join(tmpdir(),'zkapi-pending-escape-sbf-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await NativeJournalStore.open(directory),aes=await importJournalKey(crypto.getRandomValues(new Uint8Array(32)));
  const open=()=>new EncryptedJournal<NoteJournal>(store,aes,{deploymentId:manifest.deployment_id,pool:manifest.pool},validateNoteJournal);
  let journal=open();
  const fixtureFetch:typeof fetch=async(url,init)=>{
    if(String(url).startsWith('http://127.0.0.1:18889')){
      const path=new URL(String(url)).pathname,value=path.endsWith('/root')?await call({kind:'root'}):await call({kind:'path',note_id:Number(path.split('/')[5])});
      return Response.json(value);
    }
    assert.equal(new URL(String(url)).href,'http://127.0.0.1:18888/');const body=JSON.parse(String(init!.body)),a=body.params;let result:any;
    switch(body.method){
      case'getGenesisHash':result=manifest.genesis_hash;break;
      case'getBlock':result={blockhash:key(1),previousBlockhash:key(1),parentSlot:a[0]-1,blockTime:3000000000,blockHeight:a[0]};break;
      case'getMultipleAccounts':assert.equal(a[1].commitment,'finalized');result=await call({kind:'accounts',addresses:a[0]});break;
      case'getAccountInfo':{const v=await call({kind:'accounts',addresses:[a[0]]});result={context:v.context,value:v.value[0]};break;}
      case'getLatestBlockhash':result={context:{slot:100},value:await call({kind:'blockhash'})};break;
      default:throw Error('unexpected local RPC '+body.method);
    }
    return Response.json({jsonrpc:'2.0',id:body.id,result});
  };
  const chain=new SolanaWalletChain(new Connection('http://127.0.0.1:18888',{fetch:fixtureFetch}),manifest,'http://127.0.0.1:18889',{fetch:fixtureFetch,allowLoopbackHttp:true});
  const wallet:V0Wallet={publicKey:pair.publicKey,supportedTransactionVersions:new Set([0]),async signTransaction(tx){tx.sign([pair]);return tx;}};
  const sent:string[]=[];let loseEscapeAck=false;
  const rpc:TransportRpc={signatureStatus:async()=>null,finalizedBlockHeight:async()=>100,finalizedReceipt:async(signature)=>{const r=await call({kind:'receipt',signature});return r?{...r,message:new Uint8Array(Buffer.from(r.message,'base64'))}:null;},
    async sendRawTransaction(bytes){
      const signature=bs58.encode(VersionedTransaction.deserialize(bytes).signatures[0]),saved=(await journal.read('note'))!.value,op=saved.wallet!.operation!;
      assert.ok(op.attempts.some(a=>a.signature===signature&&a.wireHex===Buffer.from(bytes).toString('hex')),'exact transaction durable before SBF');
      if(op.kind==='initiate_escape'){assert.equal(saved.pending,null);assert.equal(saved.wallet!.emergencyEscapes!.length,1);}
      sent.push(signature);const r=await call({kind:'send',base64:Buffer.from(bytes).toString('base64')});
      if(loseEscapeAck&&op.kind==='initiate_escape'&&op.attempts.find(a=>a.signature===signature)?.kind==='execute'){loseEscapeAck=false;throw Error('local escape execute ACK lost');}
      return r.signature;
    }};
  let controlCalls=0,inferenceCalls=0;const unavailable:typeof fetch=async()=>{throw Error('operator offline');};
  const walletOptions=()=>({manifest,prover,journal,chain,rpc,wallets:[wallet],fetch:unavailable});let client=new WalletClient(walletOptions());
  const roles={payer:owner,tokenOwner:owner,uploader:owner,rentPayer:owner,feePayer:owner};
  const drive=async()=>{for(let n=0;n<60;n++){const r=await client.advance('note');if(r.state==='complete')return;if(r.state==='proof_required')await client.resumeProof('note');}throw Error('financial operation did not finish');};
  await client.beginDeposit('note','5000000',roles);await drive();
  const deposited=(await journal.read('note'))!.value,snapshot=await chain.snapshot(deposited.witness!.note_id,'active');
  const body:Quote['body']={quote_id:crypto.randomUUID(),deployment_id:manifest.deployment_id,pool:manifest.pool,mode:'proxy',provider:'openai',models:[tariff.model],tariff_hash:tariff.tariff_hash,
    cap_micro_usdc:manifest.cap_micro_usdc,issued_at:'3000000000',expires_at:'3000000120',session_ttl_seconds:'60',max_concurrency:'4',control_api_origin:manifest.control_api_origin,inference_api_origin:manifest.inference_api_origin};
  const quote_hash=await sha256Hex(jcsBytes(body)),quote:Quote={body,quote_hash,signature:Buffer.from(await crypto.subtle.sign('Ed25519',quoteKey.privateKey,Buffer.from(quote_hash,'hex'))).toString('base64')};
  const prepared=await prover.prepareSession(deposited.witness!,deposited.state,snapshot.root,snapshot.siblings,quote,tariff,await createCredentials('proxy'));
  const context:VerificationContext={deployment_id:manifest.deployment_id,pool:manifest.pool,vault_binding:manifest.vault_binding,state_key:[manifest.state_key.x,manifest.state_key.y],
    cap_micro_usdc:manifest.cap_micro_usdc,control_api_origin:manifest.control_api_origin,inference_api_origin:manifest.inference_api_origin,quote_public_key:manifest.quote_public_key,
    receipt_public_key:manifest.receipt_public_key,request_vk_sha256:manifest.request_vk_hash,tariff_hashes:[tariff.tariff_hash]};
  const controlOptions=()=>({context,journal,verifier:new ProverSessionVerifier(engine),now:()=>3000000000n,allowLoopbackHttp:true,fetch:(async(url,init)=>{
    if(String(url)===manifest.control_api_origin+'/zkapi/v1/sessions'){
      controlCalls++;assert.equal(init?.body,JSON.stringify(prepared.request));assert.equal(controlCalls,1,'AUTH admitted only once');
      return Response.json({request_id:prepared.request.authorization.request_id,mode:'proxy',state:'ACTIVE',cap_micro_usdc:manifest.cap_micro_usdc});
    }
    if(String(url)===manifest.inference_api_origin+'/v1/responses'){inferenceCalls++;assert.equal(inferenceCalls,1);throw Error('local provider response ACK lost');}
    throw Error('operator offline');
  }) as typeof fetch});
  let control=new ControlClient(controlOptions());await control.prepare('note',prepared,snapshot.root);await control.submit('note');
  const operationId=crypto.randomUUID();await control.prepareOperation('note',operationId,'/v1/responses',new TextEncoder().encode(JSON.stringify({model:tariff.model,input:'local fixture only'})));
  await assert.rejects(control.sendOperation('note',operationId),/ACK lost/);
  const original=(await journal.read('note'))!.value;assert.equal(original.pending!.phase,'active');assert.equal(original.pending!.operations[0].phase,'send_unknown');
  await assert.rejects(control.close('note'),/operator offline/);
  const frozen=(await journal.read('note'))!.value;assert.equal(frozen.pending!.phase,'closing');
  await assert.rejects(client.beginWithdrawal('note','initiate_escape',key(7),roles),/note unavailable/);
  await client.beginEmergencyEscape('note',key(7),roles);
  const archived=(await journal.read('note'))!.value;
  assert.equal(archived.pending,null);assert.deepEqual(archived.state,frozen.state);assert.deepEqual(archived.witness,frozen.witness);
  assert.deepEqual(archived.wallet!.emergencyEscapes![0].pending,frozen.pending);assert.deepEqual(archived.wallet!.emergencyEscapes![0].previous,frozen.state);
  const backup=await journal.exportBackup('note');journal=open();client=new WalletClient(walletOptions());control=new ControlClient(controlOptions());
  assert.deepEqual(await journal.exportBackup('note'),backup,'same encrypted archive survives reopen');
  await assert.rejects(control.submit('note'));await assert.rejects(control.sendOperation('note',operationId));
  await assert.rejects(control.prepare('note',prepared,snapshot.root));assert.equal(controlCalls,1);assert.equal(inferenceCalls,1);
  loseEscapeAck=true;
  for(let n=0;n<60;n++){const r=await client.advance('note');if(r.state==='unknown'&&!loseEscapeAck)break;if(r.state==='proof_required')await client.resumeProof('note');assert.notEqual(r.state,'complete');}
  assert.equal(loseEscapeAck,false);const lost=(await journal.read('note'))!.value.wallet!.operation!.current!;
  journal=open();client=new WalletClient(walletOptions());await drive();assert.equal(sent.filter(s=>s===lost).length,1,'finalized lost execute recovered without resend');
  const escaping=(await journal.read('note'))!.value;assert.equal(escaping.wallet!.status,'pending_escape');assert.deepEqual(escaping.wallet!.emergencyEscapes![0].pending,frozen.pending);
  await assert.rejects(client.beginFinalize('note',roles),/challenge period/);
  const pending=await chain.snapshot(escaping.witness!.note_id,'zero');await call({kind:'clock',time:Number(pending.pending!.deadline)});
  await client.beginFinalize('note',roles);await drive();
  const closed=(await open().read('note'))!.value;assert.equal(closed.wallet!.status,'closed');assert.equal(closed.pending,null);
  assert.deepEqual(closed.wallet!.emergencyEscapes![0].pending,frozen.pending);assert.deepEqual(closed.wallet!.emergencyEscapes![0].previous,frozen.state);
  assert.equal(controlCalls,1);assert.equal(inferenceCalls,1);assert.equal(new Set(sent).size,sent.length,'no signed transaction replay');
  const result=await call({kind:'report',name:'pending-escape'});assert.equal(result.vault_micro_usdc,0);assert.equal(result.destination_micro_usdc,5000000);assert.equal(result.treasury_micro_usdc,0);
  assert.ok(result.rows.every((r:any)=>r.error===null));assert.ok(result.max_cu<=1000000&&result.max_transaction_bytes<=1232);
  const report={...result,passed:true,authorization_requests:controlCalls,inference_requests:inferenceCalls,inference_replays:0,financial_exact_signature_resends:0,
    real_request_proof_verified:true,exact_pending_archive_survived_restart:true,escape_execute_ack_loss_recovered:true,elf_sha256:await sha256Hex(await read(elf)),native_prover_sha256:await sha256Hex(await read(proverPath)),
    scope:'Production SDK encrypted pending AUTH/inference archive, native request/withdrawal/tree proofs, signed v0 escape/finalize and actual Vault SBF; local HTTP/RPC/finality fixtures only',
    limits:['Local synthetic AUTH admission and provider failure, no real provider','Known public local-test setup and signing keys','No fresh-public-profile deployment or public finality','No challenged-escape successor settlement in this focused run']};
  await writeFile('target/i08-wallet/pending-escape-integration-results.json',JSON.stringify(report,null,2)+'\n');
  t.diagnostic(`Actual pending escape SBF: ${result.rows.length} signed transactions, max ${result.max_cu} CU / ${result.max_transaction_bytes} bytes; AUTH 1, inference 1, replay 0`);
});
