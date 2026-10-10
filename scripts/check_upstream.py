#!/usr/bin/env python3
"""Verify the pinned checkout, source hashes, setup and license artifacts."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor/ethereum-zkapi'


def git(*args):
    return subprocess.check_output(['git', '-C', str(VENDOR), *args], text=True).strip()


def main():
    lock = json.loads((ROOT / 'vendor/upstream-lock.json').read_text())
    expected = lock['commit']
    if git('rev-parse', 'HEAD') != expected:
        raise SystemExit('FAIL: upstream commit mismatch')
    if git('status', '--porcelain', '--untracked-files=no'):
        raise SystemExit('FAIL: upstream tracked files changed')
    files = lock['sha256']
    for path, digest in files.items():
        actual = hashlib.sha256((VENDOR / path).read_bytes()).hexdigest()
        if actual != digest:
            raise SystemExit(f'FAIL: SHA-256 mismatch: {path}')
    deployment = json.loads((VENDOR / 'sdk/assets/config/mainnet.json').read_text())['trusted_deployment']
    for kind in ('request', 'withdrawal'):
        path = f'protocol/setup/v2/{kind}.pk'
        if files[path] != deployment[f'{kind}_proving_key_sha256']:
            raise SystemExit(f'FAIL: upstream deployment key pin mismatch: {kind}')
    print(f'PASS: upstream {expected}; {len(files)} pinned files; setup PK hashes match upstream deployment')
    print('NOT ESTABLISHED: production setup trust, deployed bytecode, Solana runtime gates')


if __name__ == '__main__':
    main()
