#!/usr/bin/env python3
"""Persistent, test-only control/signer backend for the I10 devnet Vault.

prepare      builds and validates local configuration; no network calls
check-local  additionally starts PostgreSQL and signerd, reconciles, then stops
serve        validates both RPC genesis hashes and runs controld until interrupted

This never loads a wallet key or sends a chain transaction. Real providers are
enabled only with --provider-state, after offline credential/plan preparation;
they use a separate, pinned dispatcher and the same shared ledger. The optional --local-adapter is the existing synthetic I05
adapter for request-proof/challenger tests, not evidence of provider acceptance.
Known public test role seeds are allowed only by the existing explicit devnet
test profile. Database and independent signer journal survive clean restarts.
Do not delete either to work around an uncertainty or recovery error.
"""
import argparse
import datetime
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from public_devnet_profile import read_public_profile, private_role_seeds, ProfileError

ROOT = Path(__file__).resolve().parents[1]
GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
ROLE = 'i10_devnet_test'


class Failure(Exception):
    """Only static, non-secret diagnostic text belongs in this exception."""


def require(condition, message):
    if not condition:
        raise Failure(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def private_directory(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0, 'private directory ownership/mode required')


def private_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0, 'private file ownership/mode required')


def start_control_process(binary, config, output, env):
    # Static control diagnostics are retained privately. Public reports must
    # project only the fixed provider_dispatch JSON fields, never copy this log.
    path = output / 'control.stderr.log'
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and info.st_mode & 0o077 == 0 and info.st_nlink == 1,
                'private regular control diagnostic log required')
        return subprocess.Popen([str(binary), 'serve', str(config)], cwd=ROOT, env=env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=fd)
    finally:
        os.close(fd)


def save(path, value, immutable=False):
    data = value if isinstance(value, bytes) else (json.dumps(value, indent=2) + '\n').encode()
    if path.exists() or path.is_symlink():
        private_file(path)
        if immutable:
            require(path.read_bytes() == data, 'persistent identity/configuration mismatch')
            return
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def child_env():
    # Never inherit wallet/provider credentials, PG overrides, proxy settings,
    # NODE_OPTIONS, preload hooks, or a different Cargo target directory.
    allowed = ('PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL',
               'RUSTUP_HOME', 'CARGO_HOME', 'SDKROOT', 'DEVELOPER_DIR')
    return {key: os.environ[key] for key in allowed if key in os.environ}


def run(argv, env, label, timeout=120, input_bytes=None):
    try:
        process = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, start_new_session=True,
                                   stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL)
    except OSError:
        raise Failure(label + ' unavailable or timed out') from None
    try:
        output, _ = process.communicate(input=input_bytes, timeout=timeout)
    except subprocess.TimeoutExpired:
        # Build children inherit the process group. Reap them as well as Cargo;
        # pg_ctl's detached postmaster is separately collected by start_local.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        raise Failure(label + ' unavailable or timed out') from None
    # Child errors can include URL credentials. Do not forward or retain them.
    require(process.returncode == 0, label + ' failed (child output withheld)')
    return output


def rpc_origin(url):
    try:
        value = urllib.parse.urlsplit(url)
        require(value.scheme == 'https' and value.hostname is not None
                and value.username is None and value.password is None
                and not value.fragment, 'RPC must be HTTPS without embedded credentials')
        return value.hostname.lower(), value.port or 443
    except ValueError:
        raise Failure('invalid RPC URL') from None


