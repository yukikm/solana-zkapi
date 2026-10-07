/** Repeatable offline negative checks against an explicitly supplied public bundle input. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { packageDeploymentAssets } from './package_sdk_distribution_assets.mjs';

assert.equal(process.argv.length, 3);
const input = resolve(process.argv[2]), base = dirname(input);
const config = JSON.parse(await readFile(input, 'utf8'));
config.manifest = resolve(base, config.manifest); config.wasm.path = resolve(base, config.wasm.path);
for (const [name, value] of Object.entries(config.artifacts)) {
  if (name === 'additional') for (const [key, path] of Object.entries(value)) value[key] = resolve(base, path);
  else config.artifacts[name] = resolve(base, value);
}
const directory = await mkdtemp(join(tmpdir(), 'zkapi-artifact-packer-')), checks = [];
try {
  for (const [name, mutate] of [
    ['manifest-anchor', c => { c.trust.anchor = { kind: 'hash', sha256: '00'.repeat(32) }; }],
    ['wasm-anchor', c => { c.wasm.sha256 = '00'.repeat(32); }],
    ['private-config-field', c => { c.rpcUrl = 'https://rpc.invalid/private'; }],
    ['missing-artifact', c => { delete c.artifacts.treePk; }],
  ]) {
    const changed = structuredClone(config); mutate(changed);
    const path = join(directory, name + '.json'), output = join(directory, name);
    await writeFile(path, JSON.stringify(changed));
    await assert.rejects(packageDeploymentAssets(path, output));
    await assert.rejects(lstat(output), { code: 'ENOENT' });
    checks.push({ name, rejected_before_output: true });
  }
  const validInput = join(directory, 'valid.json'), destination = join(directory, 'public');
  await writeFile(validInput, JSON.stringify(config));
  const original = await packageDeploymentAssets(validInput, destination), descriptor = await readFile(join(destination, 'bundle.json'));
  await assert.rejects(packageDeploymentAssets(validInput, destination), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(destination, 'bundle.json')), descriptor);
  checks.push({ name: 'existing-output-preserved', rejected: true });
  console.log(JSON.stringify({ passed: true, checks, bundle: original, network_actions: 0 }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
