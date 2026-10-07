/** Explicit numeric-loopback standalone chat host. Provider inference is never
 * relayed. Private RPC configuration and management credentials are not assets. */
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {readFile, lstat} from 'node:fs/promises';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseField} from '../packages/sdk/src/encoding.ts';
import {jcsBytes, parseStrictJson, sha256Hex, verifyEd25519, verifyManifest, type VerifiedManifest} from '../packages/sdk/src/trust.ts';
import type {Tariff} from '../packages/sdk/src/control.ts';
import {parseReviewedDevnetProfile} from '../examples/browser-chat/load-deployment.ts';
import {GENESIS, startUiHost, type HostOptions, type UpstreamReply, type UiDirectProviderBudget} from './i10-wallet-ui/host.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const uuid = new RegExp('^' + uuidPattern + '$'), hash = /^[0-9a-f]{64}$/;
const same = (a: unknown, b: unknown) => Buffer.from(jcsBytes(a)).equals(Buffer.from(jcsBytes(b)));
const exact = (value: any, keys: string[]) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const uint = (value: unknown) => {
  assert.ok(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value));
  return BigInt(value);
};

export interface DirectDemoBudget {
  /** Must durably bind request ID and exact AUTH bytes before admitting its
   * first forward. Same-byte AUTH recovery may reuse the original reservation. */
  reserve(requestId: string, authorizationSha256: string): Promise<void>;
}
export interface DirectControlOptions {
  manifest: VerifiedManifest; tariff: Tariff; budget: DirectDemoBudget;
  forward(path: string, method: 'GET' | 'POST', headers: Record<string, string>, data?: Buffer): Promise<UpstreamReply>;
}

/** Pure route/admission boundary. The outer host checks numeric loopback,
 * Host, Origin, forbidden headers, request size and write enablement first. */
export function directControlRelay(options: DirectControlOptions): NonNullable<HostOptions['controlRelay']> {
  const {manifest, budget, forward} = options, tariff = structuredClone(options.tariff);
  assert.ok(tariff.provider === 'openrouter' && tariff.model === '*' && manifest.tariff_hashes.includes(tariff.tariff_hash));
  const quoteRequest = {mode: 'direct_openrouter', provider: 'openrouter', models: ['*'], session_ttl_seconds: '60'};
  const authToken = (authorization: string | undefined, requestId: string) => {
    assert.ok(typeof authorization === 'string');
    const match = new RegExp(`^Bearer zkc1\\.(${uuidPattern})\\.([A-Za-z0-9_-]{43})$`).exec(authorization); assert.ok(match);
    assert.equal(match[1], requestId);
    const secret = Buffer.from(match[2], 'base64url'); assert.equal(secret.length, 32); assert.equal(secret.toString('base64url'), match[2]);
    return secret;
  };
  return async ({path, method, authorization, data}) => {
    assert.ok(!path.includes('#') && !path.includes('%') && !path.includes('\\'));
    const headers: Record<string, string> = {};
    if (path === '/zkapi/v1/quotes') {
      assert.equal(method, 'POST'); assert.equal(authorization, undefined);
      assert.ok(same(parseStrictJson(data), quoteRequest));
    } else if (path === '/zkapi/v1/sessions') {
      assert.equal(method, 'POST');
      const request = parseStrictJson(data) as any;
      exact(request, ['authorization', 'quote', 'public_inputs', 'proof']);
      const auth = request.authorization, quote = request.quote, q = quote?.body;
      exact(auth, ['version', 'deployment_id', 'pool', 'request_id', 'quote_hash', 'mode', 'control_secret_hash', 'proxy_secret_hash']);
      assert.ok(auth.version === '1' && auth.deployment_id === manifest.deployment_id && auth.pool === manifest.pool
        && auth.mode === 'direct_openrouter' && uuid.test(auth.request_id) && auth.proxy_secret_hash === null);
      assert.match(auth.quote_hash, hash); assert.match(auth.control_secret_hash, hash);
      const secret = authToken(authorization, auth.request_id);
      assert.equal(await sha256Hex(secret), auth.control_secret_hash); headers.authorization = authorization!;
      exact(quote, ['body', 'quote_hash', 'signature']);
      exact(q, ['quote_id', 'deployment_id', 'pool', 'mode', 'provider', 'models', 'tariff_hash', 'cap_micro_usdc',
        'issued_at', 'expires_at', 'session_ttl_seconds', 'max_concurrency', 'control_api_origin', 'inference_api_origin']);
      assert.ok(uuid.test(q.quote_id) && q.deployment_id === manifest.deployment_id && q.pool === manifest.pool
        && q.mode === quoteRequest.mode && q.provider === quoteRequest.provider && same(q.models, quoteRequest.models)
        && q.tariff_hash === tariff.tariff_hash && q.session_ttl_seconds === quoteRequest.session_ttl_seconds
        && q.control_api_origin === manifest.control_api_origin && q.inference_api_origin === manifest.inference_api_origin
        && q.cap_micro_usdc === manifest.cap_micro_usdc && uint(q.cap_micro_usdc) > 0n
        && uint(q.cap_micro_usdc) <= 1_000_000n && uint(q.expires_at) > uint(q.issued_at)
        && uint(q.max_concurrency) > 0n && uint(q.max_concurrency) <= 4n);
      assert.equal(quote.quote_hash, auth.quote_hash);
      assert.equal(await sha256Hex(jcsBytes(q)), quote.quote_hash);
      await verifyEd25519(manifest.quote_public_key, Buffer.from(quote.quote_hash, 'hex'), quote.signature);
      assert.ok(Array.isArray(request.public_inputs) && request.public_inputs.length === 12);
      request.public_inputs.forEach(parseField);
      exact(request.proof, ['backend', 'proof']); assert.equal(request.proof.backend, 'groth16_bn254');
      assert.ok(typeof request.proof.proof === 'string');
      const proof = Buffer.from(request.proof.proof, 'base64');
      assert.equal(proof.length, 256); assert.equal(proof.toString('base64'), request.proof.proof);
      // The server/SDK verify the proof itself. Reserve the entire allowed lease,
      // not an estimated prompt cost. Never retry forwarding here.
      await budget.reserve(auth.request_id, await sha256Hex(data));
    } else if (path === '/zkapi/v1/withdraw/clearance') {
      assert.equal(method, 'POST'); assert.equal(authorization, undefined);
      const value = parseStrictJson(data) as any; exact(value, ['nullifier']); parseField(value.nullifier);
    } else if (['/zkapi/v1/config', '/zkapi/v1/catalog', '/zkapi/v1/attestation', '/zkapi/v1/tariffs/' + tariff.tariff_hash].includes(path)) {
      assert.equal(method, 'GET'); assert.equal(authorization, undefined); assert.equal(data.length, 0);
    } else {
      const route = new RegExp(`^/zkapi/v1/sessions/(${uuidPattern})(?:(/close)|(/receipts)(?:\\?cursor=([1-9][0-9]{0,18}))?|(/operations/${uuidPattern}))?$`).exec(path);
      assert.ok(route); authToken(authorization, route[1]); headers.authorization = authorization!;
      assert.equal(method, route[2] ? 'POST' : 'GET'); assert.equal(data.length, 0);
      if (route[4]) assert.ok(BigInt(route[4]) <= 0x7fffffffffffffffn);
    }
    return forward(path, method, headers, data.length ? data : undefined);
  };
}

