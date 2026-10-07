import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConsumer } from './prepare_public_consumer_acceptance.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'consumer-prepare-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle'), build = join(root, 'build'); await mkdir(bundle); await mkdir(build); await mkdir(join(build, 'assets'));
  const manifest = Buffer.from(JSON.stringify({ deployment_environment: 'devnet', cap_micro_usdc: '1000000', control_api_origin: 'https://preview.example', inference_api_origin: 'https://preview.example', manifest_hash: 'b'.repeat(64) }));
  await writeFile(join(bundle, 'manifest.json'), manifest);
  const descriptor = Buffer.from(JSON.stringify({ schema: 2, manifest: 'manifest.json', files: { 'manifest.json': { sha256: sha(manifest), bytes: manifest.length } } }));
  await writeFile(join(bundle, 'bundle.json'), descriptor);
  const profile = { schema: 1, protocolLayoutVersion: 2, sdkVersions: ['0.2.0-devnet.2'], mode: 'direct_openrouter', bundle: { url: 'https://preview.example/releases/r1/assets/bundle.json', sha256: sha(descriptor) }, rpcUrl: 'https://preview.example/rpc', indexerOrigin: 'https://preview.example', directProviderBases: { direct_openrouter: 'https://openrouter.ai/api/v1' }, models: [{ id: 'openai/gpt-4o-mini', provider: 'openrouter', apis: ['chat'], tariff: { tariff_hash: 'c'.repeat(64) } }], modelCapabilities: { 'openai/gpt-4o-mini': { streaming: true, tools: true } } };
  const bytes = Buffer.from(JSON.stringify(profile)); const profileFile = join(root, 'profile.json'); await writeFile(profileFile, bytes);
  await writeFile(join(build, 'index.html'), '<html><head><script type="module" src="/releases/r1/chat/assets/index.js"></script></head><body></body></html>');
  await writeFile(join(build, 'assets/index.js'), '/* synthetic build */'); await writeFile(join(build, 'zkapi-config.json'), 'null\n');
  const input = { schema: 1, label: 'Synthetic fixture', profileFile, profileUrl: 'https://preview.example/releases/r1/profile.json', profileSha256: sha(bytes), bundleDirectory: bundle, appBuildDirectory: build, appBase: '/releases/r1/chat/', sdkArchiveSha256: 'd'.repeat(64), nativeArchiveSha256: 'e'.repeat(64), nativeReleaseSha256: 'f'.repeat(64), grantAuthorizationSha256: null, model: 'openai/gpt-4o-mini' };
  return { root, input, profile, async rewriteProfile() { const bytes = Buffer.from(JSON.stringify(profile)); await writeFile(profileFile, bytes); input.profileSha256 = sha(bytes); } };
}
test('prepares exact release-path app, CSP, seven offline intents without network or source mutation', async t => {
  const f = await fixture(t); const savedFetch = globalThis.fetch; globalThis.fetch = () => { throw Error('network forbidden'); }; t.after(() => { globalThis.fetch = savedFetch; });
  const output = join(f.root, 'prepared'), result = await prepareConsumer(f.input, output);
  assert.equal(result.networkRequests, 0); assert.equal(result.financialActions, 0); assert.equal(result.appUrl, 'https://preview.example/releases/r1/chat/index.html');
  const plan = JSON.parse(await readFile(join(output, 'acceptance-plan.json'))); assert.equal(plan.cases.length, 7); assert.equal(new Set(plan.cases.map(x => x.intentId)).size, 7); assert(plan.cases.every(x => x.state === 'not_started'));
  assert.equal(plan.authorityVerified, false); assert.equal(plan.grantAuthorizationSha256, null); assert.equal(plan.nativeDepositMicroUsdc, '5000000');
  const config = JSON.parse(await readFile(join(output, 'app/zkapi-config.json'))); assert.equal(config.profileSha256, f.input.profileSha256); assert(!Object.hasOwn(config, 'invitation'));
  const csp = await readFile(join(output, 'csp.txt'), 'utf8'); assert(csp.includes("worker-src 'self'")); assert(csp.includes('https://openrouter.ai')); assert(!csp.includes("'unsafe-eval'"));
  assert((await readFile(join(output, 'app/index.html'), 'utf8')).includes('Content-Security-Policy'));
  assert.equal(await readFile(join(f.input.appBuildDirectory, 'zkapi-config.json'), 'utf8'), 'null\n');
  await assert.rejects(prepareConsumer(f.input, output));
});
test('rejects mismatched profile and bundle bytes before creating output', async t => {
  const f = await fixture(t); f.input.profileSha256 = '0'.repeat(64); await assert.rejects(prepareConsumer(f.input, join(f.root, 'bad')));
  await f.rewriteProfile(); await writeFile(join(f.input.bundleDirectory, 'bundle.json'), '{}'); await assert.rejects(prepareConsumer(f.input, join(f.root, 'bad2')));
});
test('refuses the wrong release build base and an existing app configuration', async t => {
  const f = await fixture(t); await writeFile(join(f.input.appBuildDirectory, 'index.html'), '<html><head><script src="/assets/index.js"></script></head></html>');
  await assert.rejects(prepareConsumer(f.input, join(f.root, 'bad')));
  await writeFile(join(f.input.appBuildDirectory, 'index.html'), '<head><script src="/releases/r1/chat/assets/index.js"></script></head>');
  await writeFile(join(f.input.appBuildDirectory, 'zkapi-config.json'), '{}'); await assert.rejects(prepareConsumer(f.input, join(f.root, 'bad2')));
});
test('requires the actual seven-case capability/model policy and excludes injected secret fields', async t => {
  const f = await fixture(t); await assert.rejects(prepareConsumer({ ...f.input, token: 'secret' }, join(f.root, 'secret')));
  f.profile.modelCapabilities[f.input.model].tools = false; await f.rewriteProfile(); await assert.rejects(prepareConsumer(f.input, join(f.root, 'tools')));
  f.profile.modelCapabilities[f.input.model].tools = true; f.profile.mode = 'proxy'; await f.rewriteProfile(); await assert.rejects(prepareConsumer(f.input, join(f.root, 'mode')));
});
test('rejects unreviewed local URL and symlinked public input', async t => {
  const f = await fixture(t); await assert.rejects(prepareConsumer({ ...f.input, profileUrl: 'https://127.0.0.1/releases/r1/profile.json' }, join(f.root, 'local')));
  await symlink(f.input.profileFile, join(f.root, 'alias.json')); await assert.rejects(prepareConsumer({ ...f.input, profileFile: join(f.root, 'alias.json') }, join(f.root, 'link')));
});
