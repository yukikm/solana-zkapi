#!/usr/bin/env python3
"""Stage a pinned restart cache after lossless raw-to-gzip archive conversion.

Explicit offline maintenance only: stop writer and follower. Supply the SHA-256
recorded for the original private cache before maintenance. Every referenced
payload is authenticated against its unchanged logical SHA-256 and length;
only chunk file stamps change. Runtime bytes, bindings, anchors, reference chain,
legacy source and journal remain unchanged. The result is a NEW candidate file;
this tool never activates it or changes the original cache/financial journal.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct

from compress_archive_chunks import original_bytes

MAGIC = b'ZKAPI-ARCHIVE-CHECKPOINT-V1\n'
META_LIMIT = 64 * 1024 * 1024
STATE_LIMIT = 256 * 1024 * 1024


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate cache field')
            result[key] = value
        return result
    def constant(_):
        raise ValueError('invalid JSON constant')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def stamp(value):
    return [value.st_dev, value.st_ino, value.st_size, value.st_mode,
            value.st_uid, value.st_gid, value.st_nlink,
            value.st_mtime_ns // 10**9, value.st_mtime_ns % 10**9,
            value.st_ctime_ns // 10**9, value.st_ctime_ns % 10**9]


def directory_stamp(path):
    value = path.lstat()
    if not stat.S_ISDIR(value.st_mode):
        raise ValueError('private directory required')
    return [value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid]


def read_regular(path, limit):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        raise ValueError('regular bounded file required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        if stamp(os.fstat(stream.fileno())) != stamp(before):
            raise ValueError('file changed during open')
        raw = stream.read(limit + 1)
        if stamp(os.fstat(stream.fileno())) != stamp(before):
            raise ValueError('file changed during read')
    if len(raw) != before.st_size or stamp(path.lstat()) != stamp(before):
        raise ValueError('file changed after read')
    return raw, before


def decode_cache(raw):
    if not raw.startswith(MAGIC) or len(raw) > len(MAGIC) + 48 + META_LIMIT + STATE_LIMIT:
        raise ValueError('cache format/bound')
    if hashlib.sha256(raw[:-32]).digest() != raw[-32:]:
        raise ValueError('cache checksum')
    cursor = len(MAGIC)
    def part(limit):
        nonlocal cursor
        if cursor + 8 > len(raw) - 32:
            raise ValueError('cache length')
        length = struct.unpack('>Q', raw[cursor:cursor+8])[0]
        cursor += 8
        if not 0 < length <= limit or cursor + length > len(raw) - 32:
            raise ValueError('cache byte bound')
        value = raw[cursor:cursor+length]
        cursor += length
        return value
    metadata = strict_json(part(META_LIMIT))
    payload = part(STATE_LIMIT)
    if cursor != len(raw) - 32 or list(hashlib.sha256(payload).digest()) != metadata['state_sha256']:
        raise ValueError('cache runtime checksum/EOF')
    return metadata, payload


def stage_checkpoint(root, cache, expected_sha256, output, verified):
    if not re.fullmatch('[0-9a-f]{64}', expected_sha256):
        raise ValueError('original cache digest required')
    if cache.resolve() != cache or output.parent != cache.parent or output == cache:
        raise ValueError('canonical cache and separate sibling output required')
    parent = cache.parent.lstat()
    raw, identity = read_regular(cache, META_LIMIT + STATE_LIMIT + len(MAGIC) + 48)
    if (stat.S_IMODE(identity.st_mode) != 0o600 or parent.st_mode & 0o022
            or identity.st_uid != parent.st_uid or identity.st_uid != root.stat().st_uid):
        raise ValueError('private cache custody')
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError('original cache digest mismatch')
    metadata, payload = decode_cache(raw)
    original_metadata = json.dumps(metadata, sort_keys=True)
    head_raw, _ = read_regular(root / 'journal.json', 16 * 1024 * 1024)
    head = strict_json(head_raw)['segmented']
    if (metadata['version'] != 1 or metadata['head']['version'] != 2
            or metadata['head']['pool'] != head['pool'] or metadata['head']['legacy'] != head['legacy']
            or metadata['head']['chunks'] > head['chunks'] or metadata['head']['blocks'] > head['blocks']
            or metadata['root_identity'] != directory_stamp(root)
            or metadata['archive_identity'] != directory_stamp(root / 'archive-v2')
            or metadata['legacy_stamp']['fields'] != stamp((root / 'legacy-v1.json').lstat())):
        raise ValueError('cache archive binding changed')
    references = metadata['references']
    old_stamps = metadata['chunk_stamps']
    if (not references or len(references) != metadata['head']['chunks'] or len(old_stamps) != len(references)
            or references[-1] != metadata['head']['tail']):
        raise ValueError('cache reference shape')
    updated = []
    for index, (reference, old) in enumerate(zip(references, old_stamps)):
        if reference['sequence'] != index + 1:
            raise ValueError('cache reference order')
        digest = bytes(reference['sha256']).hex()
        path = root / 'archive-v2' / (digest + '.json')
        current = stamp(path.lstat())
        # Compression may replace inode/length/timestamps, never custody/device.
        if any(current[k] != old['fields'][k] for k in [0, 3, 4, 5, 6]):
            raise ValueError('archive custody/device changed')
        if digest not in verified:
            encoded, info = read_regular(path, 128 * 1024 * 1024)
            original = original_bytes(encoded)
            if len(original) != reference['bytes'] or hashlib.sha256(original).hexdigest() != digest:
                raise ValueError('archive content mismatch')
            verified[digest] = (stamp(info), len(original), encoded.startswith(b'\x1f\x8b'))
        captured, length, compressed = verified[digest]
        if current != captured or reference['bytes'] != length:
            raise ValueError('verified archive changed')
        if current != old['fields'] and (not compressed or old['fields'][2] != reference['bytes']):
            raise ValueError('only verified raw-to-gzip replacements can be rebound')
        updated.append({'fields': current})
    # Recheck every captured identity and original input before staging output.
    for reference, value in zip(references, updated):
        path = root / 'archive-v2' / (bytes(reference['sha256']).hex() + '.json')
        if stamp(path.lstat()) != value['fields']:
            raise ValueError('archive changed before staging')
    if ((root / 'journal.json').read_bytes() != head_raw or stamp(cache.lstat()) != stamp(identity)
            or metadata['legacy_stamp']['fields'] != stamp((root / 'legacy-v1.json').lstat())
            or metadata['root_identity'] != directory_stamp(root)
            or metadata['archive_identity'] != directory_stamp(root / 'archive-v2')):
        raise ValueError('cache/source changed before staging')
    metadata['chunk_stamps'] = updated
    comparison = dict(metadata, chunk_stamps=old_stamps)
    if json.dumps(comparison, sort_keys=True) != original_metadata:
        raise ValueError('non-storage metadata changed')
    encoded = json.dumps(metadata, separators=(',', ':')).encode()
    if len(encoded) > META_LIMIT:
        raise ValueError('cache metadata bound')
    prefix = MAGIC + struct.pack('>Q', len(encoded)) + encoded + struct.pack('>Q', len(payload)) + payload
    candidate = prefix + hashlib.sha256(prefix).digest()
    if decode_cache(candidate) != (metadata, payload):
        raise ValueError('candidate roundtrip')
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        os.fchown(stream.fileno(), identity.st_uid, identity.st_gid)
        stream.write(candidate)
        stream.flush()
        os.fsync(stream.fileno())
    fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(fd)
    os.close(fd)
    persisted, _ = read_regular(output, META_LIMIT + STATE_LIMIT + len(MAGIC) + 48)
    if persisted != candidate or cache.read_bytes() != raw:
        raise ValueError('persisted cache mismatch')
    return {'source_sha256': expected_sha256, 'candidate_sha256': hashlib.sha256(candidate).hexdigest(),
            'references': len(references), 'runtime_sha256': hashlib.sha256(payload).hexdigest(),
            'runtime_unchanged': True, 'activated': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('journal_directory', type=Path)
    parser.add_argument('--checkpoint', nargs=3, action='append', required=True,
                        metavar=('ORIGINAL', 'ORIGINAL_SHA256', 'NEW_CANDIDATE'))
    args = parser.parse_args()
    root = args.journal_directory
    if root.resolve() != root or root.is_symlink():
        raise ValueError('canonical journal required')
    fd = os.open(root / 'owner.lock', os.O_RDWR | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb'):
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        verified = {}
        for source, digest, output in args.checkpoint:
            result = stage_checkpoint(root, Path(source), digest, Path(output), verified)
            print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
