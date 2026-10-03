#!/usr/bin/env python3
"""Exercise the actual archive builder with different checkout metadata and source bytes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BUILDER = Path('scripts/build_i02_source.sh')
CIRCUIT = Path('crates/zkapi-tree-prover/src/circuit.rs')


def build(root, output):
    # The builder must locate its sources independently of the caller's cwd.
    subprocess.run(['bash', str(root / BUILDER), str(output)], cwd=output.parent, check=True)
    return output.read_bytes()


def main():
    profile = json.loads((ROOT / 'tests/fixtures/layout2/profile.json').read_text())
    cases = []
    with tempfile.TemporaryDirectory(prefix='zkapi-source-') as temporary:
        temp = Path(temporary)
        reference = build(ROOT, temp / 'reference.tar')
        archive_hash = hashlib.sha256(reference).hexdigest()
        with tarfile.open(temp / 'reference.tar') as archive:
            members = archive.getmembers()
        for member in members:
            assert member.isfile() or member.isdir(), member.name
            assert member.mode == (0o755 if member.isdir() else 0o644), member.name
            assert member.mtime == member.uid == member.gid == 0, member.name
            assert member.uname == member.gname == '', member.name

        for name, file_mode, dir_mode, mtime in [
            ('umask-077', 0o600, 0o700, 1_600_000_000),
            ('umask-022', 0o644, 0o755, 1_700_000_000),
            ('executable-and-group-write-drift', 0o775, 0o775, 1_800_000_000),
        ]:
            checkout = temp / name
            (checkout / BUILDER).parent.mkdir(parents=True)
            shutil.copyfile(ROOT / BUILDER, checkout / BUILDER)
            # Reverse creation order to ensure enumeration order is irrelevant.
            for member in reversed(members):
                destination = checkout / member.name
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(ROOT / member.name, destination)
            for path in checkout.rglob('*'):
                path.chmod(dir_mode if path.is_dir() else file_mode)
                os.utime(path, (mtime, mtime))
            assert build(checkout, temp / f'{name}.tar') == reference, name
            cases.append({'case': name, 'file_mode': oct(file_mode),
                          'directory_mode': oct(dir_mode), 'mtime': mtime,
                          'archive_identical': True})

        # Metadata is ignored, but actual circuit changes and missing sources must not be.
        source = checkout / CIRCUIT
        source.write_bytes(source.read_bytes() + b'\n// changed circuit source\n')
        assert build(checkout, temp / 'changed.tar') != reference
        source.unlink()
        missing = subprocess.run(['bash', str(checkout / BUILDER), str(temp / 'missing.tar')],
                                 capture_output=True, check=False)
        assert missing.returncode != 0

    assert archive_hash == profile['tree_proof_artifacts']['source_bundle_hash'], 'stale source pin'
    body = {k: v for k, v in profile.items() if k != 'circuit_profile_hash'}
    profile_hash = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    assert profile_hash == profile['circuit_profile_hash'], 'stale profile pin'
    result = {'scope': 'source archive metadata regression; not a runtime or release gate',
              'archive_sha256': archive_hash, 'profile_hash': profile_hash, 'cases': cases,
              'canonical_headers_verified': True, 'source_change_changes_archive': True,
              'missing_source_rejected': True, 'pinned_profile_matches': True}
    (ROOT / 'docs/evidence/I02B-reproducibility.json').write_text(json.dumps(result, indent=2) + '\n')
    print('PASS: 3 checkout metadata variants produce identical pinned archive/profile; content changes detected; missing sources fail')


if __name__ == '__main__':
    main()
