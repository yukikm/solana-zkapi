import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {request} from 'node:http';
import {startUiHost, configuredHost, loadProviderUi, GENESIS, type HostOptions} from './host.ts';
import {jcsBytes, sha256Hex} from '../../packages/sdk/src/trust.ts';
import {providerAcceptanceBody} from '../provider_acceptance_client.ts';
test('presentation assets use an exact route allowlist and preserve the live document without backend calls', async t => {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-demo-routes-')); t.after(() => rm(output, {recursive: true, force: true}));
  const content = {'index.html': '<main>live wallet</main>', 'app.js': '/* live app */', 'style.css': '/* live style */',
    'demo.html': '<main>presentation only</main>', 'demo.js': '/* presentation script */', 'demo.css': '/* presentation style */'};
  for (const [name, text] of Object.entries(content)) await writeFile(join(output, name), text);
  let calls = 0;
  const denied = async () => { calls++; throw Error('unexpected backend call'); };
  const host = await startUiHost({port: 0, output, rpc: denied, clearance: denied, indexer: denied}); t.after(() => host.close());
  for (const [path, name, mime] of [['/', 'index.html', 'text/html'], ['/demo', 'demo.html', 'text/html'], ['/live', 'index.html', 'text/html'],
    ['/demo.js', 'demo.js', 'text/javascript'], ['/demo.css', 'demo.css', 'text/css'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css']]) {
    const response = await fetch(host.origin + path);
    assert.equal(response.status, 200); assert.equal(await response.text(), content[name as keyof typeof content]);
    assert.equal(response.headers.get('content-type'), mime); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('content-security-policy')?.includes("connect-src 'self'"));
  }
  for (const path of ['/demo.html', '/index.html', '/demo/', '/live/', '/demo.js?file=app.js', '/demo.css?x=1', '/unknown']) {
    assert.equal((await fetch(host.origin + path)).status, 400, path);
  }
  for (const path of ['/', '/demo', '/live', '/demo.js', '/demo.css']) {
    assert.equal((await fetch(host.origin + path, {method: 'POST', headers: {origin: host.origin}, body: '{}'})).status, 400);
    assert.equal((await fetch(host.origin + path, {headers: {origin: 'https://foreign.invalid'}})).status, 400);
  }
  assert.equal(calls, 0);
});

test('fixture output keeps root and live on the existing document, and partial demo output fails closed', async t => {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-demo-fixture-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'original fixture');
  const host = await startUiHost({port: 0, output}); t.after(() => host.close());
  assert.equal(await (await fetch(host.origin + '/')).text(), 'original fixture');
  assert.equal(await (await fetch(host.origin + '/live')).text(), 'original fixture');
  assert.equal((await fetch(host.origin + '/demo')).status, 400);
  assert.equal((await fetch(host.origin + '/demo.js')).status, 400);
  await writeFile(join(output, 'demo.html'), 'incomplete presentation');
  await assert.rejects(startUiHost({port: 0, output}), /ENOENT/);
});

test('indexer relay allows common snapshots only through exact bounded digest routes', async t => {
  const output=await mkdtemp(join(tmpdir(),'zkapi-ui-snapshot-routes-'));t.after(()=>rm(output,{recursive:true,force:true}));
  for(const file of ['index.html','app.js','style.css'])await writeFile(join(output,file),'fixture');
  const calls:string[]=[];
  const host=await startUiHost({port:0,output,indexer:async path=>{calls.push(path);return {status:200,bytes:Buffer.from('{}')};}});
  t.after(()=>host.close());
  for(const path of ['/zkapi/v1/tree/snapshot','/zkapi/v1/tree/snapshots/'+ 'ab'.repeat(32)+'.json']){
    const r=await fetch(host.origin+'/indexer'+path);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
  }
  assert.equal(calls.length,2);
  for(const path of ['/snapshot?note=0','/snapshots/'+ 'AB'.repeat(32)+'.json','/snapshots/short.json','/snapshots/'+ 'ab'.repeat(32)+'.json?url=https://elsewhere.invalid','/snapshots/'+ 'ab'.repeat(32)+'.json/']){
    assert.equal((await fetch(host.origin+'/indexer/zkapi/v1/tree'+path)).status,400,path);
  }
  assert.equal(calls.length,2);
});

