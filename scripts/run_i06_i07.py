#!/usr/bin/env python3
"""I06/I07 local acceptance: provider HTTP fixtures + real ledger/proofs/signer/Vault.
No external inference, provider credentials, or production deployment is used.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i06-i07'
OUT.mkdir(parents=True, exist_ok=True)
(OUT / 'runtime-report.json').unlink(missing_ok=True)
# I05's disposable PostgreSQL harness deliberately runs ALL control tests,
# including ignored database cases, and reuses the pinned actual Vault SBF.
subprocess.run(['bash', 'scripts/run_i05.sh'], cwd=ROOT, check=True)
log = (ROOT / 'target/i05/runtime.log').read_text()
for suite in ('direct_adapters', 'proxy_adapters', 'provider_ledger', 'provider_http_runtime'):
    if f'Running tests/{suite}.rs' not in log:
        raise SystemExit(f'Missing provider test suite: {suite}')
results = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', log)
if not results or any(int(f) or int(i) for _, f, i in results):
    raise SystemExit('Acceptance must execute all tests without failures or ignored cases')
for filename in ('runtime.log', 'runtime-report.json', 'svm-results.json', 'http-results.json', 'control-process-results.json'):
    shutil.copyfile(ROOT / 'target/i05' / filename, OUT / ('base-' + filename))
base = json.loads((OUT / 'base-runtime-report.json').read_text())
report = {
    'scope': 'I06/I07 LOCAL ONLY: loopback provider HTTP fixtures, real PostgreSQL, original request proofs, isolated signer, actual Vault SBF regression',
    'passed': True,
    'tests_passed': sum(int(p) for p, _, _ in results),
    'tests_failed': 0,
    'tests_ignored': 0,
    'postgres_version': base['postgres_version'],
    'rust': base['rust'],
    'commands': [['bash', 'scripts/run_i06_i07.sh'], *base['commands']],
    'live_providers_verified': False,
    'hosted_ci_verified': False,
    'release_gates_passed': [],
    'artifact_sha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.glob('base-*'))},
}
(OUT / 'runtime-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'local_passed': True, 'tests_passed': report['tests_passed'], 'real_provider_gate': 'UNVERIFIED'}))
