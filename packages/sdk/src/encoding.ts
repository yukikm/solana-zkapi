/** Protocol encoding primitives. Wallet/prover/session SDK is still I08 work. */
export const FR_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const SCALAR_MODULUS = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
export const MAX_MICRO_USDC = 9_007_199_254_740_991n;
export const VAULT_LABEL = 'solana-zkapi-vault-v1';
export const DESTINATION_LABEL = 'solana-zkapi-destination-v1';
export const AUTHORIZATION_LABEL = 'solana-zkapi-authorization-v1';
export const OPERATION_LABEL = 'solana-zkapi-operation-v1';
type BindingLabel = typeof VAULT_LABEL | typeof DESTINATION_LABEL | typeof AUTHORIZATION_LABEL;
type FrameLabel = BindingLabel | typeof OPERATION_LABEL;

export function parseMicroUsdc(text: string): bigint {
  if (typeof text !== 'string' || text.trim() !== text || !/^(0|[1-9][0-9]*)$/.test(text) || text.length > 16) throw new Error('invalid micro-USDC');
  const value = BigInt(text);
  if (value > MAX_MICRO_USDC) throw new Error('micro-USDC out of range');
  return value;
}

export function settleSession(charges: readonly bigint[], cap: bigint): bigint {
  if (typeof cap !== 'bigint' || cap < 0n || cap > MAX_MICRO_USDC) throw new Error('invalid cap');
  let sum = 0n;
  for (const amount of charges) {
    if (typeof amount !== 'bigint' || amount < 0n) throw new Error('invalid nano charge');
    sum += amount;
    if (sum > cap * 1000n) throw new Error('session budget exceeded');
  }
  return sum / 1000n + (sum % 1000n === 0n ? 0n : 1n);
}

function parseCanonicalField(text: string, modulus: bigint): Uint8Array {
  if (typeof text !== 'string' || text.length !== 66 || !/^0x[0-9a-f]{64}$/.test(text) || BigInt(text) >= modulus) throw new Error('invalid field');
  return Uint8Array.from(text.slice(2).match(/../g)!, byte => parseInt(byte, 16));
}

export function parseField(text: string): Uint8Array {
  return parseCanonicalField(text, FR_MODULUS);
}

/** Schnorr s and blind_delta_srv use the smaller Baby-JubJub scalar field. */
export function parseScalar(text: string): Uint8Array {
  return parseCanonicalField(text, SCALAR_MODULUS);
}

function integerBytes(value: number, width: 2 | 4): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** (width * 8)) throw new Error('invalid framing length');
  const result = new Uint8Array(width);
  const view = new DataView(result.buffer);
  if (width === 2) view.setUint16(0, value, false);
  else view.setUint32(0, value, false);
  return result;
}

/** Operation framing is for HMAC input; it is not an H2F authorization binding. */
export function frame(label: FrameLabel, parts: readonly Uint8Array[]): Uint8Array {
  if (![VAULT_LABEL, DESTINATION_LABEL, AUTHORIZATION_LABEL, OPERATION_LABEL].includes(label)) throw new Error('unknown frame label');
  const labelBytes = new TextEncoder().encode(label);
  const chunks = [integerBytes(labelBytes.length, 2), labelBytes, integerBytes(parts.length, 2)];
  for (const part of parts) chunks.push(integerBytes(part.length, 4), part);
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function h2f(label: BindingLabel, parts: readonly Uint8Array[]): Promise<string> {
  if (![VAULT_LABEL, DESTINATION_LABEL, AUTHORIZATION_LABEL].includes(label)) throw new Error('unknown binding label');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(frame(label, parts)));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return '0x' + (BigInt('0x' + hex) % FR_MODULUS).toString(16).padStart(64, '0');
}

function raw32(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error('expected raw32');
  return value;
}

export function vaultBinding(genesis: Uint8Array, program: Uint8Array, pool: Uint8Array, tokenProgram: Uint8Array, mint: Uint8Array): Promise<string> {
  return h2f(VAULT_LABEL, [genesis, program, pool, tokenProgram, mint].map(raw32).concat([new Uint8Array([6])]));
}

export function destinationBinding(owner: Uint8Array): Promise<string> {
  return h2f(DESTINATION_LABEL, [raw32(owner)]);
}

/** Input must already be validated JCS AuthorizationBody UTF-8 bytes. */
export function authorizationContext(jcsBytes: Uint8Array): Promise<string> {
  return h2f(AUTHORIZATION_LABEL, [jcsBytes]);
}
