#!/usr/bin/env python3
"""Local generic JSON API lifecycle with real SDK/proofs/ledger/signer/Vault SBF.

Creates fresh disposable PostgreSQL and synthetic funded notes. Never reads
funded profiles, historical journals, provider secrets or public RPC settings.
Keeps every run and report under ignored target/general-api-local. Requires
already installed pinned tools and authenticated local test proof prerequisites.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/general-api-local'


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def executable(name, candidates):
    override = os.environ.get(name)
    for candidate in ([override] if override else candidates):
        found = shutil.which(str(candidate))
        if found:
            return str(Path(found).absolute())
    raise RuntimeError(f'{name}: install the documented pinned tool or select an existing executable')


def validate(result):
    for name in ('passed', 'encrypted_journal', 'legacy_history_unchanged', 'lost_finalized_send_recovered',
                 'request_proof_verified', 'receipts_verified', 'signed_successor_verified',
                 'request_body_has_no_model', 'duplicates_not_replayed', 'invalid_requests_no_egress',
                 'restarted_journal_recovery', 'balance_conservation', 'separate_signer_process',
                 'separate_dispatcher_process'):
        if result.get(name) is not True:
            raise RuntimeError('missing lifecycle invariant: ' + name)
    if result.get('provider_calls') != {'legacy': 1, 'success': 1, 'http_error': 1, 'invalid_json': 1}:
        raise RuntimeError('unexpected upstream calls or automatic replay')
    if (result.get('automatic_api_replays') != 0 or result.get('live_provider_verified') is not False
            or result.get('public_rpc_verified') is not False or result.get('release_gates_passed') != []):
        raise RuntimeError('invalid local verification scope')
    amounts = [result.get(name) for name in ('deposit_micro_usdc', 'withdrawal_micro_usdc', 'total_charge_micro_usdc')]
    if any(not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]*', value) for value in amounts):
        raise RuntimeError('noncanonical integer financial units')
    deposit, withdrawal, charge = map(int, amounts)
    if (deposit, withdrawal, charge) != (5_000_000, 4_999_749, 251) or deposit != withdrawal + charge:
        raise RuntimeError('deposit/withdrawal/charge conservation failed')
    chain = result['chain']
    if (not chain['rows'] or any(row['error'] is not None for row in chain['rows'])
            or not 0 < chain['max_cu'] <= 1_000_000 or not 0 < chain['max_transaction_bytes'] <= 1232
            or chain['vault_micro_usdc'] != 0 or chain['destination_micro_usdc'] != withdrawal
            or chain['treasury_micro_usdc'] != charge):
        raise RuntimeError('actual Vault balances or transaction limits failed')
    cases = result.get('cases', [])
    if len(cases) != 3 or {case['variant'] for case in cases} != {'success', 'http_error', 'invalid_json'}:
        raise RuntimeError('API lifecycle cases missing')
    if any(case.get('receipt_verified') is not True for case in cases):
        raise RuntimeError('unverified receipt')


def execute():
    run_dir = Path(tempfile.mkdtemp(prefix='run-', dir=OUT))
    start = time.monotonic()
    report = {'schema': 1, 'passed': False, 'started_at_utc': now(),
              'run_directory': str(run_dir.relative_to(ROOT)),
              'scope': 'Local fixed-price JSON API, retained legacy inference history, real proofs and Vault SBF; synthetic API/RPC finality',
              'public_rpc_verified': False, 'live_provider_verified': False,
              'release_gates_passed': [], 'stages': []}
    env = {key: os.environ[key] for key in ('HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
           'RUSTUP_HOME', 'CARGO_HOME', 'SDKROOT', 'DEVELOPER_DIR') if key in os.environ}
    try:
        nodes = [ROOT / 'target/i08-toolchain/bin/node', *sorted((ROOT / 'target/toolchains').glob('node-v24.19.0-*/bin/node')), 'node']
        node = executable('ZKAPI_NODE', nodes)
        sbf = executable('ZKAPI_SBF', [ROOT / 'target/toolchains/sbf/bin/cargo-build-sbf', 'cargo-build-sbf'])
        env.update(ZKAPI_NODE=node, ZKAPI_GENERAL_API_RUN_DIR=str(run_dir), RAYON_NUM_THREADS='4', CARGO_NET_OFFLINE='true')
        env['PATH'] = os.pathsep.join([str(Path(node).parent), str(Path(sbf).parent), env.get('PATH', '')])
        for binary in ('cargo', 'rustc', 'initdb', 'pg_ctl', 'psql'):
            if not shutil.which(binary, path=env['PATH']):
                raise RuntimeError('missing installed local test tool: ' + binary)

        def run(name, args, timeout=1800):
            log = run_dir / (name + '.log')
            row = {'name': name, 'argv': list(map(str, args)), 'started_at_utc': now(), 'log': str(log.relative_to(ROOT))}
            report['stages'].append(row)
            before = time.monotonic()
            print('$ ' + ' '.join(row['argv']), flush=True)
            with log.open('w') as output:
                process = subprocess.Popen(row['argv'], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    row['exit_code'] = process.wait(timeout=timeout)
                except BaseException:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    row['exit_code'] = process.returncode
                    raise
                finally:
                    row['seconds'] = round(time.monotonic() - before, 3)
                    row['finished_at_utc'] = now()
                    row['log_sha256'] = sha(log)
            if row['exit_code']:
                raise RuntimeError(name + ' failed; see ' + row['log'])
            print(name + ': passed', flush=True)
            return log.read_text().strip()

        node_version = run('node-version', [node, '--version'])
        if node_version != 'v' + (ROOT / '.node-version').read_text().strip():
            raise RuntimeError('pinned Node required; set ZKAPI_NODE')
        rust_version = run('rust-version', ['rustc', '--version'])
        if not rust_version.startswith('rustc 1.90.0 '):
            raise RuntimeError('pinned Rust 1.90.0 required')
        sbf_version = run('sbf-version', [sbf, '--version'])
        if sbf_version.splitlines()[0] != 'cargo-build-sbf 4.1.0':
            raise RuntimeError('pinned cargo-build-sbf 4.1.0 required')
        report['tools'] = {'node': node_version, 'rust': rust_version, 'sbf': sbf_version}
        prerequisites = {'target/i09-challenger/test-tree.pk': 'python3 scripts/run_i09_challenger.py',
                         'target/i08-wallet/circuit-source.tar': 'python3 scripts/run_i08_wallet.py'}
        for path, command in prerequisites.items():
            if not (ROOT / path).is_file():
                raise RuntimeError('missing authenticated local test input ' + path + '; reproduce prerequisites with ' + command)
        report['prerequisite_sha256'] = {path: sha(ROOT / path) for path in prerequisites}
        files = []
        for directory in ('packages/sdk/src', 'services/control/src', 'services/control/migrations',
                          'apps/clientd/companion/src', 'apps/clientd/prover/src', 'programs/zkapi-vault/src', 'crates'):
            files.extend(p for p in (ROOT / directory).rglob('*') if p.is_file() and 'target' not in p.relative_to(ROOT).parts)
        files.extend(ROOT / path for path in ('packages/sdk/test/general-api-e2e.ts', 'services/control/tests/general_api_e2e.rs',
                     'scripts/run_general_api.py', 'tests/svm/src/bin/wallet.rs', 'docs/contracts/zkapi_vault.json',
                     'services/control/Cargo.lock', 'apps/clientd/companion/Cargo.lock', 'apps/clientd/prover/Cargo.lock', 'tests/svm/Cargo.lock'))
        baseline = {str(path.relative_to(ROOT)): sha(path) for path in sorted(set(files))}
        report['source_input_sha256'] = baseline
        run('control-build', ['cargo', 'build', '--locked', '--offline', '--manifest-path', 'services/control/Cargo.toml', '--bins'])
        run('verifier-build', ['cargo', 'build', '--locked', '--offline', '--manifest-path', 'apps/clientd/companion/Cargo.toml'])
        run('prover-build', ['cargo', 'build', '--locked', '--offline', '--release', '--manifest-path', 'apps/clientd/prover/Cargo.toml', '--bin', 'zkapi-client-prover'])
        run('svm-build', ['cargo', 'build', '--locked', '--offline', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'wallet'])
        elf_dir = run_dir / 'sbf'
        build = run('vault-sbf-build', ['cargo', 'build-sbf', '--manifest-path', 'programs/zkapi-vault/Cargo.toml',
                    '--tools-version', 'v1.54', '--arch', 'v0', '--features', 'sbf-entrypoint', '--sbf-out-dir', str(elf_dir), '--', '--locked', '--offline'])
        if re.search(r'stack offset.*exceed|stack frame size.*exceed', build, re.IGNORECASE):
            raise RuntimeError('SBF stack limit exceeded')
        env['ZKAPI_TEST_VAULT_ELF'] = str(elf_dir / 'zkapi_vault.so')
        report['vault_elf_sha256'] = sha(elf_dir / 'zkapi_vault.so')
        run('sdk-types', [node, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'packages/sdk/tsconfig.json'])
        with tempfile.TemporaryDirectory(prefix='zkapi-generic-', dir='/tmp') as directory:
            work = Path(directory)
            data, socket = run_dir / 'postgres', work / 'socket'
            socket.mkdir(mode=0o700)
            running = False
            try:
                run('postgres-init', ['initdb', '-D', data, '-U', 'general_api_test', '--no-locale', '--encoding=UTF8', '--auth=trust'])
                run('postgres-start', ['pg_ctl', '-D', data, '-l', run_dir / 'postgres.log', '-o', f"-k {socket} -h '' -p 55441", '-w', 'start'])
                running = True
                env['ZKAPI_TEST_DATABASE_URL'] = f'host={socket} port=55441 user=general_api_test dbname=postgres'
                durability = run('postgres-durability', ['psql', '-X', '-h', socket, '-p', '55441', '-U', 'general_api_test', '-d', 'postgres', '-Atc',
                    "SELECT current_setting('fsync'),current_setting('full_page_writes'),current_setting('synchronous_commit')"])
                if durability != 'on|on|on':
                    raise RuntimeError('disposable database durability settings changed')
                output = run('general-api-e2e', ['cargo', 'test', '--locked', '--offline', '--manifest-path', 'services/control/Cargo.toml',
                             '--features', 'i10-acceptance', '--test', 'general_api_e2e', '--', '--ignored', '--nocapture'], timeout=900)
                if 'test result: ok. 1 passed; 0 failed; 0 ignored;' not in output:
                    raise RuntimeError('actual local lifecycle test did not execute')
                result = json.loads((run_dir / 'e2e-results.json').read_text())
                validate(result)
                report['lifecycle'] = result
            finally:
                if running:
                    run('postgres-stop', ['pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'], timeout=60)
        if any(sha(ROOT / path) != expected for path, expected in baseline.items()):
            raise RuntimeError('runtime sources changed during verification; rerun to verify one source snapshot')
        if any(sha(ROOT / path) != expected for path, expected in report['prerequisite_sha256'].items()):
            raise RuntimeError('authenticated prerequisite input changed during verification')
        report['passed'] = True
    except BaseException as error:
        report['error'] = str(error)
        raise
    finally:
        report['elapsed_seconds'] = round(time.monotonic() - start, 3)
        report['finished_at_utc'] = now()
        (run_dir / 'runtime-report.json').write_text(json.dumps(report, indent=2) + '\n')
        (OUT / 'latest.json').write_text(json.dumps({'passed': report['passed'], 'report': str((run_dir / 'runtime-report.json').relative_to(ROOT))}, indent=2) + '\n')
        print(json.dumps({'passed': report['passed'], 'report': str((run_dir / 'runtime-report.json').relative_to(ROOT))}), flush=True)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (OUT / 'runner.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute()
