/** App-owned public asset loader. Trust pins are compiled into the app separately. */
import { Connection, PublicKey } from '@solana/web3.js';
import type { ArtifactBundle, ClientDeployment, CreateClientOptions, ManifestTrustPolicy, ModelConfiguration, Mode } from '@zkapi/solana-sdk';
import { parseStrictJson } from '@zkapi/solana-sdk/trust';

export interface ReviewedBrowserProfile {
  trust: ManifestTrustPolicy;
  manifestUrl: string;
  artifacts: Record<Exclude<keyof ArtifactBundle, 'additional'>, string> & { additional: Record<string, string> };
  wasmUrl: string;
  wasmSha256: string;
  models: readonly ModelConfiguration[];
  /** Public RPC endpoint or an app-owned relay; never embed a private RPC credential. */
  rpcUrl: string;
  indexerOrigin: string;
  directProviderBases?: CreateClientOptions['directProviderBases'];
  oaVerifier?: CreateClientOptions['oaVerifier'];
  /** App-owned loopback transport; logical trust origins remain unchanged. */
  relay?: { kind: 'same_origin_devnet' };
  preparationCommitment?: 'confirmed' | 'finalized';
}
/** One independently reviewed route. Selection is explicit; failures never change it. */
export interface ReviewedChatProfile extends ReviewedBrowserProfile {
  id: string;
  label: string;
  chain: 'solana:devnet';
  mode: Mode;
}
export interface DevnetAdmission {
  schema: 1; allowTransactions: boolean;
  budget_micro_usdc: string; reserved_micro_usdc: string; remaining_micro_usdc: string;
  reserved_requests: number; max_requests: number; remaining_requests: number;
  request_max_cost_micro_usdc: string; available_requests: number;
}

const RPC = 'https://rpc.zkapi.invalid', INDEXER = 'https://indexer.zkapi.invalid';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const ARTIFACTS = ['idl', 'requestPk', 'requestVk', 'withdrawalPk', 'withdrawalVk', 'treePk', 'treeVk', 'treeSourceBundle', 'treeVerifierConstants'];
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
function requireProfile(value: unknown): asserts value { if (!value) throw new Error('Invalid reviewed devnet profile'); }
function fields(value: any, required: string[], optional: string[] = []) {
  requireProfile(value && typeof value === 'object' && !Array.isArray(value));
  requireProfile(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)));
}
function digest(value: unknown) { requireProfile(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)); }
function publicKey(value: unknown) {
  requireProfile(typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value));
  requireProfile(new PublicKey(value).toBase58() === value);
}
function origin(value: unknown) {
  requireProfile(typeof value === 'string'); const url = new URL(value);
  requireProfile(url.origin === value && url.protocol === 'https:' && !url.username && !url.password);
}
/** Build-time JSON has a closed public schema. Never feed a private host config
 * into the browser bundle. Cryptographic verification still happens in the SDK. */
