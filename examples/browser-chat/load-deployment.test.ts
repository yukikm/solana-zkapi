import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {parseReviewedDevnetProfile, createDevnetRelayFetch, parseDevnetAdmission} from './load-deployment.ts';

const request = '6114e9d8-be6d-47ac-a07f-a2a5657ff4e6', operation = 'b70f77ab-ab0c-459b-a0ee-58016c58ae9f';
const rpc = 'https://rpc.zkapi.invalid', indexer = 'https://indexer.zkapi.invalid', control = 'https://control.example';
const provider = 'https://openrouter.ai/api/v1', app = 'http://127.0.0.1:4173';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function profile() {
  const artifacts = Object.fromEntries(['idl', 'requestPk', 'requestVk', 'withdrawalPk', 'withdrawalVk', 'treePk', 'treeVk', 'treeSourceBundle', 'treeVerifierConstants'].map(name => [name, '/artifacts/' + name]));
  return {id: 'reviewed-local-direct', label: 'Reviewed local direct fixture', chain: 'solana:devnet', mode: 'direct_openrouter',
    manifestUrl: '/manifest', wasmUrl: '/wasm', wasmSha256: 'ab'.repeat(32),
    artifacts: {...artifacts, additional: {vault_idl: '/artifacts/additional%3Avault_idl'}},
    rpcUrl: rpc, indexerOrigin: indexer, relay: {kind: 'same_origin_devnet'}, preparationCommitment: 'confirmed',
    directProviderBases: {direct_openrouter: provider},
    trust: {anchor: {kind: 'hash', sha256: 'cd'.repeat(32)}, expected: {
      deployment_id: 'devnet-test-profile', deployment_environment: 'devnet', genesis_hash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      program_id: '11111111111111111111111111111111', pool: '11111111111111111111111111111111', mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', control_api_origin: control, inference_api_origin: 'https://inference.example'},
      build: {stateKey: {x: '0x' + '01'.repeat(32), y: '0x' + '02'.repeat(32)}, clearanceKey: {x: '0x' + '03'.repeat(32), y: '0x' + '04'.repeat(32)},
        circuitProfileHash: 'ab'.repeat(32), idlHash: 'cd'.repeat(32), setupProfile: 'test_only', transactionFormats: ['v0_buffer', 'v0_inline_deposit_v1']}},
    models: [{id: 'openai/gpt-4o-mini', label: 'Reviewed model', provider: 'openrouter', apis: ['chat'],
      tariff: {tariff_hash: 'ef'.repeat(32), version: '1', provider: 'openrouter', model: '*', pricing_basis: 'provider_reported_usd',
        valid_from: '1791072000', valid_until: '1791676800', rates: [], operator_fee_micro_usdc: '0'}}]};
}

test('reviewed public JSON rejects private configuration and nonlocal asset/transport substitutions', () => {
  assert.equal(parseReviewedDevnetProfile(bytes(profile())).mode, 'direct_openrouter');
  const signed = profile() as any;
  signed.trust.anchor = {kind: 'ed25519', publicKey: '11111111111111111111111111111111'};
  assert.equal(parseReviewedDevnetProfile(bytes(signed)).trust.anchor.kind, 'ed25519');
  signed.trust.anchor.sha256 = 'ab'.repeat(32);
  assert.throws(() => parseReviewedDevnetProfile(bytes(signed)), 'anchor variants cannot mix fields');
  const changes: ((p: any) => void)[] = [
    p => {p.rpcUrl = 'https://rpc.example/private-token';}, p => {p.manifestUrl = 'https://assets.example/manifest';},
    p => {p.wasmUrl = '/wasm?token=PRIVATE_CANARY';}, p => {p.rpcCredential = 'PRIVATE_CANARY';},
    p => {p.trust.build.seed = 'PRIVATE_CANARY';}, p => {p.models[0].tariff.api_key = 'PRIVATE_CANARY';},
    p => {p.artifacts.requestPk = '/private-key';}, p => {p.artifacts.additional.vault_idl = '/artifacts/../../private';},
    p => {p.directProviderBases.direct_openrouter = 'https://user:PRIVATE_CANARY@openrouter.ai/api/v1';},
    p => {p.mode = 'proxy';}, p => {p.chain = 'solana:mainnet';}, p => {p.trust.expected.deployment_environment = 'mainnet';},
    p => {p.trust.expected.control_api_origin = 'https://openrouter.ai';}, p => {p.trust.anchor.sha256 = 'not-a-pin';},
    p => {p.trust.build.transactionFormats.push('arbitrary');}, p => {p.models[0].apis = ['responses'];},
    p => {p.models[0].tariff.model = 'openai/gpt-4o-mini';}, p => {p.preparationCommitment = 'processed';},
  ];
  for (const change of changes) {const candidate = profile(); change(candidate); assert.throws(() => parseReviewedDevnetProfile(bytes(candidate)));}
  assert.throws(() => parseReviewedDevnetProfile(new TextEncoder().encode('{"id":"first","id":"second"}')));
});

test('relay maps bounded control/indexer/RPC calls, keeps direct body and credentials off the relay, and preserves abort', async () => {
  const p = parseReviewedDevnetProfile(bytes(profile())), calls: {url: string; init: RequestInit}[] = [];
  const fetcher: typeof fetch = async (url, init) => {calls.push({url: String(url), init: init!}); return new Response('{}');};
  const adapter = createDevnetRelayFetch(p, app, fetcher), signal = new AbortController();
  // Caller mutation must not replace the captured route.
  (p.trust.expected as any).control_api_origin = 'https://attacker.invalid';
  const body = new Uint8Array([123, 125]), headers = {'Content-Type': 'application/json', Authorization: 'Bearer LOCAL_FIXTURE_RUNTIME_KEY'};
  await adapter(provider + '/chat/completions', {method: 'POST', body, headers, signal: signal.signal, credentials: 'include', redirect: 'follow'});
  assert.equal(calls[0].url, provider + '/chat/completions'); assert.equal(calls[0].init.body, body); assert.equal(calls[0].init.headers, headers);
  assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.cache, 'no-store');
  signal.abort(); assert.equal(calls[0].init.signal?.aborted, true);
  const routes: [string, string, string][] = [
    [control + '/zkapi/v1/quotes', 'POST', '/control/zkapi/v1/quotes'],
    [control + '/zkapi/v1/sessions', 'POST', '/control/zkapi/v1/sessions'],
    [control + `/zkapi/v1/sessions/${request}`, 'GET', `/control/zkapi/v1/sessions/${request}`],
    [control + `/zkapi/v1/sessions/${request}/close`, 'POST', `/control/zkapi/v1/sessions/${request}/close`],
    [control + `/zkapi/v1/sessions/${request}/receipts?cursor=1`, 'GET', `/control/zkapi/v1/sessions/${request}/receipts?cursor=1`],
    [control + `/zkapi/v1/sessions/${request}/operations/${operation}`, 'GET', `/control/zkapi/v1/sessions/${request}/operations/${operation}`],
    [control + '/zkapi/v1/withdraw/clearance', 'POST', '/control/zkapi/v1/withdraw/clearance'],
    [indexer + '/zkapi/v1/tree/snapshot', 'GET', '/indexer/zkapi/v1/tree/snapshot'],
    [indexer + '/zkapi/v1/tree/snapshots/' + 'ab'.repeat(32) + '.json', 'GET', '/indexer/zkapi/v1/tree/snapshots/' + 'ab'.repeat(32) + '.json'],
    [indexer + '/zkapi/v1/tree/notes/7/zero-path', 'GET', '/indexer/zkapi/v1/tree/notes/7/zero-path'],
  ];
  for (const [url, method, path] of routes) {await adapter(url, {method}); assert.equal(calls.at(-1)!.url, app + path);}
  const rpcBody = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: []});
  await adapter(rpc, {method: 'POST', body: rpcBody}); assert.equal(calls.at(-1)!.url, app + '/rpc'); assert.equal(calls.at(-1)!.init.body, rpcBody);
  assert.ok(calls.slice(1).every(call => !(call.init.headers as any)?.Authorization), 'direct authorization never enters subsequent relay calls');
});