export interface BrowserChatDevnetHostConfig {
  port: number; output: string; profilePath: string; profileSha256: string;
  manifestPath: string; wasmPath: string; artifacts: Record<string, string>;
  rpcUrl: string; historyRpcUrl?: string; indexerUrl: string; controlUrl: string; localCaPath?: string;
  allowTransactions: boolean;
  budget: {planPath: string; stateDir: string; caseId: 'openrouter-direct-plain' | 'openrouter-direct-sse'};
}

/** Fixed native forwarding; bounded bytes and time, no redirects, environment
 * proxy, retry, cookies, provider inference, or upstream error logging. */
export function localForwarder(ca?: Buffer) {
  return async (url: string, method: 'GET' | 'POST', data?: Buffer, headers: Record<string, string> = {}, maximum = 4 * 1024 * 1024): Promise<UpstreamReply> => {
    const target = new URL(url), local = ['127.0.0.1', '[::1]'].includes(target.hostname);
    assert.ok(!target.username && !target.password && !target.hash && (target.protocol === 'https:' || target.protocol === 'http:' && local));
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => request.destroy(), 60_000);
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method, agent: false, ...(local && ca ? {ca} : {}),
        headers: {...(data ? {'content-type': 'application/json', 'content-length': String(data.length)} : {}), accept: 'application/json', ...headers},
      }, response => {
        const parts: Buffer[] = []; let size = 0;
        response.on('data', part => {
          size += part.length;
          if (size > maximum) { response.destroy(); request.destroy(); fail(Error('configured upstream response unavailable')); }
          else parts.push(Buffer.from(part));
        });
        response.on('end', () => { clearTimeout(timer); ok({status: response.statusCode ?? 502, bytes: Buffer.concat(parts)}); });
        response.on('error', () => { clearTimeout(timer); fail(Error('configured upstream response unavailable')); });
      });
      request.on('error', () => { clearTimeout(timer); fail(Error('configured upstream unavailable')); }); request.end(data);
    });
  };
}

