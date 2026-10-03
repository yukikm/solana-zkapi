#!/usr/bin/env python3
"""Check I03 fixture provenance and trace preconditions, not cryptographic/SVM gates."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/vault'
GENERATOR = ROOT / 'crates/zkapi-tree-prover/examples/vault_fixtures.rs'
FR = 21888242871839275222246405745257275088548364400416034343698204186575808495617
FQ = 21888242871839275222246405745257275088696311157297823662689037894645226208583
TOKEN = bytes.fromhex('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9')
SCENARIOS = {'a', 'a-with-b', 'b-with-a', 'other-vault', 'max-id', 'genesis-a'}


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def raw(value):
    assert re.fullmatch('[0-9a-f]{64}', value), value
    return bytes.fromhex(value)


def field(value):
    assert re.fullmatch('0x[0-9a-f]{64}', value), value
    result = int(value, 16)
    assert result < FR, value
    return result


def h2f(label, parts):
    label = label.encode('ascii')
    framed = len(label).to_bytes(2, 'big') + label + len(parts).to_bytes(2, 'big')
    for part in parts:
        framed += len(part).to_bytes(4, 'big') + part
    return int.from_bytes(hashlib.sha256(framed).digest(), 'big') % FR


def edwards_decompresses(compressed):
    """Independent field calculation for Solana's off-curve PDA rejection."""
    modulus = 2**255 - 19
    y = (int.from_bytes(compressed, 'little') & (2**255 - 1)) % modulus
    d = -121665 * pow(121666, -1, modulus) % modulus
    denominator = (d * y * y + 1) % modulus
    if denominator == 0:
        return False
    x_squared = (y * y - 1) * pow(denominator, -1, modulus) % modulus
    return pow(x_squared, (modulus - 1) // 2, modulus) in (0, 1)


def pool_pda(pool_id, program):
    for bump in range(255, -1, -1):
        candidate = hashlib.sha256(
            b'pool' + pool_id + bytes([bump]) + program + b'ProgramDerivedAddress'
        ).digest()
        if not edwards_decompresses(candidate):
            return candidate, bump
    raise AssertionError('no pool PDA bump')


def public(proof, length):
    values = [field(x) for x in proof['public_inputs']]
    assert len(values) == length
    wire = proof['proof_wire_hex']
    assert re.fullmatch('[0-9a-f]{512}', wire), 'proof must be 256 bytes'
    coordinates = [int(wire[i:i + 64], 16) for i in range(0, 512, 64)]
    assert all(x < FQ for x in coordinates), 'noncanonical proof coordinate'
    return values


def main():
    manifest = read(FIXTURES / 'manifest.json')
    profile = read(ROOT / 'tests/fixtures/layout2/profile.json')
    body = {k: v for k, v in profile.items() if k != 'circuit_profile_hash'}
    # This profile only uses ASCII strings, integer counters, objects and nulls;
    # sorted compact JSON therefore has the same bytes as its JCS encoding.
    profile_hash = hashlib.sha256(json.dumps(
        body, sort_keys=True, separators=(',', ':')
    ).encode()).hexdigest()
    assert profile_hash == profile['circuit_profile_hash'] == manifest['circuit_profile_hash']
    assert profile['setup_profile'] == 'test_only'
    assert profile['protocol_layout_version'] == 2
    assert profile['tree_backend'] == 'transition_proof'
    assert profile['tree_tag_policy'] == 'proof_bound'
    assert manifest['generator_sha256'] == digest(GENERATOR), 'stale generator provenance'
    assert manifest['real_upstream_proofs'] == manifest['real_tree_proofs'] == 18
    assert manifest['all_proofs_verified_against_pinned_vks'] is True
    for name in ('request', 'withdrawal'):
        for extension in ('pk', 'vk'):
            path = ROOT / f'vendor/ethereum-zkapi/protocol/setup/v2/{name}.{extension}'
            assert digest(path) == profile[f'{name}_{extension}_hash'], path
    tree_profile = profile['tree_proof_artifacts']
    assert digest(ROOT / 'tests/fixtures/tree/test-tree.vk') == tree_profile['vk_hash']
    assert digest(ROOT / 'tests/fixtures/layout2/tree-vk-wire.bin') == tree_profile['verifier_constants_hash']
    with tempfile.TemporaryDirectory(prefix='vault-fixture-source-') as directory:
        archive = Path(directory) / 'circuit-source.tar'
        subprocess.run(['bash', str(ROOT / 'scripts/build_i02_source.sh'), str(archive)],
                       cwd=directory, check=True)
        assert digest(archive) == tree_profile['source_bundle_hash'], 'changed pinned circuit source'

    entries = manifest['files']
    assert len(entries) == len(SCENARIOS)
    assert {entry['file'] for entry in entries} == {f'{name}.json' for name in SCENARIOS}
    cases = {}
    for entry in entries:
        path = FIXTURES / entry['file']
        assert digest(path) == entry['sha256'], path
        value = read(path)
        name = path.stem
        assert value['name'] == name
        program, pool_id = raw(value['program_id']), raw(value['pool_id'])
        assert program == bytes([43]) * 32 == raw(manifest['program_id'])
        assert pool_id == bytes([9 if name == 'other-vault' else 2]) * 32
        pool, bump = pool_pda(pool_id, program)
        assert pool == raw(value['pool']) and bump == value['pool_bump']
        assert raw(value['genesis']) == bytes(32)
        assert raw(value['mint']) == bytes([4]) * 32
        assert raw(value['destination_owner']) == bytes([7]) * 32
        vault = h2f('solana-zkapi-vault-v1', [
            raw(value['genesis']), program, pool, TOKEN, raw(value['mint']), bytes([6])
        ])
        destination = h2f('solana-zkapi-destination-v1', [raw(value['destination_owner'])])
        assert value['now'] == 3_000_000_000
        assert value['ttl'] == 2_592_000 and value['challenge'] == 86_400
        assert value['expiry'] == ((value['now'] + value['ttl'] + 86399) // 86400) * 86400
        assert value['deposit'] == 5_000_000
        assert value['balance'] == (5_000_000 if name == 'genesis-a' else 4_900_000)
        assert value['is_genesis'] is (name == 'genesis-a')
        assert value['anchor'] == (1 if value['is_genesis'] else 12345)
        assert value['id'] == ({'b-with-a': 1, 'max-id': 2**32 - 1}.get(name, 0))
        commitment = int.from_bytes(raw(value['commitment']), 'big')
        assert 0 < commitment < FR
        auth = value['auth']
        request = public(auth['request'], 12)
        withdrawal = public(auth['withdrawal'], 14)
        escape = public(auth['escape'], 14)
        assert request[:3] == withdrawal[:3] == escape[:3] == [2, 0x534f4c, vault]
        assert request[4:6] == withdrawal[4:6] == escape[4:6]
        assert withdrawal[6:8] == escape[6:8]
        assert request[6] == value['now'] and request[7] == 1_000_000
        assert withdrawal[8:11] == escape[8:11] == [value['id'], value['balance'], destination]
        assert request[8] == withdrawal[11] == escape[11]
        assert withdrawal[12] == 1 and escape[12] == 0
        trees = value['trees']
        assert len(trees) == 3
        tree_inputs = []
        for op, tree in enumerate(trees):
            inputs = public(tree, 11)
            assert inputs[0] == vault and inputs[3] == value['id']
            assert inputs[6:10] == [commitment, value['deposit'], value['expiry'], op]
            assert len(tree['siblings']) == 32
            assert all(0 <= field(x) < FR for x in tree['siblings'])
            assert inputs[5 if op == 1 else 4] == 0
            assert inputs[4 if op == 1 else 5] != 0
            tree_inputs.append(inputs)
        insert, remove, restore = tree_inputs
        assert insert[1:3] == restore[1:3] == remove[1:3][::-1]
        assert insert[5] == remove[4] == restore[5]
        assert request[3] == withdrawal[3] == escape[3] == insert[2]
        cases[name] = {'fixture': value, 'request': request, 'escape': escape, 'trees': tree_inputs}

    a, ab, ba, genesis = (cases[name] for name in ('a', 'a-with-b', 'b-with-a', 'genesis-a'))
    a_root, ab_root, b_root = a['trees'][0][2], ab['trees'][1][1], ab['trees'][1][2]
    assert ba['trees'][0][1:3] == [a_root, ab_root], 'B deposit must follow the saved A request'
    assert ab['trees'][2][1:3] == [b_root, ab_root], 'challenge must restore A in current B tree'
    assert len({a_root, ab_root, b_root}) == 3, 'historical/current/pending roots must all differ'
    assert a['request'][8] == ab['escape'][11], 'historical request must challenge the same N'
    assert genesis['trees'] == a['trees'], 'genesis state must be the same deposited note'
    assert genesis['escape'][11] != a['escape'][11], 'genesis and signed state anchors must differ'
    assert cases['other-vault']['request'][2] != a['request'][2]
    assert cases['other-vault']['request'][3] == a['request'][3]
    print('PASS: 6 fixture SHA/source/profile pins, canonical inputs, independent PDA/H2F, historical/genesis/max-ID trace preconditions')
    print('Static fixture checks only; real-proof verification, SVM execution and release gates are separate.')


if __name__ == '__main__':
    main()
