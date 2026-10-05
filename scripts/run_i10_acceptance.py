#!/usr/bin/env python3
"""Reproduce I10's local component/integration matrix in dependency order.

Requires the unchanged actual I04 Vault/history artifacts. Each stage produces a
fresh report; snapshots remain under a unique run directory, including failures.
External provider/wallet/RPC and deployment acceptance are never inferred here.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i10-acceptance'
STAGES = [
    ('backend', ['bash', 'scripts/run_i06_i07.sh'], 'target/i06-i07/runtime-report.json'),
    ('sdk', ['python3', 'scripts/run_i08.py'], 'target/i08/runtime-report.json'),
    ('challenger', ['python3', 'scripts/run_i09_challenger.py'], 'target/i09-challenger/runtime-report.json'),
    ('wallet', ['python3', 'scripts/run_i08_wallet.py'], 'target/i08-wallet/runtime-report.json'),
    ('clientd', ['python3', 'scripts/run_i08_clientd.py'], 'target/i08-clientd/runtime-report.json'),
    ('operations', ['python3', 'scripts/run_i09_operations.py'], 'target/i09-operations/runtime-report.json'),
    ('integration', ['python3', 'scripts/run_i10.py'], 'target/i10/runtime-report.json'),
]


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_hashes():
    names = subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT
    ).decode().split('\0')
    vendor = 'vendor/ethereum-zkapi'
    vendor_names = subprocess.check_output(
        ['git', '-C', vendor, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT
    ).decode().split('\0')
    names += [vendor + '/' + name for name in vendor_names
              if name.startswith(('protocol/rust/', 'protocol/setup/v2/'))
              or name in ('Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml')]
    root_inputs = {'Cargo.toml', 'Cargo.lock', 'package.json', 'package-lock.json',
                   'rust-toolchain.toml', '.node-version', '.go-version', '.npmrc', '.gitmodules'}
    result = {}
    for name in sorted(set(names)):
        if not name or not (name.startswith(('apps/', 'crates/', 'packages/', 'programs/', 'scripts/', 'services/', 'tests/', 'tools/', 'deploy/', 'config/', 'docs/contracts/', 'vendor/ethereum-zkapi/', '.cargo/')) or name in root_inputs):
            continue
        path = ROOT / name
        if path.is_file() and (path.suffix in {'.rs', '.ts', '.py', '.go', '.toml', '.sql', '.sh', '.json', '.lock', '.mod', '.sum', '.pk', '.vk', '.bin', '.html', '.css'} or name in root_inputs):
            result[name] = sha(path)
    result['gitlink:' + vendor] = subprocess.check_output(
        ['git', '-C', vendor, 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip()
    return result


def execute():
    env = {k: v for k, v in os.environ.items() if not k.startswith('PG') and k not in {
        'DATABASE_URL', 'ZKAPI_TEST_DATABASE_URL', 'ZKAPI_I09_DATABASE_URL', 'CARGO_TARGET_DIR'}}
    env['RAYON_NUM_THREADS'] = '4'
    run_dir = Path(tempfile.mkdtemp(prefix='run-', dir=OUT))
    start = time.monotonic()
    report = {'schema': 1, 'passed': False, 'started_at_utc': now(),
              'scope': 'Fresh local SDK/native/WASM/Go/challenger/backend/operations and I10 integration/fault suites; fixture providers and public-network envelopes',
              'I10_complete': False, 'I10_handoff_ready': False, 'release_gates_passed': [],
              'live_provider_verified': False, 'live_wallet_verified': False,
              'public_rpc_verified': False, 'hosted_ci_verified': False,
              'counts_overlap_between_stages': True, 'stages': [],
              'run_directory': str(run_dir.relative_to(ROOT))}
    try:
        for name in ('target/i04-sbf/zkapi_vault.so', 'target/i04/sdk-svm-history.json'):
            if not (ROOT / name).is_file():
                raise RuntimeError('Missing I04 prerequisite ' + name + '; run bash scripts/run_i04.sh first')
        report['i04_input_sha256'] = {name: sha(ROOT / name) for name in
                                    ('target/i04-sbf/zkapi_vault.so', 'target/i04/sdk-svm-history.json')}
        report['source_sha256'] = source_hashes()
        for name, argv, result_name in STAGES:
            result_path = ROOT / result_name
            result_path.unlink(missing_ok=True)
            log_path = run_dir / (name + '.log')
            record = {'name': name, 'argv': argv, 'started_at_utc': now(), 'exit_code': None}
            report['stages'].append(record)
            before = time.monotonic()
            print('$ ' + ' '.join(argv), flush=True)
            with log_path.open('w') as output:
                process = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=output,
                                           stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    record['exit_code'] = process.wait(timeout=1800)
                except BaseException:
                    os.killpg(process.pid, signal.SIGINT)
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
                    record['exit_code'] = process.returncode
                    raise
                finally:
                    record['finished_at_utc'] = now()
                    record['seconds'] = round(time.monotonic() - before, 3)
            record['log'] = str(log_path.relative_to(ROOT))
            record['log_sha256'] = sha(log_path)
            if record['exit_code']:
                raise RuntimeError(name + ' failed; see ' + record['log'])
            result = json.loads(result_path.read_text())
            if result.get('passed') is not True or result.get('release_gates_passed') != []:
                raise RuntimeError(name + ': missing successful fresh local-only result')
            saved = run_dir / (name + '-results.json')
            shutil.copyfile(result_path, saved)
            record['report'] = str(saved.relative_to(ROOT))
            record['report_sha256'] = sha(saved)
            record['tests'] = result.get('tests', result.get('test_counts', result.get('tests_passed')))
            if source_hashes() != report['source_sha256']:
                raise RuntimeError('Source changed during local acceptance; stage evidence is retained but aggregate cannot pass')
            if any(sha(ROOT / name) != value for name, value in report['i04_input_sha256'].items()):
                raise RuntimeError('I04 Vault/history input changed during local acceptance')
            print(name + ': passed', flush=True)
        report['passed'] = True
    except BaseException as error:
        report['failure'] = str(error)
        raise
    finally:
        report['finished_at_utc'] = now()
        report['elapsed_seconds'] = round(time.monotonic() - start, 3)
        payload = json.dumps(report, indent=2) + '\n'
        (run_dir / 'runtime-report.json').write_text(payload)
        temporary = OUT / 'runtime-report.tmp'
        temporary.write_text(payload)
        temporary.replace(OUT / 'runtime-report.json')
    print(json.dumps({'local_suites_passed': True, 'I10_complete': False, 'release_gates_passed': []}))


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (OUT / 'runner.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute()