export async function loadBrowserChatBudget(config: BrowserChatDevnetHostConfig['budget'], manifest: VerifiedManifest, tariff: Tariff, model: string,
  allowTransactions: boolean): Promise<DirectDemoBudget & {status(): Promise<UiDirectProviderBudget>}> {
  assert.ok(['openrouter-direct-plain', 'openrouter-direct-sse'].includes(config.caseId));
  const planPath = resolve(config.planPath), stateDir = resolve(config.stateDir), plan = parseStrictJson(await readFile(planPath)) as any;
  const planSha256 = await sha256Hex(jcsBytes(plan));
  const cases = plan.cases.filter((c: any) => c.id === config.caseId); assert.equal(cases.length, 1);
  const selected = cases[0]; assert.ok(selected.mode === 'direct_openrouter' && selected.provider === 'openrouter'
    && selected.model === model && selected.endpoint === 'chat_completions' && !selected.tools
    && uint(selected.max_cost_micro_usdc) >= uint(manifest.cap_micro_usdc) && selected.session_ttl_seconds >= 60);
  assert.ok(plan.models.some((m: any) => same(m.tariff, tariff)));
  const coordinator = async (command: 'budget-status' | 'reserve-direct-demo', requestId?: string, digest?: string) => {
    const env: NodeJS.ProcessEnv = {}; for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
    const args = [join(ROOT, 'scripts/provider_demo_budget.py'), command, '--plan', planPath, '--state-dir', stateDir,
      ...(command === 'reserve-direct-demo' ? ['--case', config.caseId, '--request-id', requestId!, '--authorization-sha256', digest!] : [])];
    try {
      const result = await execute('python3', args, {cwd: ROOT, env, timeout: 30_000, maxBuffer: 1_048_576});
      return parseStrictJson(Buffer.from(result.stdout)) as any;
    } catch { throw Error('provider campaign unavailable'); }
  };
  const identity = {schema: 1, campaign_id: plan.campaign_id, plan_sha256: planSha256,
    budget_micro_usdc: plan.budget_micro_usdc, max_requests: plan.max_requests};
  const status = async (): Promise<UiDirectProviderBudget> => {
    const value = await coordinator('budget-status'); assert.ok(same(value.identity, identity));
    const total = uint(identity.budget_micro_usdc), reserved = uint(value.reserved_micro_usdc), remaining = uint(value.remaining_micro_usdc);
    const cost = uint(selected.max_cost_micro_usdc);
    assert.ok(total <= 10_000_000n && reserved + remaining === total && cost > 0n
      && value.refunds_supported === false && value.inference_replays_supported === false
      && Number.isSafeInteger(identity.max_requests) && identity.max_requests > 0 && identity.max_requests <= 1000
      && Array.isArray(value.reservations) && value.reservations.length <= identity.max_requests);
    const count = value.reservations.length, slots = identity.max_requests - count;
    return {schema: 1, allowTransactions, budget_micro_usdc: total.toString(), reserved_micro_usdc: reserved.toString(),
      remaining_micro_usdc: remaining.toString(), max_requests: identity.max_requests, reserved_requests: count,
      remaining_requests: slots, request_max_cost_micro_usdc: cost.toString(), available_requests: allowTransactions ? Math.min(slots, Number(remaining / cost)) : 0};
  };
  await status();
  return {status, async reserve(requestId, authorizationSha256) {
    assert.ok(uuid.test(requestId) && hash.test(authorizationSha256));
    const reservation = await coordinator('reserve-direct-demo', requestId, authorizationSha256);
    assert.ok(reservation.auth_forward_allowed === true && reservation.request_id === requestId
      && reservation.authorization_sha256 === authorizationSha256 && reservation.template_case_id === config.caseId
      && reservation.plan_sha256 === planSha256 && reservation.reserved_micro_usdc === selected.max_cost_micro_usdc);
  }};
}

