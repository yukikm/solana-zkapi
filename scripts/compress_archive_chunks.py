#!/usr/bin/env python3
"""Losslessly compress retained v2 archive chunks during explicit maintenance.

Stop both archive writer and follower first. This never changes journal/head,
legacy backup, financial state, filenames or uncompressed SHA-256 identities.
Old readers require decompression before rollback. New readers accept both forms.
"""
import argparse
import concurrent.futures
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid
import zlib


def original_bytes(raw):
    if not raw.startswith(b'\x1f\x8b'):
        return raw
    decoder = zlib.decompressobj(31)
    # Archive chunks are normally <=32 MiB. Oversized singleton blocks are
    # retained and require separate review instead of unbounded allocation.
    decoded = decoder.decompress(raw, 128 * 1024 * 1024 + 1)
    if len(decoded) > 128 * 1024 * 1024 or not decoder.eof or decoder.unused_data:
        raise ValueError('invalid or oversized compressed chunk')
    return decoded


def compress_chunk(path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > 128 * 1024 * 1024:
        raise ValueError('unsupported archive file identity/size')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('archive file changed')
        raw = stream.read(128 * 1024 * 1024 + 1)
    original = original_bytes(raw)
    if hashlib.sha256(original).hexdigest() != path.stem:
        raise ValueError('archive filename checksum mismatch')
    if raw.startswith(b'\x1f\x8b'):
        return len(raw), len(raw), False
    encoded = gzip.compress(original, compresslevel=1, mtime=0)
    if original_bytes(encoded) != original:
        raise ValueError('compression roundtrip mismatch')
    temporary = path.with_name('compression-' + str(uuid.uuid4()) + '.next')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, stat.S_IMODE(before.st_mode))
    with os.fdopen(fd, 'wb') as stream:
        os.fchown(stream.fileno(), before.st_uid, before.st_gid)
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    if original_bytes(temporary.read_bytes()) != original:
        raise ValueError('persisted compression roundtrip mismatch')
    after = path.lstat()
    identity = lambda v: (v.st_dev, v.st_ino, v.st_size, v.st_mtime_ns, v.st_ctime_ns, v.st_uid, v.st_gid, v.st_mode, v.st_nlink)
    if identity(before) != identity(after):
        raise ValueError('archive changed before replacement')
    os.replace(temporary, path)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    return len(raw), len(encoded), True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('journal_directory', type=Path)
    args = parser.parse_args()
    root = args.journal_directory
    if root.resolve() != root or root.is_symlink():
        raise ValueError('canonical journal directory required')
    fd = os.open(root / 'owner.lock', os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb'):
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        head = (root / 'journal.json').read_bytes()
        value = json.loads(head)
        if value['state']['version'] != 2 or value['state'].get('archive', []) != []:
            raise ValueError('v2 archive required')
        saved = 0
        converted = 0
        # Two bounded workers; zlib releases the GIL. Preserve all staging files.
        files = sorted(p for p in (root / 'archive-v2').iterdir() if re.fullmatch('[0-9a-f]{64}\\.json', p.name))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            for i, (old, new, changed) in enumerate(workers.map(compress_chunk, files)):
                saved += old - new
                converted += changed
                if i % 1000 == 0:
                    print(json.dumps({'scanned': i + 1, 'converted': converted, 'saved_bytes': saved}), flush=True)
        if (root / 'journal.json').read_bytes() != head:
            raise ValueError('journal changed during compression')
        print(json.dumps({'complete': True, 'converted': converted, 'saved_bytes': saved,
                          'journal_sha256': hashlib.sha256(head).hexdigest()}), flush=True)


if __name__ == '__main__':
    main()
