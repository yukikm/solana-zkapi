import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDeploymentAssets, DeploymentAssetsError } from '../src/deployment.ts';
import { sha256Hex } from '../src/trust.ts';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
test('deployment loader requires independent descriptor pin and safe public transport before fetching', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw Error('private request details'); };
  for (const url of ['https://user:secret@example.com/bundle.json', 'http://remote.invalid/bundle.json', 'file:///tmp/bundle.json', 'https://example.com/bundle.json?key=private']) {
    await assert.rejects(loadDeploymentAssets(url, { bundleSha256: '00'.repeat(32), fetch: fetcher }), DeploymentAssetsError);
  }
  await assert.rejects(loadDeploymentAssets('https://example.com/bundle.json', { bundleSha256: '', fetch: fetcher }), DeploymentAssetsError);
  assert.equal(calls, 0);
});

test('descriptor mismatch prevents every artifact download and omits credentials', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++; assert.equal(init?.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    return new Response('{}');
  };
  await assert.rejects(loadDeploymentAssets('https://example.com/bundle.json', { bundleSha256: '00'.repeat(32), fetch: fetcher }), DeploymentAssetsError);
  assert.equal(calls, 1);
});

function descriptor() {
  const names = ['idl', 'requestPk', 'requestVk', 'withdrawalPk', 'withdrawalVk', 'treePk', 'treeVk', 'treeSourceBundle', 'treeVerifierConstants'];
  const artifacts = { ...Object.fromEntries(names.map(name => [name, name + '.bin'])), additional: {} };
  const files = Object.fromEntries(['manifest.json', ...names.map(name => name + '.bin'), 'prover.wasm'].map(name => [name, { sha256: '00'.repeat(32), bytes: 1 }]));
  return { schema: 1, trust: {}, manifest: 'manifest.json', artifacts, wasm: { path: 'prover.wasm', sha256: '00'.repeat(32) }, files };
}

test('pinned descriptors cannot escape their static directory or remove artifact size bounds', async () => {
  for (const mutate of [
    (d: any) => { d.manifest = '../private-key'; },
    (d: any) => { d.manifest = 'https://evil.invalid/manifest'; },
    (d: any) => { d.manifest = '%2e%2e%2fprivate'; },
    (d: any) => { d.artifacts.idl = d.manifest; },
    (d: any) => { d.files['manifest.json'].bytes = 1024 * 1024 * 1024; },
    (d: any) => { d.files.extra = { sha256: '00'.repeat(32), bytes: 1 }; },
  ]) {
    const d = descriptor(); mutate(d); const raw = bytes(d); let calls = 0;
    await assert.rejects(loadDeploymentAssets('https://example.com/bundle.json', { bundleSha256: await sha256Hex(raw),
      fetch: async () => { calls++; return new Response(raw); } }), DeploymentAssetsError);
    assert.equal(calls, 1);
  }
});

test('oversized descriptor streams are canceled and private stream errors stay redacted', async () => {
  let canceled = false;
  await assert.rejects(loadDeploymentAssets('https://example.com/bundle.json', { bundleSha256: '00'.repeat(32), fetch: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
    cancel() { canceled = true; throw Error('PRIVATE'); },
  })) }), error => error instanceof DeploymentAssetsError && !error.message.includes('PRIVATE'));
  assert.equal(canceled, true);
});

test('overall deadline and caller abort reach a pending fetch without retry', async () => {
  for (const callerAbort of [false, true]) {
    let calls = 0; const caller = new AbortController();
    const pending = loadDeploymentAssets('https://example.com/bundle.json', { bundleSha256: '00'.repeat(32), timeoutMs: callerAbort ? 1000 : 15,
      signal: caller.signal, fetch: async (_url, init) => {
        calls++; return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('private canceled URL')), { once: true }));
      } });
    if (callerAbort) caller.abort();
    await assert.rejects(pending, DeploymentAssetsError); assert.equal(calls, 1);
  }
});

test('deadline bounds custom stalled response bodies, cancellation and fetch implementations', async () => {
  let canceled = false;
  const start = Date.now();
  await assert.rejects(loadDeploymentAssets('https://example.com/bundle.json', { bundleSha256: '00'.repeat(32), timeoutMs: 15,
    fetch: async () => new Response(new ReadableStream({ cancel() { canceled = true; return new Promise(() => {}); } })),
  }), DeploymentAssetsError);
  assert.equal(canceled, true); assert.ok(Date.now() - start < 2000);
  await assert.rejects(loadDeploymentAssets('https://example.com/bundle.json', { bundleSha256: '00'.repeat(32), timeoutMs: 15,
    fetch: async () => new Promise(() => {}),
  }), DeploymentAssetsError);
});
