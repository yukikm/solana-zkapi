/** Offline native configuration validation. This module reads pinned public
 * inputs only: it never opens financial storage, runs proof executables or
 * constructs a network transport. */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { validateClientConfiguration, validateClientSelectionPins, type GatewayConfiguration } from '@zkapi/solana-sdk';
import { validateGatewayConfiguration } from '@zkapi/solana-sdk/gateway';
import { apiOperationPath, type ApiService, type ApiTariff, type Mode, type Tariff } from '@zkapi/solana-sdk/control';
import { loadDaemonModels, type DaemonModelSource } from '@zkapi/solana-sdk/clientd-models';
import { parseStrictJson, sha256Hex, verifyManifest, verifyArtifactBundle,
  type ArtifactBundle, type ManifestTrustPolicy } from '@zkapi/solana-sdk/trust';
import type { TransactionPreparationCommitment } from '@zkapi/solana-sdk/transport';

export interface RuntimeConfig {
  manifest: string; policy: ManifestTrustPolicy;
  artifacts: Record<Exclude<keyof ArtifactBundle, 'additional'>, string> & { additional: Record<string, string> };
  verifier: { path: string; sha256: string }; prover: { path: string; sha256: string };
  journal: string; custody: string; note_id: string; mode: Mode;
  models: (string | DaemonModelSource)[]; tariff?: string;
  services?: { tariff: string }[]; gateway?: GatewayConfiguration; key_reuse_seconds?: number; settlement_wait_ms?: number;
  rpc: string; indexer: string; direct_provider_bases?: Partial<Record<'direct_oa' | 'direct_openrouter', string>>;
  preparation_commitment?: TransactionPreparationCommitment;
  oa_verifier?: { base: string; stationId: string };
}
export class ConfigurationError extends Error {
  readonly code: string; readonly status: 1 | 2; readonly field?: string;
  constructor(code: string, status: 1 | 2, field?: string) { super(code); this.code = code; this.status = status; this.field = field; }
}
const failure = (code: string, status: 1 | 2 = 2, field?: string): never => { throw new ConfigurationError(code, status, field); };
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function object(value: unknown, field: string): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failure('invalid_schema', 2, field);
}
function canonicalPath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value)) failure('unsafe_path', 2, field);
}
async function publicRead(path: unknown, field: string, limit = 1024 * 1024 * 1024): Promise<Uint8Array> {
  canonicalPath(path, field);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > limit || info.mode & 0o022 || await realpath(path) !== path) failure('unsafe_path', 2, field);
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    return failure('artifact_verification_failed', 1, field);
  }
}
function strict(bytes: Uint8Array, field: string, limit = 1024 * 1024): any {
  try { return parseStrictJson(bytes, limit); } catch { return failure('invalid_schema', 2, field); }
}
function networkBase(value: unknown, local: boolean, field: string): void {
  if (typeof value !== 'string') return failure('invalid_schema', 2, field);
  let url: URL;
  try { url = new URL(value); } catch { return failure('invalid_schema', 2, field); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = isIP(host) && (host === '::1' || /^127\./.test(host));
  if (url.username || url.password || url.search || url.hash || url.href.replace(/\/$/, '') !== value.replace(/\/$/, '')
    || url.pathname.includes('%') || !(url.protocol === 'https:' || local && loopback && url.protocol === 'http:')) failure('invalid_schema', 2, field);
}

export async function verifyNativeDistribution(path: string, expected: string): Promise<Record<string, string>> {
  if (!digest(expected)) failure('invalid_schema', 2, 'distribution-sha256');
  const bytes = await publicRead(path, 'distribution', 16 * 1024 * 1024);
  if (await sha256Hex(bytes) !== expected) failure('pin_mismatch', 1, 'distribution');
  const release = strict(bytes, 'distribution', 16 * 1024 * 1024); object(release, 'distribution'); object(release.files, 'distribution.files');
  if (release.schema !== 1 || !Object.keys(release.files).length) failure('invalid_schema', 2, 'distribution');
  const root = dirname(path), seen = new Set<string>();
  for (const [name, hash] of Object.entries(release.files)) {
    if (!digest(hash) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')
      || isAbsolute(name)) failure('invalid_schema', 2, 'distribution.files');
  }
  async function walk(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.mode & 0o022 || await realpath(directory) !== directory) failure('unsafe_path', 2, 'distribution');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (file === path) continue;
      const name = relative(root, file).split(sep).join('/');
      if (!Object.hasOwn(release.files, name)) failure('artifact_verification_failed', 1, 'distribution.files');
      if (await sha256Hex(await publicRead(file, 'distribution.files')) !== release.files[name]) failure('pin_mismatch', 1, 'distribution.files');
      seen.add(name);
    }
  }
  try { await walk(root); } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    failure('artifact_verification_failed', 1, 'distribution');
  }
  if (seen.size !== Object.keys(release.files).length) failure('artifact_verification_failed', 1, 'distribution.files');
  for (const name of ['bin/node', 'apps/clientd/runtime.ts', 'apps/clientd/runtime-config.ts', 'apps/clientd/runtime-delivery.ts', 'bin/zkapi-client-prover', 'bin/zkapi-client-verify']) {
    if (!seen.has(name)) failure('artifact_verification_failed', 1, 'distribution.files');
  }
  return release.files;
}

