#!/usr/bin/env python3
"""Compare the prover's dependency closure with its immutable source-bundle lock."""
from pathlib import Path
import sys

if sys.version_info < (3, 11):
    sys.exit('Python 3.11 or newer is required to validate the circuit source lock')

import tomllib

ROOT = Path(__file__).resolve().parents[1]
PINNED_LOCK = Path('tests/fixtures/layout2/source/Cargo.lock')
WORKSPACE_LOCK = Path('Cargo.lock')


def dependency_closure(lock):
    packages = {}
    by_name = {}
    for package in lock['package']:
        identity = (package['name'], package['version'], package.get('source', ''))
        if identity in packages:
            raise ValueError(f'duplicate package identity: {identity}')
        packages[identity] = package
        by_name.setdefault(identity[0], []).append(identity)

    def resolve(reference):
        parts = reference.split(' ', 2)
        matches = [identity for identity in by_name.get(parts[0], [])
                   if (len(parts) < 2 or identity[1] == parts[1])
                   and (len(parts) < 3 or '(' + identity[2] + ')' == parts[2])]
        if len(matches) != 1:
            raise ValueError(f'missing or ambiguous dependency: {reference}')
        return matches[0]

    roots = [identity for identity in by_name.get('zkapi-tree-prover', [])
             if identity[2] == '']
    if len(roots) != 1:
        raise ValueError('missing or ambiguous local zkapi-tree-prover package')
    pending = roots.copy()
    closure = {}
    while pending:
        identity = pending.pop()
        if identity in closure:
            continue
        package = packages[identity]
        dependencies = sorted(resolve(ref) for ref in package.get('dependencies', []))
        # Compare checksums, sources and all other package fields as well as edges.
        # Normalize Cargo's optional version/source qualifiers independently in
        # each lock: an unrelated package may make those qualifiers necessary.
        closure[identity] = {**package, 'dependencies': dependencies}
        pending.extend(dependencies)
    return closure


def verify(root=ROOT):
    pinned = tomllib.loads((root / PINNED_LOCK).read_text())
    current = tomllib.loads((root / WORKSPACE_LOCK).read_text())
    if current.get('version') != pinned.get('version'):
        raise ValueError('circuit source lock format changed')
    expected = dependency_closure(pinned)
    actual = dependency_closure(current)
    changed = sorted(identity for identity in expected.keys() | actual.keys()
                     if expected.get(identity) != actual.get(identity))
    if changed:
        names = ', '.join(f'{name} {version}' for name, version, _ in changed)
        raise ValueError('circuit dependency drift: ' + names
                         + '; review the circuit source/profile before updating its pinned lock')
    return len(expected)


if __name__ == '__main__':
    try:
        count = verify()
    except (ValueError, KeyError, TypeError, OSError) as error:
        sys.exit(str(error))
    print(f'PASS: {count} circuit dependency packages match the source-bundle lock')
