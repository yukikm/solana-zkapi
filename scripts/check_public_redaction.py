#!/usr/bin/env python3
"""Heuristic secret/raw-session check of explicit PUBLIC evidence only.

Never loads environment files or known secrets. Diagnostics contain public file
names, line numbers and rule names, never matched text. A pass is not a proof
that arbitrary secrets are absent; review provenance and intended public fields.
"""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import parse_qsl, urlsplit

PUBLIC = Path(__file__).resolve().parents[1] / 'docs/evidence'
MAX_BYTES = 32 * 1024 * 1024
EXTENSIONS = {'.json', '.md', '.txt', '.log', '.html'}
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
PATTERNS = {
    'raw_session_token': re.compile(r'\bzk[cp]1\.' + UUID + r'\.[A-Za-z0-9_-]{43}\b'),
    'provider_key': re.compile(r'\bsk-(?:proj-|or-v1-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{20,}\b'),
    'private_pem': re.compile(r'-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----'),
    'bearer_value': re.compile(r'\bBearer\s+(?!\[?REDACTED\]?\b|<|\$|fixture\b|example\b)[A-Za-z0-9_.-]{20,}', re.I),
}
SECRET_FIELDS = {'secretkey', 'secret_key', 'privatekey', 'private_key', 'wallet_private_key',
                 'private_journal_key', 'mnemonic', 'seed_phrase', 'apikey', 'api_key',
                 'control_token', 'proxy_token', 'provider_key', 'access_token'}
URL_KEYS = {'api-key', 'api_key', 'apikey', 'key', 'token', 'access_token', 'authorization', 'auth'}


def placeholder(value):
    return isinstance(value, str) and bool(re.fullmatch(
        r'(?:\[?REDACTED\]?|<[^>]*>|\$\{[^}]*\}|REPLACE[_A-Z0-9]*|fixture|example)', value, re.I))


def scan_text(text, is_json=False):
    findings = set()
    def add(rule, at=0):
        findings.add((text.count('\n', 0, at) + 1, rule))
    for rule, pattern in PATTERNS.items():
        for match in pattern.finditer(text):
            add(rule, match.start())
    for match in re.finditer(r'https?://[^\s<>"\x27`]+', text):
        try:
            url = urlsplit(match.group().replace('\\/', '/'))
            if url.username is not None or url.password is not None:
                add('url_userinfo', match.start())
            if any(key.lower() in URL_KEYS and value and not placeholder(value) for key, value in parse_qsl(url.query)):
                add('url_credential_query', match.start())
            if url.hostname and (url.hostname.endswith('.g.alchemy.com') or url.hostname.endswith('.infura.io')):
                tail = url.path.rstrip('/').split('/')[-1]
                if len(tail) >= 16 and not placeholder(tail):
                    add('rpc_credential_path', match.start())
        except ValueError:
            add('malformed_url', match.start())
    if is_json:
        try:
            value = json.loads(text)
        except (ValueError, RecursionError):
            add('invalid_json')
        else:
            def walk(value):
                if isinstance(value, dict):
                    if {'authorization', 'quote', 'public_inputs', 'proof'} <= value.keys():
                        add('raw_authorization_request')
                    for key, item in value.items():
                        if key.lower() in SECRET_FIELDS and item not in (None, '', False) and not placeholder(item):
                            add('secret_field_value')
                        if key.lower() == 'authorization' and isinstance(item, dict) and {'request_id', 'control_secret_hash', 'quote_hash'} <= item.keys():
                            add('raw_authorization_object')
                        walk(item)
                elif isinstance(value, list):
                    for item in value:
                        walk(item)
            try:
                walk(value)
            except RecursionError:
                add('json_nesting_limit')
    return [{'line': line, 'rule': rule} for line, rule in sorted(findings)]


def public_files(arguments, root=PUBLIC):
    """No target/vendor/environment/private inputs and no symlink traversal."""
    literal_root = root.absolute()
    root = root.resolve()
    files = set()
    for argument in arguments or [str(root)]:
        path = Path(argument).absolute()
        if not path.resolve().is_relative_to(root) or path.is_symlink():
            raise ValueError('only ordinary files/directories under docs/evidence may be scanned')
        # Reject symlinks in every ancestor inside the permitted tree too.
        for parent in [path, *path.parents]:
            if parent == root or parent == literal_root:
                break
            if parent.is_symlink():
                raise ValueError('symlink evidence path refused')
        if not path.exists():
            raise ValueError('public evidence input missing')
        candidates = path.rglob('*') if path.is_dir() else [path]
        for candidate in candidates:
            if candidate.is_symlink():
                raise ValueError('symlink evidence path refused')
            if candidate.is_file() and candidate.suffix.lower() in EXTENSIONS:
                if candidate.name.startswith('.') or any(part.lower().startswith('private') for part in candidate.resolve().relative_to(root).parts):
                    raise ValueError('private-labelled evidence input refused')
                files.add(candidate)
    return sorted(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('paths', nargs='*', help='public docs/evidence files/directories; default entire docs/evidence')
    args = parser.parse_args()
    try:
        files = public_files(args.paths)
        if not files:
            raise ValueError('no public text evidence found')
        findings = []
        for path in files:
            if path.stat().st_size > MAX_BYTES:
                findings.append({'file': str(path.relative_to(PUBLIC)), 'line': 1, 'rule': 'file_size_bound'})
                continue
            try:
                text = path.read_text(encoding='utf-8', errors='strict')
            except UnicodeError:
                findings.append({'file': str(path.relative_to(PUBLIC)), 'line': 1, 'rule': 'invalid_utf8'})
                continue
            findings.extend({'file': str(path.relative_to(PUBLIC)), **item} for item in scan_text(text, path.suffix == '.json'))
        print(json.dumps({'passed': not findings, 'scope': 'heuristic public evidence scan; not exhaustive secret detection',
                          'files_scanned': len(files), 'private_inputs_read': False, 'findings': findings}, indent=2))
        return 1 if findings else 0
    except (OSError, ValueError):
        print(json.dumps({'passed': False, 'error': 'public evidence scan refused or could not read an allowed input; values withheld'}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
