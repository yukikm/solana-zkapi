"""Read-only guards for an independently pinned experimental devnet profile.

This verifies artifact identity, not a setup ceremony or destruction of entropy.
Never reads private role seeds unless explicitly requested by the backend loader.
"""
import hashlib
import json
from pathlib import Path
import stat

PROFILE_FIELDS = ('protocol_layout_version', 'tree_backend', 'tree_tag_policy', 'circuit_id',
                  'request_pk_hash', 'request_vk_hash', 'withdrawal_pk_hash', 'withdrawal_vk_hash',
                  'tree_proof_artifacts', 'setup_profile', 'setup_transcript_hashes')
FILES = ('tree.pk', 'tree.vk', 'tree-vk-wire.bin', 'circuit-source.tar', 'request.pk', 'request.vk',
         'withdrawal.pk', 'withdrawal.vk', 'profile.json')
ROOT = Path(__file__).resolve().parents[1]


class ProfileError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ProfileError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    require(stat.S_ISREG(path.lstat().st_mode), 'regular profile artifact required')
    return path.read_bytes()


def public_key(text):
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    require(isinstance(text, str) and 1 <= len(text) <= 44 and all(c in alphabet for c in text),
            'canonical public base58 key required')
    number = 0
    for character in text:
        number = number * 58 + alphabet.index(character)
    raw = b'\0' * (len(text) - len(text.lstrip('1'))) + number.to_bytes((number.bit_length() + 7) // 8, 'big')
    require(len(raw) == 32 and raw != bytes(32), 'nonzero 32-byte public key required')
    return raw


def read_public_profile(directory, expected_hash):
    directory = Path(directory)
    require(isinstance(expected_hash, str) and len(expected_hash) == 64
            and all(c in '0123456789abcdef' for c in expected_hash), 'independent profile SHA256 required')
    raw = regular(directory / 'public-profile.json')
    require(sha(raw) == expected_hash, 'public profile SHA256 mismatch')
    p = json.loads(raw)
    require(p.get('schema') == 1 and p.get('kind') == 'public_devnet'
            and p.get('tree_setup') == 'single_party_os_random'
            and p.get('production_eligible') is False, 'fresh experimental devnet profile required')
    legacy = json.loads((ROOT / 'tests/fixtures/layout2/profile.json').read_bytes())
    for name in ('protocol_layout_version', 'tree_backend', 'tree_tag_policy', 'circuit_id',
                 'setup_profile', 'setup_transcript_hashes', 'request_pk_hash', 'request_vk_hash',
                 'withdrawal_pk_hash', 'withdrawal_vk_hash'):
        require(p.get(name) == legacy[name], 'unsupported profile policy or upstream artifact')
    tree = p['tree_proof_artifacts']
    require(tree.get('circuit_id') == 'solana.zkapi.tree.v1' and tree.get('public_inputs') == 11
            and tree.get('setup_transcript_hash') is None, 'tree descriptor mismatch')
    for name in ('pk_hash', 'vk_hash', 'verifier_constants_hash'):
        require(tree.get(name) != legacy['tree_proof_artifacts'][name], 'public fixture tree setup forbidden')
    body = {key: p[key] for key in PROFILE_FIELDS}
    expected_profile = sha(json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())
    require(p.get('circuit_profile_hash') == expected_profile
            and expected_profile != legacy['circuit_profile_hash'], 'circuit profile mismatch or fixture')
    artifact_hashes = p.get('artifact_hashes')
    require(isinstance(artifact_hashes, dict) and set(artifact_hashes) == set(FILES), 'exact artifact set required')
    for name in FILES:
        require(sha(regular(directory / name)) == artifact_hashes[name], 'profile artifact digest mismatch')
    require(json.loads(regular(directory / 'profile.json')) == dict(body, circuit_profile_hash=expected_profile),
            'public/circuit profile mismatch')
    for name, key in (('tree.pk', 'pk_hash'), ('tree.vk', 'vk_hash'),
                      ('tree-vk-wire.bin', 'verifier_constants_hash'), ('circuit-source.tar', 'source_bundle_hash')):
        require(artifact_hashes[name] == tree[key], 'tree artifact binding mismatch')
    for name, key in (('request.pk', 'request_pk_hash'), ('request.vk', 'request_vk_hash'),
                      ('withdrawal.pk', 'withdrawal_pk_hash'), ('withdrawal.vk', 'withdrawal_vk_hash')):
        require(artifact_hashes[name] == p[key], 'upstream artifact binding mismatch')
    fixture = json.loads((ROOT / 'tests/fixtures/crypto/withdrawal-signed.json').read_bytes())['public_inputs']
    known = ({'x': fixture[4], 'y': fixture[5]}, {'x': fixture[6], 'y': fixture[7]})
    require(p.get('state_key') not in known and p.get('clearance_key') not in known
            and p.get('state_key') != p.get('clearance_key'), 'fixture or shared role signing keys forbidden')
    # Canonical point and Ed25519 validation is repeated by the Rust build/server.
    for role in ('state_key', 'clearance_key'):
        key = p.get(role)
        require(isinstance(key, dict) and set(key) == {'x', 'y'} and all(
            isinstance(v, str) and len(v) == 66 and v.startswith('0x')
            and all(c in '0123456789abcdef' for c in v[2:]) for v in key.values()), 'role public key encoding')
    require(isinstance(p.get('quote_public_key'), str) and isinstance(p.get('receipt_public_key'), str)
            and p['quote_public_key'] != p['receipt_public_key'], 'independent Ed25519 roles required')
    known_ed = (bytes.fromhex('66be7e332c7a453332bd9d0a7f7db055f5c5ef1a06ada66d98b39fb6810c473a'),
                bytes.fromhex('0b513ad9b4924015ca0902ed079044d3ac5dbec2306f06948c10da8eb6e39f2d'))
    for role in ('quote_public_key', 'receipt_public_key'):
        require(public_key(p[role]) not in known_ed, 'public fixture Ed25519 key forbidden')
    return p


def private_role_seeds(directory):
    """Explicit backend-only read; callers must compare derived public role pins."""
    import os
    path = Path(directory) / 'private'
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            'private role directory ownership/mode required')
    seeds = {}
    for role in ('state', 'clearance', 'quote', 'receipt'):
        file = path / (role + '.seed')
        info = file.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                and info.st_mode & 0o077 == 0, 'private role seed ownership/mode required')
        raw = file.read_bytes()
        require(len(raw) == 32 and raw not in (bytes(32), bytes([11])*32, bytes([12])*32,
                (31).to_bytes(32, 'big'), (37).to_bytes(32, 'big')), 'public fixture role seed forbidden')
        seeds[role] = raw
    require(len(set(seeds.values())) == 4, 'independent private role seeds required')
    return seeds
