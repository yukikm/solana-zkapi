/** Checked boundaries between Kit's lossless RPC values and the journal's
 * existing safe-number slots. Financial quantities remain bigint throughout. */
import { address, type Address } from '@solana/kit';
import { Buffer } from 'buffer';

export function safeRpcNumber(value: unknown, label = 'RPC integer'): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`invalid ${label}`);
  return Number(value);
}
export interface Base64RpcAccount {
  owner: Address; executable: boolean; lamports: bigint;
  data: readonly [string, 'base64'];
}
export interface DecodedRpcAccount extends Omit<Base64RpcAccount, 'data'> { data: Uint8Array }
export function decodeRpcAccount(value: Base64RpcAccount | null): DecodedRpcAccount | null {
  if (value === null) return null;
  if (typeof value.owner !== 'string' || address(value.owner) !== value.owner || typeof value.executable !== 'boolean'
    || typeof value.lamports !== 'bigint' || value.lamports < 0n || value.lamports > 0xffffffffffffffffn
    || !Array.isArray(value.data) || value.data.length !== 2 || value.data[1] !== 'base64' || typeof value.data[0] !== 'string') throw new Error('invalid RPC account');
  const data = Buffer.from(value.data[0], 'base64');
  if (data.toString('base64') !== value.data[0]) throw new Error('invalid RPC account encoding');
  return { owner: value.owner, executable: value.executable, lamports: value.lamports, data: new Uint8Array(data) };
}
