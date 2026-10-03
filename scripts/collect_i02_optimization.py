#!/usr/bin/env python3
"""Collect real SBF research probes; no production/G1 gate promotion."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
out = ROOT / 'target/i02-research-results'
variants = {name: json.loads((out / f'{name}.json').read_text())
            for name in ['base', 'v2', 'v0-dot', 'v2-dot', 'syscall', 'proof-tag']}
for name in ['base', 'v2', 'v0-dot', 'v2-dot']:
    cases = variants[name]['cases']
    assert len(cases) == 6
    assert all(c['matches_upstream'] for c in cases)
assert len(variants['syscall']['cases']) == 5
assert all(not c['matches_upstream'] for c in variants['syscall']['cases'])
fallback = variants['proof-tag']
assert len(fallback['cases']) == 125 and len(fallback['wrong_vk_cases']) == 6
assert len([c for c in fallback['cases'] if c['ok']]) == 6
assert all(c['cu'] <= fallback['budget'] for c in fallback['cases'])
assert all(not c['ok'] for c in fallback['wrong_vk_cases'])
baseline_path = ROOT / 'docs/evidence/I02-svm-results.json'
baseline = json.loads(baseline_path.read_text())
baseline_fallback = [c for c in baseline['diagnostic_cases']
                     if c['case'].startswith('fallback-tree-')]
assert len(baseline_fallback) == 6 and all(c['ok'] for c in baseline_fallback)
report = {
    'scope': 'I02 optimization research; not a production Vault; design adopted in ADR-0001; full G1 pending',
    'runtime': 'LiteSVM 0.6.1 / Agave 2.2.0; all_enabled features; bundled SPL Token 3.5.0 SBF',
    'toolchain': 'cargo-build-sbf 4.1.0 / platform-tools v1.54',
    'baseline_file_sha256': hashlib.sha256(baseline_path.read_bytes()).hexdigest(),
    'baseline_fallback': baseline_fallback,
    'variants': variants,
    'limitations': [
        'Research flags are disabled by default; layout 2 design adopts proof-bound tag; production implementation remains pending.',
        'Proof-bound-tag retains all 11 verified public inputs, six stored-state bindings and the operation binding.',
        'Unchanged deterministic test-only tree setup/VK/proofs; not eligible for production.',
        'The harness omits production Vault account/PDA/status/nullifier/authorization-context/buffer lifecycle checks.',
        'SBPF v2 target-cluster feature/deployment compatibility has not been verified.',
        'SBPF v3 was compiled separately but rejected by the pinned LiteSVM loader; no CU result.',
        'Sponge diagnostic overrides are not cluster-admissible; proof-bound-tag and syscall probes use 1,000,000 CU.',
    ],
}
(ROOT / 'docs/evidence/I02-optimization-results.json').write_text(
    json.dumps(report, indent=2) + '\n')
print('PASS: 24 original-hash probes, 5 incompatible syscall probes, 131 proof-bound-tag cases')
for name, variant in variants.items():
    if name != 'proof-tag':
        print(f"{name}: 11-input CU={next(c['cu'] for c in variant['cases'] if c['inputs'] == 11)}")
for case in fallback['cases']:
    if case['ok']:
        print(f"{case['case']}: CU={case['cu']}")
