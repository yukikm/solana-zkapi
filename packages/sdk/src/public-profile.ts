/** Authenticated public Devnet configuration. Loading/preflight never opens
 * custody, signs, submits AUTH, requests a quote, or sends inference. */
import { address } from '@solana/kit';
import { loadDeploymentAssets, type LoadedDeploymentAssets } from './deployment.ts';
import { validateModelConfigurations, type ClientDeployment, type CreateClientOptions, type ModelConfiguration, type Mode } from './client.ts';
import { inspectSessionSnapshot } from './session-snapshot.ts';
import { createSolanaRpcWithFetch } from './solana.ts';
import { decodeRpcAccount } from './solana-rpc.ts';
import { jcsBytes, parseStrictJson, sha256Hex, verifyArtifactBundle, verifyManifest, verifyPoolConfig, type VerifiedManifest } from './trust.ts';

export const PUBLIC_PROFILE_SCHEMA = 1;
export const PUBLIC_PROFILE_SDK_VERSION = '0.2.0-devnet.8';
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MAX_RESPONSE = 4 * 1024 * 1024;
export interface PublicDeploymentProfile {
  schema: 1;
  id: string;
  revision: number;
  sdkVersions: readonly string[];
  protocolLayoutVersion: 2;
  bundle: { url: string; sha256: string };
  rpcUrl: string;
  indexerOrigin: string;
  mode: Mode;
  models: readonly ModelConfiguration[];
  modelCapabilities: Readonly<Record<string, { streaming: boolean; tools: boolean }>>;
  directProviderBases?: CreateClientOptions['directProviderBases'];
  oaVerifier?: CreateClientOptions['oaVerifier'];
  preparationCommitment?: 'confirmed' | 'finalized';
}
export interface LoadedPublicDeploymentProfile {
  readonly profile: PublicDeploymentProfile;
  readonly profileSha256: string;
  readonly assets: LoadedDeploymentAssets;
  readonly deployment: ClientDeployment;
}
export interface PublicProfileOptions {
  /** SHA-256 of exact profile bytes from an independently authenticated release. */
  profileSha256: string;
  /** Persist this with app configuration BEFORE creating custody. Reopening an
   * existing namespace requires the same digest, including during recovery. */
  installedProfileSha256?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export type PublicProfileComponent = 'profile' | 'compatibility' | 'assets' | 'models' | 'rpc' | 'pool' | 'control' | 'catalog' | 'snapshot';
export class PublicProfileError extends Error {
  readonly component: PublicProfileComponent;
  constructor(component: PublicProfileComponent) {
    super(`Public deployment ${component} verification failed.`);
    this.name = 'PublicProfileError'; this.component = component;
  }
}
const loadedProfiles = new WeakMap<LoadedPublicDeploymentProfile, { profile: PublicDeploymentProfile; assets: LoadedDeploymentAssets; fetcher: typeof fetch; hash: string }>();
function requireValue(value: unknown): asserts value { if (!value) throw Error('invalid public input'); }
function object(value: unknown): asserts value is Record<string, any> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, any> {
  object(value); requireValue(required.every(key => Object.hasOwn(value,key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function digest(value: unknown): asserts value is string { requireValue(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)); }
/** This public profile format carries no credentials. It does not discover DNS
 * trust; reviewers still authenticate the selected HTTPS service owners. */
function publicUrl(value: unknown, origin = false): string {
  requireValue(typeof value === 'string' && value.length <= 2048);
  const u = new URL(value), h = u.hostname.toLowerCase();
  requireValue(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash);
  requireValue(h.includes('.') && !h.endsWith('.') && !['localhost', 'local', 'internal', 'invalid'].some(s => h === s || h.endsWith('.'+s)));
  // No literal-address/private loopback deployments in the public distribution format.
  requireValue(!h.startsWith('[') && !/^\d+(?:\.\d+){3}$/.test(h));
  requireValue(origin ? u.origin === value : u.href === value);
  return value;
}
function uint(value: unknown): bigint {
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20 && BigInt(value) <= 0xffffffffffffffffn);
  return BigInt(value);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
}
function validateProfile(value: unknown): PublicDeploymentProfile {
  fields(value, ['schema','id','revision','sdkVersions','protocolLayoutVersion','bundle','rpcUrl','indexerOrigin','mode','models','modelCapabilities'],
    ['directProviderBases','oaVerifier','preparationCommitment']);
  requireValue(value.schema === 1 && typeof value.id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value.id)
    && Number.isSafeInteger(value.revision) && value.revision > 0);
  requireValue(Array.isArray(value.sdkVersions) && value.sdkVersions.length > 0 && value.sdkVersions.length <= 16
    && value.sdkVersions.every((v: unknown) => typeof v === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(v))
    && new Set(value.sdkVersions).size === value.sdkVersions.length);
  if (!value.sdkVersions.includes(PUBLIC_PROFILE_SDK_VERSION) || value.protocolLayoutVersion !== 2) throw new PublicProfileError('compatibility');
  fields(value.bundle,['url','sha256']); publicUrl(value.bundle.url); digest(value.bundle.sha256);
  publicUrl(value.rpcUrl); publicUrl(value.indexerOrigin,true);
  requireValue(value.preparationCommitment === undefined || ['finalized','confirmed'].includes(value.preparationCommitment));
  requireValue(Array.isArray(value.models) && value.models.length > 0 && value.models.length <= 32);
  fields(value.modelCapabilities, value.models.map((m: any) => m?.id));
  for (const m of value.models) {
    fields(m,['id','provider','apis','tariff'],['label']);
    requireValue(m.label === undefined || typeof m.label === 'string' && m.label.length > 0 && m.label.length <= 160 && !/[\x00-\x1f\x7f]/.test(m.label));
    requireValue(Array.isArray(m.apis));
    const capabilities = value.modelCapabilities[m.id]; fields(capabilities,['streaming','tools']);
    requireValue(typeof capabilities.streaming === 'boolean' && typeof capabilities.tools === 'boolean');
    const t = m.tariff;
    fields(t,['tariff_hash','version','provider','model','pricing_basis','valid_from','valid_until','rates','operator_fee_micro_usdc']);
    digest(t.tariff_hash); requireValue(uint(t.version) > 0n && uint(t.valid_until) > uint(t.valid_from) && t.operator_fee_micro_usdc === '0');
    requireValue(Array.isArray(t.rates) && t.rates.length <= 6);
    const units = ['cache_read_tokens','cache_write_1h_tokens','cache_write_5m_tokens','cache_write_tokens','input_tokens','output_tokens'];
    let previous = '';
    for (const rate of t.rates) {
      fields(rate,['unit','nano_usdc_numerator','unit_denominator']);
      requireValue(units.includes(rate.unit) && rate.unit > previous && uint(rate.nano_usdc_numerator) <= 0x7fffffffffffffffn
        && uint(rate.unit_denominator) > 0n && uint(rate.unit_denominator) <= 0x7fffffffffffffffn); previous = rate.unit;
    }
    const selected = t.rates.map((r: any) => r.unit);
    requireValue(!selected.includes('cache_write_tokens') || !selected.some((u: string) => u === 'cache_write_1h_tokens' || u === 'cache_write_5m_tokens'));
    requireValue(value.mode === 'proxy' ? selected.includes('input_tokens') && selected.includes('output_tokens') : t.rates.length === 0);
  }
  validateModelConfigurations(value.mode, value.models);
  if (value.mode === 'proxy') requireValue(value.directProviderBases === undefined && value.oaVerifier === undefined);
  else {
    fields(value.directProviderBases,[value.mode]); publicUrl(value.directProviderBases[value.mode]);
    requireValue(!value.directProviderBases[value.mode].endsWith('/'));
    if (value.mode === 'direct_oa') {
      fields(value.oaVerifier,['base','stationId']); publicUrl(value.oaVerifier.base);
      requireValue(!value.oaVerifier.base.endsWith('/') && typeof value.oaVerifier.stationId === 'string' && /^[\x21-\x7e]{1,200}$/.test(value.oaVerifier.stationId));
    } else requireValue(value.oaVerifier === undefined);
  }
  return deepFreeze(value as PublicDeploymentProfile);
}
async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); throw Error('aborted'); }
  let stop!: () => void;
  const aborted = new Promise<never>((_resolve,reject) => { stop = () => reject(Error('aborted')); signal.addEventListener('abort',stop,{once:true}); });
  try { return await Promise.race([pending,aborted]); } finally { signal.removeEventListener('abort',stop); }
}
async function responseBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    requireValue(response.ok && response.body);
    const length = response.headers.get('content-length');
    requireValue(length === null || /^[0-9]+$/.test(length) && Number(length) <= limit);
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const r = await abortable(reader.read(),signal); if (r.done) break; size += r.value.length; requireValue(size <= limit); chunks.push(r.value); }
    const bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk,at); at += chunk.length; } return bytes;
  } finally { if (reader) { void reader.cancel().catch(()=>{}); reader.releaseLock(); } else void response.body?.cancel().catch(()=>{}); }
}
async function fetchBytes(fetcher: typeof fetch, url: string, signal: AbortSignal, limit: number, init: RequestInit = {}): Promise<Uint8Array> {
  signal.throwIfAborted();
  const pending = fetcher(url,{...init,credentials:'omit',redirect:'error',cache:'no-store',signal});
  void pending.then(r => { if (signal.aborted) void r.body?.cancel().catch(()=>{}); },()=>{});
  return responseBytes(await abortable(pending,signal),limit,signal);
}
function deadline(timeoutMs: number | undefined, caller: AbortSignal | undefined, fallback: number) {
  const timeout = timeoutMs ?? fallback; requireValue(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 300_000);
  const controller = new AbortController(), signal = caller ? AbortSignal.any([caller,controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(),timeout); return {signal,close:()=>clearTimeout(timer)};
}
function cloneAssets(a: LoadedDeploymentAssets): LoadedDeploymentAssets {
  return {...a,manifest:new Uint8Array(a.manifest),trust:structuredClone(a.trust),artifacts:structuredClone(a.artifacts),wasm:new Uint8Array(a.wasm),notices:structuredClone(a.notices)};
}
function clientParts(profile: PublicDeploymentProfile, assets: LoadedDeploymentAssets, fetcher: typeof fetch): Pick<CreateClientOptions,'deployment'|'mode'|'models'|'directProviderBases'|'oaVerifier'> {
  const safeFetch: typeof fetch = (url,init) => fetcher(url,{...init,credentials:'omit',redirect:'error',cache:'no-store'});
  const rpcFetch: typeof fetch = async (url,init) => {
    const bound = deadline(30_000,init?.signal ?? undefined,30_000);
    try { return new Response(new Uint8Array(await fetchBytes(fetcher,String(url),bound.signal,MAX_RESPONSE,init))); }
    catch { throw new PublicProfileError('rpc'); }
    finally { bound.close(); }
  };
  return {deployment:{manifest:new Uint8Array(assets.manifest),trust:structuredClone(assets.trust),artifacts:structuredClone(assets.artifacts),
    connection:createSolanaRpcWithFetch(profile.rpcUrl,rpcFetch),indexerOrigin:profile.indexerOrigin,fetch:safeFetch,preparationCommitment:profile.preparationCommitment},
  mode:profile.mode,models:profile.models.map(m => ({...structuredClone(m),capabilities:structuredClone(profile.modelCapabilities[m.id])})),
  ...(profile.directProviderBases ? {directProviderBases:structuredClone(profile.directProviderBases)} : {}),
  ...(profile.oaVerifier ? {oaVerifier:structuredClone(profile.oaVerifier)} : {})};
}
async function validateAssets(profile: PublicDeploymentProfile, assets: LoadedDeploymentAssets): Promise<VerifiedManifest> {
  const m = await verifyManifest(assets.manifest,assets.trust);
  requireValue(m.deployment_environment === 'devnet' && m.genesis_hash === DEVNET_GENESIS && m.mint === DEVNET_USDC
    && m.token_program === TOKEN_PROGRAM && m.protocol_layout_version === profile.protocolLayoutVersion);
  requireValue(m.transaction_formats.every(f => f === 'v0_buffer' || f === 'v0_inline_deposit_v1'));
  publicUrl(m.control_api_origin,true); publicUrl(m.inference_api_origin,true); publicUrl(m.proving_keys_base_url);
  await verifyArtifactBundle(m,assets.artifacts);
  requireValue(await sha256Hex(assets.wasm) === assets.wasmSha256 && WebAssembly.validate(new Uint8Array(assets.wasm)));
  return m;
}
async function validateModelPins(profile: PublicDeploymentProfile, manifest: VerifiedManifest, now?: bigint) {
  for (const model of profile.models) {
    const {tariff_hash,...body} = model.tariff;
    requireValue(manifest.tariff_hashes.includes(tariff_hash) && await sha256Hex(jcsBytes(body)) === tariff_hash);
    if (now !== undefined) requireValue(now >= BigInt(model.tariff.valid_from) && now < BigInt(model.tariff.valid_until));
  }
}
/** A profile's exact digest authenticates its bundle digest and therefore the
 * bundle's existing ManifestTrustPolicy. No trust key is learned from /config. */
export async function loadPublicDeploymentProfile(url: string | URL, options: PublicProfileOptions): Promise<LoadedPublicDeploymentProfile> {
  let component: PublicProfileComponent = 'profile', bound: ReturnType<typeof deadline> | undefined;
  try {
    const expected = options.profileSha256; digest(expected); publicUrl(String(url));
    if (options.installedProfileSha256 !== undefined) { digest(options.installedProfileSha256); requireValue(options.installedProfileSha256 === expected); }
    const fetcher = options.fetch ?? fetch; bound = deadline(options.timeoutMs,options.signal,180_000);
    const bytes = await fetchBytes(fetcher,String(url),bound.signal,1024*1024,{method:'GET'});
    requireValue(await sha256Hex(bytes) === expected);
    const profile = validateProfile(parseStrictJson(bytes)); component = 'assets';
    const assets = await loadDeploymentAssets(profile.bundle.url,{bundleSha256:profile.bundle.sha256,fetch:fetcher,signal:bound.signal,timeoutMs:options.timeoutMs ?? 180_000});
    const manifest = await validateAssets(profile,assets); component = 'models'; await validateModelPins(profile,manifest);
    bound.signal.throwIfAborted();
    const stored = {profile,assets:cloneAssets(assets),fetcher,hash:expected};
    const result = Object.freeze({profile,profileSha256:expected,get assets() { return cloneAssets(stored.assets); },
      get deployment() { return clientParts(profile,stored.assets,fetcher).deployment; }});
    loadedProfiles.set(result,stored); return result;
  } catch (error) { throw error instanceof PublicProfileError ? error : new PublicProfileError(component); }
  finally { bound?.close(); }
}
export function publicProfileClientOptions(loaded: LoadedPublicDeploymentProfile) {
  const stored = loadedProfiles.get(loaded); if (!stored) throw new PublicProfileError('profile');
  return clientParts(stored.profile,stored.assets,stored.fetcher);
}
export interface PublicPreflightOptions { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; nowSeconds?: bigint }
export interface PublicPreflightResult {
  profileId: string; profileSha256: string; deploymentId: string; pool: string; manifestHash: string;
  slot: string; paused: boolean; chainAllowsNewOperations: boolean; operatorAdmission: 'unverified'; models: readonly string[];
  snapshot: Awaited<ReturnType<typeof inspectSessionSnapshot>>;
  checks: readonly string[];
}
/** Read-only: exact config/catalog GETs, shared snapshot GETs and an allowlist of
 * finalized RPC reads. No wallet/prover/custody or provider requests occur. */
export async function preflightPublicDeployment(loaded: LoadedPublicDeploymentProfile, options: PublicPreflightOptions = {}): Promise<PublicPreflightResult> {
  let component: PublicProfileComponent = 'profile', bound: ReturnType<typeof deadline> | undefined;
  try {
    const stored = loadedProfiles.get(loaded); requireValue(stored);
    const {profile,assets} = stored, fetcher = options.fetch ?? stored.fetcher;
    bound = deadline(options.timeoutMs,options.signal,60_000); const signal = bound.signal;
    component = 'assets'; const m = await validateAssets(profile,assets);
    const now = options.nowSeconds ?? BigInt(Math.floor(Date.now()/1000)); requireValue(typeof now === 'bigint' && now >= 0n);
    component = 'models'; await validateModelPins(profile,m,now);
    const readonlyFetch: typeof fetch = async (input,init) => {
      const url = String(input), method = init?.method ?? 'GET';
      if (url === profile.rpcUrl) {
        requireValue(method === 'POST' && typeof init?.body === 'string');
        const request: unknown = parseStrictJson(new TextEncoder().encode(init.body)); object(request);
        requireValue(['getGenesisHash','getAccountInfo','getMultipleAccounts','getBlock'].includes(request.method));
      } else requireValue(method === 'GET' && (url === m.control_api_origin+'/zkapi/v1/config' || url === m.control_api_origin+'/zkapi/v1/catalog'
        || url === profile.indexerOrigin+'/zkapi/v1/tree/snapshot'
        || url.startsWith(profile.indexerOrigin+'/zkapi/v1/tree/snapshots/') && /^[0-9a-f]{64}\.json$/.test(url.slice((profile.indexerOrigin+'/zkapi/v1/tree/snapshots/').length))));
      const mergedSignal = init?.signal ? AbortSignal.any([signal,init.signal]) : signal;
      const bytes = await fetchBytes(fetcher,url,mergedSignal,MAX_RESPONSE,init); return new Response(new Uint8Array(bytes),{status:200});
    };
    const rpc = createSolanaRpcWithFetch(profile.rpcUrl,readonlyFetch);
    component = 'rpc'; const genesis = await abortable(rpc.getGenesisHash().send(),signal); requireValue(genesis === m.genesis_hash);
    component = 'pool'; const observed = await abortable(rpc.getAccountInfo(address(m.pool),{commitment:'finalized',encoding:'base64'}).send(),signal);
    const a = decodeRpcAccount(observed.value); requireValue(a);
    const checked = await verifyPoolConfig(m,genesis,{address:m.pool,owner:a.owner,executable:a.executable,lamports:BigInt(a.lamports),data:a.data,
      slot:BigInt(observed.context.slot),commitment:'finalized'},BigInt(observed.context.slot));
    component = 'control';
    const serverManifest = await verifyManifest(await responseBytes(await readonlyFetch(m.control_api_origin+'/zkapi/v1/config'),1024*1024,signal),assets.trust);
    requireValue(serverManifest.manifest_hash === m.manifest_hash);
    component = 'catalog'; const catalog: unknown = parseStrictJson(await responseBytes(await readonlyFetch(m.control_api_origin+'/zkapi/v1/catalog'),1024*1024,signal));
    fields(catalog,['models']); requireValue(Array.isArray(catalog.models) && catalog.models.length <= 256);
    const apiPaths = {chat:'/v1/chat/completions',responses:'/v1/responses',messages:'/v1/messages'};
    for (const model of profile.models) requireValue(catalog.models.some((entry: any) => entry && entry.model === (profile.mode === 'proxy' ? model.id : '*')
      && entry.provider === model.provider && entry.tariff_hash === model.tariff.tariff_hash && Array.isArray(entry.modes) && entry.modes.includes(profile.mode)
      && Array.isArray(entry.modalities) && entry.modalities.includes('text')
      && (profile.mode !== 'proxy' || Array.isArray(entry.endpoints) && model.apis.every(api => entry.endpoints.includes(apiPaths[api])))));
    component = 'snapshot';
    requireValue(checked.slot <= BigInt(Number.MAX_SAFE_INTEGER));
    const snapshot = await abortable(inspectSessionSnapshot(rpc,m,profile.indexerOrigin,readonlyFetch,Number(checked.slot)),signal);
    const skew = now-BigInt(snapshot.clock); requireValue(skew >= -120n && skew <= 120n);
    signal.throwIfAborted();
    return {profileId:profile.id,profileSha256:stored.hash,deploymentId:m.deployment_id,pool:m.pool,manifestHash:m.manifest_hash,slot:String(snapshot.slot),
      paused:snapshot.paused,chainAllowsNewOperations:!snapshot.paused,operatorAdmission:'unverified',models:profile.models.map(v=>v.id),snapshot,
      checks:['profile','assets','manifest','tariffs','genesis','finalized_pool','control_config','catalog','shared_snapshot','chain_clock']};
  } catch (error) { throw error instanceof PublicProfileError ? error : new PublicProfileError(component); }
  finally { bound?.close(); }
}
