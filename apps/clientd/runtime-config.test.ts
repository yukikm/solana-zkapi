import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { loadPublicDeploymentProfile } from '@zkapi/solana-sdk/public-profile';
import { sha256Hex } from '@zkapi/solana-sdk/trust';
import { gatewayPublicProfileFixture } from '../../packages/sdk/test/gateway-public-profile-fixture.ts';
import { publicProfileFixture } from '../../packages/sdk/test/public-profile-fixture.ts';
import { validateConfigurationCommand, ConfigurationError } from './runtime-config.ts';
// Internal installer adapter; public profile provenance is checked by installNativeInputs.
// @ts-ignore JavaScript installer has no public SDK declaration.
import { installNativeInputs } from '../../tools/public-devnet-consumer/native-inputs.mjs';

async function fixture(selection: 'legacy' | 'api' | 'mixed' | 'gateway') {
  const f = selection === 'gateway' ? await gatewayPublicProfileFixture() : await publicProfileFixture(selection === 'legacy' ? {} : { schema: 2, selection });
  const loaded = await loadPublicDeploymentProfile(f.profileUrl, { profileSha256: await f.profileSha256(), fetch: f.fetcher });
  const parent = resolve('target/native-config-tests'); await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'run-'));
  const receipt = await installNativeInputs(loaded, join(root, 'inputs'), { mode: 'direct' });
  const distribution = join(root, 'install'), files: Record<string,string> = {};
  await mkdir(distribution, { mode: 0o700 });
  for (const name of ['bin/node','apps/clientd/runtime.ts','apps/clientd/runtime-config.ts','apps/clientd/runtime-delivery.ts','bin/zkapi-client-prover','bin/zkapi-client-verify']) {
    const bytes = new TextEncoder().encode('offline artifact fixture ' + name), path = join(distribution, name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 }); files[name] = await sha256Hex(bytes);
  }
  const release = join(distribution, 'release.json'), releaseBytes = new TextEncoder().encode(JSON.stringify({ schema: 1, files, platform: 'fixture', upstream: 'fixture' }));
  await writeFile(release, releaseBytes, { mode: 0o600 });
  const args = ['--validate-config','--distribution',release,'--distribution-sha256',await sha256Hex(releaseBytes),
    '--runtime-config',receipt.runtime,'--runtime-sha256',receipt.runtimeSha256];
  return { args, root, receipt, f, loaded };
}

test('offline native validator accepts API-only, mixed and legacy and creates no custody or network activity', async () => {
  for (const selection of ['api','mixed','legacy','gateway'] as const) {
    const f = await fixture(selection), network = globalThis.fetch; let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
    try {
      const result = await validateConfigurationCommand(f.args);
      assert.equal(result.valid, true); assert.equal(result.networkActions, 0); assert.equal(result.custodyInitialized, false);
      assert.equal(result.models.length, selection === 'api' || selection === 'gateway' ? 0 : 1);
      assert.equal(result.operations.length, selection === 'legacy' ? 0 : 1);
      assert.equal(calls, 0);
      assert.deepEqual((await readdir(f.root)).sort(), ['inputs','install']);
      if (selection !== 'legacy') {
        const receipt = JSON.parse(await readFile(join(f.root, 'inputs', 'installation.json'),'utf8'));
        const tariff = await readFile(join(f.root,'inputs',receipt.services[0].file));
        assert.equal(await sha256Hex(tariff), receipt.services[0].sha256);
        assert.equal(tariff.length, receipt.services[0].bytes);
      }
    } finally { globalThis.fetch = network; }
  }
});

