/** Numeric loopback-only acceptance host. No wallet key or .env is read.
 * RPC credentials stay in the private launch configuration, never /config. */
import assert from 'node:assert/strict';
import {createHash, timingSafeEqual} from 'node:crypto';
import {createServer, request as requestHttp, type IncomingMessage} from 'node:http';
import {request as requestHttps} from 'node:https';
import {readFile, lstat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {getCompiledTransactionMessageDecoder, getTransactionDecoder} from '@solana/kit';
import {jcsBytes, parseStrictJson, sha256Hex, verifyManifest, supportsInlineDeposit, type ManifestTrustPolicy, type VerifiedManifest} from '../../packages/sdk/src/trust.ts';
import {expandCompactDepositPayload} from '../../packages/sdk/src/layout2.ts';
import {discriminator, verifySignatures, resolvePreparationCommitment, type TransactionPreparationCommitment} from '../../packages/sdk/src/transport.ts';
import type {Tariff} from '../../packages/sdk/src/control.ts';
import {providerAcceptanceBody, type ProviderAcceptanceCase} from '../provider_acceptance_client.ts';
import {validatePreparedProviderConfig} from '../i10_devnet_provider.ts';
import {providerErrorCode} from './provider-diagnostics.ts';

export interface UpstreamReply {status: number; bytes: Buffer; serviceErrorCode?: string}

export const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export interface HostConfig {
  runId: string; port: number; manifestPath: string; policy: ManifestTrustPolicy; wasmPath: string; wasmSha256: string;
  artifacts: Record<string, string>; rpcUrl: string; indexerUrl: string; controlUrl: string;
  /** Explicit read-only transaction history endpoint; never used for sends. */
  historyRpcUrl?: string;
  /** Match browser blockhash/fee preparation and relay preflight; finality stays finalized. */
  preparationCommitment?: TransactionPreparationCommitment;
  localCaPath?: string; allowTransactions: boolean;
  provider?: {planPath: string; configurationDir: string; stateDir: string; requestPolicy?: 'explicit_demo'};
}
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const execute = promisify(execFile);
const same = (a: unknown, b: unknown) => Buffer.from(jcsBytes(a)).equals(Buffer.from(jcsBytes(b)));
export interface UiProviderPublic {testCase: ProviderAcceptanceCase; tariff: Tariff; planSha256: string; requestPolicy?: 'explicit_demo'}
/** Read-only capacity snapshot; only reserve() grants a one-time send. */
export interface UiProviderBudget {
  schema: 1; plan_sha256: string; request_policy: 'explicit_demo' | 'single_acceptance_case';
  budget_micro_usdc: string; reserved_micro_usdc: string; remaining_micro_usdc: string;
  max_requests: number; reserved_requests: number; remaining_requests: number;
  request_max_cost_micro_usdc: string; available_requests: number;
}
export interface UiDirectProviderBudget {
  schema: 1; allowTransactions: boolean;
  budget_micro_usdc: string; reserved_micro_usdc: string; remaining_micro_usdc: string;
  max_requests: number; reserved_requests: number; remaining_requests: number;
  request_max_cost_micro_usdc: string; available_requests: number;
}
/** Reads only prepared references, never credential files or .env. Budget
 * reservation remains the existing Python reserve-once coordinator. */
export async function loadProviderUi(config: NonNullable<HostConfig['provider']>, manifest: VerifiedManifest) {
  assert.ok(config.requestPolicy === undefined || config.requestPolicy === 'explicit_demo');
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
  const coordinator = async (command: 'budget-status' | 'reserve' | 'reserve-demo', requestId?: string, operationId?: string) => {
    const env: NodeJS.ProcessEnv = {}; for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
    const args = [join(ROOT, 'scripts/provider_demo_budget.py'), command, '--plan', planPath, '--state-dir', state,
      ...(command !== 'budget-status' ? ['--case', testCase.id] : []),
      ...(command === 'reserve-demo' ? ['--request-id', requestId!, '--operation-id', operationId!] : [])];
    try { const result = await execute('python3', args, {cwd: ROOT, env, timeout: 30_000, maxBuffer: 1_048_576}); return parseStrictJson(Buffer.from(result.stdout)) as any; }
    catch { throw Error('provider campaign unavailable'); }
  };
  const identity = {schema: 1, campaign_id: plan.campaign_id, plan_sha256: planSha256,
    budget_micro_usdc: plan.budget_micro_usdc, max_requests: plan.max_requests};
  const budget = async (): Promise<UiProviderBudget> => {
    // The coordinator validates every original/demo row under its existing lock.
    // Recheck the captured identity on every read, then expose totals only.
    const value = await coordinator('budget-status'); assert.ok(same(value.identity, identity));
    const amount = (input: unknown): bigint => { assert.ok(typeof input === 'string' && /^(0|[1-9][0-9]{0,7})$/.test(input));
      const n = BigInt(input); assert.ok(n <= 10_000_000n); return n; };
    const total = amount(identity.budget_micro_usdc), reserved = amount(value.reserved_micro_usdc), remaining = amount(value.remaining_micro_usdc);
    const cost = amount(testCase.max_cost_micro_usdc); assert.ok(cost > 0n && reserved + remaining === total);
    assert.ok(Number.isSafeInteger(identity.max_requests) && identity.max_requests > 0 && identity.max_requests <= 1000
      && Array.isArray(value.reservations) && value.reservations.length <= identity.max_requests
      && value.refunds_supported === false && value.inference_replays_supported === false);
    const reservedRequests = value.reservations.length, remainingRequests = identity.max_requests - reservedRequests;
    const policy = config.requestPolicy ?? 'single_acceptance_case';
    const policySlots = policy === 'explicit_demo' ? remainingRequests
      : value.reservations.some((row: {case_id: string}) => row.case_id === testCase.id) ? 0 : 1;
    return {schema: 1, plan_sha256: planSha256, request_policy: policy, budget_micro_usdc: total.toString(),
      reserved_micro_usdc: reserved.toString(), remaining_micro_usdc: remaining.toString(), max_requests: identity.max_requests,
      reserved_requests: reservedRequests, remaining_requests: remainingRequests, request_max_cost_micro_usdc: cost.toString(),
      available_requests: Math.min(remainingRequests, policySlots, Number(remaining / cost))};
  };
  await budget();
  return {public: {testCase, tariff, planSha256, ...(config.requestPolicy ? {requestPolicy: config.requestPolicy} : {})} satisfies UiProviderPublic, budget, async reserve(requestId?: string, operationId?: string) {
    const demo = config.requestPolicy === 'explicit_demo';
    if (demo) for (const id of [requestId, operationId]) assert.match(id ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const value = await coordinator(demo ? 'reserve-demo' : 'reserve', requestId, operationId);
    assert.ok(value.send_authorized_once === true && value.case_id === (demo ? 'demo-' + operationId : testCase.id) && value.plan_sha256 === planSha256
      && value.reserved_micro_usdc === testCase.max_cost_micro_usdc);
    if (demo) assert.ok(value.request_id === requestId && value.operation_id === operationId && value.template_case_id === testCase.id);
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
  const preparationCommitment = resolvePreparationCommitment(config.preparationCommitment);
  assert.ok(/^[a-zA-Z0-9_-]{1,80}$/.test(config.runId)); assert.ok(Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535);
  assert.ok(typeof config.allowTransactions === 'boolean'); assertHttps(config.rpcUrl);
  if (config.historyRpcUrl !== undefined) assertHttps(config.historyRpcUrl);
  const rpcUrl = config.rpcUrl, historyRpcUrl = config.historyRpcUrl;
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
    artifactNames: Object.keys(config.artifacts), allowTransactions: config.allowTransactions, preparationCommitment,
    ...(provider ? {provider: provider.public} : {})})), mime: 'application/json'});
  const ca = config.localCaPath ? await readFile(config.localCaPath) : undefined;
  const forward = async (url: string, method: string, data?: Buffer, headers: Record<string,string> = {}, timeout = 30_000): Promise<UpstreamReply> => {
    const u = new URL(url), local = ['127.0.0.1', '[::1]'].includes(u.hostname);
    assert.ok(u.protocol === 'https:' || (u.protocol === 'http:' && local));
    return new Promise((resolve, reject) => {
      const request = (u.protocol === 'https:' ? requestHttps : requestHttp)(u, {method, agent: false, ...(local && ca ? {ca} : {}), timeout,
        headers: {...(data ? {'content-type': 'application/json', 'content-length': String(data.length)} : {}), 'accept': 'application/json', ...headers}}, response => {
        const parts: Buffer[] = []; let size = 0;
        response.on('data', part => { size += part.length; if (size > 4 * 1024 * 1024) { response.destroy(); reject(Error('upstream response bound')); } else parts.push(Buffer.from(part)); });
        response.on('end', () => resolve({status: response.statusCode ?? 502, bytes: Buffer.concat(parts),
          serviceErrorCode: providerErrorCode(response.headers['x-zkapi-error-code'])})); response.on('error', () => reject(Error('upstream response unavailable')));
      });
      request.on('timeout', () => request.destroy()); request.on('error', () => reject(Error('upstream unavailable'))); request.end(data);
    });
  };
  return startUiHost({port: config.port, output, assets, manifest, allowTransactions: config.allowTransactions, preparationCommitment,
    rpc: data => forward(rpcUrl, 'POST', data),
    ...(historyRpcUrl !== undefined ? {historyRpc: (data: Buffer) => forward(historyRpcUrl, 'POST', data)} : {}),
    indexer: path => forward(config.indexerUrl + path, 'GET'),
    clearance: data => forward(config.controlUrl + '/zkapi/v1/withdraw/clearance', 'POST', data),
    ...(provider ? {provider: {...provider,
      control: (path: string, method: string, headers: Record<string,string>, data?: Buffer) => forward(config.controlUrl + path, method, data, {...headers, host: new URL(manifest.control_api_origin).host}, 60_000),
      inference: (headers: Record<string,string>, data: Buffer) => forward(config.controlUrl + '/v1/chat/completions', 'POST', data, {...headers, host: new URL(manifest.inference_api_origin).host}, 600_000)}} : {})});
}

