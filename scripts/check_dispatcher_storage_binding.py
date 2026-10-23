#!/usr/bin/env python3
"""Check a dispatcher claims path against reviewed systemd unit/drop-in files.

This static check performs no writes or provider calls. The dispatcherd
--check-storage ExecStartPre additionally checks the real service namespace.
"""
import argparse
import json
from pathlib import Path, PurePosixPath
import shlex


def absolute_path(value):
    if not isinstance(value, str) or not value.startswith('/'):
        raise ValueError('absolute dispatcher storage path required')
    path = PurePosixPath(value)
    if str(path) != value or '..' in path.parts or any(c.isspace() for c in value) or '%' in value:
        raise ValueError('literal normalized dispatcher storage path required')
    return path


def check_binding(config, units):
    claims = absolute_path(config['claims_directory'])
    writable, inaccessible = [], []
    for text in units:
        section = ''
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith(('#', ';')):
                continue
            if line.startswith('['):
                section = line
                continue
            if section != '[Service]' or '=' not in line:
                continue
            key, value = line.split('=', 1)
            if key not in ('ReadWritePaths', 'InaccessiblePaths'):
                continue
            paths = writable if key == 'ReadWritePaths' else inaccessible
            if not value.strip():
                paths.clear()
            else:
                paths.extend(absolute_path(p.removeprefix('-')) for p in shlex.split(value))
    if not any(claims == path or path in claims.parents for path in writable):
        raise ValueError('dispatcher claims directory is outside service writable paths')
    if any(claims == path or path in claims.parents for path in inaccessible):
        raise ValueError('dispatcher claims directory is inaccessible to service')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dispatcher-config', type=Path, required=True)
    parser.add_argument('--unit', type=Path, action='append', required=True,
                        help='Base unit, followed by ordered drop-ins')
    args = parser.parse_args()
    check_binding(json.loads(args.dispatcher_config.read_bytes()),
                  [path.read_text() for path in args.unit])
    print('Dispatcher storage binding matches the reviewed service paths.')


if __name__ == '__main__':
    main()
