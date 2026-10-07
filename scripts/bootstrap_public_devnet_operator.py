#!/usr/bin/env python3
"""Explicit first initialization of a new, mounted public Devnet operator.

The caller authenticates the decrypted input inventory independently. This
never initializes a provider budget, forwards AUTH, or submits a transaction.
An occupied or partially initialized state directory refuses a second run.
Errors deliberately omit private inputs and subprocess output.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import stat
import subprocess
import time

STATE = Path('/srv/zka')
APP = Path('/opt/zkapi')
SOCKET = '/run/zkapi-postgresql'
STAGE = 'validation'


def require(value):
    if not value:
        raise ValueError('operator bootstrap guard failed')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(argv, data=None, env=None, user=None):
    if user:
        argv = ['runuser', '-u', user, '--', *argv]
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, timeout=180)
    require(result.returncode == 0)
    return result.stdout


def directory(path, user='root', mode=0o700):
    path.mkdir(mode=mode, exist_ok=False)
    account = pwd.getpwnam(user)
    os.chown(path, account.pw_uid, account.pw_gid)
    path.chmod(mode)


def save(path, value, user='root', mode=0o600):
    if not isinstance(value, bytes):
        value = (json.dumps(value, indent=2) + '\n').encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        account = pwd.getpwnam(user)
        os.fchown(fd, account.pw_uid, account.pw_gid)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(value)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def sql(text, user='postgres', database='postgres'):
    return run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-h', SOCKET,
                '-U', user, '-d', database], text.encode(), user='postgres' if user == 'postgres' else None)


def key(text):
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    value = 0
    for char in text:
        require(char in alphabet)
        value = value * 58 + alphabet.index(char)
    data = value.to_bytes(32, 'big')
    require(len(data) == 32)
    return list(data)


def verified_inputs(root, expected):
    inventory = root / 'inventory.json'
    require(digest(inventory) == expected)
    pins = json.loads(inventory.read_bytes())
    require(pins['schema'] == 1 and isinstance(pins['files'], dict))
    actual = set()
    for path in root.rglob('*'):
        require(not path.is_symlink())
        if path.is_file() and path != inventory:
            actual.add(path.relative_to(root).as_posix())
    require(actual == set(pins['files']))
    for name, expected_hash in pins['files'].items():
        require(not name.startswith('/') and '..' not in Path(name).parts)
        require(digest(root / name) == expected_hash)
    config = json.loads((root / 'operator.json').read_bytes())
    require(config['schema'] == 1 and config['new_operator'] is True)
    require(type(config['start_slot']) is int and config['start_slot'] > 0)
    require(re.fullmatch(r'https://[a-z0-9]+\.cloudfront\.net', config['public_origin']))
    return config


def initialize(root, expected):
    global STAGE
    require(os.geteuid() == 0 and STATE.is_mount())
    require(not STATE.is_symlink() and not APP.is_symlink())
    require(set(p.name for p in STATE.iterdir()) <= {'lost+found'})
    cfg = verified_inputs(root, expected)
    for name in ('controld', 'signerd', 'dispatcherd', 'indexerd', 'challengerd'):
        require(digest(APP / 'bin' / name) == cfg['binary_sha256'][name])
    require(run([str(APP / 'node/bin/node'), '--version']).strip() == b'v24.19.0')
    manifest = json.loads((root / 'public/assets/manifest.json').read_bytes())
    require(manifest['manifest_hash'] == cfg['manifest_sha256'])
    require(manifest['control_api_origin'] == cfg['public_origin'])
    require(manifest['deployment_environment'] == 'devnet')
    require(manifest['cap_micro_usdc'] == '1000000')
    require(digest(root / 'public/profile.json') == cfg['profile_sha256'])
    STAGE = 'durable-initialization-marker'
    save(STATE / 'operator-initialization.json', {
        'schema': 1, 'inventory_sha256': expected, 'manifest_sha256': cfg['manifest_sha256'],
        'pool': manifest['pool'], 'status': 'initializing',
        'warning': 'An incomplete initialization requires explicit inspection; never delete this marker to retry.'})
    STAGE = 'identities-and-inputs'
    for user in ('zka-runtime', 'zka-indexer', 'zka-challenger', 'zka-gateway'):
        try:
            pwd.getpwnam(user)
            raise ValueError('existing operator user')
        except KeyError:
            run(['useradd', '--system', '--no-create-home', '--shell', '/sbin/nologin', user])
    STATE.chmod(0o755)
    for name, user, mode in [('runtime','zka-runtime',0o700), ('signer','zka-runtime',0o700),
            ('dispatcher','zka-runtime',0o700), ('postgres','postgres',0o700),
            ('indexer','zka-indexer',0o700), ('challenger','zka-challenger',0o700),
            ('config','zka-gateway',0o700), ('budget-seven','zka-gateway',0o700),
            ('public','root',0o755), ('deployment','root',0o755)]:
        directory(STATE / name, user, mode)
    save(STATE / 'budget-seven/budget.lock', b'', 'zka-gateway')
    directory(STATE / 'history', mode=0o750)
    os.chown(STATE / 'history', 0, pwd.getpwnam('zka-gateway').pw_gid)
    for source_dir, target_dir in [('public', 'public'), ('deployment', 'deployment')]:
        for source in sorted((root / source_dir).rglob('*')):
            destination = STATE / target_dir / source.relative_to(root / source_dir)
            if source.is_dir():
                directory(destination, mode=0o755)
            else:
                save(destination, source.read_bytes(), mode=0o644)
    for role in ('quote', 'receipt', 'state', 'clearance'):
        value = (root / 'roles' / (role + '.seed')).read_bytes()
        require(len(value) == 32)
        save(STATE / 'runtime' / (role + '.seed'), value, 'zka-runtime')
    save(STATE / 'runtime/openrouter-management.credential',
         (root / 'openrouter-management.credential').read_bytes(), 'zka-runtime')
    save(STATE / 'challenger/fee-key.json', (root / 'challenger-fee-key.json').read_bytes(), 'zka-challenger')
    STAGE = 'postgresql-first-initialization'
    run(['initdb', '-D', str(STATE / 'postgres'), '--no-locale', '--encoding=UTF8',
         '--auth-local=peer', '--auth-host=reject'], user='postgres')
    # These files are new initdb defaults, never a preexisting cluster.
    (STATE / 'postgres/postgresql.auto.conf').write_text(
        "listen_addresses = ''\nunix_socket_directories = '" + SOCKET + "'\n"
        "unix_socket_permissions = 0777\nshared_buffers = '128MB'\nmax_connections = 40\n"
        "fsync = on\nfull_page_writes = on\nsynchronous_commit = on\npassword_encryption = 'scram-sha-256'\n")
    (STATE / 'postgres/pg_hba.conf').write_text(
        'local all postgres peer\nlocal zkapi zkapi_migration peer map=zkapi_bootstrap\n'
        'local zkapi all scram-sha-256\nlocal all all reject\n')
    (STATE / 'postgres/pg_ident.conf').write_text('zkapi_bootstrap root zkapi_migration\n')
    for name in ('postgresql.auto.conf','pg_hba.conf','pg_ident.conf'):
        path = STATE / 'postgres' / name
        os.chown(path, pwd.getpwnam('postgres').pw_uid, pwd.getpwnam('postgres').pw_gid)
        path.chmod(0o600)
        with path.open('rb') as stream:
            os.fsync(stream.fileno())
    for source in (APP / 'deploy/public-devnet/systemd').glob('*.service'):
        destination = Path('/etc/systemd/system') / source.name
        require(not destination.exists())
        save(destination, source.read_bytes(), mode=0o644)
    run(['systemctl', 'daemon-reload'])
    run(['systemctl', 'start', 'zka-postgresql.service'])
    for attempt in range(50):
        probe = subprocess.run(['runuser','-u','postgres','--','pg_isready','-h',SOCKET],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            break
        time.sleep(0.2)
    else:
        raise ValueError('database startup')
    passwords = {role: secrets.token_hex(32) for role in ('writer','signer','provider','challenger')}
    sql('CREATE ROLE zkapi_control_writer NOLOGIN; CREATE ROLE zkapi_control_reader NOLOGIN; '
        'CREATE ROLE zkapi_migration LOGIN; ' + ' '.join(
        "CREATE ROLE zkapi_" + role + " LOGIN PASSWORD '" + secret + "' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"
        for role, secret in passwords.items()) +
        ' GRANT zkapi_control_writer TO zkapi_writer; GRANT zkapi_control_reader TO zkapi_signer;')
    sql('CREATE DATABASE zkapi OWNER zkapi_migration;')
    sql('REVOKE ALL ON DATABASE zkapi FROM PUBLIC; GRANT CONNECT ON DATABASE zkapi TO '
        'zkapi_writer,zkapi_signer,zkapi_provider,zkapi_challenger;')
    dsn = {role: f'host={SOCKET} user=zkapi_{role} dbname=zkapi password={secret}' for role, secret in passwords.items()}
    migration_env = {**os.environ, 'ZKAPI_DATABASE_URL': f'host={SOCKET} user=zkapi_migration dbname=zkapi'}
    run([str(APP / 'bin/controld'), 'migrate'], env=migration_env)
    sql('GRANT USAGE ON SCHEMA public TO zkapi_provider,zkapi_challenger; '
        'GRANT SELECT ON pools,dispatch_attempts,sessions,operations,quotes,tariffs,outbox TO zkapi_provider; '
        'GRANT SELECT ON pools,nullifier_reservations,sessions TO zkapi_challenger;', 'zkapi_migration','zkapi')
    sql('ALTER ROLE zkapi_provider SET default_transaction_read_only=on; '
        'ALTER ROLE zkapi_challenger SET default_transaction_read_only=on;')
    STAGE = 'pinned-service-configurations'
    deployment = STATE / 'deployment'
    devnet = {'idl_file':str(deployment / 'vault-idl.json'), 'program_file':str(deployment / 'zkapi_vault.so'),
        'build_manifest_file':str(deployment / 'build-manifest.json'),
        'trusted_build_manifest_hash':digest(deployment / 'build-manifest.json'),
        'public_profile_file':str(deployment / 'public-profile.json'),
        'trusted_public_profile_hash':digest(deployment / 'public-profile.json')}
    providers = {'direct':[{'provider':'openrouter', 'api_base':'https://openrouter.ai/api/v1',
        'inference_base':'https://openrouter.ai/api/v1',
        'credential_file':str(STATE / 'runtime/openrouter-management.credential'),
        'settlement_grace_seconds':60}], 'proxy':[]}
    dispatcher = {'local_test_only':False, 'devnet':{'deployment':devnet, 'manifest':manifest,
        'trusted_manifest_hash':manifest['manifest_hash']}, 'database_url':dsn['provider'],
        'pool':key(manifest['pool']), 'claims_directory':str(STATE / 'dispatcher'), 'providers':providers}
    save(STATE / 'runtime/dispatcher.json', dispatcher, 'zka-runtime')
    frontend = json.loads(json.dumps(providers))
    frontend['direct'][0]['credential_file'] = str(STATE / 'runtime/credential-not-mounted-in-control')
    frontend['dispatcher'] = {'binary':str(APP / 'bin/dispatcherd'),
        'binary_sha256':cfg['binary_sha256']['dispatcherd'], 'config_file':str(STATE / 'runtime/dispatcher.json')}
    control = {'local_test_only':True, 'devnet':devnet, 'listen':'127.0.0.1:18887',
        'manifest':manifest, 'trusted_manifest_hash':manifest['manifest_hash'],
        'primary_rpc':cfg['primary_rpc'], 'secondary_rpc':cfg['secondary_rpc'],
        'indexer_origin':'http://127.0.0.1:18883', 'signer_socket':'/run/zkapi-signer/signer.sock',
        'quote_seed_file':str(STATE / 'runtime/quote.seed'), 'receipt_seed_file':str(STATE / 'runtime/receipt.seed'),
        'enable_local_adapter':False, 'providers':frontend, 'tariffs':cfg['tariffs']}
    save(STATE / 'runtime/control.json', control, 'zka-runtime')
    save(STATE / 'runtime/control.env', ('ZKAPI_DATABASE_URL="'+dsn['writer']+'"\n').encode(), 'zka-runtime')
    save(STATE / 'runtime/signer.env', ('ZKAPI_SIGNER_DATABASE_URL="'+dsn['signer']+'"\n').encode(), 'zka-runtime')
    # systemd owns this volatile socket directory after this first bootstrap.
    directory(Path('/run/zkapi-signer'), 'zka-runtime')
    signer_config = run([str(APP / 'bin/controld'), 'signer-config', str(STATE / 'runtime/control.json')],
        env={**os.environ,'ZKAPI_DATABASE_URL':dsn['writer']}, user='zka-runtime')
    save(STATE / 'runtime/signer.json', signer_config, 'zka-runtime')
    run([str(APP / 'bin/dispatcherd'), str(STATE / 'runtime/dispatcher.json'), '--check-config'], user='zka-runtime')
    run([str(APP / 'bin/controld'), 'provision', str(STATE / 'runtime/control.json')],
        env={**os.environ,'ZKAPI_DATABASE_URL':dsn['writer']}, user='zka-runtime')
    run([str(APP / 'bin/signerd'), '--local-test', '--config', str(STATE / 'runtime/signer.json'),
         '--journal', str(STATE / 'signer/signer.journal'), '--initialize-journal'], user='zka-runtime')
    save(STATE / 'indexer/config.json', {'rpc_url':cfg['primary_rpc'], 'program_id':manifest['program_id'],
        'pool':manifest['pool'], 'genesis_hash':manifest['genesis_hash'],
        'circuit_profile_hash':manifest['circuit_profile_hash'], 'start_slot':cfg['start_slot'],
        'listen':'127.0.0.1:18883', 'public_origin':cfg['public_origin'],
        'snapshots_directory':str(STATE / 'indexer/snapshots')}, 'zka-indexer')
    directory(STATE / 'challenger/journal', 'zka-challenger')
    directory(STATE / 'challenger/alerts', 'zka-challenger')
    save(STATE / 'challenger/reader.dsn', dsn['challenger'].encode(), 'zka-challenger')
    bridge = APP / 'packages/sdk/src/challenger-cli.ts'
    save(STATE / 'challenger/config.json', {'manifest':str(STATE / 'public/assets/manifest.json'),
        'manifest_sha256':manifest['manifest_hash'], 'devnet':devnet, 'rpc_url':cfg['primary_rpc'],
        'database_dsn_file':str(STATE / 'challenger/reader.dsn'), 'start_slot':cfg['start_slot'],
        'journal_directory':str(STATE / 'challenger/journal'), 'tree_pk':str(STATE / 'public/assets/treePk.bin'),
        'node':str(APP / 'node/bin/node'), 'transport_bridge':str(bridge), 'transport_bridge_sha256':digest(bridge),
        'fee_key_file':str(STATE / 'challenger/fee-key.json'), 'payer':cfg['challenger_payer'],
        'poll_seconds':2, 'alert_sink_directory':str(STATE / 'challenger/alerts'), 'priority_fee':None}, 'zka-challenger')
    run([str(APP / 'bin/challengerd'), 'init', str(STATE / 'challenger/config.json')], user='zka-challenger')
    STAGE = 'complete'
    save(STATE / 'operator-initialized.json', {'schema':1,'inventory_sha256':expected,
        'manifest_sha256':manifest['manifest_hash'], 'pool':manifest['pool'],
        'postgres_system_identifier':sql('SELECT system_identifier FROM pg_control_system()').decode().strip(),
        'provider_budget_initialized':False, 'public_admission_enabled':False})
    print(json.dumps({'initialized':True,'provider_budget_initialized':False,'public_admission_enabled':False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--initialize-new-operator', action='store_true', required=True)
    parser.add_argument('--input-directory', type=Path, required=True)
    parser.add_argument('--inventory-sha256', required=True)
    args = parser.parse_args()
    try:
        require(re.fullmatch('[0-9a-f]{64}',args.inventory_sha256))
        initialize(args.input_directory.resolve(), args.inventory_sha256)
    except Exception:
        print(json.dumps({'initialized':False,'failed_stage':STAGE,
            'error':'Bootstrap stopped; inspect private state before any explicit recovery. Details withheld.'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