test('loopback host denies foreign origins, arbitrary provider/routes/batch RPC and financial sends by default', async t => {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-host-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'fixture');
  const calls: any[] = [], host = await startUiHost({port: 0, output, rpc: async data => { calls.push(JSON.parse(data.toString())); return {status: 200, bytes: Buffer.from('{"jsonrpc":"2.0","id":1,"result":"fixture"}')}; }}); t.after(() => host.close());
  const post = (value: unknown, path = '/rpc', origin = host.origin, extra = {}) => new Promise<{status:number}>((resolve,reject)=>{const r=request(host.origin+path,{method:'POST',headers:{origin,'content-type':'application/json',...extra}},res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode!}));});r.on('error',reject);r.end(JSON.stringify(value));});
  const get = await fetch(host.origin); assert.equal(get.status, 200); assert.equal(get.headers.get('access-control-allow-origin'), null); assert.ok(get.headers.get('content-security-policy')?.includes("connect-src 'self'"));
  const valid = {jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: []}; assert.equal((await post(valid)).status, 200); assert.equal(calls.length, 1);
  for (const [index, result] of [await post(valid, '/rpc', 'https://attacker.invalid'), await post(valid, '/rpc', host.origin, {host: 'attacker.invalid'}), await post(valid, '/rpc', host.origin, {'sec-fetch-site': 'cross-site'}), await post(valid, '/provider'), await post([valid]), await post({...valid, method: 'requestAirdrop'}), await post({...valid, method: 'sendTransaction', params: ['AA==', {encoding: 'base64'}]}), await post({...valid, method: 'getBlock', params: [1, {transactionDetails: 'full'}]})].entries()) assert.equal(result.status, 400, 'request '+index);
  assert.equal(calls.length, 1);
  assert.equal((await fetch(host.origin + '/indexer/zkapi/v1/tree/root?url=https://attacker.invalid')).status, 400);
});

for (const commitment of [undefined, 'confirmed'] as const) test(`financial relay uses ${commitment ?? 'default'} preparation with exact signed v0, genesis, pool and fee guards`, async t => {
  const {Keypair, PublicKey, TransactionInstruction} = await import('@solana/web3.js');
  const {compileV0, discriminator} = await import('../../packages/sdk/src/transport.ts');
  const {GENESIS} = await import('./host.ts');
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-send-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'fixture');
  const pair = Keypair.fromSeed(new Uint8Array(32).fill(33)), program = new PublicKey(new Uint8Array(32).fill(34)), pool = new PublicKey(new Uint8Array(32).fill(35));
  let genesis = GENESIS, fee: number|null = 5000;
  const forwarded: any[] = []; let historyCalls = 0;
  const options: HostOptions = {port: 0, output, allowTransactions: true, preparationCommitment: commitment, manifest: {program_id: program.toBase58(), pool: pool.toBase58()} as any,
    historyRpc: async () => { historyCalls++; throw Error('financial requests must not reach history RPC'); },
    rpc: async data => { const r = JSON.parse(data.toString()); let result: unknown;
      if (r.method === 'getGenesisHash') result = genesis; else if (r.method === 'getFeeForMessage') {
        assert.deepEqual(r.params[1], {commitment: commitment ?? 'finalized'}); result = {context: {slot: 1}, value: fee};
      }
      else if (r.method === 'sendTransaction') { forwarded.push(r); result = 'fixture-no-public-send'; } else throw Error('unexpected fixture request');
      return {status: 200, bytes: Buffer.from(JSON.stringify({jsonrpc: '2.0', id: r.id, result}))}; }};
  const host = await startUiHost(options); t.after(() => host.close());
  options.preparationCommitment = commitment === 'confirmed' ? 'finalized' : 'confirmed';
  const make = async (name = 'seal_payload', owner = program, boundPool = pool, sign = true) => { const tx = compileV0(new TransactionInstruction({programId: owner, keys: [{pubkey: pair.publicKey, isWritable: false, isSigner: false}, {pubkey: boundPool, isWritable: false, isSigner: false}, {pubkey: pair.publicKey, isWritable: false, isSigner: true}], data: Buffer.from(await discriminator(name))}), pair.publicKey, new PublicKey(new Uint8Array(32).fill(36)).toBase58()); if (sign) tx.sign([pair]); return Buffer.from(tx.serialize()).toString('base64'); };
  const post = (wire: string) => fetch(host.origin + '/rpc', {method: 'POST', headers: {origin: host.origin, 'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [wire, {encoding: 'base64', skipPreflight: true, maxRetries: 999}]})});
  const valid = await make();
  // A configured pool key present but unused by the actual Vault account slot must fail.
  const {VersionedTransaction} = await import('@solana/web3.js');
  const wrongPool = VersionedTransaction.deserialize(Buffer.from(await make('seal_payload', program, pair.publicKey), 'base64'));
  wrongPool.message.staticAccountKeys.push(pool); wrongPool.sign([pair]);
  assert.equal((await post(Buffer.from(wrongPool.serialize()).toString('base64'))).status, 400);
  genesis = 'mainnet-is-refused'; assert.equal((await post(valid)).status, 400); genesis = GENESIS;
  for (fee of [null, 10001]) assert.equal((await post(valid)).status, 400); fee = 5000;
  for (const wire of [await make('initialize_pool'), await make('seal_payload', pair.publicKey), await make('seal_payload', program, pair.publicKey), await make('seal_payload', program, pool, false)]) assert.equal((await post(wire)).status, 400);
  assert.equal(forwarded.length, 0);
  assert.equal((await post(valid)).status, 200); assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].params[0], valid); assert.deepEqual(forwarded[0].params[1], {encoding: 'base64', skipPreflight: false, preflightCommitment: commitment ?? 'finalized', maxRetries: 0});
  assert.equal(historyCalls, 0);
});

