#!/usr/bin/env python3
"""Read-only publication gate for exact bundle bytes and per-file distribution review.

This checks the review record, not legal sufficiency or cryptographic manifest
validity. Use the existing offline packager and SDK verification first.
"""
import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


def require(ok):
    if not ok:
        raise ValueError('public bundle or distribution review rejected')


def strict(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out)
            out[key] = value
        return out
    def reject_constant(_value):
        raise ValueError('non-JSON number')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=reject_constant)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read(path, limit):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit)
    return path.read_bytes()


def digest(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def check(bundle, review_path, bundle_sha256):
    require(digest(bundle_sha256) and bundle.is_dir() and not bundle.is_symlink())
    descriptor_raw = read(bundle / 'bundle.json', 1024 * 1024)
    require(sha(descriptor_raw) == bundle_sha256)
    descriptor = strict(descriptor_raw)
    require(type(descriptor) is dict and type(descriptor.get('schema')) is int and descriptor['schema'] in (1, 2) and type(descriptor.get('files')) is dict)
    files = descriptor['files']
    require(files and len(files) <= 128 and all(isinstance(name, str) and
            re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9.-]*', name) and name != 'bundle.json' for name in files))
    notices = descriptor.get('notices')
    if descriptor['schema'] == 1:
        require('notices' not in descriptor)
    else:
        require(type(notices) is dict and 0 < len(notices) <= 32)
        require(all(isinstance(name, str) and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}', name)
                    and name != 'bundle.json' for name in notices))
        require(all(isinstance(name, str) and re.fullmatch('[a-zA-Z0-9][a-zA-Z0-9.-]{0,127}', name)
                    and name != 'bundle.json' and name in files for name in notices.values()))
        require(len(set(notices.values())) == len(notices))
        wasm = descriptor.get('wasm', {})
        require(type(wasm) is dict)
        core = [descriptor.get('manifest'), wasm.get('path')]
        artifacts = descriptor.get('artifacts', {})
        require(type(artifacts) is dict)
        core += [value for key, value in artifacts.items() if key != 'additional']
        additional = artifacts.get('additional', {})
        require(type(additional) is dict)
        core += list(additional.values())
        require(all(name not in core for name in notices.values()))
        notice_total = 0
        for name in notices.values():
            metadata = files[name]
            require(type(metadata) is dict and type(metadata.get('bytes')) is int and 0 < metadata['bytes'] <= 1024 * 1024)
            notice_total += metadata['bytes']
        require(notice_total <= 4 * 1024 * 1024)
    # Static upload roots must not contain ignored private material or symlinks.
    require({p.name for p in bundle.iterdir()} == {'bundle.json', *files})
    actual = {'bundle.json': bundle_sha256}
    total = 0
    for name, metadata in files.items():
        require(type(metadata) is dict and set(metadata) == {'sha256', 'bytes'} and digest(metadata['sha256']))
        require(type(metadata['bytes']) is int and 0 < metadata['bytes'] <= 512 * 1024 * 1024)
        total += metadata['bytes']
        require(total <= 512 * 1024 * 1024)
        data = read(bundle / name, metadata['bytes'])
        require(len(data) == metadata['bytes'] and sha(data) == metadata['sha256'])
        actual[name] = sha(data)
    review_raw = read(review_path, 1024 * 1024)
    review = strict(review_raw)
    require(type(review) is dict and set(review) == {'schema', 'bundle_sha256', 'reviewer', 'reviewed_at', 'files'})
    require(type(review['schema']) is int and review['schema'] == 1 and review['bundle_sha256'] == bundle_sha256)
    require(isinstance(review['reviewer'], str) and 0 < len(review['reviewer'].strip()) <= 200)
    require(isinstance(review['reviewed_at'], str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', review['reviewed_at']))
    date.fromisoformat(review['reviewed_at'])
    require(type(review['files']) is dict and set(review['files']) == set(actual))
    for name, record in review['files'].items():
        require(type(record) is dict and set(record) == {'sha256', 'decision', 'source', 'terms', 'notices'})
        require(record['sha256'] == actual[name] and record['decision'] == 'approved')
        for field in ('source', 'terms'):
            require(isinstance(record[field], str) and 0 < len(record[field]) <= 2048)
            url = urlsplit(record[field])
            require(url.scheme == 'https' and url.hostname and not url.username and not url.password and not url.query)
        require(type(record['notices']) is list and len(set(record['notices'])) == len(record['notices']))
        require(all(isinstance(notice, str) and notice in actual for notice in record['notices']))
    return {'schema': 1, 'passed': True, 'scope': 'exact bytes and explicit per-file review record only',
            'bundle_sha256': bundle_sha256, 'review_sha256': sha(review_raw),
            'public_files': len(actual), 'asset_bytes': total,
            'legal_sufficiency_verified': False, 'published': False, 'proof_generation_verified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--bundle-sha256', required=True)
    parser.add_argument('--review', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.bundle, args.review, args.bundle_sha256), indent=2))
    except (ValueError, OSError, TypeError, KeyError, RecursionError):
        print(json.dumps({'passed': False, 'error': 'distribution_review_or_bundle_invalid', 'published': False}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
