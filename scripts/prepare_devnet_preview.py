#!/usr/bin/env python3
"""Package an already validated SDK/native installation; never reads private state."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
from clientd_release_provenance import BUILD_INPUTS_PATH, NOTICE_INDEX_PATH, source_snapshot, verify_committed_sources
from collect_clientd_release_notices import native_platform

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'packages/sdk/package.json').read_text())['version']
if not re.fullmatch(r'\d+\.\d+\.\d+-devnet\.\d+', VERSION):
    raise ValueError('an explicit SDK devnet preview version is required')
NATIVE_NAME = f'zkapi-clientd-{VERSION}-darwin-arm64'
SDK_NAME = f'zkapi-solana-sdk-{VERSION}.tgz'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_installation(directory):
    manifest_path = directory / 'release.json'
    manifest = json.loads(manifest_path.read_text())
    if manifest['schema'] != 1:
        raise ValueError('unsupported installation manifest')
    expected = manifest['files']
    actual = {}
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('installation contains a symlink')
        if path.is_file() and path != manifest_path:
            actual[path.relative_to(directory).as_posix()] = sha(path)
    if actual != expected:
        raise ValueError('installation differs from its complete file manifest')
    for name in expected:
        if name.startswith('/') or '..' in Path(name).parts:
            raise ValueError('unsafe installation path')
    for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md', 'bin/clientd', 'bin/node',
                 'bin/zkapi-client-prover', 'bin/zkapi-client-verify', BUILD_INPUTS_PATH, NOTICE_INDEX_PATH):
        if name not in expected:
            raise ValueError('missing release input: ' + name)
    for name in ('bin/clientd', 'bin/node', 'bin/zkapi-client-prover', 'bin/zkapi-client-verify'):
        arch = subprocess.check_output(['lipo', '-archs', str(directory / name)], text=True).strip()
        if arch != 'arm64':
            raise ValueError('this preview archive requires exclusively macOS ARM64 binaries')
    return manifest_path


def native_archive(directory, output):
    # Stable metadata and no macOS resource forks, user names or absolute paths.
    with output.open('xb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for path in [directory, *sorted(directory.rglob('*'))]:
                relative = path.relative_to(directory).as_posix()
                name = NATIVE_NAME if relative == '.' else NATIVE_NAME + '/' + relative
                info = tarfile.TarInfo(name)
                info.mode = 0o700 if path.is_dir() or path.stat().st_mode & 0o111 else 0o600
                if path.is_dir():
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                else:
                    data = path.read_bytes()
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distribution', type=Path, required=True)
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--source-revision', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.source_revision):
        parser.error('full reviewed Git source revision required')
    resolved = subprocess.check_output(['git', 'rev-parse', args.source_revision + '^{commit}'], cwd=ROOT, text=True).strip()
    if resolved != args.source_revision:
        raise ValueError('source revision is not a local commit')
    directory = args.distribution.resolve()
    manifest_path = checked_installation(directory)
    build_inputs = json.loads((directory / BUILD_INPUTS_PATH).read_text())
    if build_inputs.get('schema') != 1 or build_inputs.get('source_inputs_unchanged') is not True:
        raise ValueError('native build requires an unchanged source snapshot')
    if source_snapshot() != build_inputs.get('source_sha256'):
        raise ValueError('current source or SDK inputs differ from the native build')
    verify_committed_sources(build_inputs['source_sha256'], args.source_revision)
    notice_index = json.loads((directory / NOTICE_INDEX_PATH).read_text())
    installed_platform = native_platform(directory)
    if notice_index.get('schema') != 1 or notice_index.get('platform') != installed_platform:
        raise ValueError('installed binary platform differs from its pinned notice index')
    build_host = build_inputs.get('build_host', {})
    if (installed_platform.get('os') != 'darwin' or installed_platform.get('architecture') != 'arm64'
            or build_host.get('os') != 'darwin' or build_host.get('architecture') != 'arm64'
            or not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', build_host.get('os_version', ''))):
        raise ValueError('macOS ARM64 build provenance is required for this preview')
    node_version = subprocess.check_output([str(directory / 'bin/node'), '--version'], text=True).strip()
    if (node_version != 'v' + (ROOT / '.node-version').read_text().strip()
            or notice_index.get('toolchains', {}).get('node') != node_version
            or build_inputs.get('node_version') != node_version):
        raise ValueError('installed Node differs from source or recorded toolchain pins')
    with tarfile.open(args.sdk, 'r:gz') as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)) or any(not member.isfile() for member in members):
            raise ValueError('SDK must contain unique regular files')
        for name in names:
            if not (re.fullmatch(r'package/dist/[a-z0-9-]+\.(js|d\.ts)', name) or
                    name in ['package/' + file for file in ('package.json', 'README.md', 'DISTRIBUTION.md', 'INTERNALS.md', 'LICENSE')]):
                raise ValueError('unexpected SDK member')
        package = json.load(archive.extractfile('package/package.json'))
        if package['version'] != VERSION or package['license'] != 'MIT':
            raise ValueError('SDK version/license mismatch')
        if archive.extractfile('package/LICENSE').read() != (ROOT / 'packages/sdk/LICENSE').read_bytes():
            raise ValueError('SDK license differs from source')
    if sha(directory / 'vendor' / SDK_NAME) != sha(args.sdk) or build_inputs.get('sdk_tarball_sha256') != sha(args.sdk):
        raise ValueError('native installation must embed the exact released SDK')
    args.output.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(args.sdk, args.output / SDK_NAME)
    native = args.output / (NATIVE_NAME + '.tar.gz')
    native_archive(directory, native)
    assets = {path.name: {'sha256': sha(path), 'bytes': path.stat().st_size}
              for path in sorted(args.output.iterdir())}
    release = {
        'schema': 1, 'version': VERSION, 'tag': 'v' + VERSION,
        'source_repository': 'https://github.com/yukikm/solana-zkapi',
        'source_revision': args.source_revision, 'assets': assets,
        'native': {'os': 'macOS', 'architecture': 'arm64', 'minimum_os_version': installed_platform['minimum_os_version'],
                   'tested_os_version': build_host['os_version'], 'installation_manifest_sha256': sha(manifest_path),
                   'node_version': node_version.removeprefix('v'), 'apple_signed_or_notarized': False,
                   'build_inputs_sha256': sha(directory / BUILD_INPUTS_PATH)},
        'deployment_bundle_included': False, 'default_public_operator': None,
        'npm_registry_published': False, 'mainnet_ready': False,
        'full_I10_or_G1_G4_passed': False,
        'validation': 'See docs/support.md and docs/testing.md at source_revision; local fixtures and installed-runtime checks do not establish live provider or public-chain acceptance.',
        'release_attestation': 'Verify the GitHub immutable release after publication; this local manifest is not itself a signature.'
    }
    (args.output / 'release-manifest.json').write_text(json.dumps(release, indent=2) + '\n')
    sums = ''.join(f'{sha(path)}  {path.name}\n' for path in sorted(args.output.iterdir()))
    (args.output / 'SHA256SUMS').write_text(sums)
    print(json.dumps({'output': str(args.output), 'assets': assets, 'installation_manifest_sha256': sha(manifest_path)}))


if __name__ == '__main__':
    main()