test('invalid preparation commitment fails before file reads, RPC or listener startup', async () => {
  for (const preparationCommitment of ['processed','recent',null,1]) {
    await assert.rejects(startUiHost({port:0,output:'missing',preparationCommitment:preparationCommitment as never}),/invalid transaction preparation commitment/);
    await assert.rejects(configuredHost({preparationCommitment} as never,'missing'),/invalid transaction preparation commitment/);
  }
});

test('explicit history endpoint receives only transaction reads after its own Devnet pin; primary reads remain primary', async t => {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-history-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'fixture');
  const primary: any[] = [], history: any[] = [];
  let historyResult: unknown = null;
  const host = await startUiHost({port: 0, output,
    rpc: async data => { const json = JSON.parse(data.toString()); primary.push(json); return {status: 200, bytes: Buffer.from(JSON.stringify({jsonrpc: '2.0', id: json.id, result: 'primary'}))}; },
    historyRpc: async data => { const json = JSON.parse(data.toString()); history.push(json); assert.ok(['getGenesisHash','getTransaction'].includes(json.method)); return {status: 200, bytes: Buffer.from(JSON.stringify({jsonrpc: '2.0', id: json.id, result: json.method === 'getGenesisHash' ? GENESIS : historyResult}))}; }}); t.after(() => host.close());
  const post = (value: unknown) => fetch(host.origin + '/rpc', {method: 'POST', headers: {origin: host.origin}, body: JSON.stringify(value)});
  const query = {jsonrpc: '2.0', id: 'saved-signature-check', method: 'getTransaction', params: ['fixture-signature', {commitment: 'finalized', maxSupportedTransactionVersion: 0}]};
  assert.deepEqual(await (await post(query)).json(), {jsonrpc: '2.0', id: query.id, result: null});
  assert.deepEqual(history.map(value => value.method), ['getGenesisHash','getTransaction']); assert.deepEqual(history[1], query); assert.equal(primary.length, 0);
  historyResult = {slot: 123, meta: {err: null}, transaction: {signatures: ['fixture-signature']}};
  assert.deepEqual(await (await post(query)).json(), {jsonrpc: '2.0', id: query.id, result: historyResult});
  assert.deepEqual(history.map(value => value.method), ['getGenesisHash','getTransaction','getGenesisHash','getTransaction'], 'genesis is checked for each history read');
  for (const method of ['getGenesisHash','getSignatureStatuses','getBlockHeight','getLatestBlockhash','getAccountInfo','getBalance']) {
    assert.equal((await (await post({...query, method, params: []})).json()).result, 'primary');
  }
  assert.equal(primary.length, 6); assert.equal(history.length, 4);
  const ordinary = await startUiHost({port: 0, output, rpc: async data => { const json = JSON.parse(data.toString()); return {status: 200, bytes: Buffer.from(JSON.stringify({jsonrpc: '2.0', id: json.id, result: 'legacy-primary-history'}))}; }}); t.after(() => ordinary.close());
  const response = await fetch(ordinary.origin + '/rpc', {method: 'POST', headers: {origin: ordinary.origin}, body: JSON.stringify(query)});
  assert.equal((await response.json()).result, 'legacy-primary-history');
});

test('history identity failures stop before transaction lookup and never fall back, retry or expose credentials', async t => {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-history-pin-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'fixture');
  let fault = 'genesis', primary = 0, lookups = 0;
  const canary = 'PRIVATE_HISTORY_RPC_CREDENTIAL_CANARY';
  const host = await startUiHost({port: 0, output, rpc: async () => { primary++; throw Error(canary); },
    historyRpc: async data => { const json = JSON.parse(data.toString()); if (json.method === 'getTransaction') lookups++;
      if (fault === 'exception') throw Error(canary);
      return {status: fault === 'http' ? 503 : 200, bytes: Buffer.from(JSON.stringify({jsonrpc: '2.0', id: fault === 'id' ? 'wrong' : json.id,
        ...(fault === 'rpc' ? {error: {code: -32011, message: canary}} : {result: fault === 'genesis' ? 'another-cluster' : GENESIS})}))}; }}); t.after(() => host.close());
  for (fault of ['genesis','id','http','rpc','exception']) {
    const response = await fetch(host.origin + '/rpc', {method: 'POST', headers: {origin: host.origin}, body: JSON.stringify({jsonrpc: '2.0', id: 7, method: 'getTransaction', params: ['saved']})});
    assert.equal(response.status, 400, fault); assert.equal((await response.text()).includes(canary), false);
  }
  assert.equal(primary, 0); assert.equal(lookups, 0);
});

