import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDeploymentAssets, DeploymentAssetsError } from '../src/deployment.ts';
import { sha256Hex } from '../src/trust.ts';
import { publicProfileFixture } from './public-profile-fixture.ts';

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

async function noticedFixture() {
  const f = await publicProfileFixture();
  const notice = new TextEncoder().encode('Exact upstream notice.\n');
  const d = { ...f.descriptor, schema: 2, notices: { license: 'LICENSE.txt', provenance: 'PROVENANCE.md' } };
  for (const name of Object.values(d.notices)) {
    d.files[name] = { sha256: await sha256Hex(notice), bytes: notice.length };
    f.files.set('https://assets.example.com/' + name, notice);
  }
  const raw = bytes(d); f.files.set(f.profile.bundle.url, raw);
  return { ...f, notice, bundleSha256: await sha256Hex(raw) };
}

test('schema one retains exact validation and returns an empty notices map', async () => {
  const f = await publicProfileFixture();
  const assets = await loadDeploymentAssets(f.profile.bundle.url, { bundleSha256: f.profile.bundle.sha256, fetch: f.fetcher });
  assert.deepEqual(Object.keys(assets.notices), []);
  const raw = bytes({ ...f.descriptor, notices: {} });
  f.files.set(f.profile.bundle.url, raw); f.calls.length = 0;
  await assert.rejects(loadDeploymentAssets(f.profile.bundle.url, { bundleSha256: await sha256Hex(raw), fetch: f.fetcher }), DeploymentAssetsError);
  assert.equal(f.calls.length, 1);
});

test('schema two downloads and authenticates every notice alongside the proof assets', async () => {
  const f = await noticedFixture();
  const assets = await loadDeploymentAssets(f.profile.bundle.url, { bundleSha256: f.bundleSha256, fetch: f.fetcher });
  assert.deepEqual(Object.keys(assets.notices), ['license', 'provenance']);
  for (const value of Object.values(assets.notices)) assert.deepEqual(value, f.notice);
  assert.notEqual(assets.notices.license, assets.notices.provenance);
  assert.notEqual(assets.notices.license, f.notice);
  assert.equal(f.calls.filter(call => call.url.endsWith('/LICENSE.txt')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/PROVENANCE.md')).length, 1);
});

test('missing, changed or oversized schema two notice bytes fail the whole load without retry', async () => {
  for (const kind of ['missing', 'changed', 'oversized']) {
    const f = await noticedFixture(), url = 'https://assets.example.com/PROVENANCE.md';
    if (kind === 'missing') f.files.delete(url);
    else f.files.set(url, kind === 'changed' ? new Uint8Array(f.notice.length) : new Uint8Array(f.notice.length + 1));
    await assert.rejects(loadDeploymentAssets(f.profile.bundle.url, { bundleSha256: f.bundleSha256, fetch: f.fetcher }), DeploymentAssetsError);
    assert.equal(f.calls.filter(call => call.url === url).length, 1);
  }
});

test('schema two notice labels, paths, counts, references and size bounds reject before asset downloads', async () => {
  for (const mutate of [
    (d: any) => { delete d.notices; },
    (d: any) => { d.notices = {}; },
    (d: any) => { d.notices = []; },
    (d: any) => { d.notices = { '../license': 'NOTICE.txt' }; },
    (d: any) => { d.notices = { ['x'.repeat(129)]: 'NOTICE.txt' }; },
    (d: any) => { d.notices = { license: '../NOTICE.txt' }; },
    (d: any) => { d.notices = { license: 'bundle.json' }; },
    (d: any) => { d.notices = { license: 'manifest.json' }; },
    (d: any) => { d.notices = { license: 'prover.wasm' }; },
    (d: any) => { d.notices = { license: 'requestPk.bin' }; },
    (d: any) => { d.notices = { license: 'missing.txt' }; },
    (d: any) => { d.notices.second = 'NOTICE.txt'; },
    (d: any) => { d.files['NOTICE.txt'].bytes = 0; },
    (d: any) => { d.files['NOTICE.txt'].bytes = 1024 * 1024 + 1; },
    (d: any) => {
      for (let i = 0; i < 32; i++) { d.notices['n' + i] = 'n' + i; d.files['n' + i] = { sha256: '00'.repeat(32), bytes: 1 }; }
    },
    (d: any) => {
      d.files['NOTICE.txt'].bytes = 1024 * 1024;
      for (let i = 0; i < 4; i++) { d.notices['n' + i] = 'n' + i; d.files['n' + i] = { sha256: '00'.repeat(32), bytes: 1024 * 1024 }; }
    },
  ]) {
    const d: any = { ...descriptor(), schema: 2, notices: { license: 'NOTICE.txt' } };
    d.files['NOTICE.txt'] = { sha256: '00'.repeat(32), bytes: 1 }; mutate(d);
    const raw = bytes(d); let calls = 0;
    await assert.rejects(loadDeploymentAssets('https://example.com/bundle.json', { bundleSha256: await sha256Hex(raw),
      fetch: async () => { calls++; return new Response(raw); } }), DeploymentAssetsError);
    assert.equal(calls, 1);
  }
});
