/** I08 trust boundary. All pins come from the installed distribution, never /config itself. */
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { parseField, parseMicroUsdc, vaultBinding } from './encoding.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Point { readonly x: string; readonly y: string }
export interface SetupTranscripts { readonly request: string | null; readonly withdrawal: string | null; readonly tree: string | null }
export interface TreeProofArtifacts {
  readonly circuit_id: 'solana.zkapi.tree.v1'; readonly public_inputs: 11;
  readonly source_bundle_hash: string; readonly pk_hash: string; readonly vk_hash: string;
  readonly verifier_constants_hash: string; readonly setup_transcript_hash: string | null;
}
export interface MultisigAuthority {
  readonly authority: string; readonly program_id: string; readonly config_hash: string;
  readonly threshold: 2; readonly members: readonly string[];
}
/** Explicit test custody, accepted only on devnet with test-only setup.
 * This declaration does not replace a finalized ProgramData upgrade-authority
 * check during deployment preflight. PoolConfig still pins the admin address.
 */
export interface DevnetTestSingleKeyAuthority {
  readonly kind: 'devnet_test_single_key'; readonly authority: string;
}
export type DeploymentAuthority = MultisigAuthority | DevnetTestSingleKeyAuthority;
export interface Manifest {
  readonly deployment_id: string; readonly manifest_hash: string; readonly manifest_signature: string;
  readonly genesis_hash: string; readonly program_id: string; readonly pool: string; readonly mint: string;
  readonly token_program: string; readonly decimals: 6; readonly vault_binding: string;
  readonly state_key: Point; readonly clearance_key: Point; readonly quote_public_key: string; readonly receipt_public_key: string;
  readonly circuit_id: 'zkapi-v2-note-bound-v1'; readonly protocol_layout_version: 2;
  readonly tree_backend: 'transition_proof'; readonly tree_tag_policy: 'proof_bound'; readonly circuit_profile_hash: string;
  readonly deployment_environment: 'local' | 'devnet' | 'mainnet'; readonly setup_profile: 'test_only' | 'ceremony_verified';
  readonly setup_transcript_hashes: SetupTranscripts; readonly tree_proof_artifacts: TreeProofArtifacts;
  readonly transaction_formats: readonly ('v0_buffer' | 'v0_inline' | 'v1_inline' | 'v0_inline_deposit_v1')[];
  readonly request_pk_hash: string; readonly request_vk_hash: string; readonly withdrawal_pk_hash: string; readonly withdrawal_vk_hash: string;
  readonly cap_micro_usdc: string; readonly note_ttl_seconds: string; readonly challenge_seconds: string;
  readonly control_api_origin: string; readonly inference_api_origin: string; readonly proving_keys_base_url: string;
  readonly idl_hash: string; readonly api_endpoints: readonly string[]; readonly tariff_hashes: readonly string[];
  readonly artifact_digests: Readonly<Record<string, string>>; readonly db_schema_version: string;
  readonly authorities: { readonly admin: DeploymentAuthority; readonly upgrade: DeploymentAuthority };
}
declare const verifiedManifestBrand: unique symbol;
export type VerifiedManifest = Manifest & { readonly [verifiedManifestBrand]: true };
const verifiedManifests = new WeakSet<object>();

export interface ManifestTrustPolicy {
  /** An out-of-band digest or distribution key. A manifest cannot supply its own trust root. */
  readonly anchor: { readonly kind: 'hash'; readonly sha256: string } | { readonly kind: 'ed25519'; readonly publicKey: string };
  readonly expected: Pick<Manifest, 'deployment_id' | 'deployment_environment' | 'genesis_hash' | 'program_id' | 'pool' | 'mint' | 'token_program' | 'control_api_origin' | 'inference_api_origin'>;
  /** Values from the separately authenticated program build (ADR-0002), not a copy of fetched manifest fields. */
  readonly build: {
    readonly stateKey: Point; readonly clearanceKey: Point; readonly circuitProfileHash: string; readonly idlHash: string;
    readonly setupProfile: Manifest['setup_profile'];
    /** Independently installed build capabilities. Required to enable compact deposits;
     * omission preserves legacy buffer-only distributions. Never copy from fetched config. */
    readonly transactionFormats?: Manifest['transaction_formats'];
    /** Out-of-band, reviewed ceremony transcripts; merely downloading a transcript is insufficient. */
    readonly verifiedSetupTranscripts?: SetupTranscripts;
  };
}

