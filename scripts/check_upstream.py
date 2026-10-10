#!/usr/bin/env python3
"""Verify the upstream gitlink, source hashes, setup and dependency artifacts."""
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
    gitlink = subprocess.check_output(
        ['git', '-C', str(ROOT), 'ls-files', '--stage', '--', 'vendor/ethereum-zkapi'],
        text=True,
    ).strip()
    if gitlink != f'160000 {expected} 0\tvendor/ethereum-zkapi':
        raise SystemExit('FAIL: upstream lock does not match the indexed submodule commit')
    if not (VENDOR / '.git').exists():
        raise SystemExit('FAIL: run git submodule update --init --recursive first')
    if git('rev-parse', 'HEAD') != expected:
        raise SystemExit('FAIL: upstream commit mismatch')
    if git('status', '--porcelain', '--untracked-files=no'):
        raise SystemExit('FAIL: upstream tracked files changed')
    files = lock['sha256']
    for path, digest in files.items():
        actual = hashlib.sha256((VENDOR / path).read_bytes()).hexdigest()
        if actual != digest:
            raise SystemExit(f'FAIL: SHA-256 mismatch: {path}')
    # Compare directly with the pinned source; no separate deployment snapshot
    # or network request is needed for the compatibility setup check.
    deployment = json.loads((VENDOR / 'sdk/assets/config/mainnet.json').read_text())['trusted_deployment']
    for kind in ('request', 'withdrawal'):
        path = f'protocol/setup/v2/{kind}.pk'
        if files[path] != deployment[f'{kind}_proving_key_sha256']:
            raise SystemExit(f'FAIL: upstream SDK key pin mismatch: {kind}')
    print(f'PASS: upstream {expected}; {len(files)} pinned files; setup PK hashes match pinned SDK')
    print('NOT ESTABLISHED: production setup trust, deployed bytecode, Solana runtime gates')


if __name__ == '__main__':
    main()
