"""Source-byte provenance for native builds and their later release commit."""
import hashlib
from pathlib import Path
import re
import subprocess

from run_i10_acceptance import source_hashes

ROOT = Path(__file__).resolve().parents[1]
VENDOR = 'vendor/ethereum-zkapi'
BUILD_INPUTS_PATH = 'share/zkapi-clientd/build-inputs.json'
NOTICE_INDEX_PATH = 'share/zkapi-clientd/third-party/dependencies.json'
COPIED_FILES = (
    'THIRD_PARTY_NOTICES.md', 'apps/clientd/runtime.ts', 'scripts/clientd_secrets.py',
    'apps/clientd/README.md', 'docs/sdk/clientd-quickstart.md', 'docs/sdk/recovery.md',
    'docs/integrations/openclaw.md', 'docs/releases/devnet-preview.md',
    'apps/clientd/go.mod', 'apps/clientd/companion/Cargo.lock',
    'apps/clientd/prover/Cargo.lock', 'vendor/ethereum-zkapi/zkapi-clientd/LICENSE',
)
EXTRA_INPUTS = (*COPIED_FILES, 'LICENSE', 'packages/sdk/LICENSE',
                'packages/sdk/README.md', 'packages/sdk/DISTRIBUTION.md',
                'packages/sdk/INTERNALS.md')


def source_snapshot():
    # Generated dist/ and target/ products are excluded by the shared guard.
    result = source_hashes()
    for name in EXTRA_INPUTS:
        result[name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
    return dict(sorted(result.items()))


def _committed_hashes(repository, revision, names):
    if not names:
        return {}
    process = subprocess.run(['git', 'cat-file', '--batch'], cwd=repository,
                             input=''.join(revision + ':' + name + '\n' for name in names).encode(),
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    data, offset, result = process.stdout, 0, {}
    for name in names:
        end = data.index(b'\n', offset)
        header = data[offset:end].split()
        if len(header) != 3 or header[1] != b'blob':
            raise ValueError('release commit is missing a regular source file: ' + name)
        size = int(header[2])
        start = end + 1
        contents = data[start:start + size]
        if len(contents) != size or data[start + size:start + size + 1] != b'\n':
            raise ValueError('incomplete committed source read')
        result[name] = hashlib.sha256(contents).hexdigest()
        offset = start + size + 1
    if offset != len(data):
        raise ValueError('unexpected committed source output')
    return result


def verify_committed_sources(snapshot, revision, repository=ROOT):
    """Join every recorded source digest to its exact superproject/submodule commit."""
    if not isinstance(snapshot, dict) or not snapshot:
        raise ValueError('build source snapshot is missing')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('full source commit is required')
    root_names, vendor_names = [], []
    for name, digest in snapshot.items():
        if name == 'gitlink:' + VENDOR:
            if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{40}', digest):
                raise ValueError('invalid recorded upstream commit')
            continue
        if (not isinstance(name, str) or not name or name.startswith('/')
                or any(part in ('', '.', '..') for part in name.split('/'))
                or any(c in name for c in '\r\n\0')
                or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest)):
            raise ValueError('invalid source snapshot entry')
        if name.startswith(VENDOR + '/'):
            vendor_names.append(name[len(VENDOR) + 1:])
        else:
            root_names.append(name)
    pinned = snapshot.get('gitlink:' + VENDOR)
    if not pinned:
        raise ValueError('build snapshot must include the upstream gitlink')
    entry = subprocess.check_output(['git', 'ls-tree', '-z', revision, '--', VENDOR], cwd=repository)
    expected_entry = ('160000 commit ' + pinned + '\t' + VENDOR + '\0').encode()
    if entry != expected_entry:
        raise ValueError('release commit and build upstream gitlink differ')
    root_hashes = _committed_hashes(repository, revision, sorted(root_names))
    vendor_hashes = _committed_hashes(Path(repository) / VENDOR, pinned, sorted(vendor_names))
    committed = {**root_hashes, **{VENDOR + '/' + name: digest for name, digest in vendor_hashes.items()},
                 'gitlink:' + VENDOR: pinned}
    if committed != snapshot:
        raise ValueError('release source commit differs from recorded build inputs')
