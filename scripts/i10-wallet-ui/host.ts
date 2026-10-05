/** Numeric loopback-only acceptance host. No wallet key or .env is read.
 * RPC credentials stay in the private launch configuration, never /config. */
import assert from 'node:assert/strict';
import {createServer, request as requestHttp, type IncomingMessage} from 'node:http';
import {request as requestHttps} from 'node:https';
import {readFile, lstat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ComputeBudgetProgram, VersionedTransaction} from '@solana/web3.js';
import {jcsBytes, parseStrictJson, sha256Hex, verifyManifest, type ManifestTrustPolicy, type VerifiedManifest} from '../../packages/sdk/src/trust.ts';
import {discriminator, verifySignatures} from '../../packages/sdk/src/transport.ts';
import type {Tariff} from '../../packages/sdk/src/control.ts';
import {providerAcceptanceBody, type ProviderAcceptanceCase} from '../provider_acceptance_client.ts';
import {validatePreparedProviderConfig} from '../i10_devnet_provider.ts';

export const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export interface HostConfig {
  runId: string; port: number; manifestPath: string; policy: ManifestTrustPolicy; wasmPath: string; wasmSha256: string;
  artifacts: Record<string, string>; rpcUrl: string; indexerUrl: string; controlUrl: string;
  localCaPath?: string; allowTransactions: boolean;
  provider?: {planPath: string; configurationDir: string; stateDir: string};
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execute = promisify(execFile);
const same = (a: unknown, b: unknown) => Buffer.from(jcsBytes(a)).equals(Buffer.from(jcsBytes(b)));
export interface UiProviderPublic {testCase: ProviderAcceptanceCase; tariff: Tariff; planSha256: string}
/** Reads only prepared references, never credential files or .env. Budget
 * reservation remains the existing Python reserve-once coordinator. */
export async function loadProviderUi(config: NonNullable<HostConfig['provider']>, manifest: VerifiedManifest) {
  const state = resolve(config.stateDir), directory = resolve(config.configurationDir), planPath = resolve(config.planPath);
  assert.equal(directory, join(state, 'configurations/openai-ui'));
  const privateJson = async (path: string) => {
    const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0);
    return parseStrictJson(await readFile(path)) as any;
  };
  for (const path of [state, directory]) { const info = await lstat(path); assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0); }
  const plan = parseStrictJson(await readFile(planPath)) as any, planSha256 = await sha256Hex(jcsBytes(plan));
  const selection = await privateJson(join(directory, 'selection.json'));
  assert.ok(same(selection, {schema: 1, parent_plan_sha256: planSha256, role: 'openai', profile: 'openai-ui', case_ids: ['openai-chat-plain']}));
  const cases = plan.cases.filter((c: ProviderAcceptanceCase) => c.id === 'openai-chat-plain'); assert.equal(cases.length, 1);
  const testCase = cases[0] as ProviderAcceptanceCase;
  assert.ok(testCase.mode === 'proxy' && testCase.provider === 'openai' && testCase.endpoint === 'chat_completions' && !testCase.stream && !testCase.tools
    && testCase.max_output_tokens === 128 && testCase.session_ttl_seconds === 300);
  providerAcceptanceBody(testCase);
  const models = plan.models.filter((m: {tariff: Tariff}) => m.tariff.provider === 'openai' && m.tariff.model === testCase.model); assert.equal(models.length, 1);
  const tariffs = await privateJson(join(directory, 'tariffs.json')); assert.ok(same(tariffs, [models[0].tariff]));
  const tariff = tariffs[0] as Tariff; assert.ok(manifest.tariff_hashes.includes(tariff.tariff_hash));
  validatePreparedProviderConfig({models, cases}, await privateJson(join(directory, 'providers.json')));
  const coordinator = async (command: 'budget-status' | 'reserve') => {
    const env: NodeJS.ProcessEnv = {}; for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
    const args = [join(ROOT, 'scripts/provider_acceptance.py'), command, '--plan', planPath, '--state-dir', state,
      ...(command === 'reserve' ? ['--case', testCase.id] : [])];
    try { const result = await execute('python3', args, {cwd: ROOT, env, timeout: 30_000, maxBuffer: 1_048_576}); return parseStrictJson(Buffer.from(result.stdout)) as any; }
    catch { throw Error('provider campaign unavailable'); }
  };
  const budget = await coordinator('budget-status'); assert.equal(budget.identity.plan_sha256, planSha256);
  assert.equal(budget.identity.campaign_id, plan.campaign_id); assert.equal(budget.identity.budget_micro_usdc, plan.budget_micro_usdc);
  return {public: {testCase, tariff, planSha256} satisfies UiProviderPublic, async reserve() {
    const value = await coordinator('reserve');
    assert.ok(value.send_authorized_once === true && value.case_id === testCase.id && value.plan_sha256 === planSha256
      && value.reserved_micro_usdc === testCase.max_cost_micro_usdc);
  }};
}
const methods = new Set(['getGenesisHash', 'getAccountInfo', 'getMultipleAccounts', 'getBlock', 'getLatestBlockhash',
  'getSignatureStatuses', 'getTransaction', 'getBlockHeight', 'getFeeForMessage', 'getBalance', 'getTokenAccountBalance', 'sendTransaction']);
