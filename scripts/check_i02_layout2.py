#!/usr/bin/env python3
"""Require real adopted-backend evidence; never promote the full Vault G1 gate."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def read(path):
    return json.loads((ROOT / path).read_text())
def digest(path):
    return hashlib.sha256((ROOT / path).read_bytes()).hexdigest()

result = read('docs/evidence/I02B-svm-results.json')
rows = {r['case']: r for r in result['cases']}
assert len(rows) == len(result['cases']) == 257
assert result['compute_budget'] == 1_000_000 and result['sbf_arch'] == 'v0'
assert result['production_eligible'] is False
assert all(r['cu'] < 1_000_000 and r['transaction_bytes'] <= 1232 for r in rows.values())
assert all(r['ok'] == (r['expected'] == 'Ok') for r in rows.values())
assert len([k for k in rows if k.startswith('independent/')]) == 30
assert len([k for k in rows if k.startswith('mixed-valid/')]) == 7
for kind in ['tree','request','withdrawal']:
    for i in range(8):
        assert not rows[f'noncanonical-coordinate/{kind}/{i}']['ok']
    for variant in ['A-sign','G2-order','non-subgroup-G2']:
        assert not rows[f'{variant}/{kind}']['ok']
for name in ['native-cli/real-proof', 'historical-request/pause-challenge', 'sequence/escape', 'sequence/challenge']:
    assert rows[name]['ok']
assert not rows['sequence/consumed-N-after-challenge']['ok']
assert rows['rollback/second-token-CPI']['inner_instruction_count'] == 2
for op in ['Deposit', 'Close', 'Escape', 'Challenge', 'Expiry']:
    for name in ['a', 'max-id']:
        assert rows[f'normal/{name}/{op}']['ok']
for folder, key in [('sbf','elf_sha256'), ('sbf-wrong','wrong_elf_sha256')]:
    assert digest(f'target/i02b/{folder}/zkapi_i02_layout2.so') == result[key]
extraction = read('tests/fixtures/layout2/extraction.json')
assert extraction['legacy_pk_identical'] and extraction['legacy_vk_identical']
assert extraction['constraints'] == 33198 and extraction['invalid_witnesses_rejected'] == 47
assert extraction['old_proofs_verified'] == 6 and extraction['new_proofs_verified_by_old_vk'] == 15
profile = read('tests/fixtures/layout2/profile.json')
assert result['profile_hash'] == profile['circuit_profile_hash']
body = {k:v for k,v in profile.items() if k != 'circuit_profile_hash'}
assert hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',',':')).encode()).hexdigest() == result['profile_hash']
for key, path in [('source_bundle_hash','target/i02b/circuit-source.tar'), ('pk_hash','target/i02b/test-tree.pk'), ('vk_hash','tests/fixtures/layout2/test-tree.vk'), ('verifier_constants_hash','tests/fixtures/layout2/tree-vk-wire.bin')]:
    assert profile['tree_proof_artifacts'][key] == digest(path)
evm = read('target/i02b/evm-empty-root.json')
tests = [test for contract in evm.values() for test in contract['test_results'].values()]
assert len(tests) == 1 and tests[0]['status'] == 'Success'

# Exercise the distributed native CLI's trust boundary, not just a unit helper.
cli = ROOT / 'target/release/tree-prover'
base = [str(cli), '--test-profile', 'tests/fixtures/layout2/profile.json', result['profile_hash'], 'target/i02b/test-tree.pk', 'target/i02b/cli-witness.json', 'target/i02b/invalid-output.bin']
negative = []
def reject(name, args, message):
    proc = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, check=False)
    assert proc.returncode != 0 and message in proc.stderr, (name, proc.stdout, proc.stderr)
    negative.append(name)
args = base.copy(); args[1] = '--production'; reject('test-profile-in-production', args, 'test setup forbidden')
args = base.copy(); args[3] = '00'*32; reject('untrusted-profile-hash', args, 'profile mismatch')
bad = bytearray((ROOT / base[4]).read_bytes()); bad[-1] ^= 1
(ROOT / 'target/i02b/tampered.pk').write_bytes(bad)
args = base.copy(); args[4] = 'target/i02b/tampered.pk'; reject('tampered-proving-key', args, 'key hash')
(ROOT / 'target/i02b/tampered.pk').unlink()
bad = read('target/i02b/cli-witness.json'); bad['siblings'][0] = '0x'+'01'*32
(ROOT / 'target/i02b/tampered-witness.json').write_text(json.dumps(bad))
args = base.copy(); args[5] = 'target/i02b/tampered-witness.json'; reject('stale-or-wrong-path', args, 'invalid witness')
assert not (ROOT / base[6]).exists()
summary = {
    'scope':'I02-B completed; I03/I04 full Vault and buffer lifecycle not measured',
    'sbf_cases':len(rows), 'source_and_profile_verified':True, 'cli_negative_cases':negative,
    'extraction':extraction, 'profile_hash':result['profile_hash'],
    'evm_empty_root':{'result':'PASS','test_count':1,'forge':'1.3.1','solc':'0.8.28','result_sha256':digest('target/i02b/evm-empty-root.json')},
    'proving_times':read('target/i02b/proving-times.json'),
    'normal_cu':{op:{'min':min(v),'max':max(v)} for op in ['Deposit','Close','Escape','Challenge','Expiry'] if (v := [r['cu'] for r in rows.values() if r['case'].startswith('normal/') and r['case'].endswith('/'+op)])},
    'toolchain':{'cargo_build_sbf':'4.1.0','platform_tools':'v1.54','arch':'v0','litesvm':'0.6.1','agave':'2.2.0','spl_token_cpi_binary':'LiteSVM bundled SPL Token 3.5.0'},
    'artifact_sha256':{p:digest(p) for p in ['target/i02b/circuit-source.tar','target/i02b/sbf/zkapi_i02_layout2.so','target/i02b/sbf-wrong/zkapi_i02_layout2.so','Cargo.lock','programs/i02-layout2/Cargo.lock','tests/svm/Cargo.lock','tests/fixtures/layout2/profile.json']},
    'g1_passed':False,'production_eligible':False,
}
(ROOT / 'docs/evidence/I02B-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(f'PASS: I02-B {len(rows)} SBF cases, exact PK/VK extraction, EVM empty root, native CLI/profile and CU/bytes')
print('G1 remains pending: full I03 Vault / I04 transport lifecycle and I10 integration')
