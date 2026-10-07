#!/usr/bin/env python3
"""Serial, credential-free application SDK checks; retains failed run logs."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

from run_i10_acceptance import source_hashes

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/app-sdk-acceptance'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot():
    sources = source_hashes()
    files = [ROOT / 'README.md', ROOT / 'CONTRIBUTING.md', ROOT / 'vendor/README.md',
             ROOT / 'packages/sdk/README.md', ROOT / 'packages/sdk/INTERNALS.md', Path(__file__)]
    for directory in ('docs/sdk',):
        files.extend(p for p in (ROOT / directory).rglob('*') if p.is_file())
    for path in files:
        sources[str(path.relative_to(ROOT))] = sha(path)
    return sources


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=OUT))
    bundled_node = ROOT / 'target/i08-toolchain/bin/node'
    node = os.environ.get('ZKAPI_NODE') or (str(bundled_node) if bundled_node.is_file() else 'node')
    node = shutil.which(node)
    if not node:
        raise SystemExit('Set ZKAPI_NODE to the pinned Node 24.19.0 executable')
    env = {k: os.environ[k] for k in ('HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'ZKAPI_TEST_CHROME') if k in os.environ}
    env['ZKAPI_NODE'] = node
    env['PATH'] = str(Path(node).parent) + os.pathsep + env.get('PATH', '')
    report = {'schema': 1, 'passed': False, 'scope': 'Local application SDK, fixture lifecycle, real browser custody, isolated npm tarball consumption and docs',
              'started_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'public_chain_verified': False, 'live_provider_verified': False, 'phantom_verified': False,
              'I10_complete': False, 'release_gates_passed': [], 'stages': [], 'run_directory': str(run.relative_to(ROOT))}
    start = time.monotonic()
    try:
        version = subprocess.check_output([node, '--version'], text=True, env=env).strip()
        if version != 'v24.19.0':
            raise RuntimeError('Node 24.19.0 required; observed ' + version)
        report['node_version'] = version
        before = snapshot()
        tsc = str(ROOT / 'node_modules/typescript/bin/tsc')
        commands = [
            ('sdk-typecheck', [node, tsc, '--noEmit', '-p', 'packages/sdk/tsconfig.json']),
            ('sdk-build', [node, 'packages/sdk/build.mjs']),
            ('sdk-tests', [node, '--test', '--test-reporter=tap', *[str(p.relative_to(ROOT)) for p in sorted((ROOT / 'packages/sdk/test').glob('*.test.ts'))]]),
            ('external-package', [sys.executable, 'scripts/run_external_sdk_acceptance.py', '--output', str(run / 'external-package')]),
            ('design-doc-links', [sys.executable, 'scripts/check_design.py']),
            ('diff-check', ['git', 'diff', '--check']),
        ]
        for name, command in commands:
            log = run / (name + '.log')
            stage_start = time.monotonic()
            with log.open('w') as stream:
                completed = subprocess.run(command, cwd=ROOT, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=300)
            stage = {'name': name, 'command': command, 'exit_code': completed.returncode,
                     'elapsed_seconds': round(time.monotonic() - stage_start, 3),
                     'log': str(log.relative_to(ROOT)), 'log_sha256': sha(log)}
            report['stages'].append(stage)
            if completed.returncode:
                raise RuntimeError(name + ' failed; see ' + str(log.relative_to(ROOT)))
            if name == 'sdk-tests':
                text = log.read_text()
                counts = {}
                for key in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'):
                    values = re.findall(r'^# ' + key + r' (\d+)\s*$', text, re.M)
                    if len(values) != 1:
                        raise RuntimeError('Missing/ambiguous TAP summary: ' + key)
                    counts[key] = int(values[0])
                stage['tests'] = counts
                if not counts['tests'] or counts['pass'] != counts['tests'] or any(counts[k] for k in ('fail', 'cancelled', 'skipped', 'todo')):
                    raise RuntimeError('SDK tests require zero failures/skips')
            print('PASS', name, flush=True)
        after = snapshot()
        report['source_sha256'] = before
        report['source_inputs_unchanged'] = before == after
        if before != after:
            raise RuntimeError('Source inputs changed during acceptance')
        report['package_result'] = json.loads((run / 'external-package/results.json').read_text())
        report['passed'] = True
    except Exception as error:
        report['error'] = str(error)
        print('FAIL', error, flush=True)
    finally:
        report['elapsed_seconds'] = round(time.monotonic() - start, 3)
        encoded = json.dumps(report, indent=2) + '\n'
        (run / 'results.json').write_text(encoded)
        (OUT / 'results.json').write_text(encoded)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
