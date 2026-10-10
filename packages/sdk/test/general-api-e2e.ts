/** Fresh local fixed-price API lifecycle. The Rust parent supplies the actual
 * control App/PostgreSQL/signerd/dispatcherd. RPC finality and API responses are
 * fixtures; signed transactions execute in the actual Vault SBF. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import bs58 from 'bs58';
import {decodeRpcAccount} from '../src/solana-rpc.ts';
import {createSolanaRpcWithFetch, transactionSignature} from '../src/solana.ts';
import {fixtureSigner, signWith, decodeTransaction, kitAddress} from './kit-helpers.ts';
import {WalletClient} from '../src/wallet.ts';
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
import type {TransportRpc, V0Wallet} from '../src/transport.ts';
import {read, json, digest} from './wallet-fixture.ts';

const runDir = resolve(process.env.ZKAPI_GENERAL_API_RUN_DIR!);
assert.ok(runDir.startsWith(resolve('target/general-api-local') + '/'));
const directory = await mkdtemp(join(runDir, 'encrypted-journal-'));
const stdin = createInterface({input: process.stdin}), input = stdin[Symbol.asyncIterator]();
const elf = resolve(process.env.ZKAPI_TEST_VAULT_ELF ?? 'target/i04-sbf/zkapi_vault.so');
const svm = spawn(resolve('tests/svm/target/debug/wallet'), [elf], {stdio: ['pipe', 'pipe', 'pipe']});
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
  withdrawalVk: await read('vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.vk'), treePk: await read('target/i09-challenger/test-tree.pk'),
  treeVk: await read('tests/fixtures/layout2/test-tree.vk'), treeSourceBundle: await read('target/i08-wallet/circuit-source.tar'),
  treeVerifierConstants: await read('tests/fixtures/layout2/tree-vk-wire.bin'), additional: {vault_idl: idl}};
let origin = '', controlOrigin = '';
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
  return {snapshot: root, sha256: hash, download_url: origin + '/zkapi/v1/tree/snapshots/' + hash + '.json'};
}
async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    if (path === '/rpc') {
      const args = body.params; let result: any;
      switch (body.method) {
        case 'getGenesisHash': result = base.genesis_hash; break;
        case 'getSlot': result = Number((await call({kind: 'root'})).slot); break;
        case 'getBlock': result = {blockhash: key(1), previousBlockhash: key(1), parentSlot: args[0] - 1, blockTime: now(), blockHeight: args[0]}; break;
        case 'getMultipleAccounts': result = await call({kind: 'accounts', addresses: args[0]}); break;
        case 'getAccountInfo': { const cut = await call({kind: 'accounts', addresses: [args[0]]}); result = {context: cut.context, value: cut.value[0]}; break; }
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
    assert.ok(['success', 'http_error', 'invalid_json'].includes(body.variant)); count(body.variant);
    if (body.variant === 'http_error') { res.statusCode = 503; reply(res, {error: 'fixture temporarily unavailable'}); return; }
    if (body.variant === 'invalid_json') { res.setHeader('Content-Type', 'application/json'); res.end('{'); return; }
    reply(res, {items: [{id: 'catalog-42', label: 'GENERAL_API_PRIVATE_RESULT'}], source: 'local catalog'});
  } catch (error) { process.stderr.write(String(error) + '\n'); if (!res.headersSent) res.writeHead(500); res.end('{"error":"fixture failure"}'); }
}
const primary = createServer(handler), secondary = createServer(handler);
const listen = async (server: ReturnType<typeof createServer>) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${(server.address() as any).port}`; };
const localFetch: typeof fetch = async (url, options) => {
  assert.equal(new URL(String(url)).origin, controlOrigin, 'SDK control transport only contacts the local control fixture');
  return fetch(url, options);
};
try {
  origin = await listen(primary); const second = await listen(secondary); await call({kind: 'clock', time: now()});
  process.stdout.write(JSON.stringify({ready: true, origin, secondary: second, manifest: base}) + '\n');
  const configuration = JSON.parse((await input.next()).value!), m = configuration.manifest;
  controlOrigin = m.control_api_origin;
  const manifest = await verifyManifest(jcsBytes(m), {anchor: {kind: 'hash', sha256: m.manifest_hash},
    expected: {deployment_id: m.deployment_id, deployment_environment: m.deployment_environment, genesis_hash: m.genesis_hash, program_id: m.program_id,
      pool: m.pool, mint: m.mint, token_program: m.token_program, control_api_origin: controlOrigin, inference_api_origin: m.inference_api_origin},
    build: {stateKey: m.state_key, clearanceKey: m.clearance_key, circuitProfileHash: m.circuit_profile_hash, idlHash: m.idl_hash, setupProfile: m.setup_profile}});
  const proverPath = resolve('apps/clientd/prover/target/release/zkapi-client-prover');
  const prover = await NoteProver.create(manifest, artifacts, new NativeProver(proverPath, digest(await read(proverPath))));
  const verifierPath = resolve('apps/clientd/companion/target/debug/zkapi-client-verify');
  const verifier = new NativeSessionVerifier(verifierPath, digest(await read(verifierPath)));
  const aes = await importJournalKey(crypto.getRandomValues(new Uint8Array(32)));
  const open = async () => new EncryptedJournal<NoteJournal>(await NativeJournalStore.open(directory), aes,
    {deploymentId: manifest.deployment_id, pool: manifest.pool}, validateNoteJournal);
  let journal = await open();
  const connection = createSolanaRpcWithFetch(origin + '/rpc', fetch);
  const observed = await connection.getAccountInfo(kitAddress(manifest.pool), {encoding: 'base64', commitment: 'finalized'}).send();
  const pool = decodeRpcAccount(observed.value)!;
  const chain = new SolanaWalletChain(connection, manifest, origin, {allowLoopbackHttp: true});
  const context = await verifiedClientContext(manifest, manifest.genesis_hash, {address: manifest.pool, owner: pool.owner,
    executable: pool.executable, lamports: BigInt(pool.lamports), data: pool.data, slot: BigInt(observed.context.slot), commitment: 'finalized'}, 0n, artifacts);
  const wallet: V0Wallet = {publicKey: pair.address, supportedTransactionVersions: new Set([0]), async signTransaction(tx) { return signWith(tx, [pair]); }};
  const roles = {payer: pair.address, uploader: pair.address, feePayer: pair.address, rentPayer: pair.address, tokenOwner: pair.address};
  const sends: string[] = []; let loseSend = true;
  const rpc: TransportRpc = {signatureStatus: async () => null, finalizedBlockHeight: async () => 100,
    finalizedReceipt: async signature => { const receipt = await call({kind: 'receipt', signature}); return receipt ? {...receipt, message: new Uint8Array(Buffer.from(receipt.message, 'base64'))} : null; },
    async sendRawTransaction(bytes) {
      const signature = transactionSignature(decodeTransaction(bytes));
      assert.ok((await journal.read('note'))!.value.wallet!.operation!.attempts.some(a => a.signature === signature && a.wireHex === Buffer.from(bytes).toString('hex')));
      sends.push(signature); const result = await call({kind: 'send', base64: Buffer.from(bytes).toString('base64')});
      if (loseSend) { loseSend = false; throw Error('fixture lost finalized send response'); } return result.signature;
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
    for (let i = 0; (await journal.read('note'))!.value.pending && i < 150; i++) { await new Promise(resolve => setTimeout(resolve, 30)); await client.recover('note'); }
    assert.equal((await journal.read('note'))!.value.pending, null);
  };
  const legacy = configuration.tariffs[0] as Tariff, generic = configuration.tariffs[1] as ApiTariff;
  const oldQuote = await client.quote({mode: 'proxy', provider: 'openai', models: ['legacy-fixture'], session_ttl_seconds: '60'}, legacy);
  const cut = await chain.sessionSnapshot(witness.note_id, prover), before = (await journal.read('note'))!.value;
  const oldPrepared = await prover.prepareSession(witness, before.state, cut.root, cut.siblings, oldQuote, legacy, await createCredentials('proxy'));
  await client.prepare('note', oldPrepared, cut.root); await client.submit('note');
  const legacyId = crypto.randomUUID();
  await client.prepareOperation('note', legacyId, '/v1/chat/completions', jcsBytes({model: 'legacy-fixture', messages: [{role: 'user', content: 'GENERAL_API_PRIVATE_QUERY'}], max_completion_tokens: 20}));
  const legacyResponse = await client.sendOperation('note', legacyId); assert.equal(legacyResponse.status, 200); await legacyResponse.json(); await finishSession();
  const retainedHistory = JSON.stringify((await journal.read('note'))!.value.history[0]);
  assert.equal((await journal.read('note'))!.value.history[0].settlement.charge_micro_usdc, '1');
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
  assert.deepEqual(calls, {legacy: 1}, 'invalid local requests cannot authorize or dispatch');
  const accepted: {id: string; variant: string}[] = [];
  const apiPath = '/zkapi/v1/api/catalog/lookup';
  for (const variant of ['success', 'http_error', 'invalid_json']) {
    const id = crypto.randomUUID(), body = jcsBytes({query: 'GENERAL_API_PRIVATE_QUERY', variant});
    const response = await daemon.requestApi('catalog', 'lookup', body, id);
    assert.equal((calls as Record<string, number>)[variant], 1);
    await assert.rejects(daemon.requestApi('catalog', 'lookup', body, id));
    await assert.rejects(daemon.requestApi('catalog', 'lookup', jcsBytes({query: 'changed', variant}), id));
    const record = (await journal.read('note'))!.value, token = record.pending!.prepared.proxy_token!;
    const raw = async (path: string, bytes: Uint8Array, operationId: string) => fetch(controlOrigin + path, {method: 'POST',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': operationId}, body: new Uint8Array(bytes)});
    for (const bytes of [body, jcsBytes({query: 'changed', variant})]) { const duplicate = await raw(apiPath, bytes, id); assert.equal(duplicate.status, 409); await duplicate.arrayBuffer(); }
    if (variant === 'success') {
      for (const [path, bytes] of [[apiPath, new TextEncoder().encode('{')], ['/zkapi/v1/api/catalog/unknown', body],
        ['/zkapi/v1/api/unlisted/lookup', body], ['/v1/chat/completions', jcsBytes({model: 'legacy-fixture', messages: [{role: 'user', content: 'GENERAL_API_PRIVATE_QUERY'}], max_completion_tokens: 20})]] as const) {
        const invalid = await raw(path, bytes, crypto.randomUUID()); assert.ok(invalid.status >= 400); await invalid.arrayBuffer();
      }
      assert.deepEqual(calls, {legacy: 1, success: 1}, 'server validation and duplicates cannot re-dispatch');
    }
    if (variant === 'success') { assert.equal(response.status, 200); assert.equal((await response.json()).items[0].id, 'catalog-42'); }
    else { assert.ok(response.status >= 400); await response.arrayBuffer(); }
    await finishSession();
    accepted.push({id, variant});
  }
  // Reopen the same encrypted note and recover signed receipts/successor. No
  // request body is sent during recovery, including invalid upstream JSON.
  await daemon.management('close'); await finishSession();
  const settled = (await journal.read('note'))!.value;
  assert.equal(JSON.stringify(settled.history[0]), retainedHistory); assert.deepEqual(settled.witness, witness);
  assert.equal(settled.state.balance_micro_usdc, '4999749');
  assert.equal(settled.history.length, 4);
  const cases = accepted.map(({id, variant}) => {
    const history = settled.history.find(h => h.operations.some(o => o.id === id))!; assert.ok(history);
    assert.equal(history.settlement.charge_micro_usdc, variant === 'success' ? '250' : '0');
    assert.equal(history.receipts.length, 1);
    const receipt = history.receipts.find(r => r.body.operation_id === id)!; assert.ok(receipt);
    assert.equal(receipt.body.charged_nano_usdc, variant === 'success' ? '250000' : '0');
    if (variant === 'success') assert.deepEqual(receipt.body.usage, [{unit: 'requests', count: '1'}]);
    return {variant, operation_id: id, request_id: history.prepared.request.authorization.request_id,
      charged_nano_usdc: receipt.body.charged_nano_usdc, operation_state: variant === 'invalid_json' ? 'WAIVED_OPERATOR_LOSS' : 'DONE', receipt_verified: true};
  });
  assert.deepEqual(calls, {legacy: 1, success: 1, http_error: 1, invalid_json: 1});
  walletClient = new WalletClient({manifest, prover, journal, chain, rpc, wallets: [wallet]});
  await walletClient.beginWithdrawal('note', 'mutual_close', key(7), roles); await drive();
  const final = (await journal.read('note'))!.value;
  assert.equal(final.wallet!.status, 'closed'); assert.equal(JSON.stringify(final.history[0]), retainedHistory); assert.equal(final.history.length, 4);
  const report = await call({kind: 'report', name: 'general-api', report_path: join(runDir, 'vault-sbf-results.json')});
  assert.equal(report.vault_micro_usdc, 0); assert.equal(report.destination_micro_usdc, 4999749); assert.equal(report.treasury_micro_usdc, 251);
  assert.equal(report.source_micro_usdc + report.destination_micro_usdc + report.vault_micro_usdc + report.treasury_micro_usdc, 100000000);
  assert.ok(report.rows.every((row: any) => row.error === null));
  const journalBytes = Buffer.concat(await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name)).catch(() => Buffer.alloc(0))))).toString();
  for (const secret of ['GENERAL_API_PRIVATE_QUERY', 'GENERAL_API_PRIVATE_RESULT', witness.secret]) assert.equal(journalBytes.includes(secret), false);
  process.stdout.write(JSON.stringify({passed: true, scope: 'local actual proofs/Vault SBF with synthetic API and RPC finality', cases, provider_calls: calls,
    encrypted_journal: true, legacy_history_unchanged: true, lost_finalized_send_recovered: true, request_proof_verified: true, receipts_verified: true,
    signed_successor_verified: true, request_body_has_no_model: true, duplicates_not_replayed: true, invalid_requests_no_egress: true,
    restarted_journal_recovery: true, automatic_api_replays: 0, deposit_micro_usdc: '5000000', total_charge_micro_usdc: '251',
    generic_charge_micro_usdc: '250', legacy_charge_micro_usdc: '1', withdrawal_micro_usdc: '4999749', balance_conservation: true, chain: report,
    live_provider_verified: false, public_rpc_verified: false, release_gates_passed: []}) + '\n');
} finally {
  stdin.close();
  await Promise.all([primary, secondary].map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  if (svm.exitCode === null) { const done = once(svm, 'exit'); svm.stdin.end(); await done; }
}
