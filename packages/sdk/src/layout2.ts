/** Layout-2 transport encoding. Proof generation and verification belong to the pinned host prover. */
import { parseField, MAX_MICRO_USDC } from './encoding.ts';
export type Operation = 'deposit' | 'mutual_close' | 'initiate_escape' | 'challenge_escape' | 'claim_expired';
export const OPERATIONS: Readonly<Record<Operation, { op: number; bytes: number }>> = {
  deposit: { op: 0, bytes: 692 }, mutual_close: { op: 1, bytes: 1312 },
  initiate_escape: { op: 2, bytes: 1312 }, challenge_escape: { op: 3, bytes: 1252 },
  claim_expired: { op: 4, bytes: 612 },
};
export interface PublicProof { public_inputs: readonly string[]; proof_wire_hex: string }
export type Layout2Args =
  | { operation: 'deposit'; expectedId: number; expectedRoot: string; expiry: bigint; commitment: string; amount: bigint; tree: PublicProof }
  | { operation: 'mutual_close' | 'initiate_escape'; auth: PublicProof; tree: PublicProof }
  | { operation: 'challenge_escape'; noteId: number; auth: PublicProof; tree: PublicProof }
  | { operation: 'claim_expired'; noteId: number; tree: PublicProof };
export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out;
}
export function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('invalid u32');
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes;
}
export function u64(value: bigint): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn) throw new Error('invalid u64');
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, value, true); return bytes;
}
export function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function fromHex(value: string, length: number): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)) throw new Error('invalid canonical hex');
  return Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16));
}
function proof(value: PublicProof, count: number): Uint8Array {
  if (value.public_inputs.length !== count) throw new Error('wrong public input count');
  return concat(...value.public_inputs.map(parseField), fromHex(value.proof_wire_hex, 256));
}
export function encodeLayout2Args(args: Layout2Args): Uint8Array {
  const tree = proof(args.tree, 11);
  let encoded: Uint8Array;
  switch (args.operation) {
    case 'deposit':
      if (args.amount <= 0n || args.amount > MAX_MICRO_USDC) throw new Error('invalid deposit amount');
      encoded = concat(u32(args.expectedId), parseField(args.expectedRoot), u64(args.expiry), parseField(args.commitment), u64(args.amount), tree); break;
    case 'mutual_close': case 'initiate_escape': encoded = concat(proof(args.auth, 14), tree); break;
    case 'challenge_escape': encoded = concat(u32(args.noteId), proof(args.auth, 12), tree); break;
    case 'claim_expired': encoded = concat(u32(args.noteId), tree); break;
  }
  validatePayload(args.operation, encoded); return encoded;
}
export function validatePayload(operation: Operation, payload: Uint8Array): void {
  if (!OPERATIONS[operation] || payload.length !== OPERATIONS[operation].bytes) throw new Error('invalid layout-2 payload length or operation');
}

/** Compact deposit v1 removes only redundant public inputs. Pool binding is
 * supplied by the verified manifest/PoolConfig, never accepted from wire. */
export const COMPACT_DEPOSIT_BYTES = 436;
function integerField(value: bigint): Uint8Array { return parseField('0x' + value.toString(16).padStart(64, '0')); }
export function expandCompactDepositPayload(compact: Uint8Array, binding: string): Uint8Array {
  if (compact.length !== COMPACT_DEPOSIT_BYTES) throw new Error('invalid compact deposit length');
  const b = compact.slice(), view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const fieldAt = (offset: number) => parseField('0x' + hex(b.slice(offset, offset + 32)));
  const id = view.getUint32(0, true), expiry = view.getBigUint64(36, true), amount = view.getBigUint64(76, true);
  if (amount === 0n || amount > MAX_MICRO_USDC) throw new Error('invalid deposit amount');
  const inputs = [parseField(binding), fieldAt(4), fieldAt(84), integerField(BigInt(id)), integerField(0n),
    fieldAt(116), fieldAt(44), integerField(amount), integerField(expiry), integerField(0n), fieldAt(148)];
  return concat(b.slice(0, 84), ...inputs, b.slice(180));
}
export function compactDepositPayload(payload: Uint8Array, binding: string): Uint8Array {
  validatePayload('deposit', payload);
  const compact = concat(payload.slice(0, 84), payload.slice(148, 180), payload.slice(244, 276), payload.slice(404, 436), payload.slice(436));
  const canonical = expandCompactDepositPayload(compact, binding);
  if (canonical.some((byte, i) => byte !== payload[i])) throw new Error('deposit public inputs differ from compact expansion');
  return compact;
}
