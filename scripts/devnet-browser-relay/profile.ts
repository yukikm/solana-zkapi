/** Operator-side validation of the public browser profile wire format.
 * No application UI or runtime fetch dependency. Keep compatibility with independently built clients. */
import { PublicKey } from '@solana/web3.js';
import type { ArtifactBundle, CreateClientOptions, ManifestTrustPolicy, ModelConfiguration, Mode } from '../../packages/sdk/src/client.ts';
import { parseStrictJson } from '../../packages/sdk/src/trust.ts';

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

