#!/usr/bin/env python3
"""Generate a NEW private devnet profile offline; no wallet, RPC or provider access."""
import argparse
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from public_devnet_profile import ROOT, read_public_profile, sha


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    target = ROOT / 'target'
    target.mkdir(exist_ok=True)
    output = args.output.absolute()
    # Resolve existing ancestors before creating directories; never follow a
    # symlink out of ignored target when writing private signing material.
    if not output.resolve().is_relative_to(target.resolve()) or output.exists():
        parser.error('output must be a new directory under repository target')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    source_paths = [ROOT / 'Cargo.lock', ROOT / 'Cargo.toml']
    for directory in ('crates/zkapi-tree-prover', 'crates/zkapi-poseidon', 'crates/zkapi-layout2',
                      'crates/zkapi-solana-crypto', 'crates/zkapi-solana-types'):
        source_paths.extend(p for p in (ROOT / directory).rglob('*') if p.is_file() and p.suffix in ('.rs', '.toml'))
    with tempfile.TemporaryDirectory(prefix='public-devnet-source-', dir=target) as scratch:
        bundle = Path(scratch) / 'circuit-source.tar'
        with tarfile.open(bundle, 'w', format=tarfile.USTAR_FORMAT) as archive:
            for path in sorted(set(source_paths)):
                data = path.read_bytes()
                info = tarfile.TarInfo(str(path.relative_to(ROOT)))
                info.size = len(data); info.mode = 0o644; info.mtime = 0
                archive.addfile(info, io.BytesIO(data))
        subprocess.run(['cargo', 'run', '--locked', '--release', '-p', 'zkapi-tree-prover',
                        '--example', 'public_devnet_setup', '--', str(output), str(bundle)],
                       cwd=ROOT, check=True)
    expected = sha((output / 'public-profile.json').read_bytes())
    profile = read_public_profile(output, expected)
    print(json.dumps({'prepared': True, 'profile_directory': str(output),
                     'public_profile_sha256': expected, 'circuit_profile_hash': profile['circuit_profile_hash'],
                     'production_eligible': False, 'wallet_rpc_provider_access': False,
                     'next_step': 'Build and review a new program and new pool configuration with these public pins.'}))


if __name__ == '__main__':
    main()
