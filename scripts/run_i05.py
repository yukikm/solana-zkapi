#!/usr/bin/env python3
"""Reproduce I05 against disposable persistent PostgreSQL and separate signer/owner processes.
No existing database is contacted. No provider or public-cluster credentials are used.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i05'
OUT.mkdir(parents=True, exist_ok=True)
ENV = {k: v for k, v in os.environ.items() if not k.startswith('PG') and k not in ('DATABASE_URL', 'ZKAPI_TEST_DATABASE_URL')}
ENV['RAYON_NUM_THREADS'] = '4'
COMMANDS = []
LOG = OUT / 'runtime.log'
LOG.write_text('')
for name in ('runtime-report.json', 'http-results.json', 'control-process-results.json', 'svm-results.json', 'settled-vault.json', 'public-manifest.json'):
    (OUT / name).unlink(missing_ok=True)

def run(args, *, capture=False):
    COMMANDS.append(args)
    result = subprocess.run(args, cwd=ROOT, env=ENV, text=True, capture_output=True)
    with LOG.open('a') as log:
        log.write('$ ' + ' '.join(args) + '\n' + result.stdout + result.stderr)
    if not capture:
        print(result.stdout + result.stderr, end='', flush=True)
    if result.returncode:
        if capture:
            print(result.stdout, result.stderr)
        raise RuntimeError('I05 command failed: ' + args[0])
    return result.stdout.strip() if capture else ''

for binary in ('initdb', 'pg_ctl', 'psql', 'pg_dump', 'cargo'):
    if not shutil.which(binary):
        raise SystemExit('Missing local test tool: ' + binary)
started = time.monotonic()
with tempfile.TemporaryDirectory(prefix='zkapi-i05-', dir='/tmp') as directory:
    work = Path(directory)
    data, socket = work / 'data', work / 'socket'
    socket.mkdir()
    running = False
    try:
        run(['initdb', '-D', str(data), '-U', 'i05_test', '--no-locale', '--encoding=UTF8', '--auth=trust'], capture=True)
        # fsync remains ON: the tests exercise persistence, not an unsafe -F fixture.
        run(['pg_ctl', '-D', str(data), '-l', str(work / 'postgres.log'), '-o', f"-k {socket} -h '' -p 55435", '-w', 'start'], capture=True)
        running = True
        ENV['ZKAPI_TEST_DATABASE_URL'] = f'host={socket} port=55435 user=i05_test dbname=postgres'
        version = run(['psql', '-X', '-h', str(socket), '-p', '55435', '-U', 'i05_test', '-d', 'postgres', '-Atc', 'SHOW server_version'], capture=True)
        run(['cargo', 'run', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'control', '--', '--export'])
        run(['cargo', 'fmt', '--manifest-path', 'services/control/Cargo.toml', '--', '--check'])
        run(['cargo', 'test', '--locked', '--manifest-path', 'services/control/Cargo.toml', '--', '--include-ignored', '--nocapture', '--test-threads=1'])
        run(['cargo', 'clippy', '--locked', '--manifest-path', 'services/control/Cargo.toml', '--all-targets', '--', '-D', 'warnings'])
        run(['cargo', 'run', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'control'])
        run(['cargo', 'clippy', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'control', '--', '-D', 'warnings'])
        run(['python3', 'scripts/check_design.py'])
        run(['python3', 'scripts/check_ledger_contract.py'])
        for artifact in ('http-results.json', 'control-process-results.json', 'svm-results.json', 'public-manifest.json'):
            if not (OUT / artifact).is_file():
                raise RuntimeError('Missing runtime evidence: ' + artifact)
        for marker in ('I05_PRIVATE_PROMPT_CANARY', 'Bearer zkc1.', 'zkp1.'):
            if marker in LOG.read_text() or marker in (work / 'postgres.log').read_text():
                raise RuntimeError('Private canary appeared in runtime logs')
        report = {'scope': 'local I05 runtime; actual PostgreSQL, process signer/dispatcher and Vault SBF; public RPC/provider/production not tested', 'postgres_version': version, 'fsync': True, 'rust': run(['rustc', '--version'], capture=True), 'elapsed_seconds': round(time.monotonic()-started, 3), 'commands': COMMANDS, 'passed': True}
        (OUT / 'runtime-report.json').write_text(json.dumps(report, indent=2) + '\n')
    finally:
        if running:
            run(['pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop'], capture=True)