test('offline native configuration pins and container grammar reject before any financial output', async () => {
  const f = await fixture('api');
  for (const args of [f.args.slice(0,-2), [...f.args,'--unknown','secret'], ['--validate-config',...f.args.slice(1), 'socket'],
    f.args.map((value,index) => index===4 ? value.toUpperCase() : value),
    f.args.map((value,index) => index===7 ? '--distribution' : value)]) {
    await assert.rejects(validateConfigurationCommand(args), ConfigurationError);
  }
  await writeFile(join(f.root,'inputs','api-tariff-0.json'), '{"SECRET_CANARY":true}', { mode: 0o600 });
  await assert.rejects(validateConfigurationCommand(f.args), e => e instanceof ConfigurationError && !e.message.includes('SECRET_CANARY'));
  assert.deepEqual((await readdir(f.root)).sort(), ['inputs','install']);
});

test('native validator CLI ABI emits one bounded JSON value or sanitized stderr without reading stdin', async () => {
  const f = await fixture('api');
  async function invoke(args: string[]) {
    const child = spawn(process.execPath, [resolve('apps/clientd/runtime.ts'), ...args], { stdio: ['pipe','pipe','pipe'] });
    // Intentionally leave stdin open. Validation must branch before secret input.
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    const code = await new Promise<number|null>(resolve => child.once('exit', resolve));
    clearTimeout(timeout); child.stdin.destroy(); return {code,stdout,stderr};
  }
  const good = await invoke(f.args);
  assert.equal(good.code,0); assert.equal(good.stderr,''); assert.equal(good.stdout.split('\n').length,2); assert.equal(JSON.parse(good.stdout).valid,true);
  const invalid = await invoke([...f.args,'--secret','SECRET_CANARY']);
  assert.equal(invalid.code,2); assert.equal(invalid.stdout,''); assert.deepEqual(JSON.parse(invalid.stderr),{schema:1,error:{code:'invalid_schema'}});
  const missing = f.args.map((value,index) => index===6 ? join(f.root,'missing.json') : value), failure = await invoke(missing);
  assert.equal(failure.code,1); assert.equal(failure.stdout,''); assert.equal(JSON.parse(failure.stderr).error.code,'artifact_verification_failed');
});


test('native release inventory larger than one MiB validates within its explicit sixteen-MiB bound', async () => {
  const f=await fixture('api'),release=f.args[2];
  const value=JSON.parse(await readFile(release,'utf8'));value.platform='fixture '+ 'x'.repeat(1024*1024);
  const bytes=new TextEncoder().encode(JSON.stringify(value));await writeFile(release,bytes,{mode:0o600});f.args[4]=await sha256Hex(bytes);
  assert.equal((await validateConfigurationCommand(f.args)).valid,true);
});

test('ordinary startup rejects missing profile bindings before initializing custody', async () => {
  const f = await fixture('api');
  const source = JSON.parse(await readFile(f.receipt.runtime, 'utf8'));
  const release = JSON.parse(await readFile(f.args[2], 'utf8'));
  for (const kind of ['prover','verifier'] as const) {
    const name = kind === 'prover' ? 'bin/zkapi-client-prover' : 'bin/zkapi-client-verify';
    source[kind] = { path: join(dirname(f.args[2]), name), sha256: release.files[name] };
  }
  for (const missing of ['journal','custody','note_id']) {
    const directory = join(f.root, `missing-${missing}`); await mkdir(directory, { mode: 0o700 });
    const custody = join(directory, 'custody.json');
    const config = { ...source, journal: join(directory, 'journal'), custody, note_id: 'fresh-note' };
    delete config[missing];
    const path = join(directory, 'runtime.json'); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(process.execPath, [resolve('apps/clientd/runtime.ts'), path, join(directory,'socket'), join(directory,'relay')], { stdio: ['pipe','pipe','pipe'] });
    let stdout = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.resume();
    child.stdin.write(JSON.stringify({ passphrase: 'synthetic validation password', initialize_key: true }) + '\n');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const code = await new Promise<number|null>(resolve => child.once('exit', resolve));
    clearTimeout(timer); child.stdin.destroy();
    assert.equal(code, 1, missing); assert.equal(stdout, '');
    await assert.rejects(lstat(custody), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), ['runtime.json']);
  }
});