def read_rpcs(args, env):
    node = Path(os.environ.get('ZKAPI_NODE', ROOT / 'target/i08-toolchain/bin/node'))
    version = run([str(node), '--version'], env, 'pinned Node version').decode().strip()
    require(version == 'v' + (ROOT / '.node-version').read_text().strip(), 'pinned Node version required')
    source = ('process.stdout.write(JSON.stringify({'
              'primary:process.env.SOLANA_DEVNET_RPC,'
              'secondary:process.env.SOLANA_DEVNET_SECONDARY_RPC}));')
    node_env = dict(env)
    for name in ('SOLANA_DEVNET_RPC', 'SOLANA_DEVNET_SECONDARY_RPC'):
        if name in os.environ:
            node_env[name] = os.environ[name]
    argv = [str(node)]
    if args.env_file.exists():
        argv.append('--env-file=' + str(args.env_file))
    values = json.loads(run([*argv, '--input-type=module', '-e', source], node_env, 'RPC environment loading'))
    primary = values.get('primary')
    secondary = values.get('secondary') or 'https://api.devnet.solana.com'
    require(isinstance(primary, str) and primary, 'SOLANA_DEVNET_RPC is required')
    require(isinstance(secondary, str), 'invalid secondary RPC configuration')
    require(rpc_origin(primary) != rpc_origin(secondary), 'two independent HTTPS RPC origins required')
    return primary, secondary


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def json_http(url, body=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'})
    with opener.open(request, timeout=12) as response:
        raw = response.read(1_048_577)
        require(len(raw) <= 1_048_576, 'HTTP response limit exceeded')
        return json.loads(raw)


def validate_genesis(endpoints, env):
    # The repository's pinned Node uses its normal bundled trust store. URLs
    # remain on stdin, never argv, logs or the inherited runtime environment.
    node = Path(os.environ.get('ZKAPI_NODE', ROOT / 'target/i08-toolchain/bin/node'))
    source = """
try {
  let input=''; for await (const chunk of process.stdin) {
    input+=chunk; if(input.length>65536) throw Error();
  }
  const {endpoints, genesis}=JSON.parse(input);
  for(const endpoint of endpoints) {
    const response=await fetch(endpoint,{method:'POST',redirect:'error',
      headers:{'content-type':'application/json'},signal:AbortSignal.timeout(12000),
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getGenesisHash',params:[]})});
    if(!response.ok || !response.body) throw Error();
    const chunks=[];let size=0;
    for await (const chunk of response.body) {
      size+=chunk.length;if(size>1048576)throw Error();chunks.push(chunk);
    }
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(value.id!==1 || 'error' in value || value.result!==genesis)throw Error();
  }
  process.stdout.write('verified');
} catch { process.stderr.write('devnet RPC genesis verification failed');process.exitCode=1; }
"""
    output = run([str(node), '--input-type=module', '-e', source], env,
                 'devnet RPC genesis verification', timeout=35,
                 input_bytes=json.dumps({'endpoints': endpoints, 'genesis': GENESIS}).encode())
    require(output == b'verified', 'devnet RPC genesis mismatch')


def local_tariff():
    body = {'version': '1', 'provider': 'openai', 'model': 'i05-local-only',
            'pricing_basis': 'fixed_usage_rates', 'valid_from': '1', 'valid_until': '4000000000',
            'rates': [{'unit': unit, 'nano_usdc_numerator': '1', 'unit_denominator': '3'}
                      for unit in ('input_tokens', 'output_tokens')],
            'operator_fee_micro_usdc': '0'}
    # This body has only ASCII object keys and string values: sorted compact
    # JSON is identical to the existing JCS tariff digest. Rust validates again.
    return {**body, 'tariff_hash': hashlib.sha256(
        json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


class Backend:
    def __init__(self, args):
        self.args = args
        self.out = args.output
        self.env = child_env()
        self.signer = self.control = None
        self.pg_running = False
        self.stop_requested = False
        self.stage = 'prepare'
        self.report = {'schema': 1, 'started_at_utc': now(), 'status': 'preparing',
                       'test_only': True, 'real_provider_adapters': 0,
                       'synthetic_local_adapter': args.local_adapter,
                       'chain_transactions_sent_by_launcher': 0, 'release_gates_passed': []}
        self.socket_dir = self.out / 'socket'
        self.signer_socket = self.socket_dir / 'signer.sock'
        self.data = self.out / 'postgres'
        self.bins = ROOT / 'services/control/target/debug'
        self.db = f'host={self.socket_dir} port={args.pg_port} user={ROLE} dbname=postgres'
        self.env.update(ZKAPI_DATABASE_URL=self.db, ZKAPI_SIGNER_DATABASE_URL=self.db)
        self.psql = ['psql', '-X', '-h', str(self.socket_dir), '-p', str(args.pg_port),
                     '-U', ROLE, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc']

    def record(self):
        self.report['updated_at_utc'] = now()
        save(self.out / 'runtime-report.json', self.report)

    def prepare(self):
        private_directory(self.socket_dir)
        require(len(os.fsencode(self.socket_dir / f'.s.PGSQL.{self.args.pg_port}')) < 104,
                'Unix socket path is too long; select a shorter output directory')
        require("'" not in str(self.out) and not any(c.isspace() for c in str(self.out)),
                'output directory cannot contain quotes or whitespace')
        for tool in ('cargo', 'initdb', 'pg_ctl', 'psql'):
            require(shutil.which(tool) is not None, 'required local build/database tool unavailable')
        self.rpcs = read_rpcs(self.args, self.env)
        source = self.args.deployment
        manifest = json.loads((source / 'public-manifest.json').read_bytes())
        deployment = json.loads((source / 'deployment.json').read_bytes())
        build = source / 'build-manifest.json'
        idl = source / 'vault-idl.json'
        elf = self.args.program
        require(manifest['deployment_environment'] == 'devnet' and manifest['setup_profile'] == 'test_only'
                and manifest['genesis_hash'] == deployment['genesis'] == GENESIS,
                'explicit devnet test deployment required')
        for field in ('program_id', 'pool', 'mint', 'token_program'):
            require(manifest[field] == deployment[field], 'public deployment/manifest mismatch')
        build_value = json.loads(build.read_bytes())
        require(build_value['deployment_authority'] == deployment['initializer'], 'initializer/build mismatch')
        public_directory = getattr(self.args, 'public_devnet_profile', None)
        public_hash = getattr(self.args, 'public_devnet_profile_sha256', None)
        public_profile = None
        if public_directory is not None:
            require(not getattr(self.args, 'allow_legacy_devnet_fixtures', False), 'public and legacy profiles are mutually exclusive')
            public_profile = read_public_profile(public_directory, public_hash)
            require(build_value.get('schema') == 2 and build_value.get('public_profile_sha256') == public_hash
                    and build_value.get('tree_setup') == 'single_party_os_random', 'public build profile binding required')
            from public_devnet_profile import PROFILE_FIELDS
            for field in (*PROFILE_FIELDS, 'circuit_profile_hash', 'state_key', 'clearance_key',
                          'quote_public_key', 'receipt_public_key'):
                require(manifest.get(field) == public_profile[field], 'public deployment role/profile mismatch')
            for field in ('state_key', 'clearance_key', 'circuit_profile_hash'):
                require(build_value.get(field) == public_profile[field], 'public build role/profile mismatch')
        else:
            require(public_hash is None and getattr(self.args, 'allow_legacy_devnet_fixtures', False),
                    'select a fresh public profile or explicitly allow legacy devnet fixtures')
            require(build_value.get('schema') == 1 and 'public_profile_sha256' not in build_value,
                    'public deployment cannot use legacy role seeds')
        identity = {'schema': 1, 'deployment_id': manifest['deployment_id'], 'pool': manifest['pool'],
                    'manifest_hash': manifest['manifest_hash'], 'build_manifest_sha256': digest(build),
                    'idl_sha256': digest(idl), 'program_sha256': digest(elf)}
        if public_profile is not None:
            identity['public_profile_sha256'] = public_hash
        providers, tariffs = {}, []
        if self.args.provider_state is not None:
            require(not self.args.local_adapter, 'synthetic and public provider profiles cannot be combined')
            for name in ('providers.json', 'tariffs.json'):
                private_file(self.args.provider_state / name)
            providers = json.loads((self.args.provider_state / 'providers.json').read_bytes())
            tariffs = json.loads((self.args.provider_state / 'tariffs.json').read_bytes())
            require(isinstance(providers, dict) and set(providers) == {'direct', 'proxy'}
                    and isinstance(tariffs, list) and tariffs,
                    'prepared provider configuration required')
            require(all(t['tariff_hash'] in manifest['tariff_hashes'] for t in tariffs),
                    'prepared provider tariff absent from manifest')
            identity['provider_configuration_sha256'] = digest(self.args.provider_state / 'providers.json')
            identity['provider_tariffs_sha256'] = digest(self.args.provider_state / 'tariffs.json')
            self.report['real_provider_adapters'] = len(providers['direct']) + len(providers['proxy'])
        # Write-once identity protects restarts from changing the pool or its trust
        # pins underneath persistent nullifiers and the sign-once journal.
        save(self.out / 'identity.json', identity, immutable=True)
        role_seeds = (private_role_seeds(public_directory) if public_profile is not None else
                      {'quote': bytes([11]) * 32, 'receipt': bytes([12]) * 32,
                       'state': (31).to_bytes(32, 'big'), 'clearance': (37).to_bytes(32, 'big')})
        for role, seed in role_seeds.items():
            save(self.out / (role + '.seed'), seed, immutable=True)
        tariff = local_tariff()
        if self.args.local_adapter:
            require(tariff['tariff_hash'] in manifest['tariff_hashes'], 'synthetic tariff absent from manifest')
        config = {'local_test_only': True, 'devnet': {'idl_file': str(idl), 'program_file': str(elf),
                  'build_manifest_file': str(build), 'trusted_build_manifest_hash': digest(build)},
                  'listen': f'127.0.0.1:{self.args.port}', 'manifest': manifest,
                  'trusted_manifest_hash': manifest['manifest_hash'], 'primary_rpc': self.rpcs[0],
                  'secondary_rpc': self.rpcs[1], 'indexer_origin': self.args.indexer,
                  'signer_socket': str(self.signer_socket), 'quote_seed_file': str(self.out / 'quote.seed'),
                  'receipt_seed_file': str(self.out / 'receipt.seed'),
                  'enable_local_adapter': self.args.local_adapter, 'providers': providers,
                  'tariffs': [tariff] if self.args.local_adapter else tariffs}
        if public_profile is not None:
            config['devnet'].update(public_profile_file=str(public_directory / 'public-profile.json'),
                                    trusted_public_profile_hash=public_hash)
        if not self.args.no_build:
            print('Building control and signer binaries.', flush=True)
            run(['cargo', 'build', '--locked', '--manifest-path', 'services/control/Cargo.toml',
                 '--bin', 'controld', '--bin', 'signerd', '--bin', 'dispatcherd'], self.env, 'control/signer build', 900)
        if self.args.provider_state is not None:
            self.configure_dispatcher(config, providers)
        save(self.out / 'control.json', config)
        signer_config = run([str(self.bins / 'controld'), 'signer-config', str(self.out / 'control.json')],
                            self.env, 'actual control configuration validation')
        save(self.out / 'signer.json', json.loads(signer_config), immutable=True)
        journal = self.out / 'signer.journal'
        if journal.exists() or journal.is_symlink():
            private_file(journal)
        else:
            require(not self.data.exists() and not (self.out / 'cluster.json').exists(),
                    'signer journal missing beside initialized database; recovery required')
            run([str(self.bins / 'signerd'), '--local-test', '--config', str(self.out / 'signer.json'),
                 '--journal', str(journal), '--initialize-journal'], self.env, 'first signer journal initialization')
        self.report.update(identity=identity, configuration_validated=True,
                           public_control_origin=manifest['control_api_origin'],
                           public_inference_origin=manifest['inference_api_origin'],
                           internal_control_origin=f'http://127.0.0.1:{self.args.port}',
                           signer_socket=str(self.signer_socket), database_transport='Unix socket only',
                           postgres_port=self.args.pg_port, persistent_state=str(self.out),
                           source_sha256={str(p.relative_to(ROOT)): digest(p) for p in (
                               Path(__file__).resolve(), ROOT / 'services/control/src/config.rs',
                               ROOT / 'services/control/src/inference.rs', ROOT / 'services/control/src/proxy/transport.rs',
                               ROOT / 'services/control/src/proxy/usage.rs', ROOT / 'services/control/src/egress.rs',
                               ROOT / 'services/control/src/bin/controld.rs', ROOT / 'services/control/src/bin/signerd.rs')},
                           binary_sha256={name: digest(self.bins / name) for name in ('controld', 'signerd')},
                           status='prepared', public_rpc_genesis_verified=False)
        self.record()

    def sql(self, query):
        return run([*self.psql, query], self.env, 'PostgreSQL read-only verification').decode().strip()

    def configure_dispatcher(self, config, providers):
        # Control gets no usable provider credential references. Only a single-use
        # worker receives them, after its saved ledger attempt has been fenced.
        claims = self.out / 'dispatcher-claims'
        private_directory(claims)
        source = self.bins / 'dispatcherd'
        binary_hash = digest(source)
        binary = self.out / ('dispatcherd-' + binary_hash)
        save(binary, source.read_bytes(), immutable=True)
        binary.chmod(0o500)
        alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
        number = 0
        for character in config['manifest']['pool']:
            require(character in alphabet, 'invalid pool key')
            number = number * 58 + alphabet.index(character)
        require(0 <= number < 1 << 256, 'invalid pool key')
        pool = list(number.to_bytes(32, 'big'))
        child = {'local_test_only': False,
                 'devnet': {'deployment': config['devnet'], 'manifest': config['manifest'],
                            'trusted_manifest_hash': config['trusted_manifest_hash']},
                 'database_url': f'host={self.socket_dir} port={self.args.pg_port} user=i10_provider_reader dbname=postgres',
                 'pool': pool, 'claims_directory': str(claims), 'providers': providers}
        path = self.out / 'dispatcher.json'
        save(path, child, immutable=True)
        run([str(binary), str(path), '--check-config'], self.env, 'public provider dispatcher validation')
        frontend = json.loads(json.dumps(providers))
        for provider in frontend['proxy'] + frontend['direct']:
            provider['credential_file'] = str(self.out / 'credential-not-mounted-in-control')
        frontend['dispatcher'] = {'binary': str(binary), 'binary_sha256': binary_hash,
                                  'config_file': str(path)}
        config['providers'] = frontend
        self.report['provider_dispatcher'] = {'configuration_sha256': digest(path),
                                             'binary_sha256': binary_hash,
                                             'fixture_targets_permitted': False,
                                             'database_role': 'SELECT only',
                                             'actual_provider_requests_verified': False}

    def provision_provider_reader(self):
        reader = 'i10_provider_reader'
        allowed = "'pools','dispatch_attempts','sessions','operations','quotes','tariffs','outbox'"
        self.sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='" + reader + "') "
                 "THEN CREATE ROLE " + reader + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                 "NOINHERIT NOREPLICATION NOBYPASSRLS; END IF; END $$")
        require(self.sql("SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole "
            "OR rolinherit OR rolreplication OR rolbypassrls) AND NOT EXISTS "
            "(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) "
            "AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner=r.oid) "
            "AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) "
            "AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba=r.oid) "
            "AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner=r.oid) "
            "FROM pg_roles r WHERE rolname='" + reader + "'") == 't',
            'dispatcher reader role has unexpected authority')
        self.sql("GRANT CONNECT ON DATABASE postgres TO " + reader + "; "
                 "GRANT USAGE ON SCHEMA public TO " + reader + "; "
                 "GRANT SELECT ON public.pools,public.dispatch_attempts,public.sessions,public.operations,"
                 "public.quotes,public.tariffs,public.outbox TO " + reader + "; "
                 "ALTER ROLE " + reader + " SET default_transaction_read_only=on")
        require(self.sql("SELECT NOT has_schema_privilege('" + reader + "','public','CREATE') "
            "AND NOT has_database_privilege('" + reader + "','postgres','CREATE') "
            "AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' "
            "AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN (has_table_privilege('" + reader + "',c.oid,"
            "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR (has_table_privilege('" + reader + "',c.oid,'SELECT') "
            "AND NOT (n.nspname='public' AND c.relname IN (" + allowed + ")))) ELSE false END) "
            "AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname NOT IN ('pg_catalog','information_schema') "
            "AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('" + reader + "',c.oid,'USAGE,SELECT,UPDATE') ELSE false END)") == 't',
            'dispatcher reader has excess database privileges')
        command = list(self.psql)
        command[command.index('-U') + 1] = reader
        observed = run([*command, "SELECT current_setting('default_transaction_read_only'); "
                        "SELECT count(*) >= 0 FROM public.dispatch_attempts"], self.env,
                       'dispatcher reader connection').decode().strip()
        require(observed == 'on\nt', 'dispatcher reader cannot observe its fenced attempts')
        self.report['provider_dispatcher']['select_only_role_verified'] = True

    def start_local(self):
        self.stage = 'postgres'
        cluster_pin = self.out / 'cluster.json'
        fresh = not self.data.exists()
        if fresh:
            require(not cluster_pin.exists() and not cluster_pin.is_symlink(),
                    'initialized PostgreSQL cluster missing; restore ledger instead of creating another')
            run(['initdb', '-D', str(self.data), '-U', ROLE, '--no-locale', '--encoding=UTF8', '--auth=trust'],
                self.env, 'private PostgreSQL initialization')
        else:
            require(cluster_pin.exists(), 'existing PostgreSQL cluster has no identity pin; recovery required')
            private_file(cluster_pin)
        private_directory(self.data)
        require(not (self.data / 'postmaster.pid').exists(),
                'existing PostgreSQL owner requires explicit recovery; no automatic takeover')
        require(not self.signer_socket.exists() and not self.signer_socket.is_symlink(),
                'existing signer socket requires explicit recovery; no automatic deletion')
        try:
            run(['pg_ctl', '-D', str(self.data), '-l', str(self.out / 'postgres.log'), '-o',
                 f"-k {self.socket_dir} -h '' -p {self.args.pg_port} -c unix_socket_permissions=0700", '-w', 'start'],
                self.env, 'private PostgreSQL start')
            self.pg_running = True
        except Failure:
            # pg_ctl may time out after starting the postmaster. We exclusively
            # own this private cluster and observed no prior PID, so collect any
            # child we started before reporting startup failure.
            status = subprocess.run(['pg_ctl', '-D', str(self.data), 'status'], env=self.env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            self.pg_running = status.returncode == 0
            raise
        require(self.sql("SELECT current_setting('fsync'), current_setting('full_page_writes'), "
                         "current_setting('synchronous_commit'), current_setting('listen_addresses')") == 'on|on|on|',
                'PostgreSQL durability or Unix-only listener mismatch')
        require(Path(self.sql('SHOW data_directory')).resolve() == self.data,
                'PostgreSQL data directory mismatch')
        system_id = self.sql('SELECT system_identifier FROM pg_control_system()')
        require(system_id.isascii() and system_id.isdigit(), 'invalid PostgreSQL cluster identity')
        cluster_identity = {'schema': 1, 'system_identifier': system_id,
                            'data_directory': str(self.data),
                            'manifest_hash': self.report['identity']['manifest_hash']}
        # Pin before any ledger migration/provisioning. A crash between initdb
        # and this marker needs explicit recovery; empty ledgers are never
        # inferred safe from a header-only signer journal.
        save(cluster_pin, cluster_identity, immutable=True)
        self.report['postgres_system_identifier'] = system_id
        run([str(self.bins / 'controld'), 'migrate'], self.env, 'ledger migrations')
        run([str(self.bins / 'controld'), 'provision', str(self.out / 'control.json')], self.env, 'ledger provisioning')
        if self.args.provider_state is not None:
            self.provision_provider_reader()
        self.stage = 'signer'
        self.signer = subprocess.Popen([str(self.bins / 'signerd'), '--local-test', '--config',
            str(self.out / 'signer.json'), '--journal', str(self.out / 'signer.journal'),
            '--socket', str(self.signer_socket), '--state-seed-file', str(self.out / 'state.seed'),
            '--clearance-seed-file', str(self.out / 'clearance.seed')], cwd=ROOT, env=self.env,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        health = None
        for _ in range(100):
            require(self.signer.poll() is None, 'signer exited during startup')
            try:
                health = self.health()
                if health.get('reconciled') is True:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.1)
        require(health is not None and health.get('reconciled') is True, 'signer reconciliation unavailable')
        self.report.update(status='local_ready', signer_reconciled=True,
                           signer_config_digest=health['config_digest'], postgres_durable=True,
                           database_accepting=self.sql('SELECT accepting FROM pools') == 't')
        self.record()

    def health(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(2)
            connection.connect(str(self.signer_socket))
            connection.sendall(b'{"kind":"health"}\n')
            with connection.makefile('rb') as stream:
                line = stream.readline(4097)
                require(len(line) <= 4096 and line.endswith(b'\n'), 'signer health response limit')
                return json.loads(line)

    def serve(self):
        self.stage = 'rpc_genesis'
        validate_genesis(self.rpcs, self.env)
        self.report['public_rpc_genesis_verified'] = True
        self.start_local()
        self.stage = 'control'
        self.control = start_control_process(self.bins / 'controld', self.out / 'control.json', self.out, self.env)
        reachable = False
        for _ in range(600):
            require(self.control.poll() is None, 'control exited during startup')
            require(self.signer.poll() is None, 'signer exited during control startup')
            if self.stop_requested:
                return
            try:
                manifest = json_http(self.report['internal_control_origin'] + '/zkapi/v1/config')
                reachable = manifest.get('manifest_hash') == self.report['identity']['manifest_hash']
                if reachable:
                    break
            except Exception:
                pass
            time.sleep(0.1)
        require(reachable, 'control HTTP startup timeout')
        self.report.update(status='serving', database_accepting=self.sql('SELECT accepting FROM pools') == 't')
        self.record()
        print('Backend serving; see private runtime-report.json for HTTP and admission status.', flush=True)
        refresh_at = time.monotonic()
        while not self.stop_requested:
            require(self.control.poll() is None and self.signer.poll() is None, 'backend child exited')
            if time.monotonic() >= refresh_at:
                self.report['database_accepting'] = self.sql('SELECT accepting FROM pools') == 't'
                self.report['signer_reconciled'] = self.health().get('reconciled') is True
                self.record()
                refresh_at = time.monotonic() + 5
            time.sleep(0.2)

    def close(self):
        # Drain control before stopping the independent signer and durable DB.
        stopped = True
        for process, sig in ((self.control, signal.SIGINT), (self.signer, signal.SIGTERM)):
            try:
                if process is not None and process.poll() is None:
                    try:
                        process.send_signal(sig)
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
                        stopped = False
            except (OSError, subprocess.TimeoutExpired):
                stopped = False
        try:
            if self.signer is not None and self.signer.poll() is not None:
                self.signer_socket.unlink(missing_ok=True)
        except OSError:
            stopped = False
        if self.pg_running:
            try:
                run(['pg_ctl', '-D', str(self.data), '-m', 'fast', '-w', 'stop'], self.env, 'PostgreSQL shutdown')
                self.pg_running = False
            except Failure:
                stopped = False
        self.report['clean_shutdown'] = stopped
        if not stopped and self.report.get('status') != 'failed':
            self.report.update(status='failed', failure_stage='shutdown')
        elif self.report.get('status') not in ('failed', 'prepared'):
            self.report['status'] = 'stopped'
        try:
            self.record()
        except OSError:
            stopped = False
        return stopped


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode', choices=('prepare', 'check-local', 'serve'))
    parser.add_argument('--output', type=Path, default=ROOT / 'target/i10-devnet-backend')
    parser.add_argument('--deployment', type=Path, default=ROOT / 'target/i10-devnet-vault')
    parser.add_argument('--program', type=Path, default=ROOT / 'target/i10-devnet-sbf/zkapi_vault.so')
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env')
    parser.add_argument('--indexer', default='http://127.0.0.1:18883')
    parser.add_argument('--port', type=int, default=18887)
    parser.add_argument('--pg-port', type=int, default=55446)
    parser.add_argument('--local-adapter', action='store_true', help='explicit synthetic I05 request-proof test adapter')
    parser.add_argument('--provider-state', type=Path, help='private output from provider_acceptance.py prepare')
    parser.add_argument('--public-devnet-profile', type=Path, help='new independently pinned OS-random profile directory')
    parser.add_argument('--public-devnet-profile-sha256', help='independently retained SHA256 of public-profile.json')
    parser.add_argument('--allow-legacy-devnet-fixtures', action='store_true',
                        help='explicitly retain the historical known-public test keys and setup; never use for a public profile')
    parser.add_argument('--no-build', action='store_true', help='use already built binaries; report records their hashes')
    args = parser.parse_args()
    public_mode = args.public_devnet_profile is not None
    require(public_mode == (args.public_devnet_profile_sha256 is not None),
            'public profile directory and independent SHA256 must be supplied together')
    require(public_mode != args.allow_legacy_devnet_fixtures,
            'select a fresh public profile or explicitly allow legacy devnet fixtures')
    for name in ('output', 'deployment', 'program', 'env_file'):
        setattr(args, name, getattr(args, name).resolve())
    if args.provider_state is not None:
        args.provider_state = args.provider_state.resolve()
        private_directory(args.provider_state)
    if args.public_devnet_profile is not None:
        args.public_devnet_profile = args.public_devnet_profile.resolve()
    require(1024 <= args.port <= 65535 and 1024 <= args.pg_port <= 65535, 'unprivileged port required')
    url = urllib.parse.urlsplit(args.indexer)
    try:
        require(url.scheme == 'http' and url.hostname is not None and ipaddress.ip_address(url.hostname).is_loopback
                and not url.username and not url.password and not url.query and not url.fragment
                and url.path in ('', '/'), 'indexer must be a numeric loopback HTTP origin')
    except ValueError:
        raise Failure('indexer must be a numeric loopback HTTP origin') from None
    return args


def main():
    os.umask(0o077)
    backend = None
    try:
        args = arguments()
        private_directory(args.output)
        lock_path = args.output / 'launcher.lock'
        if lock_path.exists() or lock_path.is_symlink():
            private_file(lock_path)
        with lock_path.open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure('another backend launcher owns this state directory') from None
            backend = Backend(args)
            def stop(_signum, _frame):
                backend.stop_requested = True
            signal.signal(signal.SIGINT, stop)
            signal.signal(signal.SIGTERM, stop)
            try:
                backend.prepare()
                if backend.stop_requested:
                    pass
                elif args.mode == 'check-local':
                    backend.start_local()
                elif args.mode == 'serve':
                    backend.serve()
            except BaseException:
                backend.report.update(status='failed', failure_stage=backend.stage)
                raise
            finally:
                clean = backend.close()
            require(clean, 'backend shutdown needs explicit recovery')
        print(json.dumps({'status': backend.report['status'], 'report': str(args.output / 'runtime-report.json')}))
        return 0
    except Exception as error:
        # Parse/OS/HTTP errors may contain sensitive values; only our static
        # Failure messages may leave this process.
        message = str(error) if isinstance(error, (Failure, ProfileError)) else 'backend preparation/runtime failed; private state preserved'
        print(message, file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