function reject(message: string): never { throw new Error(`trust: ${message}`); }
function requireTrue(value: unknown, message: string): asserts value { if (!value) reject(message); }
function validString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      requireTrue(next >= 0xdc00 && next <= 0xdfff, 'unpaired UTF-16 surrogate');
    } else requireTrue(code < 0xdc00 || code > 0xdfff, 'unpaired UTF-16 surrogate');
  }
}

/** Fatal UTF-8 and duplicate-key parsing before canonicalization. JSON.parse alone loses duplicate keys.
 * Network callers retain the 1 MiB default. Local archive readers may explicitly
 * select a bounded input size; the same syntax and nesting checks still apply. */
export function parseStrictJson(bytes: Uint8Array, maximumBytes = 1024 * 1024): Json {
  requireTrue(Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 512 * 1024 * 1024, 'JSON size limit');
  requireTrue(bytes instanceof Uint8Array && bytes.length <= maximumBytes, 'JSON size');
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let at = 0;
  const space = () => { while (at < source.length && /[\x20\x09\x0a\x0d]/.test(source[at])) at++; };
  const string = (): string => {
    requireTrue(source[at++] === '"', 'JSON string');
    const start = at - 1;
    while (at < source.length) {
      const c = source[at++];
      if (c === '"') { const result: unknown = JSON.parse(source.slice(start, at)); requireTrue(typeof result === 'string', 'JSON string'); validString(result); return result; }
      if (c === '\\') at++;
    }
    return reject('unterminated JSON string');
  };
  const read = (depth: number): Json => {
    requireTrue(depth <= 64, 'JSON nesting'); space();
    const c = source[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; space(); const result: { [key: string]: Json } = Object.create(null);
      if (source[at] === '}') { at++; return result; }
      while (at < source.length) {
        space(); const key = string(); requireTrue(!Object.hasOwn(result, key), 'duplicate JSON key'); space();
        requireTrue(source[at++] === ':', 'JSON colon'); result[key] = read(depth + 1); space();
        const separator = source[at++]; if (separator === '}') return result;
        requireTrue(separator === ',', 'JSON object separator');
      }
      return reject('unterminated JSON object');
    }
    if (c === '[') {
      at++; space(); const result: Json[] = [];
      if (source[at] === ']') { at++; return result; }
      while (at < source.length) {
        result.push(read(depth + 1)); space(); const separator = source[at++];
        if (separator === ']') return result; requireTrue(separator === ',', 'JSON array separator');
      }
      return reject('unterminated JSON array');
    }
    for (const [token, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (source.startsWith(token, at)) { at += token.length; return value; }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(at));
    requireTrue(token, 'JSON value'); at += token[0].length;
    const result = Number(token[0]); requireTrue(Number.isFinite(result), 'nonfinite JSON number'); return result;
  };
  const result = read(0); space(); requireTrue(at === source.length, 'trailing JSON data'); return result;
}

/** RFC 8785: UTF-16 key ordering, ECMAScript number serialization, no Unicode normalization. */
export function jcsBytes(value: unknown): Uint8Array {
  const active = new Set<object>();
  const visit = (v: unknown, depth: number): string => {
    requireTrue(depth <= 64, 'JSON nesting');
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') { validString(v); return JSON.stringify(v); }
    if (typeof v === 'number') { requireTrue(Number.isFinite(v), 'nonfinite JSON number'); return JSON.stringify(v); }
    requireTrue(typeof v === 'object' && !active.has(v), 'non-JSON value or cycle');
    active.add(v); let result: string;
    if (Array.isArray(v)) {
      requireTrue(Object.keys(v).length === v.length && Object.getOwnPropertySymbols(v).length === 0, 'sparse or extended JSON array');
      result = '[' + v.map(item => visit(item, depth + 1)).join(',') + ']';
    } else {
      requireTrue(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'non-JSON object');
      requireTrue(Object.getOwnPropertySymbols(v).length === 0, 'non-JSON symbol');
      result = '{' + Object.keys(v).sort().map(key => {
        validString(key); const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        requireTrue('value' in descriptor, 'JSON accessor');
        return JSON.stringify(key) + ':' + visit(descriptor.value, depth + 1);
      }).join(',') + '}';
    }
    active.delete(v); return result;
  };
  return new TextEncoder().encode(visit(value, 0));
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
}
export function base58PublicKey(value: unknown): Uint8Array {
  requireTrue(typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), 'base58 public key');
  const decoded = bs58.decode(value); requireTrue(decoded.length === 32 && bs58.encode(decoded) === value, 'public key width'); return decoded;
}
export function canonicalBase64(value: unknown, length: number): Uint8Array {
  requireTrue(typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'canonical base64');
  const decoded = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  requireTrue(decoded.length === length && btoa(String.fromCharCode(...decoded)) === value, 'base64 width/canonical padding'); return decoded;
}
export async function verifyEd25519(publicKey: string, message: Uint8Array, signature: string): Promise<void> {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(base58PublicKey(publicKey)), { name: 'Ed25519' }, false, ['verify']);
  requireTrue(await crypto.subtle.verify('Ed25519', key, new Uint8Array(canonicalBase64(signature, 64)), new Uint8Array(message)), 'Ed25519 signature');
}
function digest(value: unknown): asserts value is string { requireTrue(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'SHA256 digest'); }
function hashBytes(value: string): Uint8Array { digest(value); return Uint8Array.from(value.match(/../g)!, pair => parseInt(pair, 16)); }
function record(value: unknown, keys?: readonly string[]): asserts value is Record<string, Json> {
  requireTrue(value !== null && typeof value === 'object' && !Array.isArray(value), 'JSON object');
  if (keys) requireTrue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'unknown or missing field');
}
function point(value: unknown): asserts value is Point {
  record(value, ['x', 'y']); requireTrue(typeof value.x === 'string' && typeof value.y === 'string', 'point');
  parseField(value.x); parseField(value.y);
  requireTrue(BigInt(value.x) !== 0n || BigInt(value.y) !== 1n, 'identity signing key');
}
function uint(value: unknown, positive = false): bigint {
  requireTrue(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20, 'canonical u64');
  const result = BigInt(value); requireTrue(result <= 0xffffffffffffffffn && (!positive || result > 0n), 'u64 bounds'); return result;
}
function strings(value: unknown, unique = false): asserts value is string[] {
  requireTrue(Array.isArray(value) && value.every(v => typeof v === 'string'), 'string array');
  if (unique) requireTrue(new Set(value).size === value.length, 'duplicate array item');
}
function url(value: unknown, local: boolean, origin: boolean): void {
  requireTrue(typeof value === 'string', 'URL'); let parsed: URL;
  try { parsed = new URL(value); } catch { return reject('URL'); }
  requireTrue(!parsed.username && !parsed.password && !parsed.hash && !parsed.search, 'URL credentials/query/fragment');
  requireTrue(parsed.protocol === 'https:' || local && parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'HTTPS or explicit local loopback required');
  if (origin) requireTrue(value === parsed.origin, 'canonical origin');
}
const MANIFEST_KEYS = ['deployment_id', 'manifest_hash', 'genesis_hash', 'program_id', 'pool', 'mint', 'token_program', 'decimals', 'vault_binding', 'state_key', 'clearance_key', 'quote_public_key', 'circuit_id', 'protocol_layout_version', 'tree_backend', 'tree_tag_policy', 'circuit_profile_hash', 'deployment_environment', 'setup_profile', 'setup_transcript_hashes', 'transaction_formats', 'request_pk_hash', 'request_vk_hash', 'withdrawal_pk_hash', 'withdrawal_vk_hash', 'cap_micro_usdc', 'note_ttl_seconds', 'challenge_seconds', 'control_api_origin', 'inference_api_origin', 'manifest_signature', 'idl_hash', 'api_endpoints', 'tariff_hashes', 'artifact_digests', 'db_schema_version', 'proving_keys_base_url', 'tree_proof_artifacts', 'receipt_public_key', 'authorities'] as const;
const PROFILE_KEYS = ['protocol_layout_version', 'tree_backend', 'tree_tag_policy', 'circuit_id', 'request_pk_hash', 'request_vk_hash', 'withdrawal_pk_hash', 'withdrawal_vk_hash', 'tree_proof_artifacts', 'setup_profile', 'setup_transcript_hashes'] as const;
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
function validateManifest(value: unknown): asserts value is Manifest {
  record(value, MANIFEST_KEYS);
  requireTrue(typeof value.deployment_id === 'string' && value.deployment_id.length > 0, 'deployment ID');
  for (const key of ['manifest_hash', 'circuit_profile_hash', 'request_pk_hash', 'request_vk_hash', 'withdrawal_pk_hash', 'withdrawal_vk_hash', 'idl_hash']) digest(value[key]);
  for (const key of ['genesis_hash', 'program_id', 'pool', 'mint', 'token_program', 'quote_public_key', 'receipt_public_key']) base58PublicKey(value[key]);
  requireTrue(value.token_program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'SPL Token program');
  requireTrue(value.quote_public_key !== value.receipt_public_key, 'quote/receipt role separation');
  requireTrue(typeof value.vault_binding === 'string', 'vault binding'); parseField(value.vault_binding);
  point(value.state_key); point(value.clearance_key);
  requireTrue(value.state_key.x !== value.clearance_key.x || value.state_key.y !== value.clearance_key.y, 'state/clearance role separation');
  requireTrue(value.decimals === 6 && value.protocol_layout_version === 2 && value.tree_backend === 'transition_proof' && value.tree_tag_policy === 'proof_bound' && value.circuit_id === 'zkapi-v2-note-bound-v1', 'layout 2 profile');
  requireTrue(['local', 'devnet', 'mainnet'].includes(value.deployment_environment as string), 'deployment environment');
  requireTrue(value.setup_profile === 'test_only' || value.setup_profile === 'ceremony_verified', 'setup profile');
  requireTrue(value.deployment_environment !== 'mainnet' || value.setup_profile === 'ceremony_verified', 'mainnet test setup');
  record(value.setup_transcript_hashes, ['request', 'withdrawal', 'tree']);
  record(value.tree_proof_artifacts, ['circuit_id', 'public_inputs', 'source_bundle_hash', 'pk_hash', 'vk_hash', 'verifier_constants_hash', 'setup_transcript_hash']);
  const tree = value.tree_proof_artifacts;
  requireTrue(tree.circuit_id === 'solana.zkapi.tree.v1' && tree.public_inputs === 11, 'tree circuit');
  for (const key of ['source_bundle_hash', 'pk_hash', 'vk_hash', 'verifier_constants_hash']) digest(tree[key]);
  for (const transcript of [...Object.values(value.setup_transcript_hashes), tree.setup_transcript_hash]) {
    if (value.setup_profile === 'test_only') requireTrue(transcript === null, 'test transcript must be null'); else digest(transcript);
  }
  requireTrue(tree.setup_transcript_hash === value.setup_transcript_hashes.tree, 'tree transcript mismatch');
  strings(value.transaction_formats, true);
  requireTrue(value.transaction_formats.includes('v0_buffer') && value.transaction_formats.every(v => ['v0_buffer', 'v0_inline', 'v1_inline', 'v0_inline_deposit_v1'].includes(v)), 'mandatory v0_buffer');
  requireTrue(typeof value.cap_micro_usdc === 'string' && parseMicroUsdc(value.cap_micro_usdc) > 0n, 'positive cap');
  uint(value.note_ttl_seconds, true); uint(value.challenge_seconds, true); uint(value.db_schema_version, true);
  url(value.control_api_origin, value.deployment_environment === 'local', true);
  url(value.inference_api_origin, value.deployment_environment === 'local', true);
  url(value.proving_keys_base_url, value.deployment_environment === 'local', false);
  canonicalBase64(value.manifest_signature, 64); strings(value.api_endpoints); strings(value.tariff_hashes, true);
  value.tariff_hashes.forEach(digest); record(value.artifact_digests); Object.values(value.artifact_digests).forEach(digest);
  record(value.authorities, ['admin', 'upgrade']);
  for (const authority of Object.values(value.authorities)) {
    record(authority);
    if (authority.kind === 'devnet_test_single_key') {
      record(authority, ['kind', 'authority']);
      requireTrue(value.deployment_environment === 'devnet' && value.setup_profile === 'test_only'
        && value.genesis_hash === DEVNET_GENESIS_HASH, 'single-key authority requires devnet test-only setup');
      base58PublicKey(authority.authority);
      continue;
    }
    record(authority, ['authority', 'program_id', 'config_hash', 'threshold', 'members']);
    base58PublicKey(authority.authority); base58PublicKey(authority.program_id); digest(authority.config_hash);
    strings(authority.members, true); requireTrue(authority.threshold === 2 && authority.members.length === 3, '2-of-3 authority');
    authority.members.forEach(base58PublicKey);
  }
}
function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}
function equalPoint(a: Point, b: Point): boolean { return a.x === b.x && a.y === b.y; }
function trusted(manifest: VerifiedManifest): void { requireTrue(verifiedManifests.has(manifest), 'manifest was not verified by this SDK'); }