test('unknown destination/method/query and unsupported RPC fail before network and never fall back', async () => {
  const p = parseReviewedDevnetProfile(bytes(profile())); let calls = 0;
  const adapter = createDevnetRelayFetch(p, app, async () => {calls++; throw Error('offline provider unavailable');});
  const rejected: [string, RequestInit][] = [
    ['https://attacker.invalid/zkapi/v1/sessions', {method: 'POST'}],
    ['https://inference.example/v1/chat/completions', {method: 'POST'}],
    [provider + '/chat/completions', {method: 'GET'}], [provider + '/keys', {method: 'POST'}],
    [provider + '/chat/completions?key=secret', {method: 'POST'}], [provider + '/chat/completions#fragment', {method: 'POST'}],
    [control + '/zkapi/v1/sessions', {method: 'PUT'}], [control + '/zkapi/v1/sessions', {method: 'GET'}],
    [control + `/zkapi/v1/sessions/${request}/close`, {method: 'GET'}],
    [control + `/zkapi/v1/sessions/${request}/receipts?cursor=1&url=https://attacker.invalid`, {}],
    [indexer + '/zkapi/v1/tree/snapshot?note=3', {}], [indexer + '/zkapi/v1/tree/snapshot', {method: 'POST'}],
    [rpc, {method: 'GET'}], [rpc, {method: 'POST', body: JSON.stringify({jsonrpc: '2.0', method: 'requestAirdrop', params: []})}],
    [rpc, {method: 'POST', body: '[{"jsonrpc":"2.0","method":"getGenesisHash","params":[]}]'}],
    [control + `/zkapi/v1/sessions/${request}`, {method: 'GET', body: '{}'}],
  ];
  for (const [url, init] of rejected) await assert.rejects(adapter(url, init), /Invalid reviewed devnet profile/);
  await assert.rejects(adapter(new Request(provider + '/chat/completions', {method: 'POST', body: '{}'})));
  assert.equal(calls, 0);
  await assert.rejects(adapter(provider + '/chat/completions', {method: 'POST', body: '{}'}), /offline provider unavailable/);
  assert.equal(calls, 1, 'direct errors have no retry or relay fallback');
  for (const page of ['https://public.example', 'http://localhost:4173', 'http://127.0.0.1:4173/path']) assert.throws(() => createDevnetRelayFetch(p, page));
});

