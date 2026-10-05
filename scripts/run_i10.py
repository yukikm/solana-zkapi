#!/usr/bin/env python3
"""I10 local integration/load acceptance, never a public/provider release gate.

Uses a new fsync-enabled PostgreSQL cluster with no TCP listener. Run the
documented I04/I05/I09/wallet prerequisites sequentially before this runner.
Historical reports are inputs neither to test counts nor to success decisions.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import tempfile
import time
from run_i10_acceptance import source_hashes

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i10'


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def rust_counts(output):
    rows = re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;', output)
    if not rows or any(int(failed) or int(ignored) for _, failed, ignored in rows):
        raise RuntimeError('runtime tests missing, failed or ignored')
    count = sum(int(passed) for passed, _, _ in rows)
    if count == 0:
        raise RuntimeError('no runtime tests executed')
    return {'passed': count, 'failed': 0, 'ignored': 0}


def validate_e2e(result):
    expected = {('proxy', 'openai'), ('proxy', 'anthropic'), ('proxy', 'openrouter'),
                ('direct_oa', 'oa'), ('direct_openrouter', 'openrouter')}
    modes = result.get('modes', [])
    if len(modes) != len(expected) or {(r['mode'], r['provider']) for r in modes} != expected:
        raise RuntimeError('E2E requires all five mode/provider paths in this run')
    for name in ('same_note_all_modes', 'encrypted_journal', 'lost_finalized_send_recovered', 'balance_conservation'):
        if result.get(name) is not True:
            raise RuntimeError('E2E missing invariant: ' + name)
    variants = ('plain', 'tools', 'sse', 'tools_sse', 'disconnect')
    coverage = {f'proxy/openai/{api}_{variant}' for api in ('chat', 'responses') for variant in variants}
    coverage |= {'proxy/openai/chat_http_error', 'proxy/openai/responses_missing_usage'}
    coverage |= {f'proxy/anthropic/messages_{variant}' for variant in variants}
    coverage |= {'proxy/anthropic/count_tokens', 'proxy/anthropic/messages_http_error', 'proxy/anthropic/messages_truncated_sse'}
    coverage |= {f'proxy/openrouter/chat_{variant}' for variant in (*variants, 'http_error')}
    coverage |= {'direct_oa/oa/chat_plain', 'direct_openrouter/openrouter/chat_plain'}
    cases = result.get('cases', [])
    actual = [f"{case['mode']}/{case['provider']}/{case['variant']}" for case in cases]
    if (len(cases) != 28 or set(actual) != coverage or result.get('coverage') != actual
            or any(case.get('receipt_verified') is not True or case.get('provider_calls') != 1
                   or case.get('automatic_replays') != 0 for case in cases)
            or sum(case.get('disconnect_before_final_usage') is True for case in cases) != 4):
        raise RuntimeError('E2E API/receipt/downstream cancellation coverage incomplete')
    ledger = result.get('ledger', {})
    for name, count in {'settled_sessions': 6, 'signed_settlements': 6, 'signed_receipts': 29,
                        'permanent_auth_nullifiers': 6, 'signed_clearances': 1,
                        'finished_dispatch_attempts': 28, 'dispatcher_claims': 28,
                        'zero_charge_unknown_waivers': 5}.items():
        if ledger.get(name) != count:
            raise RuntimeError('E2E ledger count mismatch: ' + name)
    if ledger.get('all_case_operation_states_verified') is not True:
        raise RuntimeError('E2E operation/receipt states not verified')
    race = result.get('exit_race', {})
    for name in ('accepted_real_request_proof', 'actual_sbf_escape', 'exit_nullifier_observed',
                 'exact_accepted_request_proof_used', 'pending_cleared', 'exit_tombstone_preserved',
                 'receipt_verified', 'signed_successor_verified', 'ledger_exit_outbox_verified',
                 'ledger_no_dispatch_or_issuance_verified'):
        if race.get(name) is not True:
            raise RuntimeError('E2E exit race invariant missing: ' + name)
    if (race.get('proxy_status') != 503 or race.get('direct_issuance_status') != 409
            or race.get('direct_issuance_error') != 'exit_consumed'
            or race.get('provider_calls') != 0 or race.get('dispatch_attempts') != 0
            or race.get('charge_micro_usdc') != '0' or race.get('receipt_evidence_kind') != 'NOT_DISPATCHED'
            or race.get('historical_request_root') != race.get('restored_root')
            or race.get('historical_request_root') == race.get('challenge_zero_root')
            or not race.get('escape_signatures') or not race.get('challenge_signatures')):
        raise RuntimeError('E2E actual escape/challenge/control race incomplete')
    if (result.get('automatic_inference_replays') != 0
            or result.get('live_provider_verified') is not False
            or result.get('public_rpc_verified') is not False
            or result.get('release_gates_passed') != []):
        raise RuntimeError('local E2E replay/scope claims are invalid')
    amounts = [result[name] for name in ('deposit_micro_usdc', 'withdrawal_micro_usdc', 'total_charge_micro_usdc')]
    if any(not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]*', value) for value in amounts):
        raise RuntimeError('E2E requires canonical integer money')
    deposit, withdrawal, charge = map(int, amounts)
    if deposit != withdrawal + charge or sum(int(row['charge_micro_usdc']) for row in modes) != charge:
        raise RuntimeError('E2E deposit/withdrawal/charge conservation failed')
    chain = result['chain']
    if (not chain['rows'] or any(row['error'] is not None for row in chain['rows'])
            or not 0 < chain['max_cu'] <= 1_000_000
            or not 0 < chain['max_transaction_bytes'] <= 1232
            or chain['vault_micro_usdc'] != 0
            or chain['destination_micro_usdc'] != withdrawal
            or chain['treasury_micro_usdc'] != charge):
        raise RuntimeError('actual Vault transaction/balance bounds failed')


def main():
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Prevent overlapping I10 invocations from mixing result files and binaries.
    with (OUT / 'runner.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute()


def execute():
    started = time.monotonic()
    started_at = utc_now()
    commands = []
    env = {k: v for k, v in os.environ.items()
           if not k.startswith('PG') and k not in ('DATABASE_URL', 'ZKAPI_TEST_DATABASE_URL', 'CARGO_TARGET_DIR')}
    env['RAYON_NUM_THREADS'] = '4'
    node = os.environ.get('ZKAPI_NODE', shutil.which('node') or '')
    env['ZKAPI_NODE'] = node
    for name in ('runtime-report.json', 'e2e-results.json', 'load-results.json', 'fault-results.json', 'vault-sbf-results.json'):
        (OUT / name).unlink(missing_ok=True)

    def run(name, args, timeout=900):
        print('$ ' + ' '.join(args), flush=True)
        before = time.monotonic()
        before_at = utc_now()
        process = subprocess.Popen(args, cwd=ROOT, env=env, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        try:
            output, _ = process.communicate(timeout=timeout)
        except BaseException:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
            (OUT / (name + '.log')).write_text(output)
            commands.append({'argv': args, 'exit_code': process.returncode,
                             'started_at_utc': before_at, 'finished_at_utc': utc_now(),
                             'seconds': round(time.monotonic() - before, 3)})
            raise
        (OUT / (name + '.log')).write_text(output)
        commands.append({'argv': args, 'exit_code': process.returncode,
                         'started_at_utc': before_at, 'finished_at_utc': utc_now(),
                         'seconds': round(time.monotonic() - before, 3)})
        print(output, end='', flush=True)
        if process.returncode:
            raise RuntimeError(f'{name} failed; see target/i10/{name}.log')
        return output.strip()

    report = {'schema': 1, 'passed': False,
              'started_at_utc': started_at,
              'scope': 'I10 local five-mode API lifecycle, actual Vault exit/control race and bounded repeated ledger/process faults; not external acceptance',
              'date_jst': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=9))).date().isoformat(),
              'os': platform.platform(), 'commands': commands,
              'I10_complete': False, 'I10_handoff_ready': False,
              'release_gates_passed': [], 'live_provider_verified': False,
              'wallet_public_rpc_verified': False, 'hosted_ci_verified': False}
    try:
        for binary in ('initdb', 'pg_ctl', 'psql', 'cargo', 'rustc', 'openssl'):
            if not shutil.which(binary):
                raise RuntimeError('missing local test tool: ' + binary)
        for path, command in [
            ('target/i04-sbf/zkapi_vault.so', 'bash scripts/run_i04.sh'),
            ('target/i05/public-manifest.json', 'bash scripts/run_i06_i07.sh'),
            ('target/i09-challenger/test-tree.pk', 'python3 scripts/run_i09_challenger.py'),
            ('target/i08-wallet/circuit-source.tar', 'python3 scripts/run_i08_wallet.py'),
        ]:
            if not (ROOT / path).is_file():
                raise RuntimeError('missing ' + path + '; run ' + command + ' first')
        report['source_input_sha256'] = source_hashes()
        report['prerequisite_input_sha256'] = {name: sha256(ROOT / name) for name in (
            'target/i04-sbf/zkapi_vault.so', 'target/i05/public-manifest.json',
            'target/i09-challenger/test-tree.pk', 'target/i08-wallet/circuit-source.tar')}
        report['node'] = run('node-version', [node, '--version'])
        if report['node'] != 'v' + (ROOT / '.node-version').read_text().strip():
            raise RuntimeError('pinned Node version required; set ZKAPI_NODE or PATH')
        report['rust'] = run('rust-version', ['rustc', '--version'])
        report['openssl'] = run('openssl-version', ['openssl', 'version'])
        control = 'services/control/Cargo.toml'
        svm = 'tests/svm/Cargo.toml'
        run('control-build', ['cargo', 'build', '--locked', '--manifest-path', control, '--bins'])
        run('svm-build', ['cargo', 'build', '--locked', '--manifest-path', svm, '--bin', 'wallet'])
        run('verifier-build', ['cargo', 'build', '--locked', '--manifest-path', 'apps/clientd/companion/Cargo.toml'])
        run('prover-build', ['cargo', 'build', '--locked', '--release', '--manifest-path',
                             'apps/clientd/prover/Cargo.toml', '--bin', 'zkapi-client-prover'])
        run('typecheck', [node, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'packages/sdk/tsconfig.json'])
        run('control-fmt', ['cargo', 'fmt', '--manifest-path', control, '--', '--check'])
        output = run('dispatcher-frame-order', ['cargo', 'test', '--locked', '--manifest-path', control,
                                               '--lib', 'egress::tests::stdout_frames_are_ordered_and_drained',
                                               '--', '--nocapture'])
        report['tests'] = {'dispatcher_frame_order': rust_counts(output)}
        with tempfile.TemporaryDirectory(prefix='zkapi-i10-', dir='/tmp') as directory:
            work = Path(directory)
            data, socket = work / 'data', work / 'socket'
            socket.mkdir(mode=0o700)
            running = False
            try:
                run('pg-init', ['initdb', '-D', str(data), '-U', 'i10_test', '--no-locale',
                                '--encoding=UTF8', '--auth=trust'])
                run('pg-start', ['pg_ctl', '-D', str(data), '-l', str(work / 'postgres.log'),
                                 '-o', f"-k {socket} -h '' -p 55440", '-w', 'start'])
                running = True
                env['ZKAPI_TEST_DATABASE_URL'] = f'host={socket} port=55440 user=i10_test dbname=postgres'
                psql = ['psql', '-X', '-h', str(socket), '-p', '55440', '-U', 'i10_test', '-d', 'postgres', '-Atc']
                report['postgres_version'] = run('pg-version', [*psql, 'SHOW server_version'])
                durability = run('pg-durability', [*psql, "SELECT current_setting('fsync'), current_setting('full_page_writes'), current_setting('synchronous_commit')"])
                if durability != 'on|on|on':
                    raise RuntimeError('disposable database durability settings changed')
                report['database'] = {'fsync': True, 'full_page_writes': True, 'synchronous_commit': 'on',
                                      'replication': 'none; separate I09 WAL drill required'}
                for suite in ('i10_load', 'i10_faults', 'i10_e2e'):
                    output = run(suite, ['cargo', 'test', '--locked', '--manifest-path', control, '--features', 'i10-acceptance',
                                        '--test', suite, '--', '--include-ignored', '--nocapture', '--test-threads=1'])
                    report['tests'][suite] = rust_counts(output)
                # Logs stay local. Do not copy SQL dumps, plaintext note witnesses or keys.
                for path in [work / 'postgres.log', OUT / 'i10_load.log', OUT / 'i10_faults.log', OUT / 'i10_e2e.log']:
                    output = path.read_text()
                    if any(canary in output for canary in ('I10_PRIVATE_PROMPT', 'I10_PRIVATE_RESPONSE',
                                                           'i10-provider-secret', 'i10-oa-runtime',
                                                           'i10-openrouter-runtime', 'I10_FAULT_PROVIDER_SECRET',
                                                           'I10_FAULT_PRIVATE_PROMPT', 'I10_FAULT_PRIVATE_RESPONSE',
                                                           'Bearer zkc1.', 'Bearer zkp1.')):
                        raise RuntimeError('private test canary in runtime log')
            finally:
                if running:
                    run('pg-stop', ['pg_ctl', '-D', str(data), '-m', 'immediate', '-w', 'stop'])
        run('control-clippy', ['cargo', 'clippy', '--locked', '--manifest-path', control, '--features', 'i10-acceptance',
                              '--test', 'i10_load', '--test', 'i10_faults', '--test', 'i10_e2e', '--', '-D', 'warnings'])
        run('svm-clippy', ['cargo', 'clippy', '--locked', '--manifest-path', svm, '--bin', 'wallet', '--', '-D', 'warnings'])
        report['results'] = {}
        for name in ('e2e', 'load', 'fault'):
            path = OUT / (name + '-results.json')
            result = json.loads(path.read_text())
            if result.get('passed') is not True:
                raise RuntimeError(name + ': missing successful fresh runtime result')
            if name == 'e2e':
                validate_e2e(result)
            elif name == 'load':
                counters = result.get('invariant_counters', {})
                required = {'aggregate_accounting_violations', 'duplicate_dispatch_violations',
                            'operation_charge_violations', 'session_cap_violations',
                            'session_concurrency_violations', 'settled_unfenced_violations',
                            'settlement_rounding_violations', 'terminal_receipt_count_violations'}
                if not required.issubset(counters) or any(value != 0 for value in counters.values()):
                    raise RuntimeError('load run missing clean financial invariant observations')
                workload = result['workload']
                if (workload['sessions'] < 12 or workload['rounds'] < 16
                        or workload['contenders_per_session_round'] < 8
                        or workload['completed_metered_operations'] != workload['sessions'] * workload['rounds'] * 4
                        or workload['nullifier_contenders'] < 100
                        or result['faults']['restore_admission_refused'] is not True
                        or result['throughput_slo_asserted'] is not False):
                    raise RuntimeError('load/fault workload incomplete or scope invalid')
            else:
                counters = result.get('invariant_counters', {})
                required = {'operation_cap_violations', 'session_reservation_cap_violations', 'unquiesced_dispatchers'}
                if (not required.issubset(counters) or any(value != 0 for value in counters.values())
                        or result.get('cycles', 0) < 4 or result.get('proxy_faults', 0) < 12
                        or result.get('healthy_capped_proxy_operations_after_reset', 0) < 4
                        or result.get('direct_uncertain_lifecycles', 0) < 4
                        or result.get('automatic_inference_replays') != 0
                        or result.get('release_gates_passed') != []):
                    raise RuntimeError('repeated fault/recovery observations incomplete')
            report['results'][name] = result
        source_dirs = ['packages/sdk/src', 'services/control/src', 'services/control/migrations',
                       'apps/clientd/prover/src', 'apps/clientd/companion/src', 'programs/zkapi-vault/src']
        files = [p for directory in source_dirs for p in (ROOT / directory).rglob('*') if p.is_file()]
        files += list((ROOT / 'services/control/tests').rglob('*.rs'))
        files += list((ROOT / 'packages/sdk/test').glob('i10-*.ts'))
        files += [ROOT / name for name in [
            'scripts/run_i10.py', 'packages/sdk/test/wallet-fixture.ts', 'package-lock.json',
            'packages/sdk/tsconfig.json', '.node-version', 'rust-toolchain.toml',
            'services/control/Cargo.toml', 'services/control/Cargo.lock',
            'services/control/target/debug/signerd', 'services/control/target/debug/dispatcherd',
            'tests/svm/Cargo.toml', 'tests/svm/Cargo.lock', 'tests/svm/src/bin/wallet.rs',
            'tests/svm/src/vault_support.rs', 'tests/svm/target/debug/wallet',
            'vendor/ethereum-zkapi/protocol/setup/v2/request.pk',
            'vendor/ethereum-zkapi/protocol/setup/v2/request.vk',
            'vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.pk',
            'vendor/ethereum-zkapi/protocol/setup/v2/withdrawal.vk',
            'tests/fixtures/layout2/test-tree.vk', 'tests/fixtures/layout2/tree-vk-wire.bin',
            'tests/fixtures/layout2/profile.json', 'docs/contracts/zkapi_vault.json',
            'apps/clientd/prover/Cargo.lock', 'apps/clientd/prover/target/release/zkapi-client-prover',
            'apps/clientd/companion/Cargo.lock', 'apps/clientd/companion/target/debug/zkapi-client-verify',
            'target/i04-sbf/zkapi_vault.so', 'target/i05/public-manifest.json',
            'target/i09-challenger/test-tree.pk', 'target/i08-wallet/circuit-source.tar',
            'target/i10/e2e-results.json', 'target/i10/load-results.json', 'target/i10/fault-results.json', 'target/i10/vault-sbf-results.json']]
        report['artifact_sha256'] = {str(p.relative_to(ROOT)): sha256(p) for p in sorted(set(files))}
        report['log_sha256'] = {str((OUT / (name + '.log')).relative_to(ROOT)): sha256(OUT / (name + '.log'))
                                for name in ('dispatcher-frame-order', 'i10_load', 'i10_faults', 'i10_e2e')}
        if source_hashes() != report['source_input_sha256'] or any(
                sha256(ROOT / name) != value for name, value in report['prerequisite_input_sha256'].items()):
            raise RuntimeError('Source or prerequisite changed during I10 acceptance')
        report['passed'] = True
    except Exception as error:
        report['failure'] = str(error)
        raise
    finally:
        report['finished_at_utc'] = utc_now()
        report['elapsed_seconds'] = round(time.monotonic() - started, 3)
        temporary = OUT / 'runtime-report.tmp'
        temporary.write_text(json.dumps(report, indent=2) + '\n')
        temporary.replace(OUT / 'runtime-report.json')
    print(json.dumps({'local_passed': report['passed'], 'tests': report['tests'],
                      'I10_complete': False, 'release_gates_passed': []}))


if __name__ == '__main__':
    main()
