#!/usr/bin/env python3
"""Validate measurement evidence without turning expected CU failures into G1 PASS."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
result = json.loads((ROOT / 'docs/evidence/I02-svm-results.json').read_text())
assert result['release_budget'] == 1_000_000
assert result['diagnostic_budget'] == 1_000_000_000
rows = {r['case']: r for r in result['cases']}
assert len(rows) == len(result['cases']), 'duplicate measurement cases'
for kind, count in [('request', 12), ('withdrawal', 14), ('escape', 14)]:
    for variant in ['genesis', 'signed']:
        name = f'{kind}-{variant}'
        assert rows[name]['ok'] and rows[name]['cu'] <= 1_000_000
        for family, n in [('input', count), ('noncanonical-input', count), ('coordinate', 8), ('noncanonical-coordinate', 8)]:
            for i in range(n):
                assert not rows[f'{name}/{family}-{i}']['ok']
        for suffix in ['A-sign', 'G2-order', 'non-subgroup-G2', 'trailing', 'truncated']:
            assert not rows[f'{name}/{suffix}']['ok']
for id_ in [0, 2**32-1]:
    for op in range(3):
        name = f'tree-{id_}-{op}'
        assert rows[f'{name}/verifier-only']['ok']
        for i in range(11):
            assert not rows[f'{name}/input-{i}']['ok']
        assert not rows[f'fallback-{name}/release-budget']['ok']
        assert not rows[f'tree-{3+op}-id-{id_}/release-budget']['ok']
assert len(result['wrong_vk_cases']) == 12
assert all(not r['ok'] for r in result['wrong_vk_cases'])
for r in result['diagnostic_cases']:
    if r['case'] == 'fallback/second-CPI-failure-rollback':
        assert not r['ok'] and r['inner_instruction_count'] == 2
    else:
        assert r['ok'] and r['cu'] > 1_000_000
for path, key in [('target/i02-sbf/zkapi_i02_harness.so', 'elf_sha256'),
                  ('target/i02-sbf-wrong/zkapi_i02_harness.so', 'wrong_vk_elf_sha256')]:
    assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == result[key]
sizes = json.loads((ROOT / 'docs/evidence/I02-transaction-sizes.json').read_text())
for row in sizes['cases']:
    for tx in row['serialized']:
        assert tx['fits_1232'] == (tx['bytes'] <= 1232)
        if row['case'].startswith('buffer-'):
            assert tx['fits_1232']
print(f'PASS: {len(rows)} SBF cases, 12 wrong-VK controls, {len(result["diagnostic_cases"])} diagnostic cases, serialized sizes and ELF hashes')
print('G1: FAIL / CU budget exceeded by BOTH tree backends; diagnostics are not cluster-admissible')