test('build installs only hash-pinned public JSON into isolated assets and records exact output hashes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zkapi-reviewed-build-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const config = join(directory, 'profile.json'), output = join(directory, 'configured'), value = bytes(profile());
  await writeFile(config, value);
  const run = promisify(execFile), args = ['examples/browser-chat/build.mjs', '--profile', config, '--profile-sha256', sha(value), '--out-dir', output];
  await run(process.execPath, args);
  const metadata = JSON.parse(await readFile(join(output, 'profile-build.json'), 'utf8'));
  assert.equal(metadata.profileSha256, sha(value)); assert.equal(metadata.schema, 1);
  for (const [name, hash] of Object.entries(metadata.assets)) assert.equal(sha(await readFile(join(output, name))), hash);
  assert.match(await readFile(join(output, 'app.js'), 'utf8'), /reviewed-local-direct/);
  const original = await readFile(join(output, 'app.js'));
  await assert.rejects(run(process.execPath, args.map(arg => arg === sha(value) ? '00'.repeat(32) : arg)));
  const privateConfig = bytes({...profile(), rpcUrl: 'https://rpc.invalid/?api-key=PRIVATE_CANARY'}); await writeFile(config, privateConfig);
  const bad = await run(process.execPath, args.map(arg => arg === sha(value) ? sha(privateConfig) : arg)).then(() => null, error => error);
  assert.ok(bad); assert.ok(!String(bad.stderr).includes('PRIVATE_CANARY'));
  assert.deepEqual(await readFile(join(output, 'app.js')), original, 'rejected config does not overwrite a reviewed build');
  await assert.rejects(run(process.execPath, ['examples/browser-chat/build.mjs', '--profile', config, '--profile-sha256', sha(privateConfig)]));
});

test('public admission hints require exact integer totals and distinguish host enablement from reserved charges', () => {
  const value = {schema: 1, allowTransactions: true, budget_micro_usdc: '10000000', reserved_micro_usdc: '1000000', remaining_micro_usdc: '9000000',
    reserved_requests: 1, max_requests: 18, remaining_requests: 17, request_max_cost_micro_usdc: '1000000', available_requests: 9};
  assert.equal(parseDevnetAdmission(bytes(value)).available_requests, 9);
  assert.equal(parseDevnetAdmission(bytes({...value, allowTransactions: false, available_requests: 0})).allowTransactions, false);
  assert.equal(parseDevnetAdmission(bytes({...value, reserved_micro_usdc: '10000000', remaining_micro_usdc: '0', available_requests: 0})).available_requests, 0);
  for (const change of [{runtime_key: 'PRIVATE_CANARY'}, {remaining_micro_usdc: '8000000'}, {available_requests: 10},
    {remaining_requests: 18}, {request_max_cost_micro_usdc: '0'}, {remaining_micro_usdc: '1e6'}, {allowTransactions: false}])
    assert.throws(() => parseDevnetAdmission(bytes({...value, ...change})));
});
