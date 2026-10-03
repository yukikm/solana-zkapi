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