export async function configuredBrowserChatHost(config: BrowserChatDevnetHostConfig) {
  assert.ok(Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535 && typeof config.allowTransactions === 'boolean');
  assert.match(config.profileSha256, hash);
  const publicBytes = await readFile(config.profilePath); assert.equal(await sha256Hex(publicBytes), config.profileSha256);
  const profile = parseReviewedDevnetProfile(publicBytes);
  const manifestBytes = await readFile(config.manifestPath), manifest = await verifyManifest(manifestBytes, profile.trust);
  assert.ok(manifest.deployment_environment === 'devnet' && manifest.genesis_hash === GENESIS && manifest.mint === '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
  const build = parseStrictJson(await readFile(join(config.output, 'profile-build.json'))) as any;
  exact(build, ['schema', 'profileSha256', 'assets']); assert.equal(build.schema, 1); assert.equal(build.profileSha256, config.profileSha256);
  exact(build.assets, ['index.html', 'styles.css', 'app.js', 'integration.js', 'worker.js']);
  const assets = new Map<string, {bytes: Buffer; mime: string}>();
  for (const [name, digest] of Object.entries(build.assets)) {
    const bytes = await readFile(join(config.output, name)); assert.equal(await sha256Hex(bytes), digest);
    assets.set(name === 'index.html' ? '/' : '/' + name, {bytes, mime: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'});
  }
  const wasm = await readFile(config.wasmPath); assert.equal(await sha256Hex(wasm), profile.wasmSha256);
  const digests: Record<string, string> = {idl: manifest.idl_hash, requestPk: manifest.request_pk_hash, requestVk: manifest.request_vk_hash,
    withdrawalPk: manifest.withdrawal_pk_hash, withdrawalVk: manifest.withdrawal_vk_hash, treePk: manifest.tree_proof_artifacts.pk_hash,
    treeVk: manifest.tree_proof_artifacts.vk_hash, treeSourceBundle: manifest.tree_proof_artifacts.source_bundle_hash,
    treeVerifierConstants: manifest.tree_proof_artifacts.verifier_constants_hash,
    ...Object.fromEntries(Object.entries(manifest.artifact_digests).map(([name, digest]) => ['additional:' + name, digest]))};
  assert.deepEqual(Object.keys(config.artifacts).sort(), Object.keys(digests).sort());
  for (const [name, path] of Object.entries(config.artifacts)) {
    const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink());
    const bytes = await readFile(path); assert.equal(await sha256Hex(bytes), digests[name]);
    assets.set('/artifacts/' + encodeURIComponent(name), {bytes, mime: 'application/octet-stream'});
  }
  assets.set('/manifest', {bytes: manifestBytes, mime: 'application/json'}); assets.set('/wasm', {bytes: wasm, mime: 'application/wasm'});
  const rpcUrl = new URL(config.rpcUrl); assert.ok(rpcUrl.protocol === 'https:' && !rpcUrl.username && !rpcUrl.password && !rpcUrl.hash);
  if (config.historyRpcUrl) { const u = new URL(config.historyRpcUrl); assert.ok(u.protocol === 'https:' && !u.username && !u.password && !u.hash); }
  for (const value of [config.indexerUrl, config.controlUrl]) {
    const u = new URL(value); assert.ok(value === u.origin && ['127.0.0.1', '[::1]'].includes(u.hostname)
      && ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password);
  }
  assert.equal(profile.models.length, 1);
  const model = profile.models[0], budget = await loadBrowserChatBudget(config.budget, manifest, model.tariff, model.id, config.allowTransactions);
  const forward = localForwarder(config.localCaPath ? await readFile(config.localCaPath) : undefined);
  return startUiHost({port: config.port, output: config.output, application: 'browser-chat', directProviderOrigin: 'https://openrouter.ai',
    assets, manifest, allowTransactions: config.allowTransactions, preparationCommitment: profile.preparationCommitment,
    directBudget: budget.status,
    rpc: data => forward(config.rpcUrl, 'POST', data),
    ...(config.historyRpcUrl ? {historyRpc: (data: Buffer) => forward(config.historyRpcUrl!, 'POST', data)} : {}),
    indexer: path => forward(config.indexerUrl + path, 'GET', undefined, {}, path.startsWith('/zkapi/v1/tree/snapshots/') ? 4 * 1024 * 1024 : 65536),
    controlRelay: directControlRelay({manifest, tariff: model.tariff, budget,
      forward: (path, method, headers, data) => forward(config.controlUrl + path, method, data,
        {...headers, host: new URL(manifest.control_api_origin).host}, 65536)})});
}

async function main() {
  const args = process.argv.slice(2); assert.ok(args.length === 2 && args[0] === '--config');
  const info = await lstat(args[1]); assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0);
  const config = parseStrictJson(await readFile(args[1])) as unknown as BrowserChatDevnetHostConfig;
  const host = await configuredBrowserChatHost(config);
  console.log(JSON.stringify({origin: host.origin, application: 'browser-chat', mode: 'direct_openrouter', transaction_sends_enabled: config.allowTransactions}));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (!stopping) {stopping = true; void host.close().then(() => process.exit(0));}
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {console.error('Browser chat host startup failed; private inputs suppressed.'); process.exitCode = 1;});
}