test('history RPC and HTTP failures stay failures; only an actual successful null result represents absence', async t => {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-history-errors-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'fixture');
  let status = 200, calls = 0, primary = 0;
  const host = await startUiHost({port: 0, output, rpc: async () => { primary++; throw Error('primary must not be substituted'); },
    historyRpc: async data => { const json = JSON.parse(data.toString()); if (json.method === 'getGenesisHash') return {status: 200, bytes: Buffer.from(JSON.stringify({jsonrpc:'2.0',id:json.id,result:GENESIS}))};
      calls++; return {status, bytes: Buffer.from(JSON.stringify({jsonrpc:'2.0',id:json.id,error:{code:-32011,message:'PRIVATE_HISTORY_URL',data:{url:'PRIVATE_HISTORY_URL'}}}))}; }}); t.after(() => host.close());
  const post = () => fetch(host.origin + '/rpc', {method:'POST',headers:{origin:host.origin},body:JSON.stringify({jsonrpc:'2.0',id:9,method:'getTransaction',params:['saved']})});
  assert.deepEqual(await (await post()).json(), {jsonrpc:'2.0',id:9,error:{code:-32011,message:'configured RPC request failed'}});
  status=429;const response=await post();assert.equal(response.status,429);assert.deepEqual(await response.json(),{error:'configured upstream unavailable'});
  assert.equal(calls,2);assert.equal(primary,0);
});

test('read-only host refuses permanent clearance; upstream HTTP/RPC error credentials never reach browser', async t => {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-errors-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'fixture');
  const canary = 'PRIVATE_RPC_CREDENTIAL_CANARY', nullifier = '0x' + '1'.repeat(64); let clearance = 0, status = 200;
  const host = await startUiHost({port: 0, output, allowTransactions: false,
    clearance: async () => { clearance++; return {status: 200, bytes: Buffer.from('{}')}; },
    indexer: async () => ({status: 503, bytes: Buffer.from(canary)}),
    rpc: async data => ({status, bytes: Buffer.from(JSON.stringify({jsonrpc: '2.0', id: JSON.parse(data.toString()).id, error: {code: -32005, message: canary, data: {url: canary}}}))})}); t.after(() => host.close());
  const post = (path: string, value: unknown) => fetch(host.origin + path, {method: 'POST', headers: {origin: host.origin}, body: JSON.stringify(value)});
  assert.equal((await post('/clearance', {nullifier})).status, 400); assert.equal(clearance, 0);
  const value = {jsonrpc: '2.0', id: 'browser-id', method: 'getGenesisHash', params: []};
  const rpcError = await post('/rpc', value); assert.equal(rpcError.status, 200); assert.deepEqual(await rpcError.json(), {jsonrpc: '2.0', id: value.id, error: {code: -32005, message: 'configured RPC request failed'}});
  status = 429; const httpError = await post('/rpc', value); assert.equal(httpError.status, 429); assert.equal((await httpError.text()).includes(canary), false);
  const indexError = await fetch(host.origin + '/indexer/zkapi/v1/tree/root'); assert.equal(indexError.status, 503); assert.equal((await indexError.text()).includes(canary), false);
});

const requestId = '11111111-1111-4111-8111-111111111111', operationId = '22222222-2222-4222-8222-222222222222';
const bearer = (prefix = 'zkc1', id = requestId) => `Bearer ${prefix}.${id}.${Buffer.alloc(32, 7).toString('base64url')}`;
async function providerFixture(t: any) {
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-provider-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'fixture');
  const planPath = resolve('config/provider-acceptance.i10.json'), plan = JSON.parse(await readFile(planPath, 'utf8'));
  const testCase = plan.cases.find((c: any) => c.id === 'openai-chat-plain'), model = plan.models.find((m: any) => m.tariff.provider === 'openai');
  const publicValue = {testCase, tariff: model.tariff, planSha256: await sha256Hex(jcsBytes(plan))};
  const manifest = {deployment_id: 'ui-provider-fixture', pool: 'fixture-pool', control_api_origin: 'https://127.0.0.1:12345',
    inference_api_origin: 'https://127.0.0.1:12346', cap_micro_usdc: '1000000', tariff_hashes: [model.tariff.tariff_hash]} as any;
  const quote = {body: {deployment_id: manifest.deployment_id, pool: manifest.pool, mode: 'proxy', provider: 'openai', models: [testCase.model],
    tariff_hash: model.tariff.tariff_hash, session_ttl_seconds: String(testCase.session_ttl_seconds), control_api_origin: manifest.control_api_origin,
    inference_api_origin: manifest.inference_api_origin, cap_micro_usdc: manifest.cap_micro_usdc}, quote_hash: '1'.repeat(64), signature: 'fixture'};
  const auth = {authorization: {version: '1', deployment_id: manifest.deployment_id, pool: manifest.pool, request_id: requestId,
    mode: 'proxy', quote_hash: quote.quote_hash, control_secret_hash: '2'.repeat(64), proxy_secret_hash: '3'.repeat(64)}, quote,
    public_inputs: [], proof: {backend: 'groth16_bn254', proof: 'fixture-native-validation-is-independent'}};
  const post = (origin: string, path: string, value?: unknown, headers = {}) => fetch(origin + path, {method: 'POST',
    headers: {origin, ...(value === undefined ? {} : {'content-type': 'application/json'}), ...headers},
    body: value instanceof Uint8Array ? Buffer.from(value) : value === undefined ? undefined : JSON.stringify(value)});
  return {output, planPath, plan, model, publicValue, manifest, auth, post};
}

