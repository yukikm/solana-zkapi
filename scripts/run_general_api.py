#!/usr/bin/env python3
"""Local generic JSON API lifecycle with real SDK/proofs/ledger/signer/Vault SBF.

Creates fresh disposable PostgreSQL and synthetic funded notes. Never reads
funded profiles, historical journals, provider secrets or public RPC settings.
Keeps every run and report under ignored target/general-api-local. Requires
already installed pinned tools and authenticated local test proof prerequisites.
"""
import argparse
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
from general_api_tools import inspect_tools, sbf_build_invocation
from sdk_consumer_lock import materialize


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


def validate(result, api_only=False, variant="legacy", gateway=False):
    unknown_variant = "truncated" if gateway else "invalid_json"
    fault = variant.split("-",1)[1] if "-" in variant else None
    if api_only:
        if result.get('generated_frontend_verified') is not True:
            raise RuntimeError('generated frontend and restricted RPC routes not verified')
        required = ('native_commands_executed', 'offline_configuration_validated') if variant.startswith('native') else ('installed_sdk', 'api_only')
        if any(result.get(name) is not True for name in required):
            raise RuntimeError('installed API-only client validation missing')
        if variant.startswith('native') and fault != 'upstream_timeout' and result.get('custody_preserved_on_restart') is not True:
            raise RuntimeError('native restart changed custody')
    for name in ('passed', 'encrypted_journal',
                 'request_proof_verified', 'receipts_verified', 'signed_successor_verified',
                 'request_body_has_no_model', 'duplicates_not_replayed', 'invalid_requests_no_egress',
                 'balance_conservation', 'separate_signer_process',
                 'separate_dispatcher_process'):
        if result.get(name) is not True:
            raise RuntimeError('missing lifecycle invariant: ' + name)
    if fault != 'upstream_timeout' and result.get('restarted_journal_recovery') is not True:
        raise RuntimeError('original journal restart not verified')
    if not api_only and any(result.get(name) is not True for name in ('legacy_history_unchanged','lost_finalized_send_recovered')):
        raise RuntimeError('legacy history or exact transaction recovery not verified')
    if result.get('provider_calls') != ({'success':1} if fault=='lost_response' else {'upstream_timeout':1} if fault=='upstream_timeout' else {'success': 1, 'http_error': 1, unknown_variant: 1} if api_only else {'legacy': 1, 'success': 1, 'http_error': 1, 'invalid_json': 1}):
        raise RuntimeError('unexpected upstream calls or automatic replay')
    if (result.get('automatic_api_replays') != 0 or result.get('live_provider_verified') is not False
            or result.get('public_rpc_verified') is not False or result.get('release_gates_passed') != []):
        raise RuntimeError('invalid local verification scope')
    amounts = [result.get(name) for name in ('deposit_micro_usdc', 'withdrawal_micro_usdc', 'total_charge_micro_usdc')]
    if any(not isinstance(value, str) or not re.fullmatch(r'0|[1-9][0-9]*', value) for value in amounts):
        raise RuntimeError('noncanonical integer financial units')
    deposit, withdrawal, charge = map(int, amounts)
    if (deposit, withdrawal, charge) != ((5_000_000,5_000_000,0) if fault=='upstream_timeout' else (5_000_000, 4_999_750, 250) if api_only else (5_000_000, 4_999_749, 251)) or deposit != withdrawal + charge:
        raise RuntimeError('deposit/withdrawal/charge conservation failed')
    chain = result['chain']
    if (not chain['rows'] or any(row['error'] is not None for row in chain['rows'])
            or not 0 < chain['max_cu'] <= 1_000_000 or not 0 < chain['max_transaction_bytes'] <= 1232
            or chain['vault_micro_usdc'] != 0 or chain['destination_micro_usdc'] != withdrawal
            or chain['treasury_micro_usdc'] != charge):
        raise RuntimeError('actual Vault balances or transaction limits failed')
    cases = result.get('cases', [])
    expected_cases = {'success'} if fault=='lost_response' else {'upstream_timeout'} if fault=='upstream_timeout' else {'success','http_error',unknown_variant}
    if len(cases) != len(expected_cases) or {case['variant'] for case in cases} != expected_cases:
        raise RuntimeError('API lifecycle cases missing')
    if any(case.get('receipt_verified') is not True for case in cases):
        raise RuntimeError('unverified receipt')


