import { test } from 'node:test';
import assert from 'node:assert/strict';
import { address } from '@solana/kit';
import { decodeRpcAccount, safeRpcNumber } from '../src/solana-rpc.ts';

const owner = address('11111111111111111111111111111111');
test('Kit RPC integer conversion preserves safe boundaries and refuses lossy numbers', () => {
  assert.equal(safeRpcNumber(0n), 0);
  assert.equal(safeRpcNumber(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  for (const value of [-1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 0, NaN, Infinity, '1', null]) {
    assert.throws(() => safeRpcNumber(value), /invalid RPC integer/);
  }
});

test('base64 RPC account decoding preserves u64 lamports and rejects malformed wire data', () => {
  const account = {owner, executable:false, lamports:0xffffffffffffffffn, data:['AQID','base64'] as const};
  assert.equal(decodeRpcAccount(null), null);
  assert.deepEqual(decodeRpcAccount(account), {owner, executable:false, lamports:0xffffffffffffffffn, data:new Uint8Array([1,2,3])});
  for (const mutation of [
    {lamports:-1n}, {lamports:1n<<64n}, {lamports:1}, {executable:0}, {owner:'invalid'},
    {data:['AQID=', 'base64']}, {data:['AQID','base58']}, {data:['AQID']},
  ]) assert.throws(() => decodeRpcAccount({...account,...mutation} as never));
});
