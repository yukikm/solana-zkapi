/** Credential-free synthetic packaging checks, with no external network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageDeploymentAssets } from './package_sdk_distribution_assets.mjs';
import { publicProfileFixture } from '../packages/sdk/test/public-profile-fixture.ts';
import { loadDeploymentAssets } from '../packages/sdk/src/deployment.ts';
import { sha256Hex } from '../packages/sdk/src/trust.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'zkapi-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = await publicProfileFixture();
  for (const [url, bytes] of f.files) await writeFile(join(root, new URL(url).pathname.slice(1)), bytes);
  const input = join(root, 'input.json');
  const config: any = { schema: 1, trust: f.trust, manifest: 'manifest.json', artifacts: f.descriptor.artifacts, wasm: f.descriptor.wasm };
  await writeFile(join(root, 'source-notice.txt'), 'Unmodified upstream license.\n');
  const run = async (value: any, name = 'output') => {
    await writeFile(input, JSON.stringify(value));
    return packageDeploymentAssets(input, join(root, name));
  };
  return { root, config, run };
}

test('notice packaging copies exact public bytes and produces a loader-verifiable schema two descriptor', async t => {
  const f = await fixture(t);
  f.config.notices = { 'LICENSE.txt': 'source-notice.txt', 'PROVENANCE.md': 'source-notice.txt' };
  const result = await f.run(f.config);
  const root = join(f.root, 'output'), raw = await readFile(join(root, 'bundle.json'));
  const d = JSON.parse(raw.toString());
  assert.equal(d.schema, 2);
  assert.equal(result.bundleSha256, await sha256Hex(raw));
  assert.deepEqual(d.notices, { 'LICENSE.txt': 'LICENSE.txt', 'PROVENANCE.md': 'PROVENANCE.md' });
  assert.ok(!raw.toString().includes('source-notice.txt') && !raw.toString().includes(f.root));
  const notice = await readFile(join(f.root, 'source-notice.txt'));
  for (const name of Object.values(d.notices) as string[]) {
    assert.deepEqual(await readFile(join(root, name)), notice);
    assert.deepEqual(d.files[name], { sha256: await sha256Hex(notice), bytes: notice.length });
  }
  const loaded = await loadDeploymentAssets('https://fixture.example/bundle.json', {
    bundleSha256: result.bundleSha256,
    fetch: async (url, init) => {
      assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
      return new Response(new Uint8Array(await readFile(join(root, new URL(String(url)).pathname.slice(1)))));
    },
  });
  assert.deepEqual(loaded.notices['LICENSE.txt'], new Uint8Array(notice));
  assert.deepEqual(loaded.notices['PROVENANCE.md'], new Uint8Array(notice));
});

test('no-notice packaging retains schema one and refuses rewriting existing output', async t => {
  const f = await fixture(t);
  const first = await f.run(f.config), path = join(f.root, 'output', 'bundle.json'), before = await readFile(path);
  const d = JSON.parse(before.toString()); assert.equal(d.schema, 1); assert.equal(Object.hasOwn(d, 'notices'), false);
  f.config.notices = { 'LICENSE.txt': 'source-notice.txt' };
  await assert.rejects(f.run(f.config));
  assert.deepEqual(await readFile(path), before); assert.equal(await sha256Hex(before), first.bundleSha256);
});

test('notice destination traversal, core-file collisions and invalid counts fail before output creation', async t => {
  const f = await fixture(t);
  const candidates = [{}, [], ...['bundle.json', 'manifest.json', 'prover.wasm', 'requestPk.bin', '../NOTICE', '.hidden', 'a/b', 'x'.repeat(129)]
    .map(name => ({ [name]: 'source-notice.txt' })), Object.fromEntries(Array.from({ length: 33 }, (_, i) => ['n' + i, 'source-notice.txt']))];
  for (let i = 0; i < candidates.length; i++) {
    await assert.rejects(f.run({ ...f.config, notices: candidates[i] }, 'bad' + i));
    await assert.rejects(stat(join(f.root, 'bad' + i)), { code: 'ENOENT' });
  }
});

test('notice source files must be nonempty, regular, nonsymlink and at most one MiB', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'empty'), '');
  await writeFile(join(f.root, 'large'), new Uint8Array(1024 * 1024 + 1));
  await symlink(join(f.root, 'source-notice.txt'), join(f.root, 'linked'));
  for (const [i, path] of ['empty', 'large', 'linked', 'missing', '.'].entries()) {
    await assert.rejects(f.run({ ...f.config, notices: { 'NOTICE.txt': path } }, 'bad' + i));
    await assert.rejects(stat(join(f.root, 'bad' + i)), { code: 'ENOENT' });
  }
});

test('aggregate notice byte limit is enforced before output and allows the exact four MiB boundary', async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'large'), new Uint8Array(1024 * 1024));
  f.config.notices = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['n' + i, 'large']));
  await assert.rejects(f.run(f.config)); await assert.rejects(stat(join(f.root, 'output')), { code: 'ENOENT' });
  delete f.config.notices.n4;
  await f.run(f.config);
  const d = JSON.parse(await readFile(join(f.root, 'output', 'bundle.json'), 'utf8'));
  assert.equal(Object.keys(d.notices).length, 4);
});