def validate_native_agent(result, kind, group):
    required = ('passed', 'generated_frontend_verified', 'native_commands_executed',
                'offline_configuration_validated', 'encrypted_journal', 'request_proof_verified',
                'receipts_verified', 'signed_successor_verified', 'duplicates_not_replayed',
                'invalid_requests_no_egress', 'balance_conservation', 'restarted_journal_recovery',
                'custody_preserved_on_restart', 'separate_control_process', 'separate_signer_process',
                'separate_dispatcher_process', 'original_request_bytes_preserved',
                'unknown_usage_not_zero', 'no_automatic_provider_replay', 'provider_circuit_breaker_preserved')
    if any(result.get(name) is not True for name in required):
        raise RuntimeError('native agent invariant missing: '+','.join(name for name in required if result.get(name) is not True))
    if result.get('native_agent') != kind or result.get('native_agent_group') != group or result.get('provider_admission_resets') != 0:
        raise RuntimeError('wrong native agent identity')
    if result.get('native_client_compatibility') != (kind == 'codex' or group != 1):
        raise RuntimeError('native client compatibility verdict missing or overstated')
    if kind == 'claude' and group == 1 and (result.get('no_native_retry_or_fallback') is True or not result.get('native_client_limitations')):
        raise RuntimeError('Claude capability retry limitation must remain explicit')
    counts = {'text': 1, 'tool': 2, 'subsequent_turn': 2, 'capability400': 1,
              'capability422': 1, 'rate_limit429': 1, 'unavailable503': 1, 'lost_headers': 1,
              'truncated': 1, 'idle_timeout': 1, 'cancel': 1, 'fallback': 1}
    names = {1: list(counts)[:6], 2: list(counts)[6:9], 3: list(counts)[9:]}[group]
    counts = {name: counts[name] for name in names}
    expected_operations, expected_charge = (8, 10) if group == 1 else (3, 0)
    matrix = result.get('native_agent_matrix', [])
    if len(matrix) != len(counts) or {row.get('name') for row in matrix} != set(counts):
        raise RuntimeError('native CLI safety matrix missing')
    for row in matrix:
        name = row['name']
        retries = 1 if kind == 'claude' and name == 'capability400' else 0
        if row.get('attempted_requests') != counts[name]+retries or row.get('provider_dispatches') != counts[name] or row.get('native_automatic_retries') != retries or row.get('client_profile_compatible') != (retries == 0) or row.get('external_network_blocked') is not True:
            raise RuntimeError('native attempt/provider dispatch distinction failed')
        if retries and (row['requests'][1].get('status') != 409 or row['requests'][1].get('responseCode') != 'recovery_required'):
            raise RuntimeError('Claude capability retry was not held before provider dispatch')
    if result.get('provider_calls') != counts or result.get('automatic_api_replays') != 0:
        raise RuntimeError('native client retry/fallback or missing provider dispatch')
    cases = result.get('cases', [])
    if len(cases) != expected_operations or {name: sum(case.get('variant') == name for case in cases) for name in counts} != counts:
        raise RuntimeError('native CLI operation matrix incomplete')
    for case in cases:
        successful = case.get('variant') in ('text', 'tool', 'subsequent_turn')
        if case.get('receipt_verified') is not True or case.get('charged_nano_usdc') != ('2000' if successful else '0') or case.get('operation_state') != ('DONE' if successful else 'WAIVED_OPERATOR_LOSS'):
            raise RuntimeError('native CLI accounting outcome mismatch')
    if (result.get('deposit_micro_usdc'), result.get('withdrawal_micro_usdc'), result.get('total_charge_micro_usdc')) != ('5000000', str(5000000-expected_charge), str(expected_charge)):
        raise RuntimeError('native CLI conservation mismatch')
    chain = result['chain']
    if not chain['rows'] or any(row['error'] is not None for row in chain['rows']) or not 0 < chain['max_cu'] <= 1_000_000 or not 0 < chain['max_transaction_bytes'] <= 1232 or (chain['vault_micro_usdc'], chain['destination_micro_usdc'], chain['treasury_micro_usdc']) != (0, 5000000-expected_charge, expected_charge):
        raise RuntimeError('native CLI SBF conservation failed')
    if result.get('live_provider_verified') is not False or result.get('public_rpc_verified') is not False or result.get('release_gates_passed') != []:
        raise RuntimeError('native CLI local verification scope changed')


