#!/usr/bin/env python3
"""Explicit test-only devnet challenger using the existing native state machine.

prepare (default) validates public pins/native config, provisions a SELECT-only
role in an already running private backend DB, and initializes a new journal.
It makes no public RPC call, reads no fee key contents, and sends no transaction.
scan explicitly reads public finalized history/evidence without recovering or
sending saved attempts; it prewarms the durable archive before a timed escape.
serve explicitly runs challengerd; only its existing bridge may read the fee key
and send signed transactions. Lost DB/journal identity always requires recovery.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import threading
import time

import run_i10_devnet_backend as shared

ROOT = shared.ROOT
READER = 'i10_devnet_challenger_reader'
Failure = shared.Failure
require = shared.require
METRICS = {'pending_jobs', 'unknown_signatures', 'complete_jobs', 'regenerated_proofs',
           'warning_jobs', 'page_jobs', 'emergency_jobs', 'oldest_unresolved_seconds',
           'finalized_slot', 'finalized_lag_seconds', 'minimum_deadline_remaining_seconds',
           'undelivered_alerts', 'oldest_detection_to_send_seconds', 'proof_failure_total',
           'root_conflict_reproves_total'}


def existing_directory(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0, 'existing owner-only directory required')


def read_private(path):
    shared.private_file(path)
    return json.loads(path.read_bytes())


def hash64(value):
    require(isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value), 'invalid public hash')
    return value


def public_key(value):
    require(isinstance(value, str) and re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', value),
            'invalid public key')
    return value


def sanitized_metric(raw):
    """Never retain arbitrary child text, strings, keys, URLs or transcripts."""
    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != METRICS:
            return None
        if not all(v is None or type(v) is int and v >= 0 for v in value.values()):
            return None
        return value
    except (ValueError, UnicodeError):
        return None


STOP_TIMEOUT_SECONDS = 20
REAP_TIMEOUT_SECONDS = 5

class Challenger:
    def __init__(self, args):
        self.args = args
        self.out = args.output
        self.env = shared.child_env()
        self.child = None
        self.stop_requested = False
        self.log_file = None
        self.log_lock = threading.Lock()
        self.threads = []
        self.report = {'schema': 1, 'started_at_utc': shared.now(), 'status': 'preparing',
                       'test_only': True, 'priority_fee': None, 'release_gates_passed': [],
                       'fee_key_read_by_launcher': False, 'public_rpc_called_by_prepare': False,
                       'transactions_sent_by_prepare': 0, 'child_output_withheld': 0}
        self.stage = 'configuration'
        self.profile = 'release' if args.release else 'debug'
        self.binary = ROOT / 'services/challenger/target' / self.profile / 'challengerd'
        self.report['build_profile'] = self.profile
        self.journal = self.out / 'journal'

    def record(self):
        self.report['updated_at_utc'] = shared.now()
        shared.save(self.out / 'runtime-report.json', self.report)

    def sql(self, query, reader=False):
        argv = ['psql', '-X', '-h', str(self.socket), '-p', str(self.pg_port),
                '-U', READER if reader else shared.ROLE, '-d', 'postgres',
                '-v', 'ON_ERROR_STOP=1', '-Atc', query]
        return shared.run(argv, self.env, 'local PostgreSQL verification', timeout=15).decode().strip()

    def inspect_database(self):
        # These checks precede every role mutation and every native run. Never
        # initialize, migrate, provision, repair or take ownership of this DB.
        identity = json.loads(self.sql("SELECT json_build_object('system_identifier',"
            "system_identifier::text,'data_directory',current_setting('data_directory'),"
            "'database',current_database(),'user',current_user,"
            "'listen_addresses',current_setting('listen_addresses'),'recovery',pg_is_in_recovery()) "
            "FROM pg_control_system()"))
        require(identity == {'system_identifier': self.cluster['system_identifier'],
                'data_directory': str(self.data), 'database': 'postgres', 'user': shared.ROLE,
                'listen_addresses': '', 'recovery': False}, 'persistent backend DB identity mismatch')
        pools = json.loads(self.sql("SELECT coalesce(json_agg(json_build_object('deployment_id',"
            "deployment_id,'manifest_hash',encode(manifest_hash,'hex'))),'[]'::json) FROM public.pools"))
        require(pools == [{'deployment_id': self.backend_identity['deployment_id'],
                           'manifest_hash': self.backend_identity['manifest_hash']}],
                'backend ledger manifest identity mismatch')

    def provision_reader(self):
        self.stage = 'reader_role'
        # Static allowlisted SQL only. Existing excessive rights are rejected,
        # never silently repurposed by revoking another role's privileges.
        self.sql("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='" + READER + "') "
                 "THEN CREATE ROLE " + READER + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
                 "NOINHERIT NOREPLICATION NOBYPASSRLS; END IF; END $$")
        role_ok = self.sql("SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole "
            "OR rolinherit OR rolreplication OR rolbypassrls) AND NOT EXISTS "
            "(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) "
            "AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner=r.oid) "
            "AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) "
            "AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba=r.oid) "
            "AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner=r.oid) "
            "FROM pg_roles r WHERE rolname='" + READER + "'")
        require(role_ok == 't', 'challenger reader role has unexpected authority')
        self.sql("GRANT CONNECT ON DATABASE postgres TO " + READER + "; "
                 "GRANT USAGE ON SCHEMA public TO " + READER + "; "
                 "GRANT SELECT ON public.pools,public.nullifier_reservations,public.sessions TO " + READER + "; "
                 "ALTER ROLE " + READER + " SET default_transaction_read_only=on")
        require(self.sql("SELECT NOT has_schema_privilege('" + READER + "','public','CREATE') "
            "AND NOT has_database_privilege('" + READER + "','postgres','CREATE') "
            "AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' "
            "AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN (has_table_privilege('" + READER + "',c.oid,"
            "'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR (has_table_privilege('" + READER + "',c.oid,'SELECT') "
            "AND NOT (n.nspname='public' AND c.relname IN ('pools','nullifier_reservations','sessions')))) ELSE false END) "
            "AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname NOT IN ('pg_catalog','information_schema') "
            "AND CASE WHEN c.relkind='S' THEN has_sequence_privilege('" + READER + "',c.oid,'USAGE,SELECT,UPDATE') ELSE false END)") == 't',
            'challenger reader has excess database privileges')
        require(self.sql("SELECT current_setting('default_transaction_read_only')", reader=True) == 'on',
                'reader transaction default is not read-only')
        # Actual SELECT under the dedicated role, without returning AUTH bytes.
        self.sql('SELECT count(*) FROM public.pools; SELECT count(*) FROM public.nullifier_reservations; '
                 'SELECT count(*) FROM public.sessions', reader=True)

    def prepare(self):
        existing_directory(self.args.backend)
        self.socket = self.args.backend / 'socket'
        self.data = self.args.backend / 'postgres'
        existing_directory(self.socket)
        existing_directory(self.data)
        require(not any(c.isspace() or c in "'\\," for c in str(self.socket)),
                'backend socket path cannot contain DSN separators')
        self.backend_identity = read_private(self.args.backend / 'identity.json')
        self.cluster = read_private(self.args.backend / 'cluster.json')
        backend_report = read_private(self.args.backend / 'runtime-report.json')
        control = read_private(self.args.backend / 'control.json')
        shared.private_file(self.args.backend / 'signer.journal')
        self.pg_port = backend_report.get('postgres_port')
        require(type(self.pg_port) is int and 1024 <= self.pg_port <= 65535, 'backend PostgreSQL port absent')
        require(self.cluster.get('schema') == 1 and self.cluster.get('data_directory') == str(self.data)
                and self.cluster.get('manifest_hash') == self.backend_identity.get('manifest_hash')
                and isinstance(self.cluster.get('system_identifier'), str)
                and self.cluster['system_identifier'].isascii() and self.cluster['system_identifier'].isdigit(),
                'backend cluster pin mismatch')
        manifest_path = self.args.deployment / 'public-manifest.json'
        manifest = json.loads(manifest_path.read_bytes())
        deployment = json.loads((self.args.deployment / 'deployment.json').read_bytes())
        initialize = json.loads((self.args.deployment / 'initialize-receipt.json').read_bytes())
        start_slot = initialize.get('slot')
        require(type(start_slot) is int and 0 < start_slot <= 0xffffffffffffffff, 'initialize slot absent')
        require(manifest == control.get('manifest') and control.get('trusted_manifest_hash') == manifest.get('manifest_hash')
                and manifest.get('deployment_environment') == 'devnet' and manifest.get('setup_profile') == 'test_only'
                and manifest.get('genesis_hash') == deployment.get('genesis') == shared.GENESIS,
                'public manifest differs from explicit devnet backend')
        for field in ('program_id','pool','mint','token_program'):
            require(manifest[field] == deployment[field], 'public deployment/manifest mismatch')
        for field in ('deployment_id','pool','manifest_hash'):
            require(manifest[field] == self.backend_identity[field], 'backend manifest pin mismatch')
        hash64(manifest['manifest_hash'])
        devnet = control.get('devnet')
        require(isinstance(devnet, dict), 'explicit backend devnet build configuration required')
        for field, identity_key in [('idl_file','idl_sha256'),('program_file','program_sha256'),
                                    ('build_manifest_file','build_manifest_sha256')]:
            path = Path(devnet[field])
            require(path.is_absolute() and shared.digest(path) == hash64(self.backend_identity[identity_key]),
                    'backend public build artifact changed')
        require(Path(devnet['idl_file']).resolve() == (self.args.deployment / 'vault-idl.json').resolve()
                and Path(devnet['build_manifest_file']).resolve() == (self.args.deployment / 'build-manifest.json').resolve()
                and devnet['trusted_build_manifest_hash'] == self.backend_identity['build_manifest_sha256'],
                'deployment build pin mismatch')
        endpoint = control['primary_rpc']
        shared.rpc_origin(endpoint)
        payer = public_key(self.args.payer or deployment['initializer'])
        # Metadata only. The file may be absent for prepare/keyless recovery;
        # serve requires it, and only the native bridge parses its actual key.
        if self.args.fee_key_file.exists() or self.args.fee_key_file.is_symlink():
            shared.private_file(self.args.fee_key_file)
        elif self.args.mode == 'serve':
            raise Failure('private fee key file required for serve')
        node_version = shared.run([str(self.args.node), '--version'], self.env, 'pinned Node version').decode().strip()
        require(node_version == 'v' + (ROOT / '.node-version').read_text().strip(), 'pinned Node version required')
        bridge = ROOT / 'packages/sdk/src/challenger-cli.ts'
        tree_hash = shared.digest(self.args.tree_pk)
        require(tree_hash == hash64(manifest['tree_proof_artifacts']['pk_hash']), 'tree proving key pin mismatch')
        identity = {'schema': 1, 'backend': str(self.args.backend), 'backend_identity': self.backend_identity,
                    'postgres_system_identifier': self.cluster['system_identifier'],
                    'start_slot': start_slot, 'payer': payer, 'tree_pk_sha256': tree_hash,
                    'bridge_sha256': shared.digest(bridge), 'node_version': node_version}
        identity_path = self.out / 'identity.json'
        journal_file = self.journal / 'journal.json'
        initialized = identity_path.exists() or identity_path.is_symlink()
        if initialized:
            require(read_private(identity_path) == identity, 'persistent challenger identity mismatch')
            existing_directory(self.journal)
            shared.private_file(journal_file)
        else:
            require(set(p.name for p in self.out.iterdir()) <= {'launcher.lock'},
                    'partial or lost challenger identity requires explicit recovery')
        self.inspect_database()
        self.provision_reader()
        self.stage = 'native_configuration'
        if not self.args.no_build:
            build = ['cargo','build','--locked','--manifest-path','services/challenger/Cargo.toml',
                     '--bin','challengerd']
            if self.args.release:
                build.append('--release')
            shared.run(build, self.env, 'challenger build', timeout=900)
        dsn = f'host={self.socket} port={self.pg_port} user={READER} dbname=postgres\n'
        shared.save(self.out / 'reader.dsn', dsn.encode(), immutable=True)
        config = {'manifest':str(manifest_path),'manifest_sha256':manifest['manifest_hash'],'devnet':devnet,
                  'rpc_url':endpoint,'database_dsn_file':str(self.out / 'reader.dsn'),'start_slot':start_slot,
                  'journal_directory':str(self.journal),'tree_pk':str(self.args.tree_pk),'node':str(self.args.node),
                  'transport_bridge':str(bridge),'transport_bridge_sha256':identity['bridge_sha256'],
                  'fee_key_file':str(self.args.fee_key_file),'payer':payer,'poll_seconds':2,
                  'alert_sink_directory':str(self.out / 'alerts'),'priority_fee':None}
        shared.save(self.out / 'config.json', config)
        # Both native commands validate public pins; neither reads DB, fee key,
        # prover key, nor calls RPC. Existing state is always opened, never init'd.
        shared.run([str(self.binary),'status' if initialized else 'init',str(self.out / 'config.json')],
                   self.env, 'native challenger offline validation')
        shared.private_file(journal_file)
        shared.save(identity_path, identity, immutable=True)
        self.report.update(status='prepared', identity=identity, reader_role=READER,
                           database_transport='Unix SELECT-only', native_configuration_validated=True,
                           journal_initialized=True, binary_sha256=shared.digest(self.binary),
                           source_sha256={str(path.relative_to(ROOT)):shared.digest(path) for path in
                               [Path(__file__).resolve(),ROOT/'scripts/run_i10_devnet_backend.py',
                                ROOT/'services/challenger/src/runtime.rs',ROOT/'services/challenger/src/lib.rs',
                                ROOT/'services/challenger/src/journal.rs',ROOT/'services/challenger/src/scan.rs',
                                ROOT/'services/challenger/src/shutdown.rs',ROOT/'services/challenger/Cargo.toml',
                                ROOT/'services/challenger/src/read_model.rs',ROOT/'services/control/src/config.rs']})
        self.record()

    def log(self, value):
        with self.log_lock:
            if self.log_file is not None:
                self.log_file.write(json.dumps({'at_utc':shared.now(),**value},separators=(',',':'))+'\n')
                self.log_file.flush()

    def collect(self, stream, stderr=False):
        try:
            while True:
                line=stream.readline(65_537)
                if not line:
                    break
                metric = None if stderr or len(line)>65_536 else sanitized_metric(line)
                if metric is None:
                    with self.log_lock:
                        self.report['child_output_withheld'] += 1
                    self.log({'event':'child_output_withheld','stream':'stderr' if stderr else 'stdout'})
                else:
                    self.log({'event':'metrics','metrics':metric})
        except (OSError,ValueError):
            self.log({'event':'log_stream_unavailable'})
        finally:
            stream.close()

    def serve(self):
        self.stage=self.args.mode
        self.inspect_database()
        path=self.out/'runtime-log.jsonl'
        if path.exists() or path.is_symlink():
            shared.private_file(path)
        self.log_file=path.open('a',encoding='utf8')
        command = 'scan' if self.args.mode == 'scan' else 'run'
        self.child=subprocess.Popen([str(self.binary),command,str(self.out/'config.json')],cwd=ROOT,
            env=self.env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        for stream,stderr in [(self.child.stdout,False),(self.child.stderr,True)]:
            thread=threading.Thread(target=self.collect,args=(stream,stderr),daemon=True)
            thread.start();self.threads.append(thread)
        self.report.update(status='running',public_network_enabled=True,
                           transaction_send_enabled=self.args.mode == 'serve',
                           maximum_runtime_seconds=self.args.max_seconds)
        self.record();self.log({'event':'started'})
        deadline=time.monotonic()+self.args.max_seconds
        while not self.stop_requested and time.monotonic()<deadline:
            status=self.child.poll()
            if status is not None and self.args.mode == 'scan':
                require(status == 0,'native challenger scan failed; journal retained')
                health=read_private(self.journal/'health.json')
                require(health.get('ready') is True and health.get('pool')==self.backend_identity['pool'],
                        'native scan did not publish ready health')
                self.report.update(status='scanned',stop_reason='scan_completed',read_only_scan_completed=True,
                                   finalized_slot=health['metrics']['finalized_slot'])
                return
            require(status is None, 'native challenger exited; journal retained')
            time.sleep(0.2)
        self.report['stop_reason']='signal' if self.stop_requested else 'bounded_runtime_expired'
        require(self.args.mode!='scan','scan interrupted or deadline exceeded; archive retained')

    def close(self):
        clean=True
        reasons=[]
        started=time.monotonic()
        if self.child is not None:
            try:
                # Native latches this before startup. Read-only waits stop;
                # bridge supervision kills/reaps its owned child while retaining
                # exact durable Unknown attempts. The group remains a fallback.
                if self.child.poll() is None:
                    self.child.send_signal(signal.SIGINT)
                    self.child.wait(timeout=STOP_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                clean=False
                reasons.append('native_stop_timeout')
            except OSError:
                clean=False
                reasons.append('native_stop_error')
            try:
                # Also catch a descendant surviving an already exited parent.
                os.killpg(self.child.pid,signal.SIGKILL)
                clean=False
                reasons.append('remaining_process_group_killed')
            except ProcessLookupError:
                pass
            except OSError:
                clean=False
                reasons.append('process_group_cleanup_error')
            try:
                self.child.wait(timeout=REAP_TIMEOUT_SECONDS)
            except (OSError,subprocess.TimeoutExpired):
                clean=False
                reasons.append('native_reap_failed')
            code=self.child.poll()
            self.report['native_exit_code']=code
            if code != 0:
                clean=False
                reasons.append('native_exit_not_zero')
        for thread in self.threads:
            thread.join(timeout=2)
            if thread.is_alive():
                clean=False
                reasons.append('log_reader_did_not_stop')
        self.report['shutdown_reasons']=reasons
        self.report['shutdown_milliseconds']=round((time.monotonic()-started)*1000)
        try:
            self.log({'event':'stopped','clean_shutdown':clean,'reasons':reasons,
                      'native_exit_code':self.report.get('native_exit_code')})
            if self.log_file is not None:
                self.log_file.close()
        except (OSError,ValueError):
            clean=False
            reasons.append('shutdown_log_failed')
        self.report['clean_shutdown']=clean
        if self.report['status']=='running':
            self.report['status']='stopped'
        try:
            self.record()
        except (OSError,Failure):
            clean=False
            self.report['clean_shutdown']=False
        return clean


def arguments(argv=None):
    parser=argparse.ArgumentParser(description=__doc__,formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('mode',nargs='?',default='prepare',choices=('prepare','scan','serve'))
    parser.add_argument('--deployment',type=Path,required=True)
    parser.add_argument('--backend',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--fee-key-file',type=Path,required=True)
    parser.add_argument('--payer',help='Public fee payer; defaults to deployment initializer')
    parser.add_argument('--node',type=Path,default=Path(os.environ.get('ZKAPI_NODE',ROOT/'target/i08-toolchain/bin/node')))
    parser.add_argument('--tree-pk',type=Path,default=ROOT/'target/i09-challenger/test-tree.pk')
    parser.add_argument('--max-seconds',type=int,default=900)
    parser.add_argument('--no-build',action='store_true')
    parser.add_argument('--release',action='store_true',help='Use/build the optimized release challenger; default is debug')
    args=parser.parse_args(argv)
    for name in ('deployment','backend','output','fee_key_file','node','tree_pk'):
        path=getattr(args,name).absolute()
        if name in ('backend','output'):
            require(not path.is_symlink(),'private state directory cannot be a symlink')
        # Keep the final fee-key component for lstat: never follow a key symlink.
        setattr(args,name,path if name=='fee_key_file' else path.resolve())
    require(args.output != args.backend and args.output != args.deployment,'separate challenger output directory required')
    require(1<=args.max_seconds<=3600,'bounded runtime must be between 1 and 3600 seconds')
    return args


def main():
    os.umask(0o077)
    runner=None
    try:
        args=arguments()
        shared.private_directory(args.output)
        lock_path=args.output/'launcher.lock'
        if lock_path.exists() or lock_path.is_symlink():
            shared.private_file(lock_path)
        with lock_path.open('a') as lock:
            try:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                raise Failure('another challenger launcher owns this output') from None
            runner=Challenger(args)
            signal.signal(signal.SIGINT,lambda *_:setattr(runner,'stop_requested',True))
            signal.signal(signal.SIGTERM,lambda *_:setattr(runner,'stop_requested',True))
            try:
                runner.prepare()
                if args.mode in ('scan','serve') and not runner.stop_requested:
                    runner.serve()
            except BaseException:
                runner.report.update(status='failed',failure_stage=runner.stage)
                raise
            finally:
                clean=runner.close()
            require(clean,'challenger shutdown needs recovery; journal retained')
        print(json.dumps({'status':runner.report['status'],'report':str(args.output/'runtime-report.json')}))
        return 0
    except Exception as error:
        print(str(error) if isinstance(error,Failure) else 'challenger preparation/runtime failed; private state retained',file=sys.stderr)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
