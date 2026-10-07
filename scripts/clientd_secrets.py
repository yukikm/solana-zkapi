#!/usr/bin/env python3
"""Prompt for clientd custody secrets and write one private-pipe JSON handoff.
Never redirect this output to a file. Requires a controlling terminal for getpass.
"""
import argparse
import base64
import getpass
import json
import os
from pathlib import Path
import stat
import sys
import warnings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--initialize', action='store_true', help='explicit first custody initialization only')
    parser.add_argument('--wallet', type=Path, help='existing private Solana 64-byte keypair JSON (never copied)')
    args = parser.parse_args()
    if sys.stdout.isatty():
        raise ValueError('pipe output directly into clientd run; terminal output is refused')
    with warnings.catch_warnings():
        warnings.simplefilter('error', getpass.GetPassWarning)
        passphrase = getpass.getpass('Journal passphrase: ')
        if not 16 <= len(passphrase.encode('utf-8')) <= 4096:
            raise ValueError('passphrase must contain 16 to 4096 UTF-8 bytes')
        if args.initialize and getpass.getpass('Confirm new passphrase: ') != passphrase:
            raise ValueError('passphrases differ')
    value = {'passphrase': passphrase}
    if args.initialize:
        value['initialize_key'] = True
    if args.wallet:
        info = args.wallet.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError('wallet must be an owned private regular file')
        with args.wallet.open('rb') as source:
            actual = os.fstat(source.fileno())
            if actual.st_dev != info.st_dev or actual.st_ino != info.st_ino:
                raise ValueError('wallet changed while opening')
            raw = source.read(4097)
        if len(raw) > 4096:
            raise ValueError('wallet exceeds size bound')
        wallet = json.loads(raw)
        if not isinstance(wallet, list) or len(wallet) != 64 or any(type(n) is not int or not 0 <= n <= 255 for n in wallet):
            raise ValueError('expected existing Solana 64-byte keypair JSON')
        value['wallet_seed_base64'] = base64.b64encode(bytes(wallet[:32])).decode('ascii')
    print(json.dumps(value), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print('clientd secret handoff failed; no secret output', file=sys.stderr)
        raise SystemExit(1)
