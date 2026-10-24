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
from sdk_consumer_lock import materialize, reviewed

ROOT = Path(__file__).resolve().parents[1]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'target/sdk-distribution')
    parser.add_argument('--offline', action='store_true', help='Use prepared npm caches only; never resolve or fetch a dependency')
    parser.add_argument('--prepare-dependencies', action='store_true', help='Populate consumer npm caches from reviewed locks, then stop before acceptance')
    parser.add_argument('--real-provers', action='store_true', help='Require existing real native/WASM artifacts and test them from the isolated consumer')
    parser.add_argument('--asset-bundle', type=Path, help='Verify a separately prepared public asset bundle in the isolated consumer')
    parser.add_argument('--asset-bundle-sha256', help='Independent SHA-256 of the public bundle.json descriptor')
    args = parser.parse_args()
    if args.offline and args.prepare_dependencies:
        parser.error('--offline and --prepare-dependencies are separate verification paths')
    if bool(args.asset_bundle) != bool(args.asset_bundle_sha256):
        parser.error('--asset-bundle and --asset-bundle-sha256 must be supplied together')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    bundled_node = ROOT / 'target/i08-toolchain/bin/node'
    selected_node = os.environ.get('ZKAPI_NODE') or (str(bundled_node) if bundled_node.is_file() else 'node')
    resolved_node = shutil.which(selected_node)
    if not resolved_node:
        raise SystemExit('Set ZKAPI_NODE to the pinned Node 24.22.1 executable')
    selected_npm = os.environ.get('ZKAPI_NPM') or shutil.which('npm')
    if not selected_npm or not shutil.which(selected_npm):
        raise SystemExit('Set ZKAPI_NPM to the pinned npm 11.19.1 executable')
    npm = str(Path(shutil.which(selected_npm)).absolute())
    node = Path(resolved_node).resolve()
    node_dir = node.parent
    env = {**os.environ, 'PATH': str(node_dir) + os.pathsep + os.environ.get('PATH', '')}
    env.pop('NODE_PATH', None)
    env.pop('NODE_OPTIONS', None)
    stages: list[dict] = []
    started = time.monotonic()
    source_paths = [*sorted((ROOT / 'packages/sdk/src').glob('*.ts')),
                    *[ROOT / 'packages/sdk' / name for name in ['package.json', 'build.mjs', 'tsconfig.json', 'tsconfig.build.json', 'README.md', 'DISTRIBUTION.md', 'INTERNALS.md', 'LICENSE']],
                    *[ROOT / 'packages/sdk/test' / name for name in ['client-guidance.test.ts', 'control.test.ts', 'generic-api.test.ts', 'gateway.test.ts', 'gateway-lifecycle.test.ts', 'gateway-public-profile-fixture.ts', 'selection.test.ts', 'clientd.test.ts', 'client.test.ts', 'direct-chat-stream.test.ts', 'response-branches.test.ts', 'chat.test.ts', 'clientd-models.test.ts', 'trust.test.ts', 'deployment.test.ts', 'public-profile.test.ts', 'public-profile-fixture.ts', 'api-onboarding-fixture.ts', 'chain-fixture.ts', 'session-snapshot-runtime.ts', 'kit-helpers.ts']],
                    ROOT / 'packages/sdk/test/recovery-installed.mjs',
                    *[ROOT / 'services/recovery' / name for name in ['server.mjs', 'store.mjs']],
                    *sorted((ROOT / 'tools/public-devnet-consumer').glob('*.*')),
                    *sorted((ROOT / 'tests/fixtures/sdk-consumer').glob('*.json')),
                    ROOT / 'docs/contracts/universal-api-gateway-vectors.json', ROOT / 'scripts/sdk_consumer_lock.py', ROOT / 'package-lock.json', Path(__file__).resolve()]
    source_inputs = {str(path.relative_to(ROOT)): sha(path) for path in source_paths}
    report = {'schema': 1, 'scope': 'Actual npm tarball in an independent temporary application; local fixtures, no live provider or chain actions',
              'public_chain_verified': False, 'public_rpc_verified': False, 'offline': args.offline, 'live_provider_verified': False, 'release_gates_passed': [], 'stages': stages, 'source_inputs': source_inputs}

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
        assert report['node_version'] == 'v24.22.1', 'pinned Node 24.22.1 is required'
        report['npm_version'] = run('npm-version', [npm, '--version'], ROOT).strip()
        assert report['npm_version'] == '11.19.1', 'pinned npm 11.19.1 is required'
        reviewed()
        run('pack', [npm, 'pack', *(['--offline'] if args.offline else []), '--workspace', '@zkapi/solana-sdk', '--pack-destination', str(output)], ROOT)
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
            report['dependency_lock'] = materialize(consumer, consumer / tarball.name)
            lock_before = sha(consumer / 'package-lock.json')
            try:
                run('install', [npm, 'ci', *(['--offline'] if args.offline else []), '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
            except RuntimeError as error:
                raise RuntimeError('Consumer dependency cache unavailable or reviewed installation failed; run the separately documented --prepare-dependencies step with network access before --offline acceptance') from error
            assert sha(consumer / 'package-lock.json') == lock_before, 'npm changed the reviewed consumer lock'
            if args.prepare_dependencies:
                report['passed'] = True
                report['scope'] = 'Dependency preparation only; no acceptance or release gates executed'
                report['source_inputs_unchanged'] = source_inputs == {str(path.relative_to(ROOT)): sha(path) for path in source_paths}
                assert report['source_inputs_unchanged'], 'source changed during dependency preparation'
                return
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
            test_names = ['client-guidance.test.ts', 'control.test.ts', 'generic-api.test.ts', 'gateway.test.ts', 'gateway-lifecycle.test.ts', 'gateway-public-profile-fixture.ts', 'selection.test.ts', 'clientd.test.ts', 'client.test.ts', 'direct-chat-stream.test.ts', 'response-branches.test.ts', 'chat.test.ts', 'clientd-models.test.ts', 'trust.test.ts', 'deployment.test.ts', 'public-profile.test.ts', 'public-profile-fixture.ts', 'api-onboarding-fixture.ts', 'chain-fixture.ts', 'kit-helpers.ts']
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
                for relative in re.findall(r"new URL\('\.\./\.\./\.\./([^']+)'", content):
                    fixture_path = consumer / 'fixtures' / relative
                    fixture_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(ROOT / relative, fixture_path)
                    content = content.replace("new URL('../../../" + relative + "'", "new URL('./fixtures/" + relative + "'")
                assert '../src/' not in content
                (consumer / name).write_text(content)
            test_output = run('installed-lifecycle-trust', ['node', '--test', '--test-reporter=tap', *[name for name in test_names if name.endswith('.test.ts')]], consumer)
            counts = {key: int(value) for key, value in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', test_output, re.MULTILINE)}
            assert set(counts) == {'tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'} and counts['pass'] > 0 and counts['tests'] == counts['pass'] and all(counts[key] == 0 for key in ['fail', 'cancelled', 'skipped', 'todo']), 'installed suite must execute every test without skips'
            report['installed_tests'] = counts
            # Recovery acceptance runs from the installed public exports in a
            # fresh child process after deleting all original device files.
            # The backup service is an explicit local fixture, not SDK source.
            recovery_service = consumer / 'recovery-service'
            recovery_service.mkdir()
            for name in ['server.mjs', 'store.mjs']:
                shutil.copyfile(ROOT / 'services/recovery' / name, recovery_service / name)
            recovery_test = (ROOT / 'packages/sdk/test/recovery-installed.mjs').read_text()
            assert '../src/' not in recovery_test and str(ROOT) not in recovery_test
            (consumer / 'recovery-installed.mjs').write_text(recovery_test)
            recovery_output = run('installed-recovery', ['node', '--test', '--test-reporter=tap', 'recovery-installed.mjs'], consumer)
            recovery_counts = {key: int(value) for key, value in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', recovery_output, re.MULTILINE)}
            assert recovery_counts == {'tests': 1, 'pass': 1, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}, 'installed recovery test must execute without skips'
            report['installed_recovery_tests'] = recovery_counts
            example = consumer / 'public-consumer'
            example.mkdir()
            for source in sorted((ROOT / 'tools/public-devnet-consumer').glob('*.*')):
                shutil.copyfile(source, example / source.name)
            run('public-consumer-help', ['node', 'public-consumer/cli.mjs', '--help'], consumer)
            run('public-consumer-upgrade-cli', ['node', '--test', 'public-consumer/cli.test.mjs'], consumer)
            run('public-consumer-network', ['node', '--test', 'public-consumer/native-inputs.test.mjs'], consumer)
            run('public-consumer-browser-adapter', ['node', '--experimental-test-module-mocks', '--test',
                'public-consumer/browser.test.mjs'], consumer)
            (consumer / 'public-consumer-install.test.mjs').write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, realpath, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publicProfileFixture } from './public-profile-fixture.ts';
import { gatewayPublicProfileFixture } from './gateway-public-profile-fixture.ts';
import { loadPublicDeploymentProfile } from '@zkapi/solana-sdk/public-profile';
import { jcsBytes, sha256Hex } from '@zkapi/solana-sdk/trust';
import { installNativeInputs } from './public-consumer/native-inputs.mjs';
const cases = [
  {name:'v3 finite gateway / bundle v2 notices',bundleSchema:2,profile:{schema:3,selection:'api'}},
  {name:'v1 inference / bundle v1',bundleSchema:1,profile:{}},
  {name:'v1 inference / bundle v2 notices',bundleSchema:2,profile:{}},
  {name:'v2 API-only / bundle v2 notices',bundleSchema:2,profile:{schema:2,selection:'api',serviceCount:2}},
  {name:'v2 mixed / bundle v2 notices',bundleSchema:2,profile:{schema:2,selection:'mixed',serviceCount:2}},
];
for (const item of cases) test('native '+item.name+' retains authenticated selection and notices without network or financial actions', async () => {
  const schema=item.bundleSchema, f = item.profile.schema===3 ? await gatewayPublicProfileFixture() : await publicProfileFixture(item.profile);
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
  assert.equal(runtime.key_reuse_seconds,60);
  if(item.profile.schema===3)assert.deepEqual(runtime.gateway,f.profile.gateway);
  assert.equal(runtime.models.length,f.profile.models.length);
  if(item.profile.selection==='api')assert.deepEqual(runtime.models,[]);
  for(const [i,model]of f.profile.models.entries()){
    assert.deepEqual(runtime.models[i].capabilities,f.profile.modelCapabilities[model.id]);
    assert.equal(runtime.models[i].id,model.id);assert.equal(runtime.models[i].provider,model.provider);assert.deepEqual(runtime.models[i].apis,model.apis);
    assert.equal(runtime.models[i].tariff,join(destination,'tariff-'+i+'.json'));
    assert.deepEqual(JSON.parse(await readFile(runtime.models[i].tariff)),model.tariff);
  }
  assert.equal(runtime.settlement_wait_ms,f.profile.mode==='direct_openrouter'?120000:undefined);
  const services=f.profile.services??[];
  assert.equal(runtime.services.length,services.length);assert.equal(receipt.services.length,services.length);
  for(const [i,service]of services.entries()){
    const path=join(destination,'api-tariff-'+i+'.json'),bytes=await readFile(path);
    assert.deepEqual(runtime.services[i],{tariff:path});assert.deepEqual(JSON.parse(bytes),service.tariff);
    assert.deepEqual(receipt.services[i],{file:'api-tariff-'+i+'.json',sha256:await sha256Hex(bytes),bytes:bytes.length});
    assert.equal((await stat(path)).mode & 0o777,0o600);
  }
  assert.equal(runtime.rpc,f.profile.rpcUrl); assert.equal(runtime.indexer,f.profile.indexerOrigin);
  assert.deepEqual(runtime.policy,f.trust); assert.equal(runtime.mode,f.profile.mode);
  const networkBytes=await readFile(receipt.network),network=JSON.parse(networkBytes);
  assert.equal(await sha256Hex(networkBytes),receipt.networkSha256);
  assert.equal(network.mode,'direct');
  const execution=network.routes.filter(route=>route.origin===f.manifest.inference_api_origin);
  assert.deepEqual(execution,f.profile.mode==='proxy'?[
    ...(f.profile.models.length?[{origin:f.manifest.inference_api_origin,prefix:'/v1'}]:[]),
    ...services.map(({tariff})=>({origin:f.manifest.inference_api_origin,prefix:(tariff.api.version==='2'?'/zkapi/v2/execute/':'/zkapi/v1/api/')+tariff.api.service+'/'+tariff.api.operation})),
  ]:[]);
  for(const {tariff}of services)assert.equal(network.routes.some(route=>route.origin===tariff.api.origin),false,'consumer egress must not acquire upstream routes');
  assert.ok(network.routes.some(route=>route.origin===f.manifest.control_api_origin&&route.prefix==='/zkapi/v1'));
  assert.notEqual(f.manifest.control_api_origin,f.manifest.inference_api_origin);
  assert.ok(f.calls.every(call=>call.method==='GET'&&!/quotes|sessions|chat|lookup|weather\\.example/.test(call.url)));
  assert.equal(f.calls.length,before,'materialization must not create additional network actions');
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
  assert(!('journal' in runtime)); assert(!('custody' in runtime));assert(!('note_id' in runtime));
  const outputNames=await readdir(destination);
  assert.equal(outputNames.filter(name=>/^api-tariff-[0-9]+\\.json$/.test(name)).length,services.length);
  for(const name of ['journal','custody.json','inference-token','management-token'])assert.equal(outputNames.includes(name),false);
  await assert.rejects(installNativeInputs(loaded,destination,{mode:'direct'}));
  assert.deepEqual(await readFile(receipt.runtime),runtimeBytes);
  await assert.rejects(installNativeInputs({...loaded},join(root,'forged'),{mode:'direct'}));
  await symlink(root,join(root,'alias'));
  await assert.rejects(installNativeInputs(loaded,join(root,'alias','other'),{mode:'direct'}));
});
""")
            native_output = run('public-consumer-install', ['node', '--test', '--test-reporter=tap', 'public-consumer-install.test.mjs'], consumer)
            native_counts = {key: int(value) for key, value in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', native_output, re.MULTILINE)}
            assert native_counts == {'tests': 5, 'pass': 5, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}
            report['native_profile_contract_tests'] = native_counts
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
            (consumer / 'browser.ts').write_text("export { createZkApiClient } from '@zkapi/solana-sdk';\nexport { createBrowserClient } from '@zkapi/solana-sdk/browser';\nexport { createRecoveryKit, createRecoveryStorage, restoreRecoveryStorage, openRecoveryStorage } from '@zkapi/solana-sdk/recovery';\nexport { saveRecoverySession, loadRecoverySession } from '@zkapi/solana-sdk/recovery-browser';\nexport { readChatText, readChatDeltas } from '@zkapi/solana-sdk/chat';\nexport { loadDeploymentAssets } from '@zkapi/solana-sdk/deployment';\nexport { loadPublicDeploymentProfile, preflightPublicDeployment } from '@zkapi/solana-sdk/public-profile';\nexport { openChat } from './public-consumer/browser.ts';\n")
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
  if (entry === 'browser') for (const name of ['recovery.js', 'recovery-browser.js'])
    assert.ok(Object.keys(result.metafile.inputs).some(path => path === 'node_modules/@zkapi/solana-sdk/dist/' + name));
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
