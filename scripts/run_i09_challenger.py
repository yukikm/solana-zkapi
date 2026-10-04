#!/usr/bin/env python3
"""I09 challenger tests; local PostgreSQL + archive + new payload in real Vault SBF.
No daemon/broadcaster, live provider/RPC, or release-gate claims.
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

for tool in ('initdb', 'pg_ctl', 'psql', 'cargo'):
    if not shutil.which(tool):
        raise SystemExit('Missing local test tool: ' + tool)
if not (ROOT / 'target/i04/sdk-svm-history.json').is_file():
    raise SystemExit('Generate the required actual Vault SBF history first: bash scripts/run_i04.sh')
if not (ROOT / 'target/i04-sbf/zkapi_vault.so').is_file():
    raise SystemExit('Build the required actual Vault SBF ELF first: bash scripts/run_i04.sh')
for name in ['generated-challenge.bin', 'proof-generation.json', 'svm-results.json']:
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
        run(['cargo', 'run', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'challenger'])
        run(['cargo', 'fmt', '--manifest-path', 'tests/svm/Cargo.toml', '--', '--check'])
        run(['cargo', 'clippy', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'challenger', '--', '-D', 'warnings'])
        svm = json.loads((OUT / 'svm-results.json').read_text())
        if not svm['passed'] or svm['max_cu'] > 1_000_000 or svm['max_transaction_bytes'] > 1232:
            raise RuntimeError('New challenger payload failed the actual Vault SBF bounds')
        artifacts = ['target/i09-challenger/generated-challenge.bin', 'target/i09-challenger/proof-generation.json', 'target/i09-challenger/svm-results.json', 'target/i04-sbf/zkapi_vault.so', 'services/challenger/Cargo.toml', 'services/challenger/Cargo.lock', 'scripts/run_i09_challenger.py', 'tests/svm/Cargo.toml', 'tests/svm/Cargo.lock', 'tests/svm/src/bin/challenger.rs', 'tests/svm/src/vault_support.rs', 'tests/fixtures/vault/a.json', 'tests/fixtures/vault/a-with-b.json', 'tests/fixtures/vault/b-with-a.json', 'tests/fixtures/layout2/test-tree.vk', 'target/i04/sdk-svm-history.json']
        artifacts += [str(path.relative_to(ROOT)) for path in sorted((ROOT / 'services/challenger/src').rglob('*.rs'))]
        report = {'scope': 'I09 challenger A/B foundation: local readonly PostgreSQL, historical real RP/tree verification, actual-SBF history replay, fsync journal, newly generated payload through actual Vault SBF/v0 buffers; no daemon/broadcaster recovery', 'passed': True, 'tests_passed': sum(int(p) for p, _, _ in results), 'tests_failed': 0, 'tests_ignored': 0, 'postgres_version': postgres, 'fsync': True, 'rust': run(['rustc', '--version'], True), 'elapsed_seconds': round(time.monotonic() - started, 3), 'commands': COMMANDS, 'artifact_sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in artifacts}, 'release_gates_passed': [], 'new_tree_proof_generated': True, 'new_payload_sbf_verified': True, 'svm': {key: svm[key] for key in ['transactions', 'expected_rejections', 'max_cu', 'max_transaction_bytes', 'payload_sha256', 'elf_sha256']}, 'live_rpc_verified': False}
        (OUT / 'runtime-report.json').write_text(json.dumps(report, indent=2) + '\n')
    finally:
        if running:
            run(['pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop'], True)
