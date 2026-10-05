import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {request} from 'node:http';
import {startUiHost, loadProviderUi} from './host.ts';
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
  for (const [path, name, mime] of [['/', 'demo.html', 'text/html'], ['/demo', 'demo.html', 'text/html'], ['/live', 'index.html', 'text/html'],
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

test('financial relay rechecks devnet genesis, exact signed v0, pool/program/instruction and fee without signing or replay', async t => {
  const {Keypair, PublicKey, TransactionInstruction} = await import('@solana/web3.js');
  const {compileV0, discriminator} = await import('../../packages/sdk/src/transport.ts');
  const {GENESIS} = await import('./host.ts');
  const output = await mkdtemp(join(tmpdir(), 'zkapi-ui-send-')); t.after(() => rm(output, {recursive: true, force: true}));
  for (const file of ['index.html', 'app.js', 'style.css']) await writeFile(join(output, file), 'fixture');
  const pair = Keypair.fromSeed(new Uint8Array(32).fill(33)), program = new PublicKey(new Uint8Array(32).fill(34)), pool = new PublicKey(new Uint8Array(32).fill(35));
  let genesis = GENESIS, fee = 5000;
  const forwarded: any[] = [];
  const host = await startUiHost({port: 0, output, allowTransactions: true, manifest: {program_id: program.toBase58(), pool: pool.toBase58()} as any,
    rpc: async data => { const r = JSON.parse(data.toString()); let result: unknown;
      if (r.method === 'getGenesisHash') result = genesis; else if (r.method === 'getFeeForMessage') result = {context: {slot: 1}, value: fee};
      else if (r.method === 'sendTransaction') { forwarded.push(r); result = 'fixture-no-public-send'; } else throw Error('unexpected fixture request');
      return {status: 200, bytes: Buffer.from(JSON.stringify({jsonrpc: '2.0', id: r.id, result}))}; }}); t.after(() => host.close());
  const make = async (name = 'seal_payload', owner = program, boundPool = pool, sign = true) => { const tx = compileV0(new TransactionInstruction({programId: owner, keys: [{pubkey: pair.publicKey, isWritable: false, isSigner: false}, {pubkey: boundPool, isWritable: false, isSigner: false}, {pubkey: pair.publicKey, isWritable: false, isSigner: true}], data: Buffer.from(await discriminator(name))}), pair.publicKey, new PublicKey(new Uint8Array(32).fill(36)).toBase58()); if (sign) tx.sign([pair]); return Buffer.from(tx.serialize()).toString('base64'); };
  const post = (wire: string) => fetch(host.origin + '/rpc', {method: 'POST', headers: {origin: host.origin, 'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [wire, {encoding: 'base64', skipPreflight: true, maxRetries: 999}]})});
  const valid = await make();
  // A configured pool key present but unused by the actual Vault account slot must fail.
  const {VersionedTransaction} = await import('@solana/web3.js');
  const wrongPool = VersionedTransaction.deserialize(Buffer.from(await make('seal_payload', program, pair.publicKey), 'base64'));
  wrongPool.message.staticAccountKeys.push(pool); wrongPool.sign([pair]);
  assert.equal((await post(Buffer.from(wrongPool.serialize()).toString('base64'))).status, 400);
  genesis = 'mainnet-is-refused'; assert.equal((await post(valid)).status, 400); genesis = GENESIS;
  fee = 10001; assert.equal((await post(valid)).status, 400); fee = 5000;
  for (const wire of [await make('initialize_pool'), await make('seal_payload', pair.publicKey), await make('seal_payload', program, pair.publicKey), await make('seal_payload', program, pool, false)]) assert.equal((await post(wire)).status, 400);
  assert.equal(forwarded.length, 0);
  assert.equal((await post(valid)).status, 200); assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].params[0], valid); assert.deepEqual(forwarded[0].params[1], {encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0});
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
  assert.equal(forwarded, 1); assert.equal(reserved, 1);
});