test('provider bridge allows only bound native control routes and canonical receipt cursors', async t => {
  const f = await providerFixture(t), calls: any[] = []; let reservations = 0;
  const host = await startUiHost({port: 0, output: f.output, manifest: f.manifest, allowTransactions: true,
    provider: {public: f.publicValue, async reserve() { reservations++; }, async inference() { throw Error('unexpected inference'); },
      async control(path, method, headers, data) { calls.push({path, method, headers, data: data?.toString()}); return {status: 200, bytes: Buffer.from('{}')}; }}}); t.after(() => host.close());
  const base = `/control/zkapi/v1/sessions/${requestId}`, headers = {authorization: bearer()};
  const quote = {mode: 'proxy', provider: 'openai', models: [f.publicValue.testCase.model], session_ttl_seconds: '300'};
  assert.equal((await f.post(host.origin, '/control/zkapi/v1/quotes', quote)).status, 200);
  assert.equal((await f.post(host.origin, '/control/zkapi/v1/sessions', f.auth, headers)).status, 200);
  assert.equal(calls[1].data, JSON.stringify(f.auth), 'exact AUTH bytes reach native verifier');
  for (const path of [base, base + '/receipts', base + '/receipts?cursor=0', base + '/receipts?cursor=9223372036854775807', base + `/operations/${operationId}`]) {
    assert.equal((await fetch(host.origin + path, {headers})).status, 200, path);
  }
  assert.equal((await f.post(host.origin, base + '/close', undefined, headers)).status, 200);
  const passed = calls.length;
  for (const path of [base + '/status', base + '/receipts?cursor=01', base + '/receipts?cursor=-1', base + '/receipts?cursor=9223372036854775808',
    base + '/receipts?cursor=1&cursor=2', base + '/receipts?cursor=%31', base + '/receipts?other=1', base + '/receipts/',
    '/control/zkapi/v1/config', base + '/close']) assert.equal((await fetch(host.origin + path, {headers})).status, 400, path);
  for (const change of [{...quote, models: ['other']}, {...quote, mode: 'direct_oa'}, {...quote, session_ttl_seconds: '60'}, {...quote, extra: true}])
    assert.equal((await f.post(host.origin, '/control/zkapi/v1/quotes', change)).status, 400);
  for (const auth of [{...f.auth, extra: true}, {...f.auth, authorization: {...f.auth.authorization, pool: 'another-pool'}},
    {...f.auth, quote: {...f.auth.quote, body: {...f.auth.quote.body, tariff_hash: '0'.repeat(64)}}}])
    assert.equal((await f.post(host.origin, '/control/zkapi/v1/sessions', auth, headers)).status, 400);
  assert.equal((await f.post(host.origin, '/control/zkapi/v1/sessions', f.auth, {authorization: bearer('zkc1', operationId)})).status, 400);
  assert.equal((await f.post(host.origin, base + '/close', {}, headers)).status, 400);
  assert.equal((await fetch(host.origin + base, {headers: {authorization: bearer(), cookie: 'x=y'}})).status, 400);
  assert.equal(calls.length, passed); assert.equal(reservations, 0);
});

test('read-only provider bridge blocks AUTH, quote, close and inference before reservation or forwarding', async t => {
  const f = await providerFixture(t); let writes = 0;
  const host = await startUiHost({port: 0, output: f.output, manifest: f.manifest, allowTransactions: false,
    provider: {public: f.publicValue, async reserve() { writes++; }, async inference() { writes++; return {status:200, bytes:Buffer.from('{}')}; },
      async control() { writes++; return {status:200, bytes:Buffer.from('{}')}; }}}); t.after(() => host.close());
  for (const path of ['/control/zkapi/v1/quotes', '/control/zkapi/v1/sessions', `/control/zkapi/v1/sessions/${requestId}/close`, '/inference/v1/chat/completions']) {
    assert.equal((await f.post(host.origin, path, f.auth, {authorization: bearer()})).status, 400);
  }
  assert.equal(writes, 0);
});

