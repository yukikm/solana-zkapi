#!/usr/bin/env python3
"""I09 challenger tests; local PostgreSQL + archive + new payload in real Vault SBF.
Includes native daemon and SDK broadcaster against local RPC fault fixtures; no live RPC/provider or release-gate claims.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i09-challenger'
OUT.mkdir(parents=True, exist_ok=True)
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG') and k not in ('DATABASE_URL', 'ZKAPI_TEST_DATABASE_URL', 'ZKAPI_I09_DATABASE_URL')}
ENV['RAYON_NUM_THREADS'] = '4'
COMMANDS = []
LOG = OUT / 'runtime.log'
LOG.write_text('')
(OUT / 'runtime-report.json').unlink(missing_ok=True)

def run(args, capture=False):
    COMMANDS.append(args)
    result = subprocess.run(args, cwd=ROOT, env=ENV, text=True, capture_output=True)
    with LOG.open('a') as output:
        output.write('$ ' + ' '.join(args) + '\n' + result.stdout + result.stderr)
    if not capture or result.returncode:
        print(result.stdout + result.stderr, end='', flush=True)
    result.check_returncode()
    return result.stdout.strip()

for tool in ('initdb', 'pg_ctl', 'psql', 'cargo', 'node'):
    if not shutil.which(tool):
        raise SystemExit('Missing local test tool: ' + tool)
if not (ROOT / 'target/i04/sdk-svm-history.json').is_file():
    raise SystemExit('Generate the required actual Vault SBF history first: bash scripts/run_i04.sh')
if not (ROOT / 'target/i04-sbf/zkapi_vault.so').is_file():
    raise SystemExit('Build the required actual Vault SBF ELF first: bash scripts/run_i04.sh')
for name in ['generated-challenge.bin', 'proof-generation.json', 'svm-results.json', 'daemon-performance.json', 'native-cli-results.json', 'i10-restart-results.json']:
    (OUT / name).unlink(missing_ok=True)
started = time.monotonic()
with tempfile.TemporaryDirectory(prefix='zkapi-i09-', dir='/tmp') as directory:
    work = Path(directory)
    data, socket = work / 'data', work / 'socket'
    socket.mkdir()
    running = False
    try:
        run(['initdb', '-D', str(data), '-U', 'i09_test', '--no-locale', '--encoding=UTF8', '--auth=trust'], True)
        run(['pg_ctl', '-D', str(data), '-l', str(work / 'postgres.log'), '-o', f"-k {socket} -h '' -p 55439", '-w', 'start'], True)
        running = True
        ENV['ZKAPI_I09_DATABASE_URL'] = f'host={socket} port=55439 user=i09_test dbname=postgres'
        postgres = run(['psql', '-X', '-h', str(socket), '-p', '55439', '-U', 'i09_test', '-d', 'postgres', '-Atc', 'SHOW server_version'], True)
        run(['cargo', 'fmt', '--manifest-path', 'services/challenger/Cargo.toml', '--', '--check'])
        run(['cargo', 'test', '--locked', '--manifest-path', 'services/challenger/Cargo.toml', '--', '--include-ignored', '--test-threads=1'])
        run(['cargo', 'clippy', '--locked', '--manifest-path', 'services/challenger/Cargo.toml', '--all-targets', '--', '-D', 'warnings'])
        results = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', LOG.read_text())
        if not results or any(int(f) or int(i) for _, f, i in results):
            raise RuntimeError('All challenger tests must run without failures or ignored cases')
        if 'generates_a_new_real_challenge_proof_using_pinned_test_setup ... ok' not in LOG.read_text():
            raise RuntimeError('Missing native proof generation test')
        restarts_result = json.loads((OUT / 'i10-restart-results.json').read_text())
        if (restarts_result.get('passed') is not True
                or restarts_result.get('fresh_process_recoveries') != 17
                or restarts_result.get('extra_sends_during_outage_and_finality_recovery') != 0
                or restarts_result.get('finalized_without_fee_key') is not True):
            raise RuntimeError('Missing repeated challenger outage/restart acceptance')
        sdk_output = run(['node', '--test', '--test-reporter=tap', 'packages/sdk/test/challenger.test.ts'])
        sdk_tests = re.search(r'# tests (\d+)', sdk_output)
        if not sdk_tests or '# fail 0' not in sdk_output:
            raise RuntimeError('Challenger SDK bridge tests failed or missing')
        run(['cargo', 'build', '--locked', '--manifest-path', 'services/challenger/Cargo.toml', '--bin', 'challengerd'])
        status = json.loads(run(['services/challenger/target/debug/challengerd', 'status', 'target/i09-challenger/cli-state/config.json']))
        if status['complete_jobs'] != 1 or status['unknown_signatures'] != 0:
            raise RuntimeError('Native CLI did not recover the durable completed queue')
        # Every 'once' is a fresh native OS process over the SAME durable queue.
        # RPC outcomes remain synthetic; the following SBF run is independent.
        rpc_fixture = subprocess.Popen(['node', 'packages/sdk/test/challenger-rpc.ts'], cwd=ROOT, env=ENV, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        cli_started = time.monotonic()
        try:
            port = json.loads(rpc_fixture.stdout.readline())['port']
            rpc_url = f'http://127.0.0.1:{port}'
            def fixture_call(method, params):
                body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
                request = urllib.request.Request(rpc_url, data=body, headers={'Content-Type': 'application/json'})
                with urllib.request.urlopen(request, timeout=10) as response:
                    return json.load(response)['result']
            cfg = json.loads((OUT / 'cli-state/config.json').read_text())
            cfg['rpc_url'] = rpc_url
            cfg['journal_directory'] = str(work / 'native-cli-journal')
            cfg['alert_sink_directory'] = str(work / 'native-cli-alerts')
            cfg['database_dsn_file'] = str(work / 'reader.dsn')
            Path(cfg['database_dsn_file']).write_text(f'host={socket} port=55439 user=i09_reader dbname=postgres')
            Path(cfg['database_dsn_file']).chmod(0o600)
            cfg['fee_key_file'] = str(work / 'test-fee.json')
            fixture_key = subprocess.run(['node', '--input-type=module', '-e', "import {createKeyPairSignerFromPrivateKeyBytes,getAddressEncoder} from '@solana/kit';const seed=new Uint8Array(32).fill(10),key=await createKeyPairSignerFromPrivateKeyBytes(seed);process.stdout.write(JSON.stringify([...seed,...getAddressEncoder().encode(key.address)]))"], cwd=ROOT, env=ENV, text=True, capture_output=True, check=True)
            Path(cfg['fee_key_file']).write_text(fixture_key.stdout)
            Path(cfg['fee_key_file']).chmod(0o600)
            config_path = work / 'native-cli.json'
            config_path.write_text(json.dumps(cfg))
            executable = 'services/challenger/target/debug/challengerd'
            run([executable, 'init', str(config_path)], True)
            fixture_call('testSetMode', ['lose-once'])
            restarts = 0
            for _ in range(10):
                run([executable, 'once', str(config_path)], True)
                restarts += 1
                persisted = json.loads((Path(cfg['journal_directory']) / 'journal.json').read_text())['state']
                job = next(iter(persisted['jobs'].values()))
                if job['attempts'] and job['attempts'][-1]['stage'] == 'Execute':
                    break
            else:
                raise RuntimeError('Native CLI never reached execute')
            exact = job['attempts'][-1]['signed_bytes']
            signature = job['attempts'][-1]['signature']
            fixture_call('testSetMode', ['confirmed'])
            before = fixture_call('testStats', [])
            run([executable, 'once', str(config_path)], True)
            restarts += 1
            persisted = json.loads((Path(cfg['journal_directory']) / 'journal.json').read_text())['state']
            job = next(iter(persisted['jobs'].values()))
            if job['complete'] or job['attempts'][-1]['signature'] != signature or job['attempts'][-1]['signed_bytes'] != exact or fixture_call('testStats', []) != before:
                raise RuntimeError('Confirmed-only CLI recovery replaced or resent unknown execute')
            Path(cfg['fee_key_file']).unlink()
            fixture_call('testSetMode', ['normal'])
            run([executable, 'recover', str(config_path)], True)
            status = json.loads(run([executable, 'status', str(config_path)], True))
            if status['complete_jobs'] != 1 or status['unknown_signatures'] != 0:
                raise RuntimeError('Native CLI finalized recovery failed without fee key')
            cli_result = {'fresh_process_steps': restarts, 'lost_response_recovered': True, 'confirmed_execute_preserved': True, 'finalized_recovered_without_fee_key': True, 'elapsed_seconds': round(time.monotonic()-cli_started, 3), 'live_rpc': False}
            (OUT / 'native-cli-results.json').write_text(json.dumps(cli_result, indent=2)+'\n')
        finally:
            rpc_fixture.terminate()
            rpc_fixture.communicate(timeout=10)
        run(['cargo', 'run', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'challenger'])
        run(['cargo', 'fmt', '--manifest-path', 'tests/svm/Cargo.toml', '--', '--check'])
        run(['cargo', 'clippy', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'challenger', '--', '-D', 'warnings'])
        svm = json.loads((OUT / 'svm-results.json').read_text())
        if not svm['passed'] or svm['max_cu'] > 1_000_000 or svm['max_transaction_bytes'] > 1232:
            raise RuntimeError('New challenger payload failed the actual Vault SBF bounds')
        artifacts = ['target/i09-challenger/generated-challenge.bin', 'target/i09-challenger/proof-generation.json', 'target/i09-challenger/svm-results.json', 'target/i04-sbf/zkapi_vault.so', 'services/challenger/Cargo.toml', 'services/challenger/Cargo.lock', 'scripts/run_i09_challenger.py', 'tests/svm/Cargo.toml', 'tests/svm/Cargo.lock', 'tests/svm/src/bin/challenger.rs', 'tests/svm/src/vault_support.rs', 'tests/fixtures/vault/a.json', 'tests/fixtures/vault/a-with-b.json', 'tests/fixtures/vault/b-with-a.json', 'tests/fixtures/layout2/test-tree.vk', 'target/i04/sdk-svm-history.json']
        artifacts += [str(path.relative_to(ROOT)) for path in sorted((ROOT / 'services/challenger/src').rglob('*.rs'))]
        artifacts += [str(path.relative_to(ROOT)) for path in sorted((ROOT / 'services/challenger/tests').rglob('*.rs'))]
        artifacts += [str(path.relative_to(ROOT)) for path in sorted((ROOT / 'services/indexer/src').rglob('*.rs'))]
        artifacts += [str(path.relative_to(ROOT)) for directory in ['packages/sdk/src', 'packages/sdk/test'] for path in sorted((ROOT / directory).glob('challenger*.ts'))]
        artifacts += ['target/i09-challenger/daemon-performance.json', 'target/i09-challenger/native-cli-results.json', 'services/challenger/target/debug/challengerd']
        artifacts += ['target/i09-challenger/i10-restart-results.json']
        report = {'scope': 'I09 challenger A/B native RPC daemon/CLI, durable scan/restart, readonly PostgreSQL, real proof, I04 signed-v0 bridge/recovery fault fixtures, actual Vault signed-v0 SBF acceptance; no live RPC claim', 'passed': True, 'tests_passed': sum(int(p) for p, _, _ in results) + int(sdk_tests.group(1)), 'native_tests_passed': sum(int(p) for p, _, _ in results), 'sdk_tests_passed': int(sdk_tests.group(1)), 'daemon_performance': json.loads((OUT / 'daemon-performance.json').read_text()), 'native_cli': cli_result, 'tests_failed': 0, 'tests_ignored': 0, 'postgres_version': postgres, 'fsync': True, 'rust': run(['rustc', '--version'], True), 'elapsed_seconds': round(time.monotonic() - started, 3), 'commands': COMMANDS, 'artifact_sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in artifacts}, 'release_gates_passed': [], 'new_tree_proof_generated': True, 'new_payload_sbf_verified': True, 'svm': {key: svm[key] for key in ['transactions', 'expected_rejections', 'max_cu', 'max_transaction_bytes', 'payload_sha256', 'elf_sha256']}, 'live_rpc_verified': False}
        report['i10_repeated_outage_restarts'] = restarts_result
        (OUT / 'runtime-report.json').write_text(json.dumps(report, indent=2) + '\n')
    finally:
        if running:
            run(['pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop'], True)
