#!/usr/bin/env python3
"""Verify an immutable historical inventory against its explicitly pinned Git source.

No network, checkout, index, or ref changes are performed. Current-source tests
remain separate: later edits or migrations do not rewrite historical evidence.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCE_PIN = 'docs/evidence/implementation-source.json'


class VerificationError(ValueError):
    pass


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise VerificationError('duplicate JSON field')
        value[key] = item
    return value


def read_json(raw):
    try:
        return json.loads(raw, object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise VerificationError('invalid evidence JSON') from error


def relative_path(value):
    if (not isinstance(value, str) or not value or
            any(character in value for character in ('\\', '\0', '\n', '\r')) or
            any(part in ('', '.', '..') for part in value.split('/')) or
            PurePosixPath(value).is_absolute()):
        raise VerificationError('invalid repository-relative evidence path')
    return value


def read_regular(root, name):
    path = root
    for part in relative_path(name).split('/'):
        path = path / part
        if path.is_symlink():
            raise VerificationError('evidence input must not be a symlink')
    if not path.is_file():
        raise VerificationError('missing evidence input: ' + name)
    return path.read_bytes()


def git_environment():
    environment = os.environ.copy()
    environment['GIT_OPTIONAL_LOCKS'] = '0'
    environment['GIT_NO_LAZY_FETCH'] = '1'
    # Defense in depth for Git versions without lazy-fetch suppression: even a
    # partial clone may not start an HTTP, SSH, file, or helper transport here.
    environment['GIT_ALLOW_PROTOCOL'] = ''
    return environment


def git_read(root, arguments, failure):
    result = subprocess.run(
        ['git', '--no-replace-objects', '-C', str(root), *arguments],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=git_environment(),
        check=False,
    )
    if result.returncode:
        raise VerificationError(failure)
    return result.stdout


def verify_blobs(root, rows):
    """Hash exact tree-selected blob IDs in bounded memory, without resolving paths."""
    process = subprocess.Popen(
        ['git', '--no-replace-objects', '-C', str(root), 'cat-file', '--batch'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env=git_environment(),
    )
    try:
        for name, object_id, expected in rows:
            process.stdin.write((object_id + '\n').encode('ascii'))
            process.stdin.flush()
            header = process.stdout.readline().decode('ascii').strip().split()
            if (len(header) != 3 or header[0] != object_id or
                    header[1] != 'blob' or not header[2].isdigit()):
                raise VerificationError('historical Git blob unavailable: ' + name +
                                        '; fetch the pinned source objects and rerun')
            remaining = int(header[2])
            digest = hashlib.sha256()
            while remaining:
                block = process.stdout.read(min(remaining, 65536))
                if not block:
                    raise VerificationError('incomplete historical Git blob: ' + name)
                digest.update(block)
                remaining -= len(block)
            if process.stdout.read(1) != b'\n':
                raise VerificationError('invalid Git blob framing')
            if digest.hexdigest() != expected:
                raise VerificationError('historical artifact SHA-256 mismatch: ' + name)
        process.stdin.close()
        if process.wait():
            raise VerificationError('historical Git object verification failed')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
        if not process.stdin.closed:
            process.stdin.close()


def verify(root=ROOT):
    root = Path(root).resolve()
    pin = read_json(read_regular(root, SOURCE_PIN))
    if (not isinstance(pin, dict) or
            set(pin) != {'schema', 'report_path', 'report_sha256', 'source_commit'} or
            type(pin['schema']) is not int or pin['schema'] != 1 or
            not isinstance(pin['report_sha256'], str) or
            re.fullmatch(r'[0-9a-f]{64}', pin['report_sha256']) is None or
            not isinstance(pin['source_commit'], str) or
            re.fullmatch(r'[0-9a-f]{40}', pin['source_commit']) is None):
        raise VerificationError('invalid historical source pin')
    report_name = relative_path(pin['report_path'])
    raw_report = read_regular(root, report_name)
    if hashlib.sha256(raw_report).hexdigest() != pin['report_sha256']:
        raise VerificationError('historical report SHA-256 mismatch')
    report = read_json(raw_report)
    artifacts = report.get('artifact_sha256') if isinstance(report, dict) else None
    if not isinstance(artifacts, dict) or not artifacts:
        raise VerificationError('no historical implementation artifacts recorded')
    for name, expected in artifacts.items():
        relative_path(name)
        if not isinstance(expected, str) or re.fullmatch(r'[0-9a-f]{64}', expected) is None:
            raise VerificationError('invalid historical artifact SHA-256')

    revision = pin['source_commit']
    missing = ('pinned historical source commit unavailable: ' + revision +
               '; fetch that exact commit from the reviewed repository and rerun '
               '(this validator never uses the network)')
    actual_commit = git_read(root, ['rev-parse', '--verify', revision + '^{commit}'], missing)
    if actual_commit.decode('ascii').strip() != revision:
        raise VerificationError('historical source pin must identify a commit object')
    tree = git_read(root, ['ls-tree', '-r', '-z', revision], missing)
    entries = {}
    for row in tree.split(b'\0'):
        if not row:
            continue
        metadata, path = row.split(b'\t', 1)
        mode, kind, object_id = metadata.decode('ascii').split()
        entries[path.decode('utf-8')] = (mode, kind, object_id)
    rows = []
    for name, expected in [(report_name, pin['report_sha256']), *sorted(artifacts.items())]:
        if name not in entries:
            raise VerificationError('missing historical artifact: ' + name)
        mode, kind, object_id = entries[name]
        if mode not in ('100644', '100755') or kind != 'blob':
            raise VerificationError('historical artifact must be a regular Git blob: ' + name)
        rows.append((name, object_id, expected))
    verify_blobs(root, rows)
    return {'source_commit': revision, 'report_sha256': pin['report_sha256'],
            'artifacts_verified': len(artifacts)}


def main():
    try:
        result = verify()
    except (VerificationError, OSError, UnicodeError, BrokenPipeError) as error:
        detail = str(error) if isinstance(error, VerificationError) else 'evidence input or Git read failed'
        raise SystemExit('FAIL: ' + detail) from None
    print(f"PASS: {result['artifacts_verified']} historical implementation artifact hashes "
          f"at {result['source_commit']}")
    print('NOT ESTABLISHED: current-source equality, test execution, SVM/CU, or release readiness')


if __name__ == '__main__':
    main()
