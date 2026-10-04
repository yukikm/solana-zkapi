#!/usr/bin/env python3
"""Reproduce I08's first local slice; no WASM/provider/wallet release claims."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i08'
OUT.mkdir(parents=True, exist_ok=True)
ENV = dict(os.environ, RAYON_NUM_THREADS='4', ZKAPI_I08_FIXTURE_DIR=str(OUT))
REPORT = OUT / 'runtime-report.json'
REPORT.unlink(missing_ok=True)
commands = []
logs = {}

def run(name, args):
    started = time.monotonic()
    completed = subprocess.run(args, cwd=ROOT, env=ENV, text=True, capture_output=True)
    output = completed.stdout + completed.stderr
    (OUT / f'{name}.log').write_text(output)
    print(output, end='', flush=True)
    commands.append({'argv': args, 'exit_code': completed.returncode, 'seconds': round(time.monotonic() - started, 3)})
    completed.check_returncode()
    logs[name] = output
    return output.strip()

started = time.monotonic()
manifest = 'apps/clientd/companion/Cargo.toml'
run('fmt', ['cargo', 'fmt', '--manifest-path', manifest, '--', '--check'])
run('native-tests', ['cargo', 'test', '--locked', '--manifest-path', manifest, '--', '--nocapture'])
run('native-build', ['cargo', 'build', '--locked', '--manifest-path', manifest])
run('clippy', ['cargo', 'clippy', '--locked', '--manifest-path', manifest, '--all-targets', '--', '-D', 'warnings'])
run('typecheck', ['npm', 'run', 'typecheck'])
run('sdk-tests', ['node', '--test', '--test-reporter=tap', *map(str, sorted((ROOT / 'packages/sdk/test').glob('*.test.ts')))])
run('native-integration', ['node', '--test', '--test-reporter=tap', 'packages/sdk/test/native-integration.ts'])
if not all((OUT / name).is_file() for name in ['prepare-command.json', 'settlement-command.json', 'expected-next-state.json']):
    raise RuntimeError('native real-proof fixture output missing')
tests = {}
for name in ['sdk-tests', 'native-integration']:
    counts = {key: int(re.search(rf'^# {key} (\d+)$', logs[name], re.M).group(1)) for key in ['tests', 'pass', 'fail', 'skipped']}
    if counts['fail'] or counts['skipped']:
        raise RuntimeError(f'{name} has failures/skips: browser and native checks are mandatory for this runner')
    tests[name] = counts
native = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored', logs['native-tests'])
tests['native-tests'] = {'pass': sum(int(x[0]) for x in native), 'fail': sum(int(x[1]) for x in native), 'skipped': sum(int(x[2]) for x in native)}
if not native or tests['native-tests']['fail'] or tests['native-tests']['skipped']:
    raise RuntimeError('native tests missing, failed or skipped')
files = [p for directory in ['packages/sdk/src', 'packages/sdk/test', 'apps/clientd/companion/src', 'apps/clientd/companion/tests']
         for p in (ROOT / directory).rglob('*') if p.is_file()]
files += [ROOT / manifest, ROOT / 'apps/clientd/companion/Cargo.lock', ROOT / 'package-lock.json', ROOT / 'packages/sdk/package.json',
          ROOT / 'scripts/run_i08.py', ROOT / 'apps/clientd/companion/target/debug/zkapi-client-verify']
report = {'scope': 'I08 first slice: trust, durable journal, shared control recovery, native real-proof and successor verification',
          'passed': True, 'date_jst': '2026-10-04', 'os': platform.platform(),
          'node': run('node-version', ['node', '--version']), 'npm': run('npm-version', ['npm', '--version']),
          'rust': run('rust-version', ['rustc', '--version']),
          'requested_node': (ROOT / '.node-version').read_text().strip(),
          'tests': tests, 'commands': commands, 'elapsed_seconds': round(time.monotonic() - started, 3),
          'browser': re.findall(r'Runtime browser: ([^\n]+)', logs['sdk-tests']),
          'artifact_sha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(files))},
          'release_gates_passed': [], 'wasm_proofs_verified': False, 'live_provider_verified': False,
          'wallet_public_rpc_verified': False, 'go_clientd_implemented': False}
REPORT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': True, 'tests': tests, 'release_gates_passed': []}))