export interface HostOptions {
  port: number; output?: string; assets?: Map<string, {bytes: Buffer; mime: string}>; manifest?: VerifiedManifest; allowTransactions?: boolean;
  /** Explicit standalone application integration; defaults preserve the wallet host. */
  application?: 'browser-chat' | 'public-api';
  allowedBrowserOrigins?: readonly string[];
  allowNativeRequests?: boolean;
  /** SHA-256 of canonical 43-character base64url invitation text; operator-private. */
  admissionTokenSha256?: string;
  /** Exact HTTPS origin behind a TLS reverse proxy on this loopback listener. */
  publicOrigin?: string;
  /** Omission preserves historical admission. Recovery stays under allowTransactions. */
  allowNewAdmissions?: boolean;
  directProviderOrigin?: 'https://openrouter.ai';
  /** Only /control is delegated, after the same loopback/origin/header/write guards.
   * The installed application must enforce its exact native routes and budget. */
  controlRelay?: (input: {path: string; method: 'GET' | 'POST'; authorization?: string; data: Buffer; allowNewAdmissions?: boolean; newAdmissionAuthorized?: boolean; signal?: AbortSignal}) => Promise<UpstreamReply>;
  directBudget?: () => Promise<UiDirectProviderBudget>;
  preparationCommitment?: TransactionPreparationCommitment;
  rpc?: (data: Buffer, signal?: AbortSignal) => Promise<{status: number; bytes: Buffer}>;
  historyRpc?: (data: Buffer, signal?: AbortSignal) => Promise<{status: number; bytes: Buffer}>;
  indexer?: (path: string, signal?: AbortSignal) => Promise<{status: number; bytes: Buffer}>;
  clearance?: (data: Buffer) => Promise<{status: number; bytes: Buffer}>;
  provider?: {public: UiProviderPublic; budget?(): Promise<UiProviderBudget>; reserve(requestId?: string, operationId?: string): Promise<void>;
    control(path: string, method: string, headers: Record<string,string>, data?: Buffer): Promise<UpstreamReply>;
    inference(headers: Record<string,string>, data: Buffer): Promise<UpstreamReply>};
}
export async function startUiHost(options: HostOptions) {
  const preparationCommitment = resolvePreparationCommitment(options.preparationCommitment);
  assert.ok(options.allowNewAdmissions === undefined || typeof options.allowNewAdmissions === 'boolean');
  const allowNewAdmissions = options.allowNewAdmissions ?? options.allowTransactions === true;
  const publicOrigin = options.publicOrigin, publicApi = options.application === 'public-api';
  const browserOrigins = new Set(options.allowedBrowserOrigins ?? []);
  const nativeRequests = options.allowNativeRequests === true;
  const admissionTokenSha256 = options.admissionTokenSha256;
  if (publicApi) {
    assert.ok(publicOrigin && Array.isArray(options.allowedBrowserOrigins) && browserOrigins.size === options.allowedBrowserOrigins.length
      && browserOrigins.size <= 32 && typeof options.allowNativeRequests === 'boolean' && !options.provider && !options.assets);
    if (allowNewAdmissions || admissionTokenSha256 !== undefined) assert.match(admissionTokenSha256 ?? '', /^[0-9a-f]{64}$/, 'public admission invitation digest required');
    for (const value of browserOrigins) { const u = new URL(value); assert.ok(u.protocol === 'https:' && u.origin === value && !u.username && !u.password); }
  } else assert.ok(options.allowedBrowserOrigins === undefined && options.allowNativeRequests === undefined && admissionTokenSha256 === undefined);
  if (publicOrigin !== undefined) {
    const url = new URL(publicOrigin);
    assert.ok((options.application === 'browser-chat' || publicApi) && publicOrigin === url.origin && url.protocol === 'https:'
      && !url.username && !url.password && typeof options.allowNewAdmissions === 'boolean', 'explicit public HTTPS origin and admission policy required');
  }
  assert.ok(options.application === undefined || options.application === 'browser-chat' || publicApi);
  assert.ok(options.directProviderOrigin === undefined || options.application === 'browser-chat' && options.directProviderOrigin === 'https://openrouter.ai');
  assert.ok(!options.controlRelay || (options.application === 'browser-chat' || publicApi) && !options.provider);
  assert.ok(!options.directBudget || (options.application === 'browser-chat' || publicApi) && !options.provider && options.controlRelay);
  const directProviderOrigin = options.directProviderOrigin, controlRelay = options.controlRelay, directBudget = options.directBudget;
  const historyRpc = options.historyRpc;
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
  if (!publicApi) {
  assert.ok(options.output);
  for (const [name, mime] of [['index.html', 'text/html'], ['app.js', 'text/javascript'], [options.application === 'browser-chat' ? 'styles.css' : 'style.css', 'text/css'], ['worker.js', 'text/javascript']]) {
    // The standalone packager already authenticates these exact bytes. Do not
    // re-read a changed file after checking its build digest.
    if (options.application === 'browser-chat' && assets.has(name === 'index.html' ? '/' : '/' + name)) continue;
    try { assets.set(name === 'index.html' ? '/' : '/' + name, {bytes: await readFile(resolve(options.output, name)), mime}); }
    catch (error) { if (name !== 'worker.js' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  assets.set('/live', assets.get('/')!);
  let demo: Buffer | undefined;
  try { if (options.application !== 'browser-chat') demo = await readFile(resolve(options.output, 'demo.html')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (demo) {
    // Presentation and live wallet share an origin; only the document changes.
    // An incomplete demo build must fail before exposing a half-built page.
    for (const [name, mime] of [['demo.js', 'text/javascript'], ['demo.css', 'text/css']]) {
      assets.set('/' + name, {bytes: await readFile(resolve(options.output, name)), mime});
    }
    const presentation = {bytes: demo, mime: 'text/html'};
    // The default page operates the existing SDK. Samples require the explicit
    // /demo route, so a visitor never mistakes an animation for a live request.
    assets.set('/demo', presentation);
  }
  }
  const allowedVault = new Map(await Promise.all(['create_payload', 'append_payload', 'seal_payload', 'execute_payload', 'close_payload', 'finalize_escape', 'deposit_compact_v1'].map(async name => [Buffer.from(await discriminator(name)).toString('hex'), name] as const)));
  const safeReply = (result: UpstreamReply, request?: any) => {
    if (result.status < 200 || result.status >= 300) return {...result, bytes: Buffer.from('{"error":"configured upstream unavailable"}')};
    if (!request) return result;
    const value = parseStrictJson(result.bytes) as any; assert.ok(value && value.jsonrpc === '2.0' && value.id === request.id);
    const envelope = value.error ? {jsonrpc: '2.0', id: request.id, error: {code: Number.isSafeInteger(value.error.code) ? value.error.code : -32000, message: 'configured RPC request failed'}} : {jsonrpc: '2.0', id: request.id, result: value.result};
    return {...result, bytes: Buffer.from(JSON.stringify(envelope))};
  };
  let origin = '', rpcId = 0;
  const callRpc = async (method: string, params: unknown[], rpc = options.rpc, signal?: AbortSignal) => {
    assert.ok(rpc); const id = ++rpcId, result = await rpc(Buffer.from(JSON.stringify({jsonrpc: '2.0', id, method, params})), signal);
    assert.equal(result.status, 200); const parsed = parseStrictJson(result.bytes) as any;
    assert.ok(parsed && parsed.jsonrpc === '2.0' && parsed.id === id && !parsed.error); return parsed.result;
  };
  const gatewayMethod = (path: string): 'GET' | 'POST' | undefined => {
    if (['/rpc','/zkapi/v1/quotes','/zkapi/v1/sessions','/zkapi/v1/withdraw/clearance'].includes(path)
      || new RegExp(`^/zkapi/v1/sessions/${uuidPattern}/close$`).test(path)) return 'POST';
    if (['/relay-status','/provider-budget','/zkapi/v1/config','/zkapi/v1/catalog','/zkapi/v1/attestation'].includes(path)
      || /^\/zkapi\/v1\/tariffs\/[0-9a-f]{64}$/.test(path)
      || /^\/zkapi\/v1\/tree\/(root|snapshot|snapshots\/[0-9a-f]{64}\.json)$/.test(path)
      || new RegExp(`^/zkapi/v1/sessions/${uuidPattern}(?:/receipts(?:\\?cursor=[1-9][0-9]{0,18})?|/operations/${uuidPattern})?$`).test(path)) return 'GET';
  };
  const server = createServer(async (request, response) => {
    const cancellation = new AbortController();
    request.once('aborted', () => cancellation.abort());
    response.once('close', () => { if (!response.writableEnded) cancellation.abort(); });
    const signal = cancellation.signal;
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'${directProviderOrigin ? ' ' + directProviderOrigin : ''}; worker-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    try {
      assert.equal(request.headers.host, new URL(origin).host); assert.ok(['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''));
      let path = request.url ?? '', newAdmissionAuthorized = !publicApi;
      if (publicApi) {
        for (const name of ['cookie','proxy-authorization','x-api-key','anthropic-version','idempotency-key','x-forwarded-host','x-forwarded-for','x-forwarded-proto']) assert.equal(request.headers[name], undefined);
        for (const name of ['host','origin','authorization','content-type','x-zkapi-admission']) assert.ok(request.rawHeaders.filter((v,i) => i % 2 === 0 && v.toLowerCase() === name).length <= 1);
        const invitation = request.headers['x-zkapi-admission'];
        if (invitation !== undefined) assert.ok(path === '/zkapi/v1/sessions' && request.method === 'POST', 'invitation is only accepted on AUTH');
        if (typeof invitation === 'string' && /^[A-Za-z0-9_-]{43}$/.test(invitation) && admissionTokenSha256 !== undefined) {
          const bytes = Buffer.from(invitation,'base64url');
          if (bytes.length === 32 && bytes.toString('base64url') === invitation)
            newAdmissionAuthorized = timingSafeEqual(createHash('sha256').update(invitation,'utf8').digest(),Buffer.from(admissionTokenSha256,'hex'));
        }
        const browserOrigin = request.headers.origin;
        if (browserOrigin !== undefined) {
          assert.ok(browserOrigins.has(browserOrigin));
          response.setHeader('access-control-allow-origin', browserOrigin); response.setHeader('vary','Origin');
          response.setHeader('access-control-expose-headers','x-zkapi-error-code');
        } else {
          // Same-origin browser GETs omit Origin. Fetch Metadata is supplied by
          // the browser and this path is enabled only for the reviewed origin.
          const sameOriginBrowser = browserOrigins.has(origin) && request.headers['sec-fetch-site'] === 'same-origin'
            && ['cors','same-origin'].includes(String(request.headers['sec-fetch-mode']))
            && (!request.headers['sec-fetch-dest'] || request.headers['sec-fetch-dest'] === 'empty');
          assert.ok(sameOriginBrowser || nativeRequests && !Object.keys(request.headers).some(name => name.startsWith('sec-fetch-')), 'explicit native transport required');
        }
        const method = gatewayMethod(path); assert.ok(method, 'unsupported public route');
        if (request.method === 'OPTIONS') {
          assert.ok(browserOrigin && request.headers['access-control-request-method'] === method && !request.headers.authorization);
          assert.ok(!request.headers['transfer-encoding'] && (!request.headers['content-length'] || request.headers['content-length'] === '0'));
          const requested = String(request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
          const allowedHeaders = ['authorization','content-type', ...(path === '/zkapi/v1/sessions' ? ['x-zkapi-admission'] : [])];
          assert.ok(new Set(requested).size === requested.length && requested.every(v => allowedHeaders.includes(v)));
          response.setHeader('access-control-allow-methods',method); response.setHeader('access-control-allow-headers',allowedHeaders.join(', '));
          response.setHeader('access-control-max-age','300'); response.statusCode=204; response.end(); return;
        }
        assert.equal(request.method,method);
        if (path === '/rpc' || path.startsWith('/zkapi/v1/tree/')) assert.equal(request.headers.authorization,undefined);
        if (path.startsWith('/zkapi/v1/tree/')) path='/indexer'+path;
        else if (path.startsWith('/zkapi/v1/')) path='/control'+path;
      } else {
        assert.ok(!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(request.headers['sec-fetch-site'])));
        if (request.headers.origin) assert.equal(request.headers.origin, origin);
      }
      if (request.method === 'GET' && assets.has(path)) { const asset = assets.get(path)!; response.setHeader('content-type', asset.mime); response.end(asset.bytes); return; }
      if (request.method === 'GET' && path === '/relay-status') {
        for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key']) assert.equal(request.headers[name], undefined);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({schema: 1, scope: 'relay_configuration_only', readiness: 'not_checked',
          admission: options.allowTransactions && allowNewAdmissions ? 'enabled' : 'suspended',
          recovery: options.allowTransactions ? 'enabled' : 'disabled',
          routes: {rpc: options.rpc ? 'configured' : 'missing', indexer: options.indexer ? 'configured' : 'missing',
            control: controlRelay || provider ? 'configured' : 'missing'},
          signer: 'not_checked', provider_credit: 'not_checked', finalized_pool: 'not_checked'})); return;
      }
      if (request.method === 'GET' && path === '/provider-budget') {
        for (const name of ['authorization', 'cookie', 'proxy-authorization', 'x-api-key']) assert.equal(request.headers[name], undefined);
        response.setHeader('content-type', 'application/json');
        try { const budget = directBudget ?? provider?.budget; assert.ok(budget); response.end(JSON.stringify(await budget())); }
        catch { response.statusCode = 503; response.end('{"error":"provider campaign unavailable"}'); }
        return;
      }
      if (request.method === 'GET' && /^\/indexer\/zkapi\/v1\/tree\/(root|snapshot|snapshots\/[0-9a-f]{64}\.json|notes\/\d+\/(path|zero-path))$/.test(path)) {
        assert.ok(options.indexer); const result = safeReply(await options.indexer(path.slice('/indexer'.length),signal)); response.statusCode = result.status; response.setHeader('content-type', 'application/json'); response.end(result.bytes); return;
      }
      if (path.startsWith('/control/') && controlRelay) {
        for (const name of ['cookie', 'proxy-authorization', 'x-api-key', 'anthropic-version', 'idempotency-key']) assert.equal(request.headers[name], undefined);
        assert.ok(request.method === 'GET' || request.method === 'POST');
        assert.ok(request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'authorization').length <= 1);
        if (request.method === 'POST') {
          if (!publicApi) assert.equal(request.headers.origin, origin); assert.ok(options.allowTransactions, 'financial writes disabled');
        }
        const data = await body(request);
        if (data.length) assert.equal(request.headers['content-type'], 'application/json');
        const result = safeReply(await controlRelay({path: path.slice('/control'.length), method: request.method,
          authorization: request.headers.authorization, data, allowNewAdmissions, newAdmissionAuthorized, signal}));
        response.statusCode = result.status; response.setHeader('content-type', 'application/json'); response.end(result.bytes); return;
      }
      if (path.startsWith('/control/') || path.startsWith('/inference/')) {
        assert.ok(provider && options.manifest);
        for (const name of ['cookie', 'proxy-authorization', 'x-api-key', 'anthropic-version']) assert.equal(request.headers[name], undefined);
        assert.ok(request.method === 'GET' || request.method === 'POST');
        if (request.method === 'POST') { if (!publicApi) assert.equal(request.headers.origin, origin); assert.ok(options.allowTransactions, 'financial writes disabled'); }
        const data = await body(request); let result: UpstreamReply;
        if (path === '/inference/v1/chat/completions') {
          assert.ok(allowNewAdmissions, 'new provider admission suspended');
          assert.equal(request.method, 'POST'); assert.equal(request.headers['content-type'], 'application/json');
          assert.ok(data.equals(Buffer.from(providerAcceptanceBody(provider.public.testCase))));
          const authorization = token(request, 'zkp1'), operation = request.headers['idempotency-key']; assert.ok(typeof operation === 'string' && uuid.test(operation));
          assert.equal(request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'idempotency-key').length, 1);
          // An uncertain reservation/forward is permanently consumed. Neither
          // this host nor a fresh host process refunds or replays it.
          await provider.reserve(authorization.split('.')[1], operation);
          result = safeReply(await provider.inference({authorization, 'idempotency-key': operation}, data));
        } else {
          const controlPath = path.slice('/control'.length), method = request.method;
          assert.equal(request.headers['idempotency-key'], undefined);
          const headers: Record<string,string> = {};
          if (controlPath === '/zkapi/v1/quotes') {
            assert.equal(method, 'POST'); assert.equal(request.headers['content-type'], 'application/json'); assert.equal(request.headers.authorization, undefined);
            assert.ok(same(parseStrictJson(data), quoteRequest));
          } else if (controlPath === '/zkapi/v1/sessions') {
            assert.ok(allowNewAdmissions, 'new provider admission suspended');
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
        const code = providerErrorCode(result.serviceErrorCode);
        if (code) response.setHeader('x-zkapi-error-code', code);
        response.statusCode = result.status; response.setHeader('content-type', 'application/json'); response.end(result.bytes); return;
      }
      assert.equal(request.method, 'POST'); if (!publicApi) assert.equal(request.headers.origin, origin);
      const data = await body(request), json = parseStrictJson(data) as any;
      let result: {status: number; bytes: Buffer};
      if (path === '/rpc') {
        assert.ok(options.rpc && json && !Array.isArray(json) && json.jsonrpc === '2.0' && methods.has(json.method) && Array.isArray(json.params));
        if (json.method === 'getBlock') assert.ok(json.params[1]?.transactionDetails === 'none');
        if (json.method === 'sendTransaction') {
          assert.ok(options.allowTransactions && options.manifest, 'financial sends disabled');
          assert.equal(await callRpc('getGenesisHash', [], options.rpc, signal), GENESIS);
          assert.ok(typeof json.params[0] === 'string' && json.params[1]?.encoding === 'base64');
          const bytes = Buffer.from(json.params[0], 'base64'); assert.equal(bytes.toString('base64'), json.params[0]); assert.ok(bytes.length <= 1232);
          const tx = getTransactionDecoder().decode(bytes), message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
          assert.ok(message.version === 0); await verifySignatures(tx);
          assert.equal((message.addressTableLookups?.length ?? 0), 0);
          assert.ok(message.staticAccounts.includes(options.manifest!.pool as typeof message.staticAccounts[number]));
          let vaultCalls = 0;
          for (const ix of message.instructions) {
            assert.ok(ix.data);
            const program = message.staticAccounts[ix.programAddressIndex];
            assert.ok([options.manifest.program_id, 'ComputeBudget111111111111111111111111111111'].includes(program));
            if (program === options.manifest.program_id) {
              const name = allowedVault.get(Buffer.from(ix.data.slice(0, 8)).toString('hex')); assert.ok(name);
              const poolPosition = name === 'execute_payload' ? 3 : name === 'finalize_escape' || name === 'deposit_compact_v1' ? 0 : 1;
              assert.equal(message.staticAccounts[ix.accountIndices![poolPosition]], options.manifest.pool);
              if (name === 'create_payload') {
                assert.ok(ix.data.length === 85 && [0, 1, 2].includes(ix.data[8]), 'only deposit/mutual-close/escape payload creation');
                assert.ok(allowNewAdmissions || ix.data[8] !== 0, 'new deposit admission suspended');
              }
              if (name === 'finalize_escape') assert.equal(ix.data.length, 12, 'canonical escape finalization required');
              if (name === 'deposit_compact_v1') {
                assert.ok(allowNewAdmissions, 'new deposit admission suspended');
                // This requires the SDK's authenticated manifest identity and
                // independent build capability pin, not a caller-supplied flag.
                assert.ok(supportsInlineDeposit(options.manifest), 'compact deposit capability required');
                assert.equal((ix.accountIndices?.length ?? 0), 19, 'canonical compact account shape required');
                // The shared strict codec checks the exact 436-byte arguments,
                // field encodings and positive amount, and reconstructs implicit
                // public inputs using the pinned binding.
                // Proof and finalized account validation remain in the SDK/Vault.
                expandCompactDepositPayload(ix.data.slice(8), options.manifest.vault_binding);
              }
              vaultCalls++;
            } else {
              assert.ok((ix.data[0] === 2 && ix.data.length === 5 && Buffer.from(ix.data).readUInt32LE(1) <= 1_000_000) || (ix.data[0] === 3 && ix.data.length === 9), 'supported compute budget required');
            }
          }
          assert.equal(vaultCalls, 1);
          const fee = await callRpc('getFeeForMessage', [Buffer.from(tx.messageBytes).toString('base64'), {commitment: preparationCommitment}],options.rpc,signal);
          assert.ok(Number.isSafeInteger(fee?.value) && fee.value >= 0 && fee.value <= 10_000);
          json.params[1] = {encoding: 'base64', skipPreflight: false, preflightCommitment: preparationCommitment, maxRetries: 0};
        }
        if (json.method === 'getTransaction' && historyRpc) {
          // Explicit history routing, with a fresh Devnet pin check. Failure is
          // never absence, and neither endpoint is retried or substituted.
          assert.equal(await callRpc('getGenesisHash', [], historyRpc, signal), GENESIS);
          result = safeReply(await historyRpc(Buffer.from(JSON.stringify(json)),signal), json);
        } else result = safeReply(await options.rpc(Buffer.from(JSON.stringify(json)),signal), json);
      } else if (path === '/clearance') {
        assert.ok(options.allowTransactions && options.clearance && json && Object.keys(json).join(',') === 'nullifier' && /^0x[0-9a-f]{64}$/.test(json.nullifier));
        result = safeReply(await options.clearance(data));
      } else throw Error('route unavailable');
      response.statusCode = result.status; response.setHeader('content-type', 'application/json'); response.end(result.bytes);
    } catch { response.statusCode = 400; response.setHeader('content-type', 'application/json'); response.end('{"error":"local acceptance request refused"}'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  origin = publicOrigin ?? 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  return {origin, server, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })};
}
