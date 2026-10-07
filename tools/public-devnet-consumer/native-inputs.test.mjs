import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeNetwork } from './native-inputs.mjs';

const manifest = { control_api_origin: 'https://control.example.com', inference_api_origin: 'https://proxy.example.com' };
const base = { rpcUrl: 'https://rpc.example.com/rpc', indexerOrigin: 'https://indexer.example.com' };

test('direct OpenRouter transport preserves actual provider base, without adding a second v1', () => {
  const network = nativeNetwork({ ...base, mode: 'direct_openrouter',
    directProviderBases: { direct_openrouter: 'https://openrouter.ai/api/v1' } }, manifest, { mode: 'direct' });
  assert.deepEqual(network.routes, [
    { origin: 'https://control.example.com', prefix: '/zkapi/v1' },
    { origin: 'https://indexer.example.com', prefix: '/zkapi/v1/tree' },
    { origin: 'https://rpc.example.com', prefix: '/rpc' },
    { origin: 'https://openrouter.ai', prefix: '/api/v1' },
  ]);
  assert.equal(network.routes.some(r => r.origin === manifest.inference_api_origin), false);
});

test('proxy and OA verifier routes derive only from reviewed profile values', () => {
  const proxy = nativeNetwork({ ...base, mode: 'proxy' }, manifest, { mode: 'tor', socks5: '127.0.0.1:9050' });
  assert.deepEqual(proxy.routes.at(-1), { origin: 'https://proxy.example.com', prefix: '/v1' });
  assert.equal(proxy.socks5, '127.0.0.1:9050');
  const oa = nativeNetwork({ ...base, mode: 'direct_oa', directProviderBases: { direct_oa: 'https://api.example.com/v1' },
    oaVerifier: { base: 'https://verifier.example.com/api' } }, manifest, { mode: 'direct' });
  assert.deepEqual(oa.routes.at(-1), { origin: 'https://verifier.example.com', prefix: '/api/submit_key' });
});

test('network mode is explicit and does not accept credentials or insecure destinations', () => {
  const profile = { ...base, mode: 'proxy' };
  for (const options of [undefined, {}, { mode: 'auto' }, { mode: 'tor' },
    { mode: 'direct', socks5: '127.0.0.1:9050' }, { mode: 'tor', socks5: 'proxy.example.com:9050' },
    { mode: 'tor', socks5: '127.0.0.1:65536' }]) assert.throws(() => nativeNetwork(profile, manifest, options));
  for (const rpcUrl of ['http://rpc.example.com', 'https://key@rpc.example.com', 'https://rpc.example.com/?api-key=secret'])
    assert.throws(() => nativeNetwork({ ...profile, rpcUrl }, manifest, { mode: 'direct' }));
});

test('native admission references only a private file and the authenticated control origin', () => {
  const network = nativeNetwork({ ...base, mode: 'proxy' }, manifest,
    { mode: 'direct', admissionTokenFile: '/private/invitation' });
  assert.deepEqual(network.admission, { origin: manifest.control_api_origin, token_file: '/private/invitation' });
  for (const admissionTokenFile of ['', 'relative', '/private/../invitation', '/private/invitation\n', 42])
    assert.throws(() => nativeNetwork({ ...base, mode: 'proxy' }, manifest, { mode: 'direct', admissionTokenFile }));
  assert.equal(Object.hasOwn(nativeNetwork({ ...base, mode: 'proxy' }, manifest, { mode: 'direct' }), 'admission'), false);
});
