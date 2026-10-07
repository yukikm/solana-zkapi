/** Offline public-app/acceptance preparation. Never fetches, signs, funds, reserves,
 * starts a service, executes a client, or initializes an authority. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStrictJson } from '../packages/sdk/dist/trust.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => assert.match(value, /^[a-f0-9]{64}$/);
const cases = ['B-01', 'B-02', 'B-03', 'N-01', 'N-02', 'N-03', 'N-04'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function exact(value, keys) { assert(plain(value)); assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
function publicUrl(value) {
  assert.equal(typeof value, 'string'); const u = new URL(value);
  assert.equal(u.protocol, 'https:'); assert(u.href === value || u.origin === value);
  assert(!u.username && !u.password && !u.search && !u.hash && !/%|\s/.test(value));
  assert(!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)); return u;
}
async function file(path, maximum) {
  assert(isAbsolute(path) && resolve(path) === path && await realpath(path) === path);
  const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= maximum);
  const bytes = await readFile(path); assert(bytes.length <= maximum); return bytes;
}
export function consumerCsp(profile, manifest, origin) {
  const urls = [profile.bundle.url, profile.rpcUrl, profile.indexerOrigin, manifest.control_api_origin,
    manifest.inference_api_origin, profile.directProviderBases.direct_openrouter];
  const connections = [...new Set(urls.map(value => publicUrl(value).origin))].sort();
  assert(connections.includes(origin));
  // The installed worker receives verified WASM bytes. No remote scripts or blob scripts.
  return "default-src 'none'; base-uri 'none'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' " + connections.join(' ') + "; form-action 'none'";
}
async function treeFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    assert(!entry.isSymbolicLink());
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    assert(!/[\\\x00-\x1f\x7f]/.test(relative));
    if (entry.isDirectory()) result.push(...await treeFiles(directory, relative));
    else { assert(entry.isFile()); result.push(relative); }
    assert(result.length <= 2048);
  }
  return result.sort();
}
export async function prepareConsumer(input, output) {
  exact(input, ['schema', 'label', 'profileFile', 'profileUrl', 'profileSha256', 'bundleDirectory', 'appBuildDirectory',
    'appBase', 'sdkArchiveSha256', 'nativeArchiveSha256', 'nativeReleaseSha256', 'grantAuthorizationSha256', 'model']);
  assert.equal(input.schema, 1); assert.equal(typeof input.label, 'string'); assert(input.label.length > 0 && input.label.length <= 100);
  for (const key of ['profileSha256', 'sdkArchiveSha256', 'nativeArchiveSha256', 'nativeReleaseSha256']) digest(input[key]);
  if (input.grantAuthorizationSha256 !== null) digest(input.grantAuthorizationSha256);
  assert.match(input.appBase, /^\/releases\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}\/chat\/$/);
  const profileUrl = publicUrl(input.profileUrl), releaseBase = input.appBase.slice(0, -5);
  assert.equal(profileUrl.pathname, releaseBase + 'profile.json');
  const profileBytes = await file(input.profileFile, 256 * 1024); assert.equal(hash(profileBytes), input.profileSha256);
  const profile = parseStrictJson(profileBytes, 256 * 1024);
  assert.equal(profile.schema, 1); assert.equal(profile.protocolLayoutVersion, 2); assert(profile.sdkVersions.includes('0.2.0-devnet.2'));
  assert.equal(profile.mode, 'direct_openrouter'); assert.equal(publicUrl(profile.bundle.url).origin, profileUrl.origin);
  assert(publicUrl(profile.bundle.url).pathname.startsWith(releaseBase + 'assets/'));
  assert.equal(publicUrl(profile.rpcUrl).origin, profileUrl.origin); assert.equal(publicUrl(profile.indexerOrigin).origin, profileUrl.origin);
  const model = profile.models.filter(x => x.id === input.model);
  assert.equal(model.length, 1); assert.equal(model[0].provider, 'openrouter'); assert(model[0].apis.includes('chat'));
  const capability = profile.modelCapabilities[input.model]; assert(capability.streaming === true && capability.tools === true);
  digest(model[0].tariff.tariff_hash);
  assert(isAbsolute(input.bundleDirectory) && await realpath(input.bundleDirectory) === input.bundleDirectory);
  const bundleBytes = await file(join(input.bundleDirectory, 'bundle.json'), 1024 * 1024); assert.equal(hash(bundleBytes), profile.bundle.sha256);
  const bundle = parseStrictJson(bundleBytes); assert.match(bundle.manifest, /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}$/);
  const manifestBytes = await file(join(input.bundleDirectory, bundle.manifest), 1024 * 1024);
  assert.equal(hash(manifestBytes), bundle.files[bundle.manifest].sha256); assert.equal(manifestBytes.length, bundle.files[bundle.manifest].bytes);
  const manifest = parseStrictJson(manifestBytes);
  assert.equal(manifest.deployment_environment, 'devnet'); assert.equal(manifest.cap_micro_usdc, '1000000');
  assert.equal(publicUrl(manifest.control_api_origin).origin, profileUrl.origin);
  assert.equal(manifest.control_api_origin, profileUrl.origin); digest(manifest.manifest_hash);
  const csp = consumerCsp(profile, manifest, profileUrl.origin);
  assert(isAbsolute(input.appBuildDirectory) && await realpath(input.appBuildDirectory) === input.appBuildDirectory);
  const files = await treeFiles(input.appBuildDirectory); assert(files.includes('index.html') && files.includes('zkapi-config.json'));
  const html = (await file(join(input.appBuildDirectory, 'index.html'), 1024 * 1024)).toString('utf8');
  assert(html.includes(`src="${input.appBase}assets/`)); assert(!html.includes('http-equiv="Content-Security-Policy"'));
  assert.equal(parseStrictJson(await file(join(input.appBuildDirectory, 'zkapi-config.json'), 256 * 1024)), null);
  assert(isAbsolute(output) && resolve(output) === output && join(await realpath(dirname(output)), basename(output)) === output);
  // Validate every input first; a partially written new output is preserved for review.
  await mkdir(output, { mode: 0o700 }); await mkdir(join(output, 'app'), { mode: 0o700 });
  const hashes = {}; let totalBytes = 0;
  async function write(name, bytes) {
    totalBytes += bytes.length; assert(totalBytes <= 64 * 1024 * 1024);
    const target = join(output, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); hashes[name] = { sha256: hash(bytes), bytes: bytes.length };
  }
  const config = { schema: 2, chain: 'solana:devnet', label: input.label, profileUrl: input.profileUrl, profileSha256: input.profileSha256 };
  for (const name of files) {
    let bytes = await file(join(input.appBuildDirectory, name), 16 * 1024 * 1024);
    if (name === 'zkapi-config.json') bytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
    if (name === 'index.html') bytes = Buffer.from(html.replace('<head>', '<head>\n    <meta http-equiv="Content-Security-Policy" content="' + csp + '" />'));
    await write('app/' + name, bytes);
  }
  await write('csp.txt', Buffer.from(csp + '\n'));
  await write('native-N-01.json', Buffer.from(JSON.stringify({ model: input.model, stream: false, max_tokens: 128,
    messages: [{ role: 'user', content: 'Reply exactly PUBLIC NATIVE JSON VERIFIED.' }] }, null, 2) + '\n'));
  await write('native-N-04.json', Buffer.from(JSON.stringify({ model: input.model, stream: true, max_tokens: 128,
    messages: [{ role: 'user', content: 'Count slowly from one to twenty, one word per line.' }] }, null, 2) + '\n'));
  await write('openclaw-probe.txt', Buffer.from('PUBLIC OPENCLAW READ VERIFIED\n'));
  const plan = { schema: 1, kind: 'public_consumer_acceptance_preparation', generatedAt: new Date().toISOString(),
    publicAppUrl: profileUrl.origin + input.appBase + 'index.html', appBase: input.appBase, profileUrl: input.profileUrl,
    profileSha256: input.profileSha256, bundleSha256: profile.bundle.sha256, manifestHash: manifest.manifest_hash,
    sdkArchiveSha256: input.sdkArchiveSha256, nativeArchiveSha256: input.nativeArchiveSha256, nativeReleaseSha256: input.nativeReleaseSha256,
    grantAuthorizationSha256: input.grantAuthorizationSha256, model: input.model, tariffSha256: model[0].tariff.tariff_hash,
    mode: profile.mode, sessionTtlSeconds: 60, maxOutputTokens: 128, capMicroUsdc: '1000000', maxNewAuthorizations: 7,
    browserDepositMicroUsdc: '4000000', nativeDepositMicroUsdc: '5000000',
    cases: cases.map(id => ({ id, intentId: randomUUID(), maxNewAuthorizations: 1, state: 'not_started' })),
    automaticallyExecute: false, publicDownloadVerified: false, sdkPreflightPassed: false, authorityVerified: false,
    providerRequests: 0, walletTransactions: 0, reservations: 0, files: hashes,
    warning: 'Offline preparation only. Actual pins, public download/preflight, authority and custody must be reviewed before each deliberate live action. Failed cases have no replacement allowance.' };
  await writeFile(join(output, 'acceptance-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { output, appUrl: plan.publicAppUrl, files: Object.keys(hashes).length, profileSha256: plan.profileSha256,
    grantPresent: plan.grantAuthorizationSha256 !== null, financialActions: 0, networkRequests: 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert.equal(process.argv.length, 4);
    console.log(JSON.stringify(await prepareConsumer(parseStrictJson(await file(resolve(process.argv[2]), 256 * 1024), 256 * 1024), resolve(process.argv[3])), null, 2));
  } catch { console.error(JSON.stringify({ error: 'consumer_preparation_rejected', financialActions: 0, networkRequests: 0 })); process.exitCode = 1; }
}
