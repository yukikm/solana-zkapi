#!/usr/bin/env python3
"""Bounded local startup readiness; never requests a signature or provider call."""
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import time


def signer_ready(config_path, socket_path):
    config = json.loads(Path(config_path).read_bytes())
    # SignerConfig contains only ASCII text, booleans, byte arrays and integer
    # values in the exactly representable range. Its serialization is JCS.
    def validate(value):
        if isinstance(value, dict):
            return all(isinstance(k, str) and k.isascii() and validate(v) for k, v in value.items())
        if isinstance(value, list):
            return all(validate(v) for v in value)
        return value is None or type(value) is bool or type(value) is int and abs(value) < 2**53 or isinstance(value, str) and value.isascii()
    if not validate(config):
        raise ValueError('unsupported config encoding')
    expected = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(2)
        connection.connect(socket_path)
        connection.sendall(b'{"kind":"health"}\n')
        with connection.makefile('rb') as stream:
            line = stream.readline(4097)
    if len(line) > 4096 or not line.endswith(b'\n'):
        return False
    value = json.loads(line)
    return value.get('reconciled') is True and value.get('config_digest') == expected


def main():
    args = sys.argv[1:]
    if not (args == ['postgres'] or len(args) == 3 and args[0] == 'signer'):
        return 2
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            if args[0] == 'postgres':
                ready = subprocess.run(['pg_isready','-h','/run/zkapi-postgresql'],
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=2).returncode == 0
            else:
                ready = signer_ready(args[1],args[2])
            if ready:
                return 0
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        time.sleep(0.2)
    print('Local service readiness deadline exceeded; retained state requires inspection.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