export async function validateRuntimeConfiguration(input: unknown, options: { requireCustody?: boolean } = {}) {
  object(input, 'runtime');
  const allowed = new Set(['manifest','policy','artifacts','verifier','prover','journal','custody','note_id','mode','models','tariff','services',
    'gateway','key_reuse_seconds','settlement_wait_ms','rpc','indexer','direct_provider_bases','preparation_commitment','oa_verifier']);
  if (Object.keys(input).some(key => !allowed.has(key)) || !Array.isArray(input.models)
    || input.services !== undefined && (!Array.isArray(input.services) || input.services.length > 64)) failure('invalid_schema', 2, 'runtime');
  const c = input as unknown as RuntimeConfig;
  // Materialized deployment inputs omit these until setup assigns a fresh
  // profile. Ordinary startup must validate all three before opening custody.
  if (options.requireCustody) {
    for (const field of ['journal','custody'] as const) canonicalPath(c[field], field);
    if (typeof c.note_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.note_id)) failure('invalid_schema', 2, 'note_id');
  }
  const bytes = await publicRead(c.manifest, 'manifest', 4 * 1024 * 1024);
  let m: Awaited<ReturnType<typeof verifyManifest>>;
  try { m = await verifyManifest(bytes, c.policy); } catch { return failure('artifact_verification_failed', 1, 'manifest'); }
  const models = c.models.length || !c.services?.length
    ? await loadDaemonModels(c, m.tariff_hashes, async path => strict(await publicRead(path, 'models.tariff', 1024 * 1024), 'models.tariff') as Tariff)
      .catch(error => { if (error instanceof ConfigurationError) throw error; return failure('invalid_tariff', 2, 'models'); }) : [];
  const services: ApiService[] = [];
  for (const service of c.services ?? []) {
    object(service, 'services');
    if (Object.keys(service).join(',') !== 'tariff') failure('invalid_schema', 2, 'services');
    services.push({ tariff: strict(await publicRead(service.tariff, 'services.tariff', 1024 * 1024), 'services.tariff') as ApiTariff });
  }
  try {
    validateClientConfiguration(c.mode, models, services);
    if (c.gateway) validateGatewayConfiguration(c.gateway, services, models);
    if (services.some(s => s.tariff.api.version === '2') && !c.gateway) throw Error('gateway mounts required');
    await validateClientSelectionPins({ models, services }, m, undefined, c.policy.build.gatewayAdapters);
    for (const mount of c.gateway?.mounts ?? []) {
      const selected = services.find(s => s.tariff.api.service === mount.service && s.tariff.api.operation === mount.operation)!;
      const { jcsBytes } = await import('@zkapi/solana-sdk/trust');
      if (await sha256Hex(jcsBytes(selected.tariff.api as any)) !== mount.binding_hash) throw Error('gateway binding pin mismatch');
    }
  } catch { return failure('invalid_tariff', 2, 'selection'); }
  const artifacts: any = { additional: Object.create(null) };
  object(c.artifacts, 'artifacts'); object(c.artifacts.additional, 'artifacts.additional');
  const names = ['idl','requestPk','requestVk','withdrawalPk','withdrawalVk','treePk','treeVk','treeSourceBundle','treeVerifierConstants'];
  if (Object.keys(c.artifacts).some(name => name !== 'additional' && !names.includes(name))) failure('invalid_schema', 2, 'artifacts');
  for (const name of names) artifacts[name] = await publicRead((c.artifacts as any)[name], 'artifacts.' + name);
  for (const [name, path] of Object.entries(c.artifacts.additional)) artifacts.additional[name] = await publicRead(path, 'artifacts.additional');
  let verified: ArtifactBundle;
  try { verified = await verifyArtifactBundle(m, artifacts); } catch { return failure('artifact_verification_failed', 1, 'artifacts'); }
  for (const kind of ['prover', 'verifier'] as const) {
    const binary = c[kind]; object(binary, kind);
    if (Object.keys(binary).sort().join(',') !== 'path,sha256' || !digest(binary.sha256)) failure('invalid_schema', 2, kind);
    if (await sha256Hex(await publicRead(binary.path, kind)) !== binary.sha256) failure('pin_mismatch', 1, kind);
  }
  const local = m.deployment_environment === 'local';
  networkBase(c.rpc, local, 'rpc'); networkBase(c.indexer, local, 'indexer');
  if (c.direct_provider_bases !== undefined) {
    object(c.direct_provider_bases, 'direct_provider_bases');
    for (const [mode, base] of Object.entries(c.direct_provider_bases)) {
      if (!['direct_oa', 'direct_openrouter'].includes(mode)) failure('invalid_schema', 2, 'direct_provider_bases');
      networkBase(base, local, 'direct_provider_bases');
    }
  }
  if (c.mode !== 'proxy' && !c.direct_provider_bases?.[c.mode]) failure('invalid_schema', 2, 'direct_provider_bases');
  if (c.oa_verifier !== undefined) {
    object(c.oa_verifier, 'oa_verifier');
    if (Object.keys(c.oa_verifier).sort().join(',') !== 'base,stationId' || typeof c.oa_verifier.stationId !== 'string' || !c.oa_verifier.stationId.length || Buffer.byteLength(c.oa_verifier.stationId) > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(c.oa_verifier.stationId)) failure('invalid_schema', 2, 'oa_verifier');
    networkBase(c.oa_verifier.base, local, 'oa_verifier');
  }
  if (c.mode === 'direct_oa' && !c.oa_verifier) failure('invalid_schema', 2, 'oa_verifier');
  if (c.key_reuse_seconds !== undefined && (!Number.isInteger(c.key_reuse_seconds) || c.key_reuse_seconds < 0 || c.key_reuse_seconds > 300)) failure('invalid_schema', 2, 'key_reuse_seconds');
  if (c.settlement_wait_ms !== undefined && (!Number.isSafeInteger(c.settlement_wait_ms) || c.settlement_wait_ms < 0 || c.settlement_wait_ms > 180000 || c.mode === 'proxy' && c.settlement_wait_ms !== 0)) failure('invalid_schema', 2, 'settlement_wait_ms');
  if (c.preparation_commitment !== undefined && !['confirmed','finalized'].includes(c.preparation_commitment)) failure('invalid_schema', 2, 'preparation_commitment');
  for (const field of ['journal','custody'] as const) if (c[field] !== undefined) canonicalPath(c[field], field);
  if (c.note_id !== undefined && (typeof c.note_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.note_id))) failure('invalid_schema', 2, 'note_id');
  return { config: c, manifest: m, models, services, artifacts: verified };
}