test('provider error status and fixed code reach browser while private body and unknown headers do not', async t => {
  const f = await providerFixture(t); let errorCode = 'operation_unavailable';
  const host = await startUiHost({port: 0, output: f.output, manifest: f.manifest, allowTransactions: true,
    provider: {public: f.publicValue, async reserve(request, operation) { assert.equal(request, requestId); assert.equal(operation, operationId); },
      async inference() { return {status: 503, bytes: Buffer.from('PRIVATE_UPSTREAM_CANARY'), serviceErrorCode: errorCode}; },
      async control() { throw Error('unexpected'); }}}); t.after(() => host.close());
  const post = () => f.post(host.origin, '/inference/v1/chat/completions', providerAcceptanceBody(f.publicValue.testCase),
    {authorization: bearer('zkp1'), 'idempotency-key': operationId});
  const known = await post(); assert.equal(known.status, 503); assert.equal(known.headers.get('x-zkapi-error-code'), 'operation_unavailable');
  assert.deepEqual(await known.json(), {error:'configured upstream unavailable'});
  errorCode = 'PRIVATE_UPSTREAM_CANARY'; const unknown = await post();
  assert.equal(unknown.status, 503); assert.equal(unknown.headers.get('x-zkapi-error-code'), null);
  assert.equal((await unknown.text()).includes('PRIVATE'), false);
});

test('provider budget is an exact read-only route with origin checks and redacted failures', async t => {
  const f = await providerFixture(t); let reads = 0, writes = 0, fail = false;
  const snapshot = {schema: 1 as const, plan_sha256: f.publicValue.planSha256, request_policy: 'explicit_demo' as const,
    budget_micro_usdc: '10000000', reserved_micro_usdc: '96385', remaining_micro_usdc: '9903615', max_requests: 18,
    reserved_requests: 5, remaining_requests: 13, request_max_cost_micro_usdc: '19277', available_requests: 13};
  const host = await startUiHost({port: 0, output: f.output, allowTransactions: false, provider: {
    public: f.publicValue, async budget() { reads++; if (fail) throw Error('PRIVATE_BUDGET_PATH_CANARY'); return snapshot; },
    async reserve() { writes++; }, async control() { writes++; throw Error('unexpected'); }, async inference() { writes++; throw Error('unexpected'); }}});
  t.after(() => host.close());
  const result = await fetch(host.origin + '/provider-budget');
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store'); assert.deepEqual(await result.json(), snapshot);
  for (const path of ['/provider-budget/', '/provider-budget?case=other', '/provider-budget?state=private'])
    assert.equal((await fetch(host.origin + path)).status, 400);
  assert.equal((await f.post(host.origin, '/provider-budget', {})).status, 400);
  for (const headers of [{origin: 'https://foreign.invalid'}, {'sec-fetch-site': 'cross-site'}, {authorization: bearer()}, {cookie: 'x=y'}] as Record<string, string>[])
    assert.equal((await fetch(host.origin + '/provider-budget', {headers})).status, 400);
  assert.equal(reads, 1); assert.equal(writes, 0);
  fail = true; const unavailable = await fetch(host.origin + '/provider-budget');
  assert.equal(unavailable.status, 503); assert.deepEqual(await unavailable.json(), {error: 'provider campaign unavailable'});
  assert.equal(reads, 2); assert.equal(writes, 0);
});

