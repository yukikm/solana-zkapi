#!/usr/bin/env python3
"""I08 C/D: new native/WASM proofs and durable SDK wallet over actual Vault SBF.

Finality/RPC/clearance envelopes are local test adapters, never live acceptance.
Requires I04 SBF, I05 manifest, and I09's authenticated public test tree setup.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i08-wallet'
OUT.mkdir(parents=True, exist_ok=True)
ENV = dict(os.environ, RAYON_NUM_THREADS='4', ZKAPI_I08_FIXTURE_DIR=str(ROOT / 'target/i08'))
REPORT = OUT / 'runtime-report.json'
REPORT.unlink(missing_ok=True)
COMMANDS = []
LOGS = {}


def run(name, args):
    print('$ ' + ' '.join(args), flush=True)
    start = time.monotonic()
    result = subprocess.run(args, cwd=ROOT, env=ENV, text=True, capture_output=True)
    output = result.stdout + result.stderr
    (OUT / (name + '.log')).write_text(output)
    print(output, end='', flush=True)
    COMMANDS.append({'argv': args, 'exit_code': result.returncode,
                     'seconds': round(time.monotonic() - start, 3)})
    result.check_returncode()
    LOGS[name] = output
    return output.strip()


def node_counts(name):
    counts = {key: int(re.search(rf'^# {key} (\d+)$', LOGS[name], re.M).group(1))
              for key in ['tests', 'pass', 'fail', 'skipped']}
    if counts['tests'] == 0 or counts['fail'] or counts['skipped']:
        raise RuntimeError(name + ': every runtime test, including Chromium, must execute')
    return counts


for required, command in [
    ('target/i04-sbf/zkapi_vault.so', 'bash scripts/run_i04.sh'),
    ('target/i05/public-manifest.json', 'bash scripts/run_i05.sh'),
    ('target/i09-challenger/test-tree.pk', 'python3 scripts/run_i09_challenger.py'),
]:
    if not (ROOT / required).is_file():
        raise SystemExit('Missing ' + required + '; reproduce prerequisite with ' + command)

started = time.monotonic()
node = run('node-version', ['node', '--version'])
npm = ['node', os.environ['ZKAPI_NPM_CLI']] if 'ZKAPI_NPM_CLI' in os.environ else ['npm']
npm_version = run('npm-version', [*npm, '--version'])
engines = json.loads((ROOT / 'package.json').read_text())['engines']
if node != 'v' + engines['node'] or npm_version != engines['npm']:
    raise SystemExit('Use pinned Node/npm from package.json; ZKAPI_NPM_CLI can select an installed npm CLI')
rust = run('rust-version', ['rustc', '--version'])

# macOS ships BSD tar. The authenticated source archive needs canonical GNU tar.
gnu_tar = shutil.which('gtar')
if gnu_tar:
    gnubin = Path(gnu_tar).resolve().parent.parent / 'libexec/gnubin'
    if (gnubin / 'tar').is_file():
        ENV['PATH'] = str(gnubin) + os.pathsep + ENV['PATH']
run('source-bundle', ['bash', 'scripts/build_i02_source.sh', 'target/i08-wallet/circuit-source.tar'])

prover = 'apps/clientd/prover/Cargo.toml'
run('prover-fmt', ['cargo', 'fmt', '--manifest-path', prover, '--', '--check'])
run('native-build', ['cargo', 'build', '--locked', '--release', '--manifest-path', prover, '--bin', 'zkapi-client-prover', '--example', 'test_clearance'])
run('wasm-build', ['cargo', 'build', '--locked', '--release', '--manifest-path', prover, '--target', 'wasm32-unknown-unknown', '--lib'])
run('native-tests', ['cargo', 'test', '--locked', '--manifest-path', prover, '--', '--nocapture'])
run('prover-clippy', ['cargo', 'clippy', '--locked', '--manifest-path', prover, '--all-targets', '--', '-D', 'warnings'])
# Regenerate actual request/receipt/successor fixtures for the same shared verifier.
run('verifier-fixture', ['cargo', 'test', '--locked', '--manifest-path', 'apps/clientd/companion/Cargo.toml', '--test', 'verification', 'real_request_receipts_successor_and_next_request', '--', '--nocapture'])
run('svm-build', ['cargo', 'build', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'wallet'])
run('svm-fmt', ['rustfmt', '--edition', '2021', '--check', '--config', 'skip_children=true', 'tests/svm/src/bin/wallet.rs'])
run('svm-clippy', ['cargo', 'clippy', '--locked', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'wallet', '--', '-D', 'warnings'])
run('typecheck', [*npm, 'run', 'typecheck'])
run('sdk-tests', ['node', '--test', '--test-reporter=tap', *map(str, sorted((ROOT / 'packages/sdk/test').glob('*.test.ts')))])
for name, script in [('wasm-browser', 'prover-browser.ts'), ('wasm-sbf', 'prover-sbf.ts'), ('wallet-sbf', 'wallet-integration.ts')]:
    run(name, ['node', '--test', '--test-reporter=tap', 'packages/sdk/test/' + script])

tests = {name: node_counts(name) for name in ['sdk-tests', 'wasm-browser', 'wasm-sbf', 'wallet-sbf']}
native = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored', LOGS['native-tests'])
tests['native-tests'] = {'pass': sum(int(x[0]) for x in native), 'fail': sum(int(x[1]) for x in native),
                         'skipped': sum(int(x[2]) for x in native)}
if tests['native-tests']['pass'] < 2 or tests['native-tests']['fail'] or tests['native-tests']['skipped']:
    raise RuntimeError('real native proof tests failed, missing, or skipped')
wasm = json.loads((OUT / 'wasm-results.json').read_text())
svm = {name: json.loads((OUT / (name + '-sbf-results.json')).read_text()) for name in ['wallet', 'wasm-close', 'wasm-escape']}
for name, result in svm.items():
    if result['max_cu'] > 1_000_000 or result['max_transaction_bytes'] > 1232:
        raise RuntimeError(name + ': actual Vault bounds exceeded')
svm_summary = {name: {**{key: result[key] for key in ['max_cu', 'max_transaction_bytes', 'vault_micro_usdc', 'destination_micro_usdc']},
                      'transactions': len(result['rows']),
                      'expected_rejections': sum(row['error'] is not None for row in result['rows'])}
               for name, result in svm.items()}
files = [p for directory in ['packages/sdk/src', 'packages/sdk/test', 'apps/clientd/prover/src',
                              'apps/clientd/prover/tests', 'apps/clientd/prover/examples', 'apps/clientd/companion/src']
         for p in (ROOT / directory).rglob('*') if p.is_file()]
files += [ROOT / name for name in [prover, 'apps/clientd/prover/Cargo.lock',
    'apps/clientd/prover/target/release/zkapi-client-prover',
    'apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm',
    'apps/clientd/companion/Cargo.toml', 'apps/clientd/companion/Cargo.lock',
    'services/control/src/crypto.rs', 'services/control/src/quote.rs', 'services/control/src/receipts.rs', 'services/control/src/wire.rs',
    'package-lock.json', 'packages/sdk/package.json', 'scripts/run_i08_wallet.py',
    'tests/svm/src/bin/wallet.rs', 'tests/svm/src/vault_support.rs', 'tests/svm/Cargo.toml', 'tests/svm/Cargo.lock',
    'target/i04-sbf/zkapi_vault.so', 'target/i05/public-manifest.json', 'target/i09-challenger/test-tree.pk',
    'target/i08-wallet/circuit-source.tar', 'target/i08-wallet/native-request.json',
    'target/i08-wallet/native-vault.json', 'target/i08-wallet/wasm-vault.json',
    'target/i08-wallet/wasm-results.json', 'target/i08-wallet/wallet-sbf-results.json',
    'target/i08-wallet/wasm-close-sbf-results.json', 'target/i08-wallet/wasm-escape-sbf-results.json']]
report = {'scope': 'I08 C/D: real native/WASM proof generation, shared verifier, explicit native fallback, full encrypted witness and SDK wallet with actual Vault SBF',
          'passed': True, 'os': platform.platform(), 'node': node, 'npm': npm_version, 'rust': rust,
          'tests': tests, 'wasm': wasm, 'svm': svm_summary, 'commands': COMMANDS,
          'elapsed_seconds': round(time.monotonic() - started, 3),
          'artifact_sha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(files))},
          'wasm_proofs_verified': True, 'new_wasm_payload_sbf_verified': True,
          'wallet_recovery_sbf_verified': True, 'clearance_http': 'test signer, actual Baby-JubJub signature',
          'chain_finality': 'local RPC/indexer fixtures over actual SBF accounts; no live consensus',
          'setup_profile': 'authenticated TEST ONLY public setup',
          'live_provider_verified': False, 'wallet_public_rpc_verified': False, 'release_gates_passed': []}
REPORT.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'passed': True, 'tests': tests, 'svm': svm_summary, 'release_gates_passed': []}))