export function parseReviewedDevnetProfile(bytes: Uint8Array): ReviewedChatProfile {
  const p = parseStrictJson(bytes) as any;
  fields(p, ['id', 'label', 'chain', 'mode', 'trust', 'manifestUrl', 'artifacts', 'wasmUrl', 'wasmSha256', 'models', 'rpcUrl', 'indexerOrigin', 'directProviderBases', 'relay'], ['preparationCommitment']);
  requireProfile(typeof p.id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(p.id));
  requireProfile(typeof p.label === 'string' && p.label.length > 0 && p.label.length <= 160 && !/[\x00-\x1f\x7f]/.test(p.label));
  requireProfile(p.chain === 'solana:devnet' && p.mode === 'direct_openrouter');
  fields(p.relay, ['kind']); requireProfile(p.relay.kind === 'same_origin_devnet');
  requireProfile(p.rpcUrl === RPC && p.indexerOrigin === INDEXER);
  fields(p.directProviderBases, ['direct_openrouter']); requireProfile(p.directProviderBases.direct_openrouter === OPENROUTER);
  requireProfile(p.preparationCommitment === undefined || ['confirmed', 'finalized'].includes(p.preparationCommitment));
  requireProfile(p.manifestUrl === '/manifest' && p.wasmUrl === '/wasm'); digest(p.wasmSha256);
  fields(p.artifacts, [...ARTIFACTS, 'additional']);
  for (const name of ARTIFACTS) requireProfile(p.artifacts[name] === '/artifacts/' + encodeURIComponent(name));
  requireProfile(p.artifacts.additional && typeof p.artifacts.additional === 'object' && !Array.isArray(p.artifacts.additional));
  requireProfile(Object.keys(p.artifacts.additional).length <= 64);
  for (const [name, url] of Object.entries(p.artifacts.additional)) {
    requireProfile(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(name));
    requireProfile(url === '/artifacts/' + encodeURIComponent('additional:' + name));
  }
  fields(p.trust, ['anchor', 'expected', 'build']);
  requireProfile(p.trust.anchor && ['hash', 'ed25519'].includes(p.trust.anchor.kind));
  if (p.trust.anchor.kind === 'hash') {fields(p.trust.anchor, ['kind', 'sha256']); digest(p.trust.anchor.sha256);}
  else {fields(p.trust.anchor, ['kind', 'publicKey']); publicKey(p.trust.anchor.publicKey);}
  const expected = p.trust.expected;
  fields(expected, ['deployment_id', 'deployment_environment', 'genesis_hash', 'program_id', 'pool', 'mint', 'token_program', 'control_api_origin', 'inference_api_origin']);
  requireProfile(typeof expected.deployment_id === 'string' && /^[a-zA-Z0-9_.-]{1,200}$/.test(expected.deployment_id));
  requireProfile(expected.deployment_environment === 'devnet' && expected.genesis_hash === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  for (const key of ['program_id', 'pool', 'mint', 'token_program']) publicKey(expected[key]);
  origin(expected.control_api_origin); origin(expected.inference_api_origin);
  requireProfile(new Set([RPC, INDEXER, new URL(OPENROUTER).origin, expected.control_api_origin, expected.inference_api_origin]).size === 5);
  const build = p.trust.build;
  fields(build, ['stateKey', 'clearanceKey', 'circuitProfileHash', 'idlHash', 'setupProfile'], ['transactionFormats', 'verifiedSetupTranscripts']);
  for (const key of ['stateKey', 'clearanceKey']) {
    fields(build[key], ['x', 'y']);
    for (const coordinate of ['x', 'y']) requireProfile(typeof build[key][coordinate] === 'string' && /^0x[0-9a-f]{64}$/.test(build[key][coordinate]));
  }
  digest(build.circuitProfileHash); digest(build.idlHash);
  requireProfile(['test_only', 'ceremony_verified'].includes(build.setupProfile));
  if (build.transactionFormats !== undefined) requireProfile(Array.isArray(build.transactionFormats) &&
    (JSON.stringify(build.transactionFormats) === '["v0_buffer"]' || JSON.stringify(build.transactionFormats) === '["v0_buffer","v0_inline_deposit_v1"]'));
  if (build.verifiedSetupTranscripts !== undefined) {
    fields(build.verifiedSetupTranscripts, ['request', 'withdrawal', 'tree']);
    for (const value of Object.values(build.verifiedSetupTranscripts)) if (value !== null) digest(value);
  }
  requireProfile(Array.isArray(p.models) && p.models.length > 0 && p.models.length <= 16);
  const modelIds = new Set<string>();
  for (const model of p.models) {
    fields(model, ['id', 'provider', 'apis', 'tariff'], ['label']);
    requireProfile(typeof model.id === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(model.id) && !modelIds.has(model.id)); modelIds.add(model.id);
    requireProfile(model.label === undefined || typeof model.label === 'string' && model.label.length <= 160 && !/[\x00-\x1f\x7f]/.test(model.label));
    requireProfile(model.provider === 'openrouter' && JSON.stringify(model.apis) === '["chat"]');
    const tariff = model.tariff;
    fields(tariff, ['tariff_hash', 'version', 'provider', 'model', 'pricing_basis', 'valid_from', 'valid_until', 'rates', 'operator_fee_micro_usdc']);
    digest(tariff.tariff_hash);
    requireProfile(tariff.version === '1' && tariff.provider === 'openrouter' && tariff.model === '*' && tariff.pricing_basis === 'provider_reported_usd'
      && tariff.operator_fee_micro_usdc === '0' && Array.isArray(tariff.rates) && tariff.rates.length === 0);
    for (const key of ['valid_from', 'valid_until']) requireProfile(typeof tariff[key] === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(tariff[key]));
    requireProfile(BigInt(tariff.valid_until) > BigInt(tariff.valid_from));
  }
  return p as ReviewedChatProfile;
}

/** One bounded app-owned routing adapter for both SDK HTTP and web3 RPC.
 * Provider traffic stays direct; no route can downgrade it to the relay. */
export function createDevnetRelayFetch(profile: ReviewedBrowserProfile, pageOrigin: string, fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  const p = structuredClone(profile), app = new URL(pageOrigin);
  requireProfile(app.origin === pageOrigin && app.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(app.hostname));
  requireProfile(p.relay?.kind === 'same_origin_devnet' && p.rpcUrl === RPC && p.indexerOrigin === INDEXER
    && p.directProviderBases?.direct_openrouter === OPENROUTER);
  const control = p.trust.expected.control_api_origin;
  origin(control); requireProfile(![RPC, INDEXER, new URL(OPENROUTER).origin].includes(control));
  const session = new RegExp(`^/zkapi/v1/sessions/${UUID}$`), close = new RegExp(`^/zkapi/v1/sessions/${UUID}/close$`);
  const receipts = new RegExp(`^/zkapi/v1/sessions/${UUID}/receipts$`), operation = new RegExp(`^/zkapi/v1/sessions/${UUID}/operations/${UUID}$`);
  const rpcMethods = new Set(['getGenesisHash', 'getLatestBlockhash', 'getBlockHeight', 'getBlockTime', 'getSlot', 'getBalance', 'getAccountInfo', 'getMultipleAccounts', 'getFeeForMessage', 'getSignatureStatuses', 'getTransaction', 'getBlock', 'sendTransaction']);
  return async (input, init = {}) => {
    // SDK and web3 use URL + init; reject Request/stream inputs instead of
    // silently dropping their headers/body or widening this transport contract.
    requireProfile(typeof input === 'string' || input instanceof URL);
    const url = new URL(String(input)), method = init.method ?? 'GET';
    requireProfile(!url.username && !url.password && !url.hash && ['GET', 'POST'].includes(method));
    let destination: string | undefined, timeout = 120_000;
    if (url.origin === RPC && url.pathname === '/' && !url.search && method === 'POST') {
      requireProfile(typeof init.body === 'string' && new TextEncoder().encode(init.body).length <= 16 * 1024);
      const request = parseStrictJson(new TextEncoder().encode(init.body)) as any;
      requireProfile(request && !Array.isArray(request) && request.jsonrpc === '2.0' && rpcMethods.has(request.method) && Array.isArray(request.params));
      destination = pageOrigin + '/rpc';
    } else if (url.origin === INDEXER && method === 'GET' && !url.search && /^\/zkapi\/v1\/tree\/(root|snapshot|snapshots\/[0-9a-f]{64}\.json|notes\/(0|[1-9][0-9]{0,9})\/(path|zero-path))$/.test(url.pathname)) {
      destination = pageOrigin + '/indexer' + url.pathname;
    } else if (url.origin === control) {
      const publicRead = ['/zkapi/v1/config', '/zkapi/v1/catalog', '/zkapi/v1/attestation'].includes(url.pathname)
        || /^\/zkapi\/v1\/tariffs\/[0-9a-f]{64}$/.test(url.pathname) || session.test(url.pathname) || operation.test(url.pathname);
      const read = method === 'GET' && ((!url.search && publicRead)
        || receipts.test(url.pathname) && (!url.search || /^\?cursor=[1-9][0-9]{0,18}$/.test(url.search)));
      const write = method === 'POST' && !url.search && (['/zkapi/v1/quotes', '/zkapi/v1/sessions', '/zkapi/v1/withdraw/clearance'].includes(url.pathname) || close.test(url.pathname));
      requireProfile(read || write); destination = pageOrigin + '/control' + url.pathname + url.search;
    } else if (url.href === OPENROUTER + '/chat/completions' && method === 'POST') {
      destination = url.href; timeout = 600_000;
    }
    requireProfile(destination);
    requireProfile(method !== 'GET' || init.body === undefined || init.body === null);
    return fetcher(destination, { ...init, method, credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  };
}
async function read(url: string, maximum: number, timeout = 120_000): Promise<Uint8Array> {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body) throw new Error('Public deployment asset unavailable');
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length;
      if (length > maximum) throw new Error('Public deployment asset exceeds size limit'); parts.push(item.value); }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
/** Public totals are an admission hint, never settlement or reservation authority. */
export function parseDevnetAdmission(bytes: Uint8Array): DevnetAdmission {
  const value = parseStrictJson(bytes, 4096) as any;
  fields(value, ['schema', 'allowTransactions', 'budget_micro_usdc', 'reserved_micro_usdc', 'remaining_micro_usdc',
    'reserved_requests', 'max_requests', 'remaining_requests', 'request_max_cost_micro_usdc', 'available_requests']);
  requireProfile(value.schema === 1 && typeof value.allowTransactions === 'boolean');
  for (const key of ['budget_micro_usdc', 'reserved_micro_usdc', 'remaining_micro_usdc', 'request_max_cost_micro_usdc'])
    requireProfile(typeof value[key] === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value[key]) && BigInt(value[key]) <= BigInt(Number.MAX_SAFE_INTEGER));
  for (const key of ['reserved_requests', 'max_requests', 'remaining_requests', 'available_requests'])
    requireProfile(Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1_000_000);
  requireProfile(BigInt(value.budget_micro_usdc) === BigInt(value.reserved_micro_usdc) + BigInt(value.remaining_micro_usdc));
  requireProfile(value.max_requests === value.reserved_requests + value.remaining_requests && BigInt(value.request_max_cost_micro_usdc) > 0n);
  const affordable = BigInt(value.remaining_micro_usdc) / BigInt(value.request_max_cost_micro_usdc);
  requireProfile(value.available_requests === (value.allowTransactions ? Number(affordable < BigInt(value.remaining_requests) ? affordable : BigInt(value.remaining_requests)) : 0));
  return value as DevnetAdmission;
}
export async function readDevnetAdmission(): Promise<DevnetAdmission> {
  const origin = new URL(globalThis.location.origin);
  requireProfile(origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname));
  return parseDevnetAdmission(await read('/provider-budget', 4096, 5000));
}
export async function loadDeployment(profile: ReviewedBrowserProfile) {
  const p = structuredClone(profile);
  const fetcher = p.relay ? createDevnetRelayFetch(p, globalThis.location.origin) : undefined;
  const manifest = await read(p.manifestUrl, 1024 * 1024);
  parseStrictJson(manifest); // fail early on malformed public JSON; factory authenticates it
  const artifacts: Record<string, Uint8Array> = {}, additional: Record<string, Uint8Array> = {};
  for (const [name, url] of Object.entries(p.artifacts)) {
    if (name === 'additional') continue;
    artifacts[name] = await read(url as string, 64 * 1024 * 1024);
  }
  for (const [name, url] of Object.entries(p.artifacts.additional)) additional[name] = await read(url, 64 * 1024 * 1024);
  const deployment: ClientDeployment = { manifest, trust: p.trust, artifacts: { ...artifacts, additional } as unknown as ArtifactBundle,
    connection: new Connection(p.rpcUrl, { commitment: 'finalized', disableRetryOnRateLimit: true, ...(fetcher ? { fetch: fetcher } : {}) }),
    indexerOrigin: p.indexerOrigin, ...(fetcher ? { fetch: fetcher } : {}), ...(p.preparationCommitment ? { preparationCommitment: p.preparationCommitment } : {}) };
  return { deployment, models: p.models, wasm: await read(p.wasmUrl, 64 * 1024 * 1024), wasmSha256: p.wasmSha256,
    directProviderBases: p.directProviderBases, oaVerifier: p.oaVerifier };
}