const assertLocalService = (input: string) => { const u = new URL(input); assert.ok(!u.username && !u.password && !u.hash && u.origin === input && (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))); return u; };
const assertHttps = (input: string) => { const u = new URL(input); assert.ok(u.protocol === 'https:' && !u.username && !u.password && !u.hash); return u; };
async function body(request: IncomingMessage, maximum = 64 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) { size += part.length; assert.ok(size <= maximum); chunks.push(Buffer.from(part)); }
  return Buffer.concat(chunks);
}
export async function configuredHost(config: HostConfig, output: string) {
  assert.ok(/^[a-zA-Z0-9_-]{1,80}$/.test(config.runId)); assert.ok(Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535);
  assert.ok(typeof config.allowTransactions === 'boolean'); assertHttps(config.rpcUrl);
  for (const origin of [config.indexerUrl, config.controlUrl]) assertLocalService(origin);
  const manifestBytes = new Uint8Array(await readFile(config.manifestPath)), manifest = await verifyManifest(manifestBytes, config.policy);
  assert.equal(manifest.deployment_environment, 'devnet'); assert.equal(manifest.setup_profile, 'test_only'); assert.equal(manifest.genesis_hash, GENESIS);
  assert.equal(manifest.mint, '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  if (config.provider) assert.equal(config.runId, 'openai-ui');
  const provider = config.provider ? await loadProviderUi(config.provider, manifest) : undefined;
  const wasm = await readFile(config.wasmPath); assert.equal(await sha256Hex(wasm), config.wasmSha256);
  const artifactHashes: Record<string, string> = {idl: manifest.idl_hash, requestPk: manifest.request_pk_hash, requestVk: manifest.request_vk_hash,
    withdrawalPk: manifest.withdrawal_pk_hash, withdrawalVk: manifest.withdrawal_vk_hash, treePk: manifest.tree_proof_artifacts.pk_hash,
    treeVk: manifest.tree_proof_artifacts.vk_hash, treeSourceBundle: manifest.tree_proof_artifacts.source_bundle_hash,
    treeVerifierConstants: manifest.tree_proof_artifacts.verifier_constants_hash,
    ...Object.fromEntries(Object.entries(manifest.artifact_digests).map(([k, v]) => ['additional:' + k, v]))};
  assert.deepEqual(Object.keys(config.artifacts).sort(), Object.keys(artifactHashes).sort());
  const assets = new Map<string, {bytes: Buffer; mime: string}>();
  for (const [name, path] of Object.entries(config.artifacts)) {
    assert.ok((await lstat(path)).isFile()); const value = await readFile(path); assert.equal(await sha256Hex(value), artifactHashes[name]);
    assets.set('/artifact/' + encodeURIComponent(name), {bytes: value, mime: 'application/octet-stream'});
  }
  assets.set('/manifest', {bytes: Buffer.from(manifestBytes), mime: 'application/json'}); assets.set('/wasm', {bytes: wasm, mime: 'application/wasm'});
  assets.set('/config', {bytes: Buffer.from(JSON.stringify({runId: config.runId, policy: config.policy, wasmSha256: config.wasmSha256,
    artifactNames: Object.keys(config.artifacts), allowTransactions: config.allowTransactions,
    ...(provider ? {provider: provider.public} : {})})), mime: 'application/json'});
  const ca = config.localCaPath ? await readFile(config.localCaPath) : undefined;
  const forward = async (url: string, method: string, data?: Buffer, headers: Record<string,string> = {}, timeout = 30_000): Promise<{status: number; bytes: Buffer}> => {
    const u = new URL(url), local = ['127.0.0.1', '[::1]'].includes(u.hostname);
    assert.ok(u.protocol === 'https:' || (u.protocol === 'http:' && local));
    return new Promise((resolve, reject) => {
      const request = (u.protocol === 'https:' ? requestHttps : requestHttp)(u, {method, agent: false, ...(local && ca ? {ca} : {}), timeout,
        headers: {...(data ? {'content-type': 'application/json', 'content-length': String(data.length)} : {}), 'accept': 'application/json', ...headers}}, response => {
        const parts: Buffer[] = []; let size = 0;
        response.on('data', part => { size += part.length; if (size > 4 * 1024 * 1024) { response.destroy(); reject(Error('upstream response bound')); } else parts.push(Buffer.from(part)); });
        response.on('end', () => resolve({status: response.statusCode ?? 502, bytes: Buffer.concat(parts)})); response.on('error', () => reject(Error('upstream response unavailable')));
      });
      request.on('timeout', () => request.destroy()); request.on('error', () => reject(Error('upstream unavailable'))); request.end(data);
    });
  };
  return startUiHost({port: config.port, output, assets, manifest, allowTransactions: config.allowTransactions,
    rpc: data => forward(config.rpcUrl, 'POST', data),
    indexer: path => forward(config.indexerUrl + path, 'GET'),
    clearance: data => forward(config.controlUrl + '/zkapi/v1/withdraw/clearance', 'POST', data),
    ...(provider ? {provider: {...provider,
      control: (path: string, method: string, headers: Record<string,string>, data?: Buffer) => forward(config.controlUrl + path, method, data, {...headers, host: new URL(manifest.control_api_origin).host}, 60_000),
      inference: (headers: Record<string,string>, data: Buffer) => forward(config.controlUrl + '/v1/chat/completions', 'POST', data, {...headers, host: new URL(manifest.inference_api_origin).host}, 600_000)}} : {})});
}

export interface HostOptions {
  port: number; output: string; assets?: Map<string, {bytes: Buffer; mime: string}>; manifest?: VerifiedManifest; allowTransactions?: boolean;
  rpc?: (data: Buffer) => Promise<{status: number; bytes: Buffer}>;
  indexer?: (path: string) => Promise<{status: number; bytes: Buffer}>;
  clearance?: (data: Buffer) => Promise<{status: number; bytes: Buffer}>;
  provider?: {public: UiProviderPublic; reserve(): Promise<void>;
    control(path: string, method: string, headers: Record<string,string>, data?: Buffer): Promise<{status: number; bytes: Buffer}>;
    inference(headers: Record<string,string>, data: Buffer): Promise<{status: number; bytes: Buffer}>};
}
export async function startUiHost(options: HostOptions) {
  const provider = options.provider ? {...options.provider, public: structuredClone(options.provider.public)} : undefined;
  const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const uuid = new RegExp('^' + uuidPattern + '$');
  const token = (request: IncomingMessage, prefix: 'zkc1' | 'zkp1', id?: string) => {
    const value = request.headers.authorization;
    assert.equal(request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'authorization').length, 1);
    assert.ok(typeof value === 'string'); const match = new RegExp(`^Bearer ${prefix}\\.(${uuidPattern})\\.([A-Za-z0-9_-]{43})$`).exec(value); assert.ok(match);
    assert.equal(Buffer.from(match[2], 'base64url').toString('base64url'), match[2]);
    if (id) assert.equal(match[1], id); return value;
  };
  const quoteRequest = provider && {mode: 'proxy', provider: 'openai', models: [provider.public.testCase.model], session_ttl_seconds: String(provider.public.testCase.session_ttl_seconds)};
  const exactFields = (value: any, fields: string[]) => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), fields.sort()); };
  const assets = new Map(options.assets);
  for (const [name, mime] of [['index.html', 'text/html'], ['app.js', 'text/javascript'], ['style.css', 'text/css'], ['worker.js', 'text/javascript']]) {
    try { assets.set(name === 'index.html' ? '/' : '/' + name, {bytes: await readFile(resolve(options.output, name)), mime}); }
    catch (error) { if (name !== 'worker.js' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  assets.set('/live', assets.get('/')!);
  let demo: Buffer | undefined;
  try { demo = await readFile(resolve(options.output, 'demo.html')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (demo) {
    // Presentation and live wallet share an origin; only the document changes.
    // An incomplete demo build must fail before exposing a half-built page.
    for (const [name, mime] of [['demo.js', 'text/javascript'], ['demo.css', 'text/css']]) {
      assets.set('/' + name, {bytes: await readFile(resolve(options.output, name)), mime});
    }
    const presentation = {bytes: demo, mime: 'text/html'};
    assets.set('/', presentation); assets.set('/demo', presentation);
  }
  const allowedVault = new Map(await Promise.all(['create_payload', 'append_payload', 'seal_payload', 'execute_payload', 'close_payload'].map(async name => [Buffer.from(await discriminator(name)).toString('hex'), name] as const)));
  const safeReply = (result: {status:number; bytes:Buffer}, request?: any) => {
    if (result.status < 200 || result.status >= 300) return {...result, bytes: Buffer.from('{"error":"configured upstream unavailable"}')};
    if (!request) return result;
    const value = parseStrictJson(result.bytes) as any; assert.ok(value && value.jsonrpc === '2.0' && value.id === request.id);
    const envelope = value.error ? {jsonrpc: '2.0', id: request.id, error: {code: Number.isSafeInteger(value.error.code) ? value.error.code : -32000, message: 'configured RPC request failed'}} : {jsonrpc: '2.0', id: request.id, result: value.result};
    return {...result, bytes: Buffer.from(JSON.stringify(envelope))};
  };
  let origin = '', rpcId = 0;
  const callRpc = async (method: string, params: unknown[]) => {
    assert.ok(options.rpc); const result = await options.rpc(Buffer.from(JSON.stringify({jsonrpc: '2.0', id: ++rpcId, method, params})));
    assert.equal(result.status, 200); const parsed = parseStrictJson(result.bytes) as any; assert.ok(!parsed.error); return parsed.result;
  };
  const server = createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      assert.equal(request.headers.host, new URL(origin).host); assert.ok(['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''));
      assert.ok(!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])));
      if (request.headers.origin) assert.equal(request.headers.origin, origin);
      const path = request.url ?? '';
      if (request.method === 'GET' && assets.has(path)) { const asset = assets.get(path)!; response.setHeader('content-type', asset.mime); response.end(asset.bytes); return; }
      if (request.method === 'GET' && /^\/indexer\/zkapi\/v1\/tree\/(root|notes\/\d+\/(path|zero-path))$/.test(path)) {
        assert.ok(options.indexer); const result = safeReply(await options.indexer(path.slice('/indexer'.length))); response.statusCode = result.status; response.setHeader('content-type', 'application/json'); response.end(result.bytes); return;
      }
      if (path.startsWith('/control/') || path.startsWith('/inference/')) {
        assert.ok(provider && options.manifest);
        for (const name of ['cookie', 'proxy-authorization', 'x-api-key', 'anthropic-version']) assert.equal(request.headers[name], undefined);
        assert.ok(request.method === 'GET' || request.method === 'POST');
        if (request.method === 'POST') { assert.equal(request.headers.origin, origin); assert.ok(options.allowTransactions, 'financial writes disabled'); }
        const data = await body(request); let result: {status:number; bytes:Buffer};
        if (path === '/inference/v1/chat/completions') {
          assert.equal(request.method, 'POST'); assert.equal(request.headers['content-type'], 'application/json');
          assert.ok(data.equals(Buffer.from(providerAcceptanceBody(provider.public.testCase))));
          const authorization = token(request, 'zkp1'), operation = request.headers['idempotency-key']; assert.ok(typeof operation === 'string' && uuid.test(operation));
          assert.equal(request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'idempotency-key').length, 1);
          // An uncertain reservation/forward is permanently consumed. Neither
          // this host nor a fresh host process refunds or replays it.
          await provider.reserve();
          result = safeReply(await provider.inference({authorization, 'idempotency-key': operation}, data));
        } else {
          const controlPath = path.slice('/control'.length), method = request.method;
          assert.equal(request.headers['idempotency-key'], undefined);
          const headers: Record<string,string> = {};
          if (controlPath === '/zkapi/v1/quotes') {
            assert.equal(method, 'POST'); assert.equal(request.headers['content-type'], 'application/json'); assert.equal(request.headers.authorization, undefined);
            assert.ok(same(parseStrictJson(data), quoteRequest));
          } else if (controlPath === '/zkapi/v1/sessions') {
            assert.equal(method, 'POST'); assert.equal(request.headers['content-type'], 'application/json');
            const value = parseStrictJson(data) as any; exactFields(value, ['authorization', 'quote', 'public_inputs', 'proof']);
            const auth = value.authorization, q = value.quote?.body;
            exactFields(auth, ['version', 'deployment_id', 'pool', 'request_id', 'quote_hash', 'mode', 'control_secret_hash', 'proxy_secret_hash']);
            assert.ok(auth.version === '1' && auth.deployment_id === options.manifest.deployment_id && auth.pool === options.manifest.pool && auth.mode === 'proxy' && uuid.test(auth.request_id));
            headers.authorization = token(request, 'zkc1', auth.request_id);
            for (const name of ['quote_hash', 'control_secret_hash', 'proxy_secret_hash']) assert.match(auth[name], /^[0-9a-f]{64}$/);
            assert.ok(q && q.deployment_id === options.manifest.deployment_id && q.pool === options.manifest.pool
              && q.mode === 'proxy' && q.provider === 'openai' && same(q.models, quoteRequest!.models)
              && q.tariff_hash === provider.public.tariff.tariff_hash && q.session_ttl_seconds === quoteRequest!.session_ttl_seconds
              && q.control_api_origin === options.manifest.control_api_origin && q.inference_api_origin === options.manifest.inference_api_origin
              && q.cap_micro_usdc === options.manifest.cap_micro_usdc && value.quote.quote_hash === auth.quote_hash);
          } else {
            const route = new RegExp(`^/zkapi/v1/sessions/(${uuidPattern})(?:(/close)|(/receipts)(?:\\?cursor=(0|[1-9][0-9]{0,18}))?|(/operations/${uuidPattern}))?$`).exec(controlPath);
            assert.ok(route); headers.authorization = token(request, 'zkc1', route[1]);
            assert.equal(method, route[2] ? 'POST' : 'GET'); assert.equal(data.length, 0);
            if (route[4]) assert.ok(BigInt(route[4]) <= 0x7fffffffffffffffn);
          }
          result = safeReply(await provider.control(controlPath, method, headers, data.length ? data : undefined));
        }
        response.statusCode = result.status; response.setHeader('content-type', 'application/json'); response.end(result.bytes); return;
      }
      assert.equal(request.method, 'POST'); assert.equal(request.headers.origin, origin);
      const data = await body(request), json = parseStrictJson(data) as any;
      let result: {status: number; bytes: Buffer};
      if (path === '/rpc') {
        assert.ok(options.rpc && json && !Array.isArray(json) && json.jsonrpc === '2.0' && methods.has(json.method) && Array.isArray(json.params));
        if (json.method === 'getBlock') assert.ok(json.params[1]?.transactionDetails === 'none');
        if (json.method === 'sendTransaction') {
          assert.ok(options.allowTransactions && options.manifest, 'financial sends disabled');
          assert.equal(await callRpc('getGenesisHash', []), GENESIS);
          assert.ok(typeof json.params[0] === 'string' && json.params[1]?.encoding === 'base64');
          const bytes = Buffer.from(json.params[0], 'base64'); assert.equal(bytes.toString('base64'), json.params[0]); assert.ok(bytes.length <= 1232);
          const tx = VersionedTransaction.deserialize(bytes); assert.equal(tx.version, 0); await verifySignatures(tx);
          assert.equal(tx.message.addressTableLookups.length, 0);
          assert.ok(tx.message.staticAccountKeys.some(key => key.toBase58() === options.manifest!.pool));
          let vaultCalls = 0;
          for (const ix of tx.message.compiledInstructions) {
            const program = tx.message.staticAccountKeys[ix.programIdIndex].toBase58();
            assert.ok([options.manifest.program_id, ComputeBudgetProgram.programId.toBase58()].includes(program));
            if (program === options.manifest.program_id) {
              const name = allowedVault.get(Buffer.from(ix.data.slice(0, 8)).toString('hex')); assert.ok(name);
              const poolPosition = name === 'execute_payload' ? 3 : 1;
              assert.equal(tx.message.staticAccountKeys[ix.accountKeyIndexes[poolPosition]]?.toBase58(), options.manifest.pool);
              if (name === 'create_payload') assert.ok(ix.data[8] === 0 || ix.data[8] === 1, 'only deposit/mutual-close payload creation');
              vaultCalls++;
            } else {
              assert.ok((ix.data[0] === 2 && ix.data.length === 5 && Buffer.from(ix.data).readUInt32LE(1) <= 1_000_000) || (ix.data[0] === 3 && ix.data.length === 9), 'supported compute budget required');
            }
          }
          assert.equal(vaultCalls, 1);
          const fee = await callRpc('getFeeForMessage', [Buffer.from(tx.message.serialize()).toString('base64'), {commitment: 'finalized'}]);
          assert.ok(Number.isSafeInteger(fee?.value) && fee.value >= 0 && fee.value <= 10_000);
          json.params[1] = {encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0};
        }
        result = safeReply(await options.rpc(Buffer.from(JSON.stringify(json))), json);
      } else if (path === '/clearance') {
        assert.ok(options.allowTransactions && options.clearance && json && Object.keys(json).join(',') === 'nullifier' && /^0x[0-9a-f]{64}$/.test(json.nullifier));
        result = safeReply(await options.clearance(data));
      } else throw Error('route unavailable');
      response.statusCode = result.status; response.setHeader('content-type', 'application/json'); response.end(result.bytes);
    } catch { response.statusCode = 400; response.setHeader('content-type', 'application/json'); response.end('{"error":"local acceptance request refused"}'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  return {origin, server, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })};
}
