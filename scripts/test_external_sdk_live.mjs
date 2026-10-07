import { test } from 'node:test';
import assert from 'node:assert/strict';
import { externalRelay, safeFailure } from './external_sdk_live.mjs';
import { ChatResponseError } from '@zkapi/solana-sdk/chat';

const profile = { mode: 'direct_openrouter', rpcUrl: 'https://rpc.zkapi.invalid', indexerOrigin: 'https://indexer.zkapi.invalid',
  directProviderBases: { direct_openrouter: 'https://openrouter.ai/api/v1' }, trust: { expected: { control_api_origin: 'https://127.0.0.1:19685' } } };
const origin = 'http://127.0.0.1:4174';

test('independent SDK relay preserves exact bodies, host origin, and direct provider routing', async () => {
  const observed = [], dispatches = [];
  const relay = externalRelay(profile, origin, async event => { dispatches.push(event); }, async (url, init) => {
    observed.push({ url: String(url), init }); return new Response('{}');
  });
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] });
  await relay(profile.rpcUrl, { method: 'POST', body: rpc });
  assert.equal(observed[0].url, origin + '/rpc'); assert.equal(observed[0].init.body, rpc); assert.equal(observed[0].init.headers.get('Origin'), origin);
  const body = new TextEncoder().encode('{"model":"example","messages":[]}');
  await relay('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body, headers: { authorization: 'Bearer fixture-only' } });
  assert.equal(observed[1].url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(observed[1].init.body, body);
  assert.equal(observed[1].init.headers.get('Origin'), null); assert.equal(observed[1].init.headers.get('authorization'), 'Bearer fixture-only');
  assert.equal(dispatches[1].kind, 'inference'); assert.equal(observed[1].init.credentials, 'omit'); assert.equal(observed[1].init.redirect, 'error');
});

test('unknown endpoints, RPC methods and direct-mode fallback never reach transport', async () => {
  let requests = 0;
  const relay = externalRelay(profile, origin, async () => {}, async () => { requests++; return new Response('{}'); });
  await assert.rejects(relay('https://openrouter.ai/api/v1/models'));
  await assert.rejects(relay('https://proxy.invalid/v1/chat/completions', { method: 'POST', body: '{}' }));
  await assert.rejects(relay(profile.rpcUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'requestAirdrop', params: [] }) }));
  assert.equal(requests, 0);
});

test('durable admission rejection prevents transaction/provider transport', async () => {
  let requests = 0;
  const relay = externalRelay(profile, origin, async () => { throw Error('already attempted'); }, async () => { requests++; return new Response('{}'); });
  await assert.rejects(relay('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: '{}' }), /already attempted/);
  await assert.rejects(relay(profile.rpcUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'sendTransaction', params: ['fixture'] }) }), /already attempted/);
  assert.equal(requests, 0);
});

test('public failure diagnostics use only allowlisted fields and never private messages', () => {
  assert.deepEqual(safeFailure(new Error('PRIVATE upstream body')), { kind: 'operation_failed' });
  assert.deepEqual(safeFailure(Object.assign(new Error('PRIVATE'), { name: 'ClientActionError', code: 'not_ready' })), { kind: 'client_action', code: 'not_ready' });
  assert.deepEqual(safeFailure(Object.assign(new Error('PRIVATE'), { name: 'ClientActionError', code: 'PRIVATE' })), { kind: 'operation_failed' });
  assert.deepEqual(safeFailure(new ChatResponseError('invalid_response', 'PRIVATE operation', 200)), { kind: 'chat_response', code: 'invalid_response', status: 200 });
});
