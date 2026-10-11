/** Fresh local fixed-price API lifecycle. The Rust parent supplies the actual
 * control App/PostgreSQL/signerd/dispatcherd. RPC finality and API responses are
 * fixtures; signed transactions execute in the actual Vault SBF. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer, request as httpRequest, type IncomingMessage, type ServerResponse, type IncomingHttpHeaders} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import bs58 from 'bs58';
import {decodeRpcAccount} from '../src/solana-rpc.ts';
import {createSolanaRpcWithFetch, transactionSignature} from '../src/solana.ts';
import {fixtureSigner, signWith, decodeTransaction, kitAddress} from './kit-helpers.ts';
import {WalletClient} from '../src/wallet.ts';
import {ZkApiClient} from '../src/client.ts';
import {selectFrontendRoute, validateFrontendRoutes} from '../../../scripts/api_registration.ts';
import {SolanaWalletChain} from '../src/wallet-chain.ts';
import {NoteProver} from '../src/prover.ts';
import {NativeProver} from '../src/prover-node.ts';
import {NativeSessionVerifier} from '../src/control-node.ts';
import {ClientDaemon} from '../src/clientd-bridge.ts';
import {ControlClient, createCredentials, verifiedClientContext, validateNoteJournal,
  type NoteJournal, type ApiBinding, type ApiTariff, type Tariff} from '../src/control.ts';
import {EncryptedJournal, importJournalKey} from '../src/journal.ts';
import {NativeJournalStore} from '../src/journal-node.ts';
import {verifyManifest, jcsBytes, type Manifest, type ArtifactBundle} from '../src/trust.ts';
import {connectionTransport, type TransportRpc, type V0Wallet} from '../src/transport.ts';
import {read, json, digest} from './wallet-fixture.ts';

const onboarding = process.env.ZKAPI_ONBOARDING_VARIANT;
const fault = onboarding?.split('-')[1] as 'lost_response'|'upstream_timeout'|undefined;
const nativeMode = onboarding?.startsWith('native');
const expectedCharge = fault==='upstream_timeout'?0:onboarding?250:251;
const expectedWithdrawal=5000000-expectedCharge;
const variants=fault==='lost_response'?['success']:fault==='upstream_timeout'?['upstream_timeout']:['success','http_error','invalid_json'];
const expectedCalls=Object.fromEntries([...(onboarding?[]:['legacy']),...variants].map(v=>[v,1]));
const runDir = resolve(process.env.ZKAPI_GENERAL_API_RUN_DIR!);
assert.ok(runDir.startsWith(resolve('target/general-api-local') + '/'));
const directory = await mkdtemp(join(runDir, 'encrypted-journal-'));
const stdin = createInterface({input: process.stdin}), input = stdin[Symbol.asyncIterator]();
const elf = resolve(process.env.ZKAPI_TEST_VAULT_ELF!);
const svm = spawn(resolve(process.env.ZKAPI_TEST_SVM!), [elf], {stdio: ['pipe', 'pipe', 'pipe']});
let svmError = '';
svm.stderr.on('data', b => svmError += b);
const pending: {resolve(v: any): void; reject(e: unknown): void}[] = [];
createInterface({input: svm.stdout}).on('line', line => {
  const next = pending.shift();
  if (next) { try { next.resolve(JSON.parse(line)); } catch (error) { next.reject(error); } }
});
svm.on('exit', code => { for (const next of pending.splice(0)) next.reject(Error(`SBF exited ${code}: ${svmError}`)); });
const call = (value: object) => new Promise<any>((resolve, reject) => { pending.push({resolve, reject}); svm.stdin.write(JSON.stringify(value) + '\n'); });
const now = () => Math.floor(Date.now() / 1000);
const pair = await fixtureSigner(new Uint8Array(32).fill(1));
const key = (n: number) => kitAddress(new Uint8Array(32).fill(n));
const chainFixture = await json('tests/fixtures/vault/genesis-a.json');
const profile = await json('tests/fixtures/layout2/profile.json');
const idl = await read('docs/contracts/zkapi_vault.json');
const inputs = chainFixture.auth.escape.public_inputs as string[];
const authority = {authority: pair.address, program_id: key(20), config_hash: '11'.repeat(32), threshold: 2 as const, members: [key(21), key(22), key(23)]};
const base: Manifest = {...profile, deployment_id: 'general-api-local', deployment_environment: 'local',
  manifest_hash: '00'.repeat(32), manifest_signature: Buffer.alloc(64).toString('base64'),
  genesis_hash: bs58.encode(Buffer.from(chainFixture.genesis, 'hex')), program_id: bs58.encode(Buffer.from(chainFixture.program_id, 'hex')),
  pool: bs58.encode(Buffer.from(chainFixture.pool, 'hex')), mint: key(4), token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', decimals: 6,
  vault_binding: inputs[2], state_key: {x: inputs[4], y: inputs[5]}, clearance_key: {x: inputs[6], y: inputs[7]},
  quote_public_key: (await fixtureSigner(new Uint8Array(32).fill(11))).address,
  receipt_public_key: (await fixtureSigner(new Uint8Array(32).fill(12))).address,
  transaction_formats: ['v0_buffer'], cap_micro_usdc: '1000000', note_ttl_seconds: '2592000', challenge_seconds: '86400',
  control_api_origin: 'http://127.0.0.1:18886', inference_api_origin: 'http://127.0.0.1:18887', proving_keys_base_url: 'http://127.0.0.1:18886/keys',
  idl_hash: digest(idl), api_endpoints: ['/zkapi/v1/config'], tariff_hashes: [], artifact_digests: {vault_idl: digest(idl)}, db_schema_version: '2',
  authorities: {admin: authority, upgrade: {...authority, authority: key(25)}}};
const artifacts: ArtifactBundle = {idl, requestPk: await read('vendor/ethereum-zkapi/protocol/setup/v2/request.pk'),
  requestVk: await read('vendor/ethereum-zkapi/protocol/setup/v2/request.vk'), withdrawalPk: await read('vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.pk'),
  withdrawalVk: await read('vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.vk'), treePk: new Uint8Array(await readFile(process.env.ZKAPI_TEST_TREE_PK!)),
  treeVk: await read('tests/fixtures/layout2/test-tree.vk'), treeSourceBundle: new Uint8Array(await readFile(process.env.ZKAPI_TEST_SOURCE_ARCHIVE!)),
  treeVerifierConstants: await read('tests/fixtures/layout2/tree-vk-wire.bin'), additional: {vault_idl: idl}};
let origin = '', controlOrigin = '', frontendOrigin = '';
let frontendRoutes: any;
const routeCalls: {path:string;backend:string;method:string;rpcMethod?:string}[] = [];
const rpcProbePrefix = 'general-api-frontend-denied:';
const backendRpcProbeCalls: string[] = [], frontendRpcRejections: string[] = [];
function frontendEvidence() {
  if (!onboarding) return {frontend_route_calls:routeCalls};
  for (const method of ['getAccountInfo','getSignatureStatuses','getTransaction','sendTransaction']) {
    assert.ok(routeCalls.some(call => call.backend==='rpc' && call.method==='POST' && call.rpcMethod===method), `generated frontend must carry ${method}`);
  }
  for (const path of ['/zkapi/v1/tree/root','/zkapi/v1/tree/notes/0/zero-path','/zkapi/v1/tree/notes/0/path','/zkapi/v1/tree/snapshot']) {
    assert.ok(routeCalls.some(call => call.backend==='indexer' && call.method==='GET' && call.path===path), `generated frontend must carry ${path}`);
  }
  assert.ok(routeCalls.some(call => call.backend==='indexer' && call.method==='GET' && /^\/zkapi\/v1\/tree\/snapshots\/[0-9a-f]{64}\.json$/.test(call.path)));
  assert.ok(routeCalls.some(call => call.backend==='control' && call.method==='POST' && call.path==='/zkapi/v1/api/catalog/lookup'));
  assert.deepEqual(frontendRpcRejections,['batch','unknown_method']);
  return {generated_frontend_verified:true,frontend_route_calls:routeCalls,
    frontend_rpc_methods:Object.fromEntries([...new Set(routeCalls.flatMap(call=>call.rpcMethod?[call.rpcMethod]:[]))].sort().map(method=>[method,routeCalls.filter(call=>call.rpcMethod===method).length])),
    frontend_rpc_rejections:frontendRpcRejections};
}
const wires = new Map<string,string>();
let invalidObserved!:()=>void, invalidRelease!:()=>void;
const invalidJsonBarrier = {observed:new Promise<void>(resolve=>invalidObserved=resolve),release:()=>invalidRelease()};
const invalidContinue = new Promise<void>(resolve=>invalidRelease=resolve);
let lostObserved!:()=>void, lostRelease!:()=>void;
const lostResponseBarrier={observed:new Promise<void>(resolve=>lostObserved=resolve),release:()=>lostRelease()};
const lostContinue=new Promise<void>(resolve=>lostRelease=resolve);
const snapshots = new Map<string, Uint8Array>(), calls: Record<string, number> = {};
const count = (name: string) => calls[name] = (calls[name] ?? 0) + 1;
const reply = (res: ServerResponse, body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
async function snapshot() {
  const root = await call({kind: 'root'}), active_notes = [];
  for (let id = 0; id < Number(root.next_note_id); id++) {
    const view = await call({kind: 'snapshot', note_id: id});
    assert.equal(view.root, root.root); assert.equal(view.sequence, root.sequence); assert.equal(view.pending, undefined);
    if (view.note.status === 'active') active_notes.push({note_id: String(id), commitment: view.note.registration_commitment,
      deposit_micro_usdc: view.note.deposit_micro_usdc, expiry: view.note.expiry});
  }
  assert.deepEqual(await call({kind: 'root'}), root);
  const bytes = jcsBytes({schema_version: '1', snapshot: root, active_notes, pending_withdrawals: []}), hash = digest(bytes);
  snapshots.set(hash, bytes);
  return {snapshot: root, sha256: hash, download_url: (onboarding ? frontendOrigin : origin) + '/zkapi/v1/tree/snapshots/' + hash + '.json'};
}
async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    if (path === '/rpc') {
      // Observe the rejected probes at the actual backend independently of
      // concurrent control health reads and other legitimate RPC traffic.
      for (const request of Array.isArray(body) ? body : [body]) {
        if (typeof request?.id === 'string' && request.id.startsWith(rpcProbePrefix)) backendRpcProbeCalls.push(request.id);
      }
      const args = body.params; let result: any;
      switch (body.method) {
        case 'getGenesisHash': result = base.genesis_hash; break;
        case 'getSlot': result = Number((await call({kind: 'root'})).slot); break;
        case 'getBlock': result = {blockhash: key(1), previousBlockhash: key(1), parentSlot: args[0] - 1, blockTime: now(), blockHeight: args[0]}; break;
        case 'getMultipleAccounts': result = await call({kind: 'accounts', addresses: args[0]}); break;
        case 'getAccountInfo': { const cut = await call({kind: 'accounts', addresses: [args[0]]}); result = {context: cut.context, value: cut.value[0]}; break; }
        case 'getBlockHeight': result = 100; break;
        case 'getBalance': result = {context:{slot:100},value:10000000000}; break;
        case 'getMinimumBalanceForRentExemption': result = 10000000; break;
        case 'sendTransaction': { const sent = await call({kind:'send',base64:args[0]}); wires.set(sent.signature,args[0]); result=sent.signature; break; }
        case 'getSignatureStatuses': { result={context:{slot:100},value:await Promise.all(args[0].map(async (signature:string)=>{const receipt=await call({kind:'receipt',signature});return receipt?{slot:receipt.slot,confirmations:null,err:receipt.err,confirmationStatus:'finalized'}:null;}))}; break; }
        case 'getTransaction': { const receipt=await call({kind:'receipt',signature:args[0]}); result=receipt?{...receipt.rpc,transaction:[wires.get(args[0]),'base64']}:null; break; }
        case 'getLatestBlockhash': result = {context: {slot: 100}, value: await call({kind: 'blockhash'})}; break;
        default: throw Error('unexpected RPC ' + body.method);
      }
      reply(res, {jsonrpc: '2.0', id: body.id, result}); return;
    }
    if (path === '/zkapi/v1/tree/snapshot') { reply(res, await snapshot()); return; }
    if (/^\/zkapi\/v1\/tree\/snapshots\/[0-9a-f]{64}\.json$/.test(path)) {
      const bytes = snapshots.get(path.split('/').at(-1)!.slice(0, -5));
      if (!bytes) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(Buffer.from(bytes)); return;
    }
    if (path === '/zkapi/v1/tree/root') { reply(res, await call({kind: 'root'})); return; }
    if (path.startsWith('/zkapi/v1/tree/notes/')) { reply(res, await call({kind: 'path', note_id: Number(path.split('/')[5])})); return; }
    assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer general-api-fixture-credential');
    if (path === '/v1/chat/completions') {
      count('legacy'); assert.equal(body.model, 'legacy-fixture');
      reply(res, {id: 'legacy-local', object: 'chat.completion', choices: [{message: {role: 'assistant', content: 'GENERAL_API_PRIVATE_RESULT'}}],
        usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: {cached_tokens: 0}}}); return;
    }
    assert.equal(path, '/lookup'); assert.equal(body.model, undefined); assert.equal(body.query, 'GENERAL_API_PRIVATE_QUERY');
    assert.ok(['success', 'http_error', 'invalid_json','upstream_timeout'].includes(body.variant)); count(body.variant);
    if(body.variant==='upstream_timeout'){await new Promise<void>(resolve=>res.once('close',resolve));return;}
    if (body.variant === 'http_error') { res.statusCode = 503; reply(res, {error: 'fixture temporarily unavailable'}); return; }
    if (body.variant === 'invalid_json') { if(onboarding){invalidObserved();await invalidContinue;} res.setHeader('Content-Type', 'application/json'); res.end('{'); return; }
    reply(res, {items: [{id: 'catalog-42', label: 'GENERAL_API_PRIVATE_RESULT'}], source: 'local catalog'});
  } catch (error) { process.stderr.write(String(error) + '\n'); if (!res.headersSent) res.writeHead(500); res.end('{"error":"fixture failure"}'); }
}
const primary = createServer(handler), secondary = createServer(handler);
const frontend = createServer(async (req,res)=>{
  try {
    assert.ok(frontendRoutes,'frontend configuration required');
    const route=selectFrontendRoute(frontendRoutes,frontendOrigin+req.url,req.method!);assert.ok(route,'registered frontend route required');
    const bytes:Buffer[]=[];for await(const chunk of req)bytes.push(chunk);const body=Buffer.concat(bytes);assert.ok(body.length<=route.requestMaxBytes);
    let rpcMethod:string|undefined;
    if(route.backend==='rpc') {
      const message=JSON.parse(body.toString());
      const reason=Array.isArray(message)?'batch':!message||typeof message!=='object'||typeof message.method!=='string'?'invalid_request':!frontendRoutes.rpcMethods.includes(message.method)?'unknown_method':null;
      if(reason){frontendRpcRejections.push(reason);res.statusCode=400;reply(res,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'restricted RPC request rejected'}});return;}
      rpcMethod=message.method;
    }
    routeCalls.push({path:new URL(req.url!,frontendOrigin).pathname,backend:route.backend,method:req.method!,...(rpcMethod?{rpcMethod}:{})});
    const target=route.backend==='rpc'?frontendRoutes.listeners.rpc:(route.backend==='control'?'http://'+frontendRoutes.listeners.control:'http://'+frontendRoutes.listeners.indexer)+req.url;
    const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value&&key!=='host'&&key!=='connection')headers.set(key,Array.isArray(value)?value.join(','):value);
    if(route.backend==='control')headers.set('Host',new URL(route.origin).host);
    // Fetch forbids overriding Host. Use HTTP directly so the backend sees the
    // authenticated public route origin, while the socket stays on loopback.
    const forwardedHeaders:Record<string,string>={};headers.forEach((value,key)=>forwardedHeaders[key]=value);
    const response=await new Promise<{status:number;headers:IncomingHttpHeaders;body:Buffer}>((resolve,reject)=>{
      const request=httpRequest(target,{method:req.method,headers:forwardedHeaders,signal:AbortSignal.timeout(route.timeoutMs)},upstream=>{
        const chunks:Buffer[]=[];let length=0;
        upstream.on('data',chunk=>{length+=chunk.length;if(length>route.responseMaxBytes)request.destroy(Error('fixture response bound'));else chunks.push(Buffer.from(chunk));});
        upstream.on('error',reject);upstream.on('end',()=>resolve({status:upstream.statusCode??502,headers:upstream.headers,body:Buffer.concat(chunks)}));
      });
      request.on('error',reject);request.end(body);
    });
    res.statusCode=response.status;for(const [key,value] of Object.entries(response.headers))if(value&&!['content-length','transfer-encoding','connection'].includes(key))res.setHeader(key,value);
    if(fault==='lost_response'&&route.path==='/zkapi/v1/api/catalog/lookup'&&response.status===200){lostObserved();await lostContinue;}
    res.end(response.body);
  } catch {if(!res.headersSent)res.writeHead(502);res.end('{"error":"fixture frontend rejected request"}');}
});
const listen = async (server: ReturnType<typeof createServer>) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as any).port}`; };
const localFetch: typeof fetch = async (url, options) => {
  assert.equal(new URL(String(url)).origin, controlOrigin, 'SDK control transport only contacts the local control fixture');
  return fetch(url, options);
};
try {
  origin = await listen(primary); const second = await listen(secondary); if(onboarding) frontendOrigin=await listen(frontend); await call({kind: 'clock', time: now()});
  process.stdout.write(JSON.stringify({ready: true, origin, secondary: second, controlOrigin:frontendOrigin, manifest: base}) + '\n');
  const configuration = JSON.parse((await input.next()).value!), m = configuration.manifest;
  controlOrigin = m.control_api_origin;
  if(onboarding){
    frontendRoutes=configuration.registration.routes;validateFrontendRoutes(frontendRoutes,frontendOrigin);
    const rpcRoute=frontendRoutes.routes.find((route:any)=>route.backend==='rpc');assert.ok(rpcRoute);
    for(const body of [[{jsonrpc:'2.0',id:rpcProbePrefix+'batch',method:'getGenesisHash',params:[]}],{jsonrpc:'2.0',id:rpcProbePrefix+'unknown',method:'getClusterNodes',params:[]}]) {
      const response=await fetch(rpcRoute.origin+rpcRoute.path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.status,400);await response.arrayBuffer();assert.deepEqual(backendRpcProbeCalls,[],'rejected RPC requests must not reach the backend');
    }
  }
  const trust = {anchor: {kind: 'hash', sha256: m.manifest_hash},
    expected: {deployment_id: m.deployment_id, deployment_environment: m.deployment_environment, genesis_hash: m.genesis_hash, program_id: m.program_id,
      pool: m.pool, mint: m.mint, token_program: m.token_program, control_api_origin: controlOrigin, inference_api_origin: m.inference_api_origin},
    build: {stateKey: m.state_key, clearanceKey: m.clearance_key, circuitProfileHash: m.circuit_profile_hash, idlHash: m.idl_hash, setupProfile: m.setup_profile}} as const;
  const manifest = await verifyManifest(jcsBytes(m), trust);
  if(nativeMode){
    const {runNativeOnboarding}=await import('./native-onboarding.ts');
    const report=await runNativeOnboarding({runDir,installation:process.env.ZKAPI_TEST_NATIVE_INSTALLATION!,manifest,trust,artifacts,tariff:configuration.tariffs[0],rpcOrigin:frontendOrigin,roles:{payer:pair.address,uploader:pair.address,feePayer:pair.address,rentPayer:pair.address,tokenOwner:pair.address},walletSeed:pair.secretKey,destinationOwner:key(7),call,calls,invalidJsonBarrier,fault,lostResponseBarrier});
    process.stdout.write(JSON.stringify({...report,...frontendEvidence()})+'\n');
  } else {
  const proverPath = resolve(process.env.ZKAPI_TEST_NATIVE_PROVER!);
  const prover = await NoteProver.create(manifest, artifacts, new NativeProver(proverPath, digest(await read(proverPath))));
  const verifierPath = resolve(process.env.ZKAPI_TEST_VERIFIER!);
  const verifier = new NativeSessionVerifier(verifierPath, digest(await read(verifierPath)));
  const aes = await importJournalKey(crypto.getRandomValues(new Uint8Array(32)));
  const open = async () => new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(directory), aes,
    {deploymentId: manifest.deployment_id, pool: manifest.pool}, validateNoteJournal);
  let journal = await open();
  const connection = createSolanaRpcWithFetch((onboarding?frontendOrigin:origin) + '/rpc', fetch);
  const observed = await connection.getAccountInfo(kitAddress(manifest.pool), {encoding: 'base64', commitment: 'finalized'}).send();
  const pool = decodeRpcAccount(observed.value)!;
  const chain = new SolanaWalletChain(connection, manifest, onboarding?frontendOrigin:origin, {allowLoopbackHttp: true});
  const context = await verifiedClientContext(manifest, manifest.genesis_hash, {address: manifest.pool, owner: pool.owner,
    executable: pool.executable, lamports: BigInt(pool.lamports), data: pool.data, slot: BigInt(observed.context.slot), commitment: 'finalized'}, 0n, artifacts);
  const wallet: V0Wallet = {publicKey: pair.address, supportedTransactionVersions: new Set([0]), async signTransaction(tx) { return signWith(tx, [pair]); }};
  const roles = {payer: pair.address, uploader: pair.address, feePayer: pair.address, rentPayer: pair.address, tokenOwner: pair.address};
  const sends: string[] = []; let loseSend = true;
  const baseRpc: TransportRpc = onboarding ? connectionTransport(connection) : {signatureStatus: async () => null, finalizedBlockHeight: async () => 100,
    finalizedReceipt: async signature => { const receipt = await call({kind: 'receipt', signature}); return receipt ? {...receipt, message: new Uint8Array(Buffer.from(receipt.message, 'base64'))} : null; },
    sendRawTransaction: async bytes => (await call({kind: 'send', base64: Buffer.from(bytes).toString('base64')})).signature};
  const rpc: TransportRpc = {...baseRpc,
    async sendRawTransaction(bytes) {
      const signature = transactionSignature(decodeTransaction(bytes));
      assert.ok((await journal.read('note'))!.value.wallet!.operation!.attempts.some(a => a.signature === signature && a.wireHex === Buffer.from(bytes).toString('hex')));
      sends.push(signature); const result = await baseRpc.sendRawTransaction(bytes);
      if (loseSend) { loseSend = false; throw Error('fixture lost finalized send response'); } return result;
    }};
  let walletClient = new WalletClient({manifest, prover, journal, chain, rpc, wallets: [wallet]});
  const drive = async () => { for (let i = 0; i < 80; i++) { const result = await walletClient.advance('note'); if (result.state === 'complete') return;
    if (result.state === 'proof_required') await walletClient.resumeProof('note'); assert.notEqual(result.state, 'rejected'); } throw Error('wallet did not finish'); };
  await walletClient.beginDeposit('note', '5000000', roles);
  assert.equal((await walletClient.advance('note')).state, 'unknown');
  journal = await open(); walletClient = new WalletClient({manifest, prover, journal, chain, rpc, wallets: [wallet]}); await drive();
  assert.equal(sends.filter(signature => signature === sends[0]).length, 1);
  const witness = structuredClone((await journal.read('note'))!.value.witness!);
  const options = () => ({context, journal, verifier, fetch: localFetch, allowLoopbackHttp: true});
  let client = new ControlClient(options());
  const finishSession = async () => {
    if ((await journal.read('note'))!.value.pending) await client.close('note');
    journal = await open(); client = new ControlClient(options());
    for (let i = 0; (await journal.read('note'))!.value.pending && i < 1000; i++) { await new Promise(resolve => setTimeout(resolve, 30)); await client.recover('note'); }
    assert.equal((await journal.read('note'))!.value.pending, null);
  };
  const generic = configuration.tariffs[onboarding?0:1] as ApiTariff;
  let retainedHistory: string | undefined;
  if(!onboarding){
  const legacy = configuration.tariffs[0] as Tariff;
  const oldQuote = await client.quote({mode: 'proxy', provider: 'openai', models: ['legacy-fixture'], session_ttl_seconds: '60'}, legacy);
  const cut = await chain.sessionSnapshot(witness.note_id, prover), before = (await journal.read('note'))!.value;
  const oldPrepared = await prover.prepareSession(witness, before.state, cut.root, cut.siblings, oldQuote, legacy, await createCredentials('proxy'));
  await client.prepare('note', oldPrepared, cut.root); await client.submit('note');
  const legacyId = crypto.randomUUID();
  await client.prepareOperation('note', legacyId, '/v1/chat/completions', jcsBytes({model: 'legacy-fixture', messages: [{role: 'user', content: 'GENERAL_API_PRIVATE_QUERY'}], max_completion_tokens: 20}));
  const legacyResponse = await client.sendOperation('note', legacyId); assert.equal(legacyResponse.status, 200); await legacyResponse.json(); await finishSession();
  retainedHistory = JSON.stringify((await journal.read('note'))!.value.history[0]);
  assert.equal((await journal.read('note'))!.value.history[0].settlement.charge_micro_usdc, '1');
  }
  const daemon = new ClientDaemon({client, journal, noteId: 'note', mode: 'proxy', models: [], services: [{tariff: generic}], keyReuseSeconds: 60,
    prepare: async () => { throw Error('general API never prepares an inference model'); },
    prepareApi: async (api: ApiBinding, credentials) => {
      const quote = await client.quoteApi(api, generic), record = (await journal.read('note'))!.value;
      assert.equal('models' in quote.body, false); assert.equal('model' in generic, false);
      const cut = await chain.sessionSnapshot(witness.note_id, prover);
      return {prepared: await prover.prepareSession(witness, record.state, cut.root, cut.siblings, quote, generic, credentials), root: cut.root};
    }});
  await daemon.start();
  await assert.rejects(daemon.requestApi('unlisted', 'lookup', jcsBytes({query: 'x'})));
  await assert.rejects(daemon.requestApi('catalog', 'lookup', new TextEncoder().encode('{')));
  assert.deepEqual(calls, onboarding?{}:{legacy: 1}, 'invalid local requests cannot authorize or dispatch');
  const facadeStore=await NativeJournalStore.open(directory);
  const createFacade=()=>onboarding?new ZkApiClient({wallet:{manifest,prover,journal,chain,rpc,wallets:[wallet]},control:client,store:facadeStore,noteId:'note',mode:'proxy',models:[],services:[{tariff:generic}]}):null;
  let facade=createFacade();
  if(facade)await facade.recover();
  const accepted: {id: string; variant: string}[] = [];
  const apiPath = '/zkapi/v1/api/catalog/lookup';
  for (const variant of variants) {
    const id = crypto.randomUUID(), body = jcsBytes({query: 'GENERAL_API_PRIVATE_QUERY', variant});
    const abort=new AbortController();
    const execution = facade?facade.requestApi({service:'catalog',operation:'lookup',body:JSON.parse(new TextDecoder().decode(body)),operationId:id,signal:abort.signal}):daemon.requestApi('catalog', 'lookup', body, id);
    const interrupted=!!onboarding&&(variant==='invalid_json'||fault==='lost_response');
    const barrier=fault==='lost_response'?lostResponseBarrier:invalidJsonBarrier;
    let response:Response|null;
    if(interrupted){
      await barrier.observed;
      if(fault==='lost_response'){const state=await client.operationStatus('note',id) as any;assert.equal(state.state,'DONE');}
      abort.abort();
      response=await execution.catch(()=>null); assert.equal(response,null);
      facade!.dispose(); barrier.release();
    } else response=await execution;
    if((calls as Record<string, number>)[variant]!==1)assert.fail(`fixture dispatch missing (${variant}): HTTP ${response?.status} ${response ? await response.text() : 'interrupted'}`);
    await assert.rejects(daemon.requestApi('catalog', 'lookup', body, id));
    await assert.rejects(daemon.requestApi('catalog', 'lookup', jcsBytes({query: 'changed', variant}), id));
    const record = (await journal.read('note'))!.value;
    const operationSession=record.pending?.operations.some(o=>o.id===id)?record.pending:record.history.find(h=>h.operations.some(o=>o.id===id));
    assert.ok(operationSession,'original operation authorization must remain available after automatic settlement');
    const token = operationSession.prepared.proxy_token!;
    const raw = async (path: string, bytes: Uint8Array, operationId: string) => fetch(controlOrigin + path, {method: 'POST',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': operationId}, body: new Uint8Array(bytes)});
    for (const bytes of [body, jcsBytes({query: 'changed', variant})]) { const duplicate = await raw(apiPath, bytes, id); assert.equal(duplicate.status, 409); await duplicate.arrayBuffer(); }
    if (variant === 'success') {
      for (const [path, bytes] of [[apiPath, new TextEncoder().encode('{')], ['/zkapi/v1/api/catalog/unknown', body],
        ['/zkapi/v1/api/unlisted/lookup', body], ['/v1/chat/completions', jcsBytes({model: 'legacy-fixture', messages: [{role: 'user', content: 'GENERAL_API_PRIVATE_QUERY'}], max_completion_tokens: 20})]] as const) {
        const invalid = await raw(path, bytes, crypto.randomUUID()); assert.ok(invalid.status >= 400); await invalid.arrayBuffer();
      }
      assert.deepEqual(calls, onboarding?{success:1}:{legacy: 1, success: 1}, 'server validation and duplicates cannot re-dispatch');
    }
    if (variant === 'success'&&response) { assert.equal(response!.status, 200); assert.equal((await response!.json()).items[0].id, 'catalog-42'); }
    else if(response) { assert.ok(response.status >= 400); await response.arrayBuffer(); }
    await finishSession();
    if(interrupted){facade=createFacade();await facade!.recover();assert.equal((calls as Record<string,number>)[variant],1);}
    accepted.push({id, variant});
  }
  // Reopen the same encrypted note and recover signed receipts/successor. No
  // request body is sent during recovery, including invalid upstream JSON.
  await daemon.management('close'); await finishSession();
  const settled = (await journal.read('note'))!.value;
  if(!onboarding)assert.equal(JSON.stringify(settled.history[0]), retainedHistory); assert.deepEqual(settled.witness, witness);
  assert.equal(settled.state.balance_micro_usdc, String(expectedWithdrawal));
  assert.equal(settled.history.length, variants.length+(onboarding?0:1));
  const cases = accepted.map(({id, variant}) => {
    const history = settled.history.find(h => h.operations.some(o => o.id === id))!; assert.ok(history);
    assert.equal(history.settlement.charge_micro_usdc, variant === 'success' ? '250' : '0');
    assert.equal(history.receipts.length, 1);
    const receipt = history.receipts.find(r => r.body.operation_id === id)!; assert.ok(receipt);
    assert.equal(receipt.body.charged_nano_usdc, variant === 'success' ? '250000' : '0');
    if (variant === 'success') assert.deepEqual(receipt.body.usage, [{unit: 'requests', count: '1'}]);
    return {variant, operation_id: id, request_id: history.prepared.request.authorization.request_id,
      charged_nano_usdc: receipt.body.charged_nano_usdc, operation_state: ['invalid_json','upstream_timeout'].includes(variant) ? 'WAIVED_OPERATOR_LOSS' : 'DONE', receipt_verified: true};
  });
  assert.deepEqual(calls, expectedCalls);
  walletClient = new WalletClient({manifest, prover, journal, chain, rpc, wallets: [wallet]});
  await walletClient.beginWithdrawal('note', 'mutual_close', key(7), roles); await drive();
  const final = (await journal.read('note'))!.value;
  assert.equal(final.wallet!.status, 'closed'); if(!onboarding)assert.equal(JSON.stringify(final.history[0]), retainedHistory); assert.equal(final.history.length, variants.length+(onboarding?0:1));
  const report = await call({kind: 'report', name: 'general-api', report_path: join(runDir, 'vault-sbf-results.json')});
  assert.equal(report.vault_micro_usdc, 0); assert.equal(report.destination_micro_usdc, expectedWithdrawal); assert.equal(report.treasury_micro_usdc, expectedCharge);
  assert.equal(report.source_micro_usdc + report.destination_micro_usdc + report.vault_micro_usdc + report.treasury_micro_usdc, 100000000);
  assert.ok(report.rows.every((row: any) => row.error === null));
  const journalBytes = Buffer.concat(await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name)).catch(() => Buffer.alloc(0))))).toString();
  for (const secret of ['GENERAL_API_PRIVATE_QUERY', 'GENERAL_API_PRIVATE_RESULT', witness.secret]) assert.equal(journalBytes.includes(secret), false);
  if(facade)await facade.dispose();
  process.stdout.write(JSON.stringify({passed: true,...frontendEvidence(),api_only:!!onboarding,installed_sdk:!!process.env.ZKAPI_TEST_LIFECYCLE_SCRIPT, scope: 'local actual proofs/Vault SBF with synthetic API and RPC finality', cases, provider_calls: calls,
    encrypted_journal: true, legacy_history_unchanged: !onboarding, lost_finalized_send_recovered: true, request_proof_verified: true, receipts_verified: true,
    signed_successor_verified: true, request_body_has_no_model: true, duplicates_not_replayed: true, invalid_requests_no_egress: true,
    restarted_journal_recovery: true, automatic_api_replays: 0, deposit_micro_usdc: '5000000', total_charge_micro_usdc:String(expectedCharge),
    generic_charge_micro_usdc:String(fault==='upstream_timeout'?0:250), legacy_charge_micro_usdc: onboarding?'0':'1', withdrawal_micro_usdc:String(expectedWithdrawal), balance_conservation: true, chain: report,
    live_provider_verified: false, public_rpc_verified: false, release_gates_passed: []}) + '\n');
  }
} finally {
  invalidJsonBarrier.release();lostResponseBarrier.release();
  stdin.close();
  await Promise.all([primary, secondary,...(onboarding?[frontend]:[])].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  if (svm.exitCode === null) { const done = once(svm, 'exit'); svm.stdin.end(); await done; }
}