export async function validateConfigurationCommand(args: readonly string[]) {
  const values = new Map<string, string>();
  const flags = ['--distribution','--distribution-sha256','--runtime-config','--runtime-sha256'];
  if (args.length !== 9 || args[0] !== '--validate-config') failure('invalid_schema');
  for (let i = 1; i < args.length; i += 2) {
    if (!flags.includes(args[i]) || values.has(args[i]) || !args[i + 1]) failure('invalid_schema');
    values.set(args[i], args[i + 1]);
  }
  const distribution = values.get('--distribution')!, runtime = values.get('--runtime-config')!;
  canonicalPath(distribution, 'distribution'); canonicalPath(runtime, 'runtime-config');
  if (!digest(values.get('--runtime-sha256'))) failure('invalid_schema', 2, 'runtime-sha256');
  const files = await verifyNativeDistribution(distribution, values.get('--distribution-sha256')!);
  const bytes = await publicRead(runtime, 'runtime-config', 1024 * 1024);
  if (await sha256Hex(bytes) !== values.get('--runtime-sha256')) failure('pin_mismatch', 1, 'runtime-config');
  const c = strict(bytes, 'runtime'); object(c, 'runtime');
  for (const [kind, name] of [['prover','bin/zkapi-client-prover'], ['verifier','bin/zkapi-client-verify']] as const) {
    const pin = { path: join(dirname(distribution), name), sha256: files[name] };
    if (c[kind] !== undefined && (Object.keys(c[kind] ?? {}).sort().join(',') !== 'path,sha256'
      || c[kind].path !== pin.path || c[kind].sha256 !== pin.sha256)) failure('pin_mismatch', 1, kind);
    c[kind] = pin;
  }
  const validated = await validateRuntimeConfiguration(c);
  const summary = { schema: 1, valid: true, manifestHash: validated.manifest.manifest_hash, mode: c.mode,
    models: validated.models.map(model => model.id).sort(),
    operations: validated.services.map(({ tariff }) => ({ service: tariff.api.service, operation: tariff.api.operation,
      endpoint: apiOperationPath(tariff.api), tariffHash: tariff.tariff_hash })).sort((a, b) => a.service < b.service ? -1 : a.service > b.service ? 1 : a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0),
    custodyInitialized: false, networkActions: 0 };
  if (Buffer.byteLength(JSON.stringify(summary)) > 65535) failure('invalid_schema', 2, 'selection');
  return summary;
}
