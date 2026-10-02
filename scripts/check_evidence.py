#!/usr/bin/env python3
"""Check recorded implementation artifact hashes, without asserting runtime gates."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    report = json.loads((ROOT / 'docs/evidence/implementation-results.json').read_text())
    artifacts = report['artifact_sha256']
    if not artifacts:
        raise SystemExit('FAIL: no implementation artifacts recorded')
    errors = []
    for name, expected in sorted(artifacts.items()):
        path = (ROOT / name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            errors.append(f'missing or invalid artifact: {name}')
        elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            errors.append(f'artifact SHA-256 mismatch: {name}')
    if errors:
        raise SystemExit('\n'.join('FAIL: ' + error for error in errors))
    print(f'PASS: {len(artifacts)} recorded implementation artifact hashes')
    print('NOT ESTABLISHED: test execution, SVM/CU, or release readiness')


if __name__ == '__main__':
    main()
