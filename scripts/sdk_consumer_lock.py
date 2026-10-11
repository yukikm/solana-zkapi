"""Materialize reviewed SDK consumer locks without resolving a dependency graph.

Only the local SDK artifact reference, version and integrity may change. Run
npm ci separately: dependency preparation may fetch; acceptance uses --offline.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]
KINDS = ('sdk-consumer', 'clientd-runtime')
ACCEPTANCE_DEPENDENCIES = {'typescript': '5.9.3', '@types/node': '24.10.0', 'esbuild': '0.28.2'}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def reviewed(kind: str = 'sdk-consumer', *, root: Path = ROOT) -> tuple[dict, dict, dict]:
    if kind not in KINDS:
        raise ValueError('unknown reviewed consumer fixture')
    directory = root / 'tests/fixtures' / kind
    package = json.loads((directory / 'package.json').read_text())
    lock = json.loads((directory / 'package-lock.json').read_text())
    source = json.loads((root / 'package-lock.json').read_text())
    sdk = json.loads((root / 'packages/sdk/package.json').read_text())
    if package.get('dependencies') != {'@zkapi/solana-sdk': 'file:./zkapi-sdk.tgz'} or package.get('devDependencies', {}) != (ACCEPTANCE_DEPENDENCIES if kind == 'sdk-consumer' else {}):
        raise ValueError('consumer fixture dependency declarations drifted; review and update the tracked fixture')
    if lock.get('lockfileVersion') != 3 or lock.get('packages', {}).get('') != {key: package[key] for key in ['name','version','dependencies','devDependencies'] if key in package}:
        raise ValueError('consumer fixture package and lock disagree')
    sdk_entry = lock['packages'].get('node_modules/@zkapi/solana-sdk', {})
    if sdk_entry.get('dependencies') != sdk['dependencies'] or sdk_entry.get('engines') != sdk['engines'] or source['packages']['packages/sdk'].get('dependencies') != sdk['dependencies'] or source['packages']['packages/sdk'].get('version') != sdk['version']:
        raise ValueError('SDK dependency declarations drifted; update source lock and reviewed consumer fixture')
    runtime = {name: entry for name, entry in source['packages'].items() if name.startswith('node_modules/') and not entry.get('link') and not entry.get('dev')}
    fixture_runtime = {name: entry for name, entry in lock['packages'].items() if name.startswith('node_modules/') and name != 'node_modules/@zkapi/solana-sdk' and not entry.get('dev')}
    if set(runtime) != set(fixture_runtime):
        raise ValueError('SDK runtime dependency graph drifted; review and update the tracked consumer fixture')
    for name, entry in fixture_runtime.items():
        if any(entry.get(key) != runtime[name].get(key) for key in ['version','resolved','integrity','dependencies','optionalDependencies','peerDependencies']):
            raise ValueError('SDK runtime dependency pin drifted: ' + name)
    for name, version in package.get('devDependencies', {}).items():
        if lock['packages'].get('node_modules/' + name, {}).get('version') != version:
            raise ValueError('acceptance dependency pin drifted: ' + name)
    esbuild = lock['packages'].get('node_modules/esbuild')
    if esbuild:
        for name, version in esbuild.get('optionalDependencies', {}).items():
            entry = lock['packages'].get('node_modules/' + name, {})
            if entry.get('version') != version or not entry.get('integrity') or not entry.get('resolved') or not entry.get('optional'):
                raise ValueError('esbuild platform dependency missing from reviewed lock: ' + name)
    hashes = {'fixture_package_sha256':sha(directory/'package.json'), 'fixture_lock_sha256':sha(directory/'package-lock.json'),
              'source_package_sha256':sha(root/'packages/sdk/package.json'), 'source_lock_sha256':sha(root/'package-lock.json')}
    return package, lock, hashes


def materialize(directory: Path, tarball: Path, kind: str = 'sdk-consumer', *, root: Path = ROOT) -> dict:
    """Write package/lock into an existing fresh consumer, retaining reviewed graph.

    The caller copies the SDK tarball inside directory before calling this helper.
    No network, npm, wallet or custody operation is performed here.
    """
    package, lock, hashes = reviewed(kind, root=root)
    directory, tarball = directory.resolve(), tarball.resolve(strict=True)
    try:
        relative = tarball.relative_to(directory)
    except ValueError as error:
        raise ValueError('SDK tarball must be copied inside the consumer before materialization') from error
    if any((directory/name).exists() for name in ['package.json','package-lock.json']):
        raise ValueError('consumer package or lock already exists; preserve it and choose a fresh output')
    with tarfile.open(tarball, 'r:gz') as archive:
        member = archive.getmember('package/package.json')
        if not member.isfile():
            raise ValueError('SDK package metadata is not a regular file')
        sdk = json.load(archive.extractfile(member))
    source = json.loads((root/'packages/sdk/package.json').read_text())
    if any(sdk.get(key) != source.get(key) for key in ['name','version','dependencies','engines']):
        raise ValueError('SDK archive metadata differs from reviewed source package')
    reference = 'file:' + relative.as_posix()
    package['dependencies']['@zkapi/solana-sdk'] = reference
    lock['packages']['']['dependencies']['@zkapi/solana-sdk'] = reference
    entry = lock['packages']['node_modules/@zkapi/solana-sdk']
    entry.update(version=sdk['version'], resolved=reference,
                 integrity='sha512-'+base64.b64encode(hashlib.sha512(tarball.read_bytes()).digest()).decode())
    (directory/'package.json').write_text(json.dumps(package,indent=2)+'\n')
    (directory/'package-lock.json').write_text(json.dumps(lock,indent=2)+'\n')
    return {**hashes,'materialized_package_sha256':sha(directory/'package.json'), 'materialized_lock_sha256':sha(directory/'package-lock.json'),
            'sdk_tarball_sha256':sha(tarball), 'sdk_version':sdk['version']}