def execute(onboarding=False, gateway=False, native_clients=False):
    run_dir = Path(tempfile.mkdtemp(prefix='run-', dir=OUT))
    start = time.monotonic()
    report = {'schema': 1, 'passed': False, 'started_at_utc': now(),
              'run_directory': str(run_dir.relative_to(ROOT)),
              'scope': ('Fixed HTTP gateway regressions and pinned actual Codex and Claude CLI through installed finite HTTP gateway' if native_clients else 'Installed finite HTTP native gateway; exact raw target, repeated octet headers and trailers' if gateway else 'Installed API-only SDK/native clients with generated configuration and routes' if onboarding else 'Fixed-price JSON API with retained legacy inference history') + '; real local proofs and Vault SBF, synthetic provider/RPC finality',
              'public_rpc_verified': False, 'live_provider_verified': False,
              'release_gates_passed': [], 'stages': []}
    env = {key: os.environ[key] for key in ('HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
           'RUSTUP_HOME', 'CARGO_HOME', 'SDKROOT', 'DEVELOPER_DIR') if key in os.environ}
    try:
        inventory = inspect_tools(ROOT)
        report['tool_inventory'] = inventory
        if not inventory['passed']:
            raise RuntimeError('missing/mismatched tools; run --check-tools for every requirement')
        selected = inventory['executables']
        node, sbf = selected['node'], selected['sbf']
        tool_links = run_dir / 'tools'
        tool_links.mkdir(mode=0o700)
        for name in ('node', 'npm', 'go', 'tar', 'initdb', 'pg_ctl', 'psql', 'rustc', 'cargo'):
            (tool_links / name).symlink_to(selected[name])
        env.update(ZKAPI_NODE=node, ZKAPI_NPM=selected['npm'], ZKAPI_GO=selected['go'],
                   ZKAPI_GENERAL_API_RUN_DIR=str(run_dir), RAYON_NUM_THREADS='4', CARGO_INCREMENTAL='0',
                   CARGO_NET_OFFLINE='true', GOPROXY='off', GOTOOLCHAIN='local',
                   RUSTC=selected['rustc'], CARGO=selected['cargo'])
        if gateway: env['ZKAPI_GATEWAY_TEST']='1'
        if native_clients:
            cli = {'codex': executable('ZKAPI_CODEX', [Path.home()/'.codex/packages/standalone/releases/0.145.0-aarch64-apple-darwin/bin/codex']),
                   'claude': executable('ZKAPI_CLAUDE', [Path.home()/'.local/share/claude/versions/2.1.220'])}
            env['ZKAPI_CODEX'], env['ZKAPI_CLAUDE'] = cli['codex'], cli['claude']
            report['native_agent_binaries'] = {kind: {'path': path, 'sha256': sha(Path(path))} for kind, path in cli.items()}

        env['PATH'] = os.pathsep.join([str(tool_links), str(Path(sbf).parent), env.get('PATH', '')])

        def run(name, args, timeout=1800, cwd=ROOT, environment=None):
            log = run_dir / (name + '.log')
            row = {'name': name, 'argv': list(map(str, args)), 'started_at_utc': now(), 'log': str(log.relative_to(ROOT))}
            report['stages'].append(row)
            before = time.monotonic()
            print('$ ' + ' '.join(row['argv']), flush=True)
            with log.open('w') as output:
                process = subprocess.Popen(row['argv'], cwd=cwd, env=env if environment is None else environment, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
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

        source_dirs = ('packages/sdk/src','packages/sdk/test','services/control/src','services/control/tests','services/control/migrations','services/control/fixtures',
                       'apps/clientd','programs/zkapi-vault/src','crates','scripts','tools/public-devnet-consumer',
                       'tests/fixtures','tests/svm/src','docs/contracts')
        excluded = {'target','node_modules','dist','__pycache__'}
        suffixes = {'.rs','.ts','.mjs','.js','.py','.sh','.json','.go','.toml','.lock','.mod','.sum','.md','.bin','.vk'}
        files = {p for directory in source_dirs for p in (ROOT/directory).rglob('*')
                 if p.is_file() and not excluded.intersection(p.relative_to(ROOT).parts) and p.suffix in suffixes}
        files.update(ROOT/name for name in ('package.json','package-lock.json','Cargo.toml','Cargo.lock','rust-toolchain.toml','.node-version',
                     'packages/sdk/package.json','packages/sdk/build.mjs','packages/sdk/tsconfig.json','packages/sdk/tsconfig.build.json',
                     'services/control/Cargo.toml','services/control/Cargo.lock','tests/svm/Cargo.toml','tests/svm/Cargo.lock',
                     'programs/zkapi-vault/Cargo.toml','programs/zkapi-vault/Cargo.lock'))
        baseline = {str(path.relative_to(ROOT)): sha(path) for path in sorted(files)}
        report['source_input_sha256'] = baseline
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
        prerequisites = run_dir / 'prerequisites'
        prerequisites.mkdir(mode=0o700)
        run('pinned-upstream', ['python3', 'scripts/check_upstream.py'])
        run('source-archive', ['bash', 'scripts/build_i02_source.sh', prerequisites / 'circuit-source.tar'])
        run('tree-test-key', ['cargo', 'run', '--locked', '--offline', '--release', '-p', 'zkapi-tree-prover',
                             '--example', 'test_setup', '--', prerequisites / 'test-tree.pk'])
        profile = json.loads((ROOT / 'tests/fixtures/layout2/profile.json').read_text())
        expected = {'test-tree.pk': profile['tree_proof_artifacts']['pk_hash'],
                    'circuit-source.tar': profile['tree_proof_artifacts']['source_bundle_hash']}
        for name, digest in expected.items():
            if sha(prerequisites / name) != digest:
                raise RuntimeError('pinned test prerequisite mismatch: ' + name)
        for name in ('request', 'withdrawal'):
            for extension in ('pk', 'vk'):
                if sha(ROOT / f'vendor/ethereum-zkapi/protocol/setup/v2/{name}.{extension}') != profile[f'{name}_{extension}_hash']:
                    raise RuntimeError('upstream proof artifact pin mismatch')
        for name, pin in [('test-tree.vk','vk_hash'), ('tree-vk-wire.bin','verifier_constants_hash')]:
            if sha(ROOT / 'tests/fixtures/layout2' / name) != profile['tree_proof_artifacts'][pin]:
                raise RuntimeError('tree public artifact pin mismatch')
        report['prerequisite_sha256'] = {str((prerequisites / name).relative_to(ROOT)): digest for name,digest in expected.items()}
        env.update(ZKAPI_TEST_TREE_PK=str(prerequisites / 'test-tree.pk'),
                   ZKAPI_TEST_SOURCE_ARCHIVE=str(prerequisites / 'circuit-source.tar'))
        run('control-build', ['cargo', 'build', '--locked', '--offline', '--manifest-path', 'services/control/Cargo.toml', '--bins'])
        run('verifier-build', ['cargo', 'build', '--locked', '--offline', '--manifest-path', 'apps/clientd/companion/Cargo.toml'])
        run('prover-build', ['cargo', 'build', '--locked', '--offline', '--release', '--manifest-path', 'apps/clientd/prover/Cargo.toml', '--bin', 'zkapi-client-prover'])
        run('svm-build', ['cargo', 'build', '--locked', '--offline', '--manifest-path', 'tests/svm/Cargo.toml', '--bin', 'wallet'])
        elf_dir = run_dir / 'sbf'
        sbf_command, sbf_environment = sbf_build_invocation(inventory, 'programs/zkapi-vault/Cargo.toml', elf_dir, env)
        build = run('vault-sbf-build', sbf_command, environment=sbf_environment)
        if re.search(r'stack offset.*exceed|stack frame size.*exceed', build, re.IGNORECASE):
            raise RuntimeError('SBF stack limit exceeded')
        env.update(ZKAPI_TEST_VAULT_ELF=str(elf_dir / 'zkapi_vault.so'),
                   ZKAPI_TEST_SVM=str(ROOT / 'tests/svm/target/debug/wallet'),
                   ZKAPI_TEST_NATIVE_PROVER=str(ROOT / 'apps/clientd/prover/target/release/zkapi-client-prover'),
                   ZKAPI_TEST_VERIFIER=str(ROOT / 'apps/clientd/companion/target/debug/zkapi-client-verify'))
        report['vault_elf_sha256'] = sha(elf_dir / 'zkapi_vault.so')
        run('sdk-types', [node, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'packages/sdk/tsconfig.json'])
        if onboarding:
            run('wasm-build', ['cargo','build','--locked','--offline','--release','--manifest-path','apps/clientd/prover/Cargo.toml','--target','wasm32-unknown-unknown','--lib'])
            env['ZKAPI_TEST_WASM_PROVER'] = str(ROOT / 'apps/clientd/prover/target/wasm32-unknown-unknown/release/zkapi_client_prover.wasm')
            env['ZKAPI_TEST_WASM'] = env['ZKAPI_TEST_WASM_PROVER']
            run('sdk-distribution', ['python3','scripts/run_external_sdk_acceptance.py','--offline','--output',run_dir/'sdk-distribution'])
            native = run_dir / 'native-distribution'
            run('native-distribution', ['python3','scripts/build_clientd_distribution.py','--offline','--output',native,
                '--prover',env['ZKAPI_TEST_NATIVE_PROVER'],'--verifier',env['ZKAPI_TEST_VERIFIER']])
            env['ZKAPI_TEST_NATIVE_INSTALLATION'] = str(native)
            consumer = Path(tempfile.mkdtemp(prefix='zkapi-onboarding-consumer-')).resolve()
            report['external_consumer'] = str(consumer)
            version = json.loads((ROOT/'packages/sdk/package.json').read_text())['version']
            tarball = run_dir/'sdk-distribution'/f'zkapi-solana-sdk-{version}.tgz'
            copied = consumer / tarball.name
            shutil.copyfile(tarball,copied)
            report['consumer_lock'] = materialize(consumer,copied)
            run('installed-sdk-offline', ['npm','ci','--offline','--ignore-scripts','--no-audit','--no-fund'],cwd=consumer)
            for name in ['general-api-e2e.ts','native-onboarding.ts','native-agent-driver.ts','native-agent-fixture.ts','kit-helpers.ts','wallet-fixture.ts']:
                content=(ROOT/'packages/sdk/test'/name).read_text()
                content=re.sub(r"(['\"])\.\./src/([a-z0-9-]+)\.ts\1",lambda m:"'@zkapi/solana-sdk"+('' if m[2]=='client' else '/'+m[2])+"'",content)
                content=content.replace("../../../scripts/api_registration.ts","./api-registration.ts")
                if '../src/' in content: raise RuntimeError('source import escaped installed acceptance boundary')
                (consumer/name).write_text(content)
            content=(ROOT/'scripts/api_registration.ts').read_text()
            content=re.sub(r"(['\"])\.\./packages/sdk/src/([a-z0-9-]+)\.ts\1",lambda m:"'@zkapi/solana-sdk"+('' if m[2]=='client' else '/'+m[2])+"'",content)
            (consumer/'api-registration.ts').write_text(content)
            env['ZKAPI_TEST_LIFECYCLE_SCRIPT']=str(consumer/'general-api-e2e.ts')
            distribution = json.loads((run_dir/'sdk-distribution/results.json').read_text())
            report['public_format_fixtures'] = {'scope': 'Injected HTTPS/Devnet-format responses, distinct from local chain execution',
                'installed_tests': distribution['installed_tests'], 'native_profile_contract_tests': distribution['native_profile_contract_tests'],
                'live_provider_verified': False, 'public_rpc_verified': False}
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
                variants = ['native','native-lost_response','native-upstream_timeout'] if gateway else ['sdk','native','sdk-lost_response','native-lost_response','sdk-upstream_timeout','native-upstream_timeout'] if onboarding else ['legacy']
                if native_clients: variants += [f'native-{kind}-{group}' for kind in ('codex','claude') for group in (1,2,3)]
                report['lifecycles'] = {}
                for variant in variants:
                    if variant != 'legacy': env['ZKAPI_ONBOARDING_VARIANT'] = variant
                    native_kind = variant.split('-')[1] if variant.startswith(('native-codex-','native-claude-')) else None
                    native_group = int(variant.rsplit('-',1)[1]) if native_kind else None
                    if native_kind:
                        env['ZKAPI_GATEWAY_CLIENT'] = native_kind
                        env['ZKAPI_GATEWAY_CLIENT_GROUP'] = str(native_group)
                    else:
                        env.pop('ZKAPI_GATEWAY_CLIENT', None)
                        env.pop('ZKAPI_GATEWAY_CLIENT_GROUP', None)
                    output = run('general-api-' + variant, ['cargo', 'test', '--locked', '--offline', '--manifest-path', 'services/control/Cargo.toml',
                                 '--features', 'i10-acceptance', '--test', 'general_api_e2e', '--', '--ignored', '--nocapture'], timeout=1500)
                    if 'test result: ok. 1 passed; 0 failed; 0 ignored;' not in output:
                        raise RuntimeError('actual local lifecycle test did not execute')
                    result = json.loads((run_dir / 'e2e-results.json').read_text())
                    if native_kind: validate_native_agent(result, native_kind, native_group)
                    else: validate(result, api_only=onboarding, variant=variant, gateway=gateway)
                    if onboarding and result.get('separate_control_process') is not True:
                        raise RuntimeError('real controld process required')
                    report['lifecycles'][variant] = result
                    (run_dir / ('e2e-' + variant + '.json')).write_text(json.dumps(result,indent=2)+'\n')
                if native_clients:
                    report['native_client_totals'] = {}
                    for kind in ('codex','claude'):
                        groups = [report['lifecycles'][f'native-{kind}-{group}'] for group in (1,2,3)]
                        totals = {'operations': sum(len(row['cases']) for row in groups), 'charge_micro_usdc': sum(int(row['total_charge_micro_usdc']) for row in groups), 'deposit_micro_usdc': sum(int(row['deposit_micro_usdc']) for row in groups), 'withdrawal_micro_usdc': sum(int(row['withdrawal_micro_usdc']) for row in groups), 'native_client_compatibility': all(row['native_client_compatibility'] for row in groups), 'provider_admission_resets': sum(row['provider_admission_resets'] for row in groups)}
                        if totals != {'operations':14,'charge_micro_usdc':10,'deposit_micro_usdc':15000000,'withdrawal_micro_usdc':14999990,'native_client_compatibility':kind=='codex','provider_admission_resets':0}:
                            raise RuntimeError('isolated native group aggregation failed')
                        report['native_client_totals'][kind] = totals
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-tools', action='store_true', help='Read-only installed-tool inventory; creates no run directory')
    parser.add_argument('--onboarding', action='store_true', help='Fresh generated configuration and installed SDK/native acceptance')
    parser.add_argument('--gateway', action='store_true', help='Installed native finite HTTP v2 gateway, receipt v3 and fresh real proof/SBF lifecycle')
    parser.add_argument('--gateway-clients', action='store_true', help='Pinned Codex/Claude CLI matrix through installed gateway with fresh local proof/SBF settlement')
    args = parser.parse_args()
    if args.gateway_clients: args.gateway = True
    if args.gateway: OUT = ROOT / 'target/gateway-native-local'
    if args.check_tools:
        result = inspect_tools(ROOT)
        print(json.dumps(result, indent=2))
        raise SystemExit(0 if result['passed'] else 1)
    OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (OUT / 'runner.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute(args.onboarding or args.gateway, args.gateway, args.gateway_clients)