test('prepared UI profile uses existing global budget and refuses concurrent/restarted inference replay', async t => {
  const f = await providerFixture(t), stateDir = join(f.output, 'budget'), configurationDir = join(stateDir, 'configurations/openai-ui');
  await mkdir(configurationDir, {recursive: true, mode: 0o700});
  const privateWrite = (name: string, value: unknown) => writeFile(join(configurationDir, name), JSON.stringify(value), {mode: 0o600});
  const selection = {schema: 1, parent_plan_sha256: f.publicValue.planSha256, role: 'openai', profile: 'openai-ui', case_ids: ['openai-chat-plain']};
  await privateWrite('selection.json', selection); await privateWrite('tariffs.json', [f.model.tariff]);
  const prepared = {direct: [], proxy: [{provider: 'openai', credential_file: '/never-read-provider-credential-canary', local_test_base: null, models: [f.model.profile]}]};
  await privateWrite('providers.json', prepared);
  const config = {planPath: f.planPath, configurationDir, stateDir};
  await assert.rejects(loadProviderUi(config, f.manifest), /campaign unavailable/);
  await promisify(execFile)('python3', ['scripts/provider_acceptance.py', 'budget-init', '--plan', f.planPath, '--state-dir', stateDir],
    {env: {PATH: process.env.PATH, ZKAPI_PROVIDER_BUDGET_MICRO_USDC: '10000000'}});
  const loaded = await loadProviderUi(config, f.manifest);
  assert.deepEqual(jcsBytes(loaded.public), jcsBytes(f.publicValue)); assert.ok(!JSON.stringify(loaded.public).includes('credential'));
  const initialBudgetBytes = await readFile(join(stateDir, 'budget-state.json'));
  assert.equal((await loaded.budget()).available_requests, 1);
  assert.deepEqual(await readFile(join(stateDir, 'budget-state.json')), initialBudgetBytes, 'status never reserves or rewrites the budget');
  for (const bad of [{...selection, profile: 'openai-native'}, {...selection, case_ids: ['openai-chat-plain', 'openai-chat-sse']}, {...selection, parent_plan_sha256: '0'.repeat(64)}]) {
    await privateWrite('selection.json', bad); await assert.rejects(loadProviderUi(config, f.manifest));
  }
  await privateWrite('selection.json', selection);
  await privateWrite('providers.json', {...prepared, proxy: [{...prepared.proxy[0], models: [{...f.model.profile, context_tokens: 1}]}]});
  await assert.rejects(loadProviderUi(config, f.manifest)); await privateWrite('providers.json', prepared);
  let forwarded = 0, reserved = 0; const originalReserve = loaded.reserve;
  const start = async () => startUiHost({port: 0, output: f.output, manifest: f.manifest, allowTransactions: true, provider: {
    ...(await loadProviderUi(config, f.manifest)), async reserve() { await originalReserve(); reserved++; },
    async control() { throw Error('unexpected control'); }, async inference(headers, data) {
      assert.equal(reserved, 1); assert.equal(headers.authorization, bearer('zkp1')); assert.equal(headers['idempotency-key'], operationId);
      assert.deepEqual(data, Buffer.from(providerAcceptanceBody(f.publicValue.testCase))); forwarded++;
      return {status: 503, bytes: Buffer.from('PRIVATE_PROVIDER_RESPONSE_CANARY')};
    }}});
  const headers = {authorization: bearer('zkp1'), 'idempotency-key': operationId};
  const host = await start();
  t.after(() => host.server.listening ? host.close() : undefined);
  const exact = providerAcceptanceBody(f.publicValue.testCase), path = '/inference/v1/chat/completions';
  for (const [badPath, body, extra] of [[path, Buffer.from('{}'), headers], [path + '?url=bad', exact, headers],
    [path, exact, {...headers, authorization: bearer()}], [path, exact, {...headers, 'idempotency-key': 'not-a-uuid'}],
    [path, exact, {...headers, 'x-api-key': 'PRIVATE'}]] as const) assert.equal((await f.post(host.origin, badPath, body, extra)).status, 400);
  assert.equal(reserved, 0); assert.equal(forwarded, 0);
  const responses = await Promise.all([f.post(host.origin, path, exact, headers), f.post(host.origin, path, exact, headers)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [400, 503]);
  for (const response of responses) assert.ok(!(await response.text()).includes('PRIVATE_PROVIDER'));
  await host.close();
  const restarted = await start(); t.after(() => restarted.close());
  assert.equal((await f.post(restarted.origin, path, exact, {...headers, 'idempotency-key': '33333333-3333-4333-8333-333333333333'})).status, 400);
  const budget = JSON.parse(await readFile(join(stateDir, 'budget-state.json'), 'utf8'));
  assert.equal(budget.reservations.length, 1); assert.equal(budget.reservations[0].case_id, 'openai-chat-plain');
  assert.equal(budget.reservations[0].max_cost_micro_usdc, f.publicValue.testCase.max_cost_micro_usdc);
  const status = await loaded.budget();
  assert.equal(status.reserved_requests, 1); assert.equal(status.remaining_requests, f.plan.max_requests - 1);
  assert.equal(status.available_requests, 0, 'legacy acceptance case cannot be repeated even with campaign capacity');
  assert.equal(forwarded, 1); assert.equal(reserved, 1);
});

test('explicit demo bridge burns a separate session/operation reservation and preserves the completed acceptance reservation', async t => {
  const f=await providerFixture(t), stateDir=join(f.output,'budget'), configurationDir=join(stateDir,'configurations/openai-ui');
  await mkdir(configurationDir,{recursive:true,mode:0o700});
  const files={'selection.json':{schema:1,parent_plan_sha256:f.publicValue.planSha256,role:'openai',profile:'openai-ui',case_ids:['openai-chat-plain']},
    'tariffs.json':[f.model.tariff], 'providers.json':{direct:[],proxy:[{provider:'openai',credential_file:'/never-read-secret',local_test_base:null,models:[f.model.profile]}]}};
  for(const [name,value] of Object.entries(files)) await writeFile(join(configurationDir,name),JSON.stringify(value),{mode:0o600});
  await promisify(execFile)('python3',['scripts/provider_acceptance.py','budget-init','--plan',f.planPath,'--state-dir',stateDir],
    {env:{PATH:process.env.PATH,ZKAPI_PROVIDER_BUDGET_MICRO_USDC:'10000000'}});
  const config={planPath:f.planPath,configurationDir,stateDir};
  await (await loadProviderUi(config,f.manifest)).reserve();
  const before=JSON.parse(await readFile(join(stateDir,'budget-state.json'),'utf8'));
  let sends=0;
  const start=async()=>startUiHost({port:0,output:f.output,manifest:f.manifest,allowTransactions:true,provider:{
    ...await loadProviderUi({...config,requestPolicy:'explicit_demo'},f.manifest),
    async control(){throw Error('unexpected');}, async inference(){sends++;return {status:200,bytes:Buffer.from('{}')};}}});
  const host=await start(); t.after(()=>host.server.listening?host.close():undefined);
  const getBudget = async (origin: string) => { const response = await fetch(origin + '/provider-budget'); assert.equal(response.status, 200); return response.json() as Promise<any>; };
  const initial = await getBudget(host.origin);
  assert.equal(initial.reserved_requests, 1); assert.equal(initial.available_requests, f.plan.max_requests - 1);
  assert.equal(initial.request_policy, 'explicit_demo'); assert.equal(initial.plan_sha256, f.publicValue.planSha256);
  assert.equal(initial.request_max_cost_micro_usdc, f.publicValue.testCase.max_cost_micro_usdc);
  assert.ok(!JSON.stringify(initial).includes('reservations') && !JSON.stringify(initial).includes('request_id') && !JSON.stringify(initial).includes('credential'));
  assert.deepEqual(JSON.parse(await readFile(join(stateDir,'budget-state.json'),'utf8')), before);
  const send=(origin:string,session=requestId,operation=operationId)=>f.post(origin,'/inference/v1/chat/completions',providerAcceptanceBody(f.publicValue.testCase),
    {authorization:bearer('zkp1',session),'idempotency-key':operation});
  assert.deepEqual((await Promise.all([send(host.origin),send(host.origin)])).map(r=>r.status).sort(),[200,400]);
  await host.close(); const reopened=await start(); t.after(()=>reopened.close());
  const nextRequest='33333333-3333-4333-8333-333333333333',nextOperation='44444444-4444-4444-8444-444444444444';
  assert.equal((await send(reopened.origin)).status,400);
  assert.equal((await send(reopened.origin,requestId,nextOperation)).status,400);
  assert.equal((await send(reopened.origin,nextRequest,operationId)).status,400);
  assert.equal((await send(reopened.origin,nextRequest,nextOperation)).status,200);
  const after=JSON.parse(await readFile(join(stateDir,'budget-state.json'),'utf8'));
  assert.deepEqual(after.identity,before.identity);assert.deepEqual(after.reservations[0],before.reservations[0]);
  assert.equal(after.reservations.length,3); assert.equal(sends,2);
  assert.equal(after.reservations[1].case_id,'demo-'+operationId);assert.equal(after.reservations[2].request_id,nextRequest);
  const status = await getBudget(reopened.origin);
  assert.equal(status.reserved_requests, 3); assert.equal(status.remaining_requests, f.plan.max_requests - 3);
  assert.equal(status.available_requests, f.plan.max_requests - 3);
  assert.equal(status.reserved_micro_usdc, String(BigInt(f.publicValue.testCase.max_cost_micro_usdc) * 3n));
  assert.equal(BigInt(status.reserved_micro_usdc) + BigInt(status.remaining_micro_usdc), BigInt(f.plan.budget_micro_usdc));
  // Status must neither repair corrupt history nor expose private coordinator diagnostics.
  const statePath = join(stateDir, 'budget-state.json'), bytes = await readFile(statePath);
  for (const invalid of ['PRIVATE_BUDGET_CANARY', JSON.stringify({...after, identity: {...after.identity, plan_sha256: '0'.repeat(64)}}),
    JSON.stringify({...after, reservations: [...after.reservations, after.reservations[0]]})]) {
    await writeFile(statePath, invalid);
    const response = await fetch(reopened.origin + '/provider-budget'); assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {error: 'provider campaign unavailable'});
    assert.equal(await readFile(statePath, 'utf8'), invalid, 'read-only status must not reset corrupted budget');
  }
  await writeFile(statePath, bytes);
  assert.equal((await getBudget(reopened.origin)).available_requests, f.plan.max_requests - 3);
  assert.equal(sends, 2);
});
