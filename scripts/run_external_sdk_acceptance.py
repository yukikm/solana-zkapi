#!/usr/bin/env python3
"""Install a real SDK tarball outside the checkout and test its public exports.

Provider, chain and lifecycle responses are fixtures. Optional native/WASM
verification uses separately copied real artifacts; never reads .env or journals.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'target/sdk-distribution')
    parser.add_argument('--real-provers', action='store_true', help='Require existing real native/WASM artifacts and test them from the isolated consumer')
    parser.add_argument('--asset-bundle', type=Path, help='Verify a separately prepared public asset bundle in the isolated consumer')
    parser.add_argument('--asset-bundle-sha256', help='Independent SHA-256 of the public bundle.json descriptor')
    args = parser.parse_args()
    if bool(args.asset_bundle) != bool(args.asset_bundle_sha256):
        parser.error('--asset-bundle and --asset-bundle-sha256 must be supplied together')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    bundled_node = ROOT / 'target/i08-toolchain/bin/node'
    selected_node = os.environ.get('ZKAPI_NODE') or (str(bundled_node) if bundled_node.is_file() else 'node')
    resolved_node = shutil.which(selected_node)
    if not resolved_node:
        raise SystemExit('Set ZKAPI_NODE to the pinned Node 24.19.0 executable')
    node = Path(resolved_node).resolve()
    node_dir = node.parent
    env = {**os.environ, 'PATH': str(node_dir) + os.pathsep + os.environ.get('PATH', '')}
    env.pop('NODE_PATH', None)
    env.pop('NODE_OPTIONS', None)
    stages: list[dict] = []
    started = time.monotonic()
    source_paths = [*sorted((ROOT / 'packages/sdk/src').glob('*.ts')),
                    *[ROOT / 'packages/sdk' / name for name in ['package.json', 'build.mjs', 'tsconfig.json', 'tsconfig.build.json', 'README.md', 'DISTRIBUTION.md', 'INTERNALS.md', 'LICENSE']],
                    *[ROOT / 'packages/sdk/test' / name for name in ['client.test.ts', 'chat.test.ts', 'clientd-models.test.ts', 'trust.test.ts', 'deployment.test.ts', 'public-profile.test.ts', 'public-profile-fixture.ts', 'chain-fixture.ts', 'session-snapshot-runtime.ts', 'kit-helpers.ts']],
                    *sorted((ROOT / 'tools/public-devnet-consumer').glob('*.*')),
                    Path(__file__).resolve()]
    source_inputs = {str(path.relative_to(ROOT)): sha(path) for path in source_paths}
    report = {'schema': 1, 'scope': 'Actual npm tarball in an independent temporary application; local fixtures, no live provider or chain actions',
              'public_chain_verified': False, 'live_provider_verified': False, 'release_gates_passed': [], 'stages': stages, 'source_inputs': source_inputs}

    def run(name: str, command: list[str], cwd: Path, timeout: int = 300, extra_env: dict | None = None) -> str:
        start = time.monotonic()
        completed = subprocess.run(command, cwd=cwd, env={**env, **(extra_env or {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout)
        log = output / (name + '.log')
        log.write_text(completed.stdout)
        stages.append({'name': name, 'exit_code': completed.returncode, 'seconds': round(time.monotonic() - start, 3),
                       'log': log.name, 'log_sha256': sha(log)})
        if completed.returncode:
            raise RuntimeError(f'{name} failed; see {log}')
        return completed.stdout

    try:
        report['node_version'] = run('node-version', [str(node), '--version'], ROOT).strip()
        assert report['node_version'] == 'v24.19.0', 'pinned Node 24.19.0 is required'
        run('pack', ['npm', 'pack', '--workspace', '@zkapi/solana-sdk', '--pack-destination', str(output)], ROOT)
        package = json.loads((ROOT / 'packages/sdk/package.json').read_text())
        tarball = output / f"zkapi-solana-sdk-{package['version']}.tgz"
        report['tarball'] = {'file': tarball.name, 'sha256': sha(tarball), 'bytes': tarball.stat().st_size}
        with tarfile.open(tarball) as archive:
            names = []
            for item in archive.getmembers():
                assert item.isfile(), 'tarball must contain only regular files'
                name = item.name.removeprefix('package/')
                assert item.name.startswith('package/'), 'unexpected tarball root'
                assert re.fullmatch(r'dist/[a-z0-9-]+\.(js|d\.ts)', name) or name in ['package.json', 'README.md', 'DISTRIBUTION.md', 'INTERNALS.md', 'LICENSE'], f'unexpected package file: {name}'
                names.append(name)
                if name.startswith('dist/'):
                    source = archive.extractfile(item).read().decode()
                    assert not re.search(r"(?:from|import)\s*(?:\(\s*)?['\"][^'\"]*\.ts['\"]", source), f'source TypeScript import in {name}'
                    assert str(ROOT) not in source, 'workspace path in compiled package'
            assert len(names) == len(set(names)), 'duplicate tarball member'
        report['package_files'] = names
        with tempfile.TemporaryDirectory(prefix='zkapi-external-sdk-') as directory:
            consumer = Path(directory).resolve()
            assert not consumer.is_relative_to(ROOT)
            shutil.copyfile(tarball, consumer / tarball.name)
            (consumer / 'package.json').write_text(json.dumps({'name': 'independent-zkapi-consumer', 'private': True, 'type': 'module',
                'dependencies': {'@zkapi/solana-sdk': './' + tarball.name},
                'devDependencies': {'typescript': '5.9.3', '@types/node': '24.10.0', 'esbuild': '0.28.2'}}, indent=2))
            run('install', ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
            installed = consumer / 'node_modules/@zkapi/solana-sdk'
            assert installed.is_dir() and not installed.is_symlink()
            assert not (installed / 'src').exists()
            for name in names:
                if name.startswith('dist/'):
                    assert (installed / name).is_file()
            shutil.copyfile(consumer / 'package-lock.json', output / 'consumer-package-lock.json')
            report['consumer_lock_sha256'] = sha(output / 'consumer-package-lock.json')
            paths = list(package['exports'])
            imports = [(key, '@zkapi/solana-sdk' + (key[1:] if key != '.' else '')) for key in paths]
            (consumer / 'imports.mjs').write_text("import assert from 'node:assert/strict';\n" + '\n'.join(
                f"assert.ok(Object.keys(await import({json.dumps(path)})).length > 0);" for key, path in imports if key != './prover-worker') +
                "\nawait assert.rejects(import('@zkapi/solana-sdk/src/client.ts'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });\n" +
                "await assert.rejects(import('@zkapi/solana-sdk/dist/client.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });\nconsole.log('compiled exports and private-path boundary passed');\n")
            installed_lock = json.loads((consumer / 'package-lock.json').read_text())
            forbidden = ('@solana/web3.js', '@solana/web3-compat')
            assert not any(location.endswith('node_modules/' + name)
                           for location in installed_lock['packages'] for name in forbidden)
            report['solana_client'] = json.loads((consumer / 'node_modules/@solana/kit/package.json').read_text())['version']
            assert report['solana_client'] == '8.4.0'
            report['legacy_solana_dependencies'] = []
            run('node-exports', ['node', 'imports.mjs'], consumer)
            (consumer / 'types.ts').write_text('\n'.join(f"import * as api{index} from {json.dumps(path)};\nvoid api{index};" for index, (_key, path) in enumerate(imports)))
            (consumer / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {'target': 'ES2023', 'module': 'NodeNext', 'moduleResolution': 'NodeNext', 'strict': True, 'noEmit': True, 'lib': ['ES2023', 'DOM'], 'types': ['node']}, 'files': ['types.ts']}))
            run('declarations', ['node', 'node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], consumer)
            # Reuse source tests but redirect every runtime library import to the
            # installed package. Fixtures are explicit local copies, not imports.
            test_names = ['client.test.ts', 'chat.test.ts', 'clientd-models.test.ts', 'trust.test.ts', 'deployment.test.ts', 'public-profile.test.ts', 'public-profile-fixture.ts', 'chain-fixture.ts', 'kit-helpers.ts']
            if args.real_provers:
                test_names.append('session-snapshot-runtime.ts')
            for name in test_names:
                content = (ROOT / 'packages/sdk/test' / name).read_text()
                content = re.sub(r"(['\"])\.\./src/([a-z0-9-]+)\.ts\1", lambda m: "'@zkapi/solana-sdk" + ('' if m[2] == 'client' else '/' + m[2]) + "'", content)
                content = content.replace("new URL('../../../' + path, import.meta.url)", "new URL('./fixtures/' + path, import.meta.url)")
                content = content.replace("new URL('../../../'+p,import.meta.url)", "new URL('./fixtures/'+p,import.meta.url)")
                for name_in_fixture in re.findall(r"(?<![.\w])read\('([^']+)'\)", content):
                    path = consumer / 'fixtures' / name_in_fixture
                    path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(ROOT / name_in_fixture, path)
                assert '../src/' not in content
                (consumer / name).write_text(content)
            test_output = run('installed-lifecycle-trust', ['node', '--test', '--test-reporter=tap', *[name for name in test_names if name.endswith('.test.ts')]], consumer)
            counts = {key: int(value) for key, value in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', test_output, re.MULTILINE)}
            assert set(counts) == {'tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'} and counts['pass'] > 0 and counts['tests'] == counts['pass'] and all(counts[key] == 0 for key in ['fail', 'cancelled', 'skipped', 'todo']), 'installed suite must execute every test without skips'
            report['installed_tests'] = counts
            example = consumer / 'public-consumer'
            example.mkdir()
            for source in sorted((ROOT / 'tools/public-devnet-consumer').glob('*.*')):
                shutil.copyfile(source, example / source.name)
            run('public-consumer-help', ['node', 'public-consumer/cli.mjs', '--help'], consumer)
            run('public-consumer-network', ['node', '--test', 'public-consumer/native-inputs.test.mjs'], consumer)
            run('public-consumer-browser-adapter', ['node', '--experimental-test-module-mocks', '--test',
                'public-consumer/browser.test.mjs'], consumer)
            (consumer / 'public-consumer-install.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicProfileFixture } from './public-profile-fixture.ts';
import { loadPublicDeploymentProfile } from '@zkapi/solana-sdk/public-profile';
import { jcsBytes, sha256Hex } from '@zkapi/solana-sdk/trust';
import { installNativeInputs } from './public-consumer/native-inputs.mjs';
for (const schema of [1,2]) test('native schema '+schema+' files retain authenticated notices; no financial sends or overwrite', async () => {
  const f = await publicProfileFixture();
  const notice=new TextEncoder().encode('Synthetic upstream license notice');
  if(schema===2) {
    const descriptor={...f.descriptor,schema:2,notices:{'runtime.json':'NOTICE.txt'},files:{...f.descriptor.files,
      'NOTICE.txt':{sha256:await sha256Hex(notice),bytes:notice.length}}};
    const bytes=jcsBytes(descriptor);f.files.set('https://assets.example.com/NOTICE.txt',notice);
    f.files.set(f.profile.bundle.url,bytes);f.profile.bundle.sha256=await sha256Hex(bytes);
  }
  const loaded = await loadPublicDeploymentProfile(f.profileUrl, {profileSha256: await f.profileSha256(), fetch:f.fetcher});
  if(schema===2)loaded.assets.notices['runtime.json'].fill(0);
  const root = await realpath(await mkdtemp(join(tmpdir(),'zkapi-profile-install-'))), destination=join(root,'inputs');
  const before=f.calls.length;
  const receipt=await installNativeInputs(loaded,destination,{mode:'direct'});
  assert.equal(f.calls.length,before); assert.equal(receipt.custodyInitialized,false); assert.equal(receipt.funded,false);
  const runtimeBytes=await readFile(receipt.runtime), runtime=JSON.parse(runtimeBytes);
  assert.equal(await sha256Hex(runtimeBytes),receipt.runtimeSha256);
  assert.equal(runtime.key_reuse_seconds,60); assert.deepEqual(runtime.models[0].capabilities,{streaming:true,tools:false});
  assert.equal(runtime.settlement_wait_ms,120000);
  assert.equal(runtime.models[0].tariff,join(destination,'tariff-0.json'));
  assert.equal(runtime.rpc,f.profile.rpcUrl); assert.equal(runtime.indexer,f.profile.indexerOrigin);
  assert.deepEqual(runtime.policy,f.trust); assert.equal(runtime.mode,'direct_openrouter');
  assert.equal((await stat(destination)).mode & 0o777,0o700); assert.equal((await stat(receipt.runtime)).mode & 0o777,0o600);
  const noticeIndexBytes=await readFile(receipt.notices), noticeIndex=JSON.parse(noticeIndexBytes);
  assert.equal(await sha256Hex(noticeIndexBytes),receipt.noticesSha256);
  assert.equal(noticeIndex.schema,1);
  if(schema===1)assert.deepEqual(noticeIndex.notices,{});
  else {
    assert.deepEqual(noticeIndex.notices,{'runtime.json':{file:'notice-0.bin',sha256:await sha256Hex(notice),bytes:notice.length}});
    const noticePath=join(destination,noticeIndex.notices['runtime.json'].file);
    assert.deepEqual(new Uint8Array(await readFile(noticePath)),notice);
    assert.equal((await stat(noticePath)).mode & 0o777,0o600);
  }
  assert(!('journal' in runtime)); assert(!('custody' in runtime));
  await assert.rejects(installNativeInputs(loaded,destination,{mode:'direct'}));
  assert.deepEqual(await readFile(receipt.runtime),runtimeBytes);
  await assert.rejects(installNativeInputs({...loaded},join(root,'forged'),{mode:'direct'}));
  await symlink(root,join(root,'alias'));
  await assert.rejects(installNativeInputs(loaded,join(root,'alias','other'),{mode:'direct'}));
});
""")
            run('public-consumer-install', ['node', '--test', 'public-consumer-install.test.mjs'], consumer)
            (consumer / 'public-consumer.tsconfig.json').write_text(json.dumps({'compilerOptions': {
                'target': 'ES2023', 'module': 'NodeNext', 'moduleResolution': 'NodeNext', 'strict': True,
                'noEmit': True, 'lib': ['ES2023', 'DOM'], 'types': ['node']},
                'files': ['public-consumer/browser.ts', 'public-consumer/worker.ts']}))
            run('public-consumer-types', ['node', 'node_modules/typescript/bin/tsc', '-p', 'public-consumer.tsconfig.json'], consumer)
            if args.real_provers:
                artifacts = consumer / 'provers'
                artifacts.mkdir()
                originals = {'native': ROOT / 'apps/clientd/prover/target/release/zkapi-client-prover',
                             'wasm': ROOT / 'apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm'}
                report['real_prover_artifacts'] = {name: {'sha256': sha(path), 'bytes': path.stat().st_size} for name, path in originals.items()}
                for name, path in originals.items():
                    shutil.copyfile(path, artifacts / name)
                    (artifacts / name).chmod(0o700 if name == 'native' else 0o600)
                fixture = consumer / 'tests/fixtures/layout2/a.json'
                fixture.parent.mkdir(parents=True)
                shutil.copyfile(ROOT / 'tests/fixtures/layout2/a.json', fixture)
                prover_output = run('installed-real-provers', ['node', '--test', '--test-reporter=tap', 'session-snapshot-runtime.ts'], consumer,
                    extra_env={'ZKAPI_TEST_NATIVE_PROVER': str(artifacts / 'native'), 'ZKAPI_TEST_WASM_PROVER': str(artifacts / 'wasm')})
                counts = {key: int(value) for key, value in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', prover_output, re.MULTILINE)}
                assert counts == {'tests': 1, 'pass': 1, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
                report['real_prover_tests'] = counts
            (consumer / 'browser.ts').write_text("export { createZkApiClient } from '@zkapi/solana-sdk';\nexport { createBrowserClient } from '@zkapi/solana-sdk/browser';\nexport { readChatText, readChatDeltas } from '@zkapi/solana-sdk/chat';\nexport { loadDeploymentAssets } from '@zkapi/solana-sdk/deployment';\nexport { loadPublicDeploymentProfile, preflightPublicDeployment } from '@zkapi/solana-sdk/public-profile';\nexport { openChat } from './public-consumer/browser.ts';\n")
            (consumer / 'worker.ts').write_text("import '@zkapi/solana-sdk/prover-worker';\n")
            (consumer / 'build.mjs').write_text("""import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
for (const entry of ['browser', 'worker']) {
  const result = await build({ entryPoints: [entry + '.ts'], bundle: true, platform: 'browser', format: 'esm', target: 'chrome120', outfile: entry + '.js', metafile: true });
  for (const [path, file] of Object.entries(result.metafile.inputs)) {
    assert.ok(!path.startsWith('../') && !path.startsWith('/') && !path.startsWith('node:'));
    assert.ok(!file.imports.some(item => item.path.startsWith('node:')));
  }
  assert.ok(Object.keys(result.metafile.inputs).some(path => path.startsWith('node_modules/@zkapi/solana-sdk/dist/')));
  await writeFile(entry + '-metafile.json', JSON.stringify(result.metafile, null, 2));
}
console.log('Independent browser and worker bundles contain only installed package/dependency files');
""")
            run('browser-build', ['node', 'build.mjs'], consumer)
            for name in ['browser-metafile.json', 'worker-metafile.json']:
                shutil.copyfile(consumer / name, output / name)
            report['browser_outputs'] = {name: {'sha256': sha(consumer / name), 'bytes': (consumer / name).stat().st_size} for name in ['browser.js', 'worker.js']}
            if args.asset_bundle:
                descriptor = args.asset_bundle.resolve() / 'bundle.json'
                assert re.fullmatch('[0-9a-f]{64}', args.asset_bundle_sha256 or '') and sha(descriptor) == args.asset_bundle_sha256
                public_dir = consumer / 'public-assets'
                public_dir.mkdir()
                public_names = ['bundle.json', *json.loads(descriptor.read_text())['files']]
                assert len(public_names) == len(set(public_names)) and all(re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9.-]*', name) for name in public_names)
                for name in public_names:
                    source = args.asset_bundle.resolve() / name
                    assert source.is_file() and not source.is_symlink()
                    shutil.copyfile(source, public_dir / name)
                (consumer / 'verify-assets.mjs').write_text("""import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseStrictJson, sha256Hex, verifyManifest, verifyArtifactBundle } from '@zkapi/solana-sdk/trust';
import { WasmProver } from '@zkapi/solana-sdk/prover-runtime';
import { loadDeploymentAssets, DeploymentAssetsError } from '@zkapi/solana-sdk/deployment';
const read = async name => { assert.match(name, /^[a-zA-Z0-9.-]+$/); return new Uint8Array(await readFile('public-assets/' + name)); };
const raw = await read('bundle.json'); assert.equal(await sha256Hex(raw), process.argv[2]);
const descriptor = parseStrictJson(raw), artifacts = { additional: Object.create(null) };
let downloads = 0;
const localFetch = async (input, init) => {
  downloads++; assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
  const url = new URL(String(input)); assert.equal(url.origin, 'https://public.invalid');
  return new Response(await read(url.pathname.slice(1)));
};
const loaded = await loadDeploymentAssets('https://public.invalid/bundle.json', {bundleSha256: process.argv[2], fetch: localFetch});
assert.equal(loaded.verifiedManifest.manifest_hash, parseStrictJson(await read(descriptor.manifest)).manifest_hash);
assert.equal(downloads, 1 + Object.keys(descriptor.files).length);
await assert.rejects(loadDeploymentAssets('https://public.invalid/bundle.json', {bundleSha256: process.argv[2], fetch: async (url, init) => {
  const response = await localFetch(url, init);
  if (new URL(String(url)).pathname.endsWith('/treePk.bin')) {const bytes = new Uint8Array(await response.arrayBuffer()); bytes[0] ^= 1; return new Response(bytes);}
  return response;
}}), DeploymentAssetsError);
const manifest = await verifyManifest(await read(descriptor.manifest), descriptor.trust);
for (const [name, file] of Object.entries(descriptor.artifacts)) {
  if (name === 'additional') for (const [key, value] of Object.entries(file)) artifacts.additional[key] = await read(value);
  else artifacts[name] = await read(file);
}
await verifyArtifactBundle(manifest, artifacts);
const wasm = await read(descriptor.wasm.path); await WasmProver.create(wasm, descriptor.wasm.sha256);
const corrupted = structuredClone(artifacts); corrupted.treePk[0] ^= 1;
await assert.rejects(verifyArtifactBundle(manifest, corrupted), /artifact mismatch/);
await assert.rejects(verifyManifest(await read(descriptor.manifest), { ...descriptor.trust, anchor: { kind: 'hash', sha256: '00'.repeat(32) } }));
await assert.rejects(WasmProver.create(wasm, '00'.repeat(32)));
console.log(JSON.stringify({manifestHash: manifest.manifest_hash, pool: manifest.pool, artifactFiles: Object.keys(descriptor.files).length, verification: 'real public artifact hashes and WASM initialization; no RPC/AUTH/inference'}));
""")
                run('installed-public-assets', ['node', 'verify-assets.mjs', args.asset_bundle_sha256], consumer)
                report['public_assets'] = {'bundle_sha256': args.asset_bundle_sha256, 'verified': True}
        report['source_inputs_unchanged'] = source_inputs == {str(path.relative_to(ROOT)): sha(path) for path in source_paths}
        assert report['source_inputs_unchanged'], 'SDK inputs changed during isolated acceptance'
        report['passed'] = True
    except Exception as error:
        report['passed'] = False
        report['failure'] = str(error)
        raise
    finally:
        report['seconds'] = round(time.monotonic() - started, 3)
        (output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': True, 'report': str(output / 'results.json'), 'tarball_sha256': report['tarball']['sha256']}))


if __name__ == '__main__':
    main()
