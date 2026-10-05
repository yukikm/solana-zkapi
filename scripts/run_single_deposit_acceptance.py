#!/usr/bin/env python3
"""Reproduce ADR-0003 local acceptance without live credentials or deployment.

All commands run serially. Logs and failed runs are retained; results.json points
to the latest run. No package installation, shared fixture regeneration, public
RPC, provider request, Phantom extension or funded wallet is used by this runner.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time

from run_i10_acceptance import source_hashes

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/single-deposit-acceptance'
WRONG_VK = ROOT / 'target/i04-sbf-wrong/zkapi_vault.so'
ELF = ROOT / 'target/single-deposit-sbf/zkapi_vault.so'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sources():
    # Existing source inventory includes tracked and untracked runtime files,
    # contracts, locks and proof fixtures; excludes target and docs/evidence.
    snapshot = source_hashes()
    generator = ROOT / 'work/design/generate_contracts.py'
    snapshot[str(generator.relative_to(ROOT))] = sha(generator)
    snapshot['.github/workflows/ci.yml'] = sha(ROOT / '.github/workflows/ci.yml')
    return snapshot


def executable(override, local, fallback):
    candidate = os.environ.get(override)
    if not candidate:
        candidate = str(ROOT / local) if (ROOT / local).is_file() else fallback
    found = shutil.which(candidate)
    if not found:
        raise RuntimeError(f'{override}: executable unavailable: {candidate}')
    # Keep virtualenv Python's path (resolving its symlink bypasses the venv).
    return str(Path(found).absolute())


def tap_summary(log):
    text = log.read_text()
    result = {}
    for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
        found = re.findall(r'^# ' + key + r' (\d+)\s*$', text, re.MULTILINE)
        if len(found) != 1:
            raise RuntimeError(f'{log.name}: missing or ambiguous TAP {key} summary')
        result[key] = int(found[0])
    if result['tests'] == 0 or result['pass'] != result['tests'] or any(
            result[key] != 0 for key in ('fail', 'cancelled', 'skipped', 'todo')):
        raise RuntimeError(f'{log.name}: TAP requires all tests passed with zero skips: {result}')
    return result


def execute():
    run_dir = Path(tempfile.mkdtemp(prefix='run-', dir=OUT))
    start = time.monotonic()
    report = {'schema': 1, 'passed': False, 'started_at_utc': now(),
              'scope': 'Offline compact deposit codecs, compiler IDL, real-proof local SBF, SDK signing/journal, indexer and synthetic browser/provider fixtures',
              'public_deployment_verified': False, 'public_finality_verified': False,
              'phantom_verified': False, 'live_provider_verified': False,
              'I10_complete': False, 'release_gates_passed': [],
              'counts_overlap_between_stages': True, 'stages': [],
              'run_directory': str(run_dir.relative_to(ROOT))}
    baseline = None
    fixture_hash = None
    try:
        node = executable('ZKAPI_NODE', 'target/i08-toolchain/bin/node', 'node')
        sbf = executable('ZKAPI_SBF', 'target/toolchains/sbf/bin/cargo-build-sbf', 'cargo-build-sbf')
        schema_python = executable('ZKAPI_SCHEMA_PYTHON', 'target/i10-schema-env/bin/python', 'python3')
        # Keep only local toolchain/home/temporary-directory settings. In
        # particular no inherited RPC, database, wallet or provider variables.
        allowed = ('HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
                   'RUSTUP_HOME', 'CARGO_HOME', 'SDKROOT', 'DEVELOPER_DIR')
        env = {key: os.environ[key] for key in allowed if key in os.environ}
        env['PATH'] = os.pathsep.join([str(Path(node).parent), str(Path(sbf).parent), env.get('PATH', '')])
        env['ZKAPI_NODE'] = node
        env['RAYON_NUM_THREADS'] = '4'
        node_version = subprocess.check_output([node, '--version'], cwd=ROOT, env=env, text=True).strip()
        if node_version != 'v24.19.0':
            raise RuntimeError(f'Node v24.19.0 required, got {node_version}; set ZKAPI_NODE')
        sbf_version = subprocess.check_output([sbf, '--version'], cwd=ROOT, env=env, text=True).splitlines()[0]
        if sbf_version != 'cargo-build-sbf 4.1.0':
            raise RuntimeError('cargo-build-sbf 4.1.0 required: ' + sbf_version)
        if not WRONG_VK.is_file():
            raise RuntimeError('Missing explicit legacy regression prerequisite target/i04-sbf-wrong/zkapi_vault.so; build its wrong-vk local fixture first')
        report['tools'] = {'node': node, 'node_version': node_version,
                           'schema_python': schema_python, 'sbf': sbf, 'sbf_version': sbf_version}
        fixture_hash = sha(WRONG_VK)
        report['legacy_wrong_vk_sha256'] = fixture_hash
        baseline = sources()
        report['source_input_sha256'] = baseline

        def run(name, argv, *, tap=False, artifact=None):
            argv = [str(item) for item in argv]
            log = run_dir / (name + '.log')
            row = {'name': name, 'argv': argv, 'started_at_utc': now(),
                   'exit_code': None, 'log': str(log.relative_to(ROOT))}
            report['stages'].append(row)
            before = time.monotonic()
            print('$ ' + ' '.join(argv), flush=True)
            with log.open('w') as output:
                process = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=output,
                                           stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    row['exit_code'] = process.wait(timeout=1800)
                except BaseException:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    row['exit_code'] = process.returncode
                    raise
                finally:
                    row['seconds'] = round(time.monotonic() - before, 3)
                    row['finished_at_utc'] = now()
                    row['log_sha256'] = sha(log)
            if row['exit_code'] != 0:
                raise RuntimeError(f'{name} failed; see {row["log"]}')
            if tap:
                row['tap'] = tap_summary(log)
            rust_counts = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', log.read_text())
            if rust_counts:
                row['rust_tests'] = {key: sum(int(count[i]) for count in rust_counts)
                                     for i, key in enumerate(('passed', 'failed', 'ignored'))}
            if artifact:
                row['artifact'] = str(artifact.relative_to(ROOT))
                row['artifact_sha256'] = sha(artifact)
            if sources() != baseline or sha(WRONG_VK) != fixture_hash:
                raise RuntimeError('Runtime source or wrong-VK input changed during acceptance; aggregate cannot pass')
            print(name + ': passed', flush=True)
            return row

        run('layout2-unit', ['cargo', 'test', '--locked', '--manifest-path', 'crates/zkapi-layout2/Cargo.toml'])
        run('vault-unit', ['cargo', 'test', '--locked', '--manifest-path', 'programs/zkapi-vault/Cargo.toml'])
        generated_idl = run_dir / 'generated-vault.json'
        run('compiler-idl', ['cargo', 'run', '--locked', '--manifest-path', 'tools/vault-idl/Cargo.toml', '--', generated_idl], artifact=generated_idl)
        if generated_idl.read_bytes() != (ROOT / 'docs/contracts/zkapi_vault.json').read_bytes():
            raise RuntimeError('Fresh compiler-backed IDL differs from docs/contracts/zkapi_vault.json')
        run('idl-guard', ['python3', 'scripts/check_vault_idl.py'])
        run('idl-mutations', ['python3', 'scripts/test_check_vault_idl.py'])
        build = run('sbf-build', ['cargo', 'build-sbf', '--manifest-path', 'programs/zkapi-vault/Cargo.toml',
            '--tools-version', 'v1.54', '--arch', 'v0', '--features', 'sbf-entrypoint',
            '--sbf-out-dir', 'target/single-deposit-sbf', '--', '--locked'], artifact=ELF)
        if re.search(r'stack offset.*exceed|stack frame size.*exceed', (ROOT / build['log']).read_text(), re.IGNORECASE):
            raise RuntimeError('SBF stack warning exceeds supported frame size')
        svm_report = run_dir / 'svm-results.json'
        run('compact-sbf', ['cargo', 'run', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin',
            'compact_deposit', '--', ELF, svm_report], artifact=svm_report)
        svm = json.loads(svm_report.read_text())
        if svm.get('status') != 'pass' or svm.get('elf_sha256') != sha(ELF):
            raise RuntimeError('Compact SBF report does not match the newly built ELF')
        run('compact-indexer-sbf', ['cargo', 'run', '--locked', '--manifest-path', 'services/indexer/Cargo.toml',
            '--example', 'verify_compact_history', '--', run_dir / 'sdk-history.json'])
        legacy_dir = run_dir / 'legacy-vault-regression'
        run('legacy-vault-sbf', ['cargo', 'run', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin',
            'vault', '--', ELF, WRONG_VK, legacy_dir], artifact=legacy_dir / 'I03-svm-results.json')
        indexer = run('indexer', ['cargo', 'test', '--locked', '--manifest-path', 'services/indexer/Cargo.toml'])
        indexer_text = (ROOT / indexer['log']).read_text()
        for name in ('mixed_deposit_transports_without_events_replay_identically_after_restart',
                     'compact_wire_length_field_binding_and_unknown_version_fail_closed'):
            if not re.search(r'test ' + name + r' \.\.\. ok', indexer_text):
                raise RuntimeError('Missing required compact replay test: ' + name)
        # The existing manual archive microbenchmark is intentionally ignored.
        if indexer['rust_tests']['ignored'] != 1:
            raise RuntimeError('Indexer ignored count differs from its one manual benchmark')
        tsc = [node, 'node_modules/typescript/bin/tsc', '--noEmit']
        run('sdk-types', [*tsc, '-p', 'packages/sdk/tsconfig.json'])
        run('sdk-tests', [node, '--test', '--test-reporter=tap', '--test-concurrency=1',
            *sorted(ROOT.glob('packages/sdk/test/*.test.ts'))], tap=True)
        run('clientd-types', [*tsc, '-p', 'apps/clientd/tsconfig.json'])
        run('ui-types', [*tsc, '--strict', '--target', 'ES2023', '--module', 'NodeNext',
            '--moduleResolution', 'NodeNext', '--allowImportingTsExtensions', '--resolveJsonModule',
            '--lib', 'ES2023,DOM', '--types', 'node', *sorted(ROOT.glob('scripts/i10-wallet-ui/*.ts'))])
        run('ui-tests', [node, '--test', '--test-reporter=tap', '--test-concurrency=1',
            *sorted(ROOT.glob('scripts/i10-wallet-ui/*.test.ts'))], tap=True)
        run('control-capabilities', ['cargo', 'test', '--locked', '--manifest-path', 'services/control/Cargo.toml', '--test', 'devnet_config'])
        run('openapi', [schema_python, 'scripts/check_openapi_contract.py'])
        run('design', ['python3', 'scripts/check_design.py'])
        run('format-rust', ['rustfmt', '--edition', '2021', '--check',
            'crates/zkapi-layout2/src/compact.rs', 'crates/zkapi-layout2/src/lib.rs',
            'programs/zkapi-vault/src/lib.rs', 'programs/zkapi-vault/src/handlers.rs',
            'services/indexer/src/replay.rs', 'services/indexer/tests/replay.rs',
            'services/indexer/examples/verify_compact_history.rs', 'tests/svm/src/bin/compact_deposit.rs',
            'services/control/src/chain.rs', 'services/control/src/config.rs', 'services/control/tests/devnet_config.rs'])
        run('diff-check', ['git', 'diff', '--check'])
        report['artifacts_sha256'] = {
            str(p.relative_to(ROOT)): sha(p) for p in sorted(run_dir.rglob('*.json')) if p.is_file()}
        report['artifacts_sha256'][str(ELF.relative_to(ROOT))] = sha(ELF)
        report['passed'] = True
    except BaseException as error:
        report['failure'] = str(error)
        raise
    finally:
        if baseline is not None:
            final_sources = sources()
            report['changed_sources'] = sorted(name for name in set(baseline) | set(final_sources)
                                               if baseline.get(name) != final_sources.get(name))
            report['sources_unchanged'] = not report['changed_sources']
            if not report['sources_unchanged']:
                report['passed'] = False
        if fixture_hash is not None:
            report['legacy_wrong_vk_unchanged'] = WRONG_VK.is_file() and sha(WRONG_VK) == fixture_hash
            report['passed'] = report['passed'] and report['legacy_wrong_vk_unchanged']
        report['finished_at_utc'] = now()
        report['elapsed_seconds'] = round(time.monotonic() - start, 3)
        payload = json.dumps(report, indent=2) + '\n'
        (run_dir / 'results.json').write_text(payload)
        temporary = OUT / 'results.tmp'
        temporary.write_text(payload)
        temporary.replace(OUT / 'results.json')
    if not report['passed']:
        raise RuntimeError('Acceptance did not pass; inspect target/single-deposit-acceptance/results.json')
    print(json.dumps({'passed': True, 'scope': 'local only', 'report': 'target/single-deposit-acceptance/results.json'}))


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (OUT / 'runner.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute()