/** Capability selection is permitted only after distribution/build authentication. */
export function supportsInlineDeposit(manifest: VerifiedManifest): boolean {
  trusted(manifest);
  return manifest.transaction_formats.includes('v0_inline_deposit_v1');
}

async function verifyCompactDepositIdl(idl: Record<string, Json>): Promise<void> {
  requireTrue(Array.isArray(idl.instructions), 'compact deposit IDL instructions');
  const named = (name: string) => (idl.instructions as Json[]).filter(i => i !== null && typeof i === 'object' && !Array.isArray(i) && i.name === name);
  const matches = named('deposit_compact_v1');
  requireTrue(matches.length === 1, 'compact deposit IDL instruction');
  const instruction = matches[0]; record(instruction);
  const discriminator = Array.from(hashBytes(await sha256Hex(new TextEncoder().encode('global:deposit_compact_v1'))).slice(0, 8));
  const same = (left: unknown, right: unknown) => new TextDecoder().decode(jcsBytes(left)) === new TextDecoder().decode(jcsBytes(right));
  requireTrue(same(instruction.discriminator, discriminator), 'compact deposit IDL discriminator');
  const array = (length: number) => ({ array: ['u8', length] });
  const args = [
    ['expected_id', 'u32'], ['expected_root', array(32)], ['expiry', 'u64'],
    ['commitment', array(32)], ['amount', 'u64'], ['new_root', array(32)],
    ['new_leaf', array(32)], ['transition_tag', array(32)], ['tree_proof', array(256)],
  ].map(([name, type]) => ({ name, type }));
  requireTrue(same(instruction.args, args), 'compact deposit IDL arguments');
  const financial = ['pool', 'tree', 'note', 'pending', 'exit', 'vault_authority', 'mint', 'source', 'vault',
    'destination_owner', 'destination', 'treasury_owner', 'treasury', 'token_owner', 'payer'].map(name => ({ name,
      ...(['tree', 'note', 'pending', 'exit', 'source', 'vault', 'destination', 'treasury', 'payer'].includes(name) ? { writable: true } : {}),
      ...(name === 'payer' ? { signer: true } : {}),
    }));
  const accounts = [{ name: 'financial', accounts: [...financial,
    { name: 'token_program', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { name: 'associated_token_program', address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' },
    { name: 'system_program', address: '11111111111111111111111111111111' },
  ] }, { name: 'token_owner_signer', signer: true }];
  requireTrue(same(instruction.accounts, accounts), 'compact deposit IDL accounts');
}

/** Hash semantics are shared with the server: omit manifest_hash and manifest_signature only. */
export async function manifestDigest(manifest: Manifest): Promise<string> {
  const { manifest_hash: _hash, manifest_signature: _signature, ...body } = manifest;
  return sha256Hex(jcsBytes(body));
}
export async function circuitProfileDigest(manifest: Manifest): Promise<string> {
  return sha256Hex(jcsBytes(Object.fromEntries(PROFILE_KEYS.map(key => [key, manifest[key]]))));
}

/** Authenticate before any endpoint/role key/artifact can be used. Never performs network requests. */
export async function verifyManifest(bytes: Uint8Array, policy: ManifestTrustPolicy): Promise<VerifiedManifest> {
  // Snapshot all external pins before the first await; callers cannot replace a policy mid-verification.
  const pins = structuredClone(policy);
  const manifest = parseStrictJson(bytes); validateManifest(manifest);
  const hash = await manifestDigest(manifest); requireTrue(hash === manifest.manifest_hash, 'manifest hash mismatch');
  if (pins.anchor.kind === 'hash') { digest(pins.anchor.sha256); requireTrue(hash === pins.anchor.sha256, 'distribution hash pin'); }
  else { requireTrue(pins.anchor.kind === 'ed25519', 'distribution trust anchor'); await verifyEd25519(pins.anchor.publicKey, hashBytes(hash), manifest.manifest_signature); }
  for (const key of ['deployment_id', 'deployment_environment', 'genesis_hash', 'program_id', 'pool', 'mint', 'token_program', 'control_api_origin', 'inference_api_origin'] as const) {
    requireTrue(manifest[key] === pins.expected[key], `deployment pin ${key}`);
  }
  const binding = await vaultBinding(...(['genesis_hash', 'program_id', 'pool', 'token_program', 'mint'] as const).map(k => base58PublicKey(manifest[k])) as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array]);
  requireTrue(manifest.vault_binding === binding, 'vault binding mismatch');
  point(pins.build.stateKey); point(pins.build.clearanceKey);
  requireTrue(equalPoint(manifest.state_key, pins.build.stateKey) && equalPoint(manifest.clearance_key, pins.build.clearanceKey), 'ADR-0002 build role keys');
  requireTrue(manifest.circuit_profile_hash === pins.build.circuitProfileHash && manifest.circuit_profile_hash === await circuitProfileDigest(manifest), 'circuit profile mismatch');
  requireTrue(manifest.idl_hash === pins.build.idlHash && manifest.setup_profile === pins.build.setupProfile, 'IDL/setup build pin');
  if (manifest.transaction_formats.includes('v0_inline_deposit_v1')) {
    requireTrue(pins.build.transactionFormats?.includes('v0_buffer')
      && pins.build.transactionFormats.includes('v0_inline_deposit_v1'), 'compact deposit build capability pin');
  }
  if (manifest.setup_profile === 'ceremony_verified') {
    requireTrue(pins.build.verifiedSetupTranscripts && ['request', 'withdrawal', 'tree'].every(k => manifest.setup_transcript_hashes[k as keyof SetupTranscripts] === pins.build.verifiedSetupTranscripts![k as keyof SetupTranscripts]), 'unreviewed setup transcripts');
  }
  if (manifest.deployment_environment === 'mainnet') {
    // These are a denylist of public test artifacts, never trust roots or production keys.
    const testHashes = new Set([
      'c894b261a13f571d0df36be29734aabf2a8cd7162baddc5e08a50341aa076584', '8011244c99fa1a8524870906462d430fc86366b8ad821736c5fa726b479e6d97',
      '8e41398092fdd02b9ff86c6ccbecbd7ce2402e6f22ec162e6124d1d04fe0a668', '2a8ea7f07176e369a93d1d816124192a798d1466c99fd6dc47850ba82094b679',
      'c01b31f6806ce59114fe8befa210967415e20229b0a998018d4955a726fd0f80', '9141a035fdba50b13a5776182be029bb23dd15e69cd579c5d6e310b7e2ee5fb7',
    ]);
    requireTrue(![manifest.request_pk_hash, manifest.request_vk_hash, manifest.withdrawal_pk_hash, manifest.withdrawal_vk_hash, manifest.tree_proof_artifacts.pk_hash, manifest.tree_proof_artifacts.vk_hash].some(h => testHashes.has(h)), 'known test artifacts on mainnet');
    requireTrue(manifest.authorities.admin.authority !== manifest.authorities.upgrade.authority, 'admin/upgrade role separation');
  }
  freezeDeep(manifest); verifiedManifests.add(manifest); return manifest as unknown as VerifiedManifest;
}

export interface FinalizedPoolAccount {
  readonly address: string; readonly owner: string; readonly executable: boolean; readonly lamports: bigint;
  readonly data: Uint8Array; readonly slot: bigint; readonly commitment: 'finalized';
}
/** Validate actual account bytes; a server-produced decoded PoolConfig is not sufficient. */
export async function verifyPoolConfig(manifest: VerifiedManifest, observedGenesisHash: string, account: FinalizedPoolAccount, minimumSlot: bigint): Promise<{ readonly paused: boolean; readonly slot: bigint; readonly treasuryOwner: string }> {
  trusted(manifest);
  const observation = { ...account, data: new Uint8Array(account.data) };
  requireTrue(observedGenesisHash === manifest.genesis_hash, 'RPC genesis mismatch');
  requireTrue(observation.commitment === 'finalized' && typeof minimumSlot === 'bigint' && minimumSlot >= 0n && typeof observation.slot === 'bigint' && observation.slot >= minimumSlot, 'finalized pool context');
  requireTrue(observation.address === manifest.pool && observation.owner === manifest.program_id && observation.executable === false && typeof observation.lamports === 'bigint' && observation.lamports > 0n, 'PoolConfig identity/owner');
  const raw = observation.data;
  requireTrue(raw.length === 422 && raw[8] === 2, 'PoolConfig layout');
  const discriminator = (await sha256Hex(new TextEncoder().encode('account:PoolConfig'))).slice(0, 16);
  requireTrue(Array.from(raw.subarray(0, 8), b => b.toString(16).padStart(2, '0')).join('') === discriminator, 'PoolConfig discriminator');
  const [pool, bump] = PublicKey.findProgramAddressSync([new TextEncoder().encode('pool'), raw.subarray(390, 422)], new PublicKey(manifest.program_id));
  requireTrue(pool.toBase58() === manifest.pool && raw[9] === bump, 'PoolConfig PDA');
  const same = (start: number, expected: Uint8Array) => requireTrue(expected.every((v, i) => raw[start + i] === v), 'PoolConfig manifest mismatch');
  same(10, base58PublicKey(manifest.genesis_hash)); same(42, base58PublicKey(manifest.mint)); same(74, base58PublicKey(manifest.token_program));
  requireTrue(raw[106] === 6, 'PoolConfig decimals'); same(107, parseField(manifest.vault_binding));
  same(139, base58PublicKey(manifest.authorities.admin.authority));
  same(203, parseField(manifest.state_key.x)); same(235, parseField(manifest.state_key.y));
  same(267, parseField(manifest.clearance_key.x)); same(299, parseField(manifest.clearance_key.y));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  requireTrue(view.getBigUint64(331, true) === BigInt(manifest.note_ttl_seconds) && view.getBigUint64(339, true) === BigInt(manifest.challenge_seconds) && view.getBigUint64(347, true) === BigInt(manifest.cap_micro_usdc), 'PoolConfig timing/cap');
  requireTrue(raw[355] <= 1 && raw[356] === 1 && raw[357] === 1, 'PoolConfig flags/backend'); same(358, hashBytes(manifest.circuit_profile_hash));
  return Object.freeze({ paused: raw[355] === 1, slot: observation.slot, treasuryOwner: bs58.encode(raw.subarray(171, 203)) });
}

export interface ArtifactBundle {
  readonly idl: Uint8Array; readonly requestPk: Uint8Array; readonly requestVk: Uint8Array;
  readonly withdrawalPk: Uint8Array; readonly withdrawalVk: Uint8Array; readonly treePk: Uint8Array; readonly treeVk: Uint8Array;
  readonly treeSourceBundle: Uint8Array; readonly treeVerifierConstants: Uint8Array;
  /** Every additional manifest digest must be checked, including binary/image artifacts when supplied there. */
  readonly additional: Readonly<Record<string, Uint8Array>>;
}
/** Returns independent copies of exact verified bytes, preventing mutation during/after hashing. */
export async function verifyArtifactBundle(manifest: VerifiedManifest, bundle: ArtifactBundle): Promise<ArtifactBundle> {
  trusted(manifest);
  const hashes = {
    idl: manifest.idl_hash, requestPk: manifest.request_pk_hash, requestVk: manifest.request_vk_hash,
    withdrawalPk: manifest.withdrawal_pk_hash, withdrawalVk: manifest.withdrawal_vk_hash,
    treePk: manifest.tree_proof_artifacts.pk_hash, treeVk: manifest.tree_proof_artifacts.vk_hash,
    treeSourceBundle: manifest.tree_proof_artifacts.source_bundle_hash, treeVerifierConstants: manifest.tree_proof_artifacts.verifier_constants_hash,
  };
  const verified: Record<string, Uint8Array> = Object.create(null);
  for (const name of Object.keys(hashes) as (keyof typeof hashes)[]) {
    requireTrue(bundle[name] instanceof Uint8Array && bundle[name].length > 0, `missing artifact ${name}`);
    verified[name] = new Uint8Array(bundle[name]);
  }
  const additional: Record<string, Uint8Array> = Object.create(null);
  requireTrue(bundle.additional && typeof bundle.additional === 'object', 'additional artifacts');
  requireTrue(Object.keys(bundle.additional).length === Object.keys(manifest.artifact_digests).length, 'unknown or missing additional artifact');
  for (const name of Object.keys(manifest.artifact_digests)) {
    requireTrue(Object.hasOwn(bundle.additional, name) && bundle.additional[name] instanceof Uint8Array && bundle.additional[name].length > 0, `missing artifact ${name}`);
    additional[name] = new Uint8Array(bundle.additional[name]);
  }
  for (const name of Object.keys(hashes) as (keyof typeof hashes)[]) requireTrue(await sha256Hex(verified[name]) === hashes[name], `artifact mismatch ${name}`);
  for (const [name, hash] of Object.entries(manifest.artifact_digests)) requireTrue(await sha256Hex(additional[name]) === hash, `artifact mismatch ${name}`);
  // IDL is JSON as well as a digest-pinned artifact; its program address must agree with the deployment.
  const idl = parseStrictJson(verified.idl); record(idl); requireTrue(idl.address === manifest.program_id, 'IDL program address');
  if (supportsInlineDeposit(manifest)) await verifyCompactDepositIdl(idl);
  return Object.freeze({ ...verified, additional: Object.freeze(additional) }) as unknown as ArtifactBundle;
}
