#!/usr/bin/env python3
"""Historical archive launcher regression with disposable I04/I05/I09 inputs.
Prerequisites: local fixtures, control/debug, challenger/debug + release builds,
the explicit legacy-archive-fixture examples in both profiles, pinned Node, and
PostgreSQL tools in PATH. No user key or RPC. Current config v2 CLI coverage is
in services/challenger/tests/current_cli.rs; no production fallback is enabled.
"""
import argparse, json, os, pathlib, shutil, sys, tempfile, subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import run_i10_devnet_backend as backend
import run_i10_devnet_challenger as launcher

class ArchiveFixtureChallenger(launcher.Challenger):
 def __init__(self,args):
  super().__init__(args)
  # Verify the launcher's build selection, then explicitly substitute the
  # test-only archive entrypoint. The historical launcher emits legacy config.
  assert self.binary==ROOT/'services/challenger/target'/self.profile/'challengerd'
  self.binary=self.binary.parent/'examples/legacy_archive_fixture'
  assert self.binary.is_file(), 'build the explicit legacy-archive-fixture example'
  self.report['native_entrypoint']='legacy_archive_fixture'
  self.report['fixture_source_sha256']=backend.digest(ROOT/'services/challenger/examples/legacy_archive_fixture.rs')

os.umask(0o077)
os.environ['SOLANA_DEVNET_RPC']='https://primary.invalid'
os.environ['SOLANA_DEVNET_SECONDARY_RPC']='https://secondary.invalid'
tmp=tempfile.TemporaryDirectory(prefix='i10-ch-',dir='/tmp')
p=pathlib.Path(tmp.name).resolve()
backend.private_directory(p/'backend')
node=shutil.which('node')
assert node, 'pinned Node required in PATH'
assert subprocess.check_output([node,'--version'],text=True).strip()=='v'+(ROOT/'.node-version').read_text().strip()
os.environ['ZKAPI_NODE']=node  # Pass the already version-checked executable to Backend.
args=argparse.Namespace(output=p/'backend',deployment=p/'deployment',program=p/'deployment/zkapi_vault.so',env_file=p/'no-env-file',indexer='http://127.0.0.1:18883',port=19887,pg_port=55496,local_adapter=True,no_build=True,mode='check-local',allow_legacy_devnet_fixtures=True,provider_state=None,public_devnet_profile=None,public_devnet_profile_sha256=None)
b=backend.Backend(args)
results=[]
try:
 fixture=json.loads(subprocess.check_output([node,str(ROOT/'scripts/i10_devnet_challenger_test_fixture.ts'),str(args.deployment)],cwd=ROOT,text=True))
 assert fixture['offline_fixture'] and fixture['sdk_manifest_signature_verified']
 results.append('isolated_current_artifacts_and_signed_offline_manifest')
 b.prepare();b.start_local()
 fee=p/'fee-path-never-read.json';fee.write_text('not a key')
 common=['prepare','--deployment',str(args.deployment),'--backend',str(args.output),'--output',str(p/'challenger'),'--fee-key-file',str(fee),'--node',node,'--no-build']
 a=launcher.arguments(common)
 backend.private_directory(a.output)
 def prepare():
  c=ArchiveFixtureChallenger(a)
  try:c.prepare()
  finally:c.close()
  return c
 original=pathlib.Path.read_bytes
 def protected(path):
  if path==fee:raise AssertionError('fee key must not be read')
  return original(path)
 pathlib.Path.read_bytes=protected
 prepare();results.append('first_prepare_native_init_and_select_only_role')
 prepare();results.append('repeat_prepare_native_status_preserves_journal')
 # Normal production commands must still reject this historical configuration.
 production=ROOT/'services/challenger/target/debug/challengerd'
 rejected=subprocess.run([str(production),'status',str(a.output/'config.json')],cwd=ROOT,env=b.env,
                         stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 assert rejected.returncode!=0, 'production CLI accepted legacy archive config'
 results.append('production_cli_rejects_legacy_archive_configuration')
 # The actual native parser must continue rejecting a substituted artifact.
 idl=args.deployment/'vault-idl.json';saved_idl=idl.read_bytes();idl.write_bytes(saved_idl+b' ')
 try:
  subprocess.run([str(ROOT/'services/challenger/target/debug/examples/legacy_archive_fixture'),'status',str(a.output/'config.json')],cwd=ROOT,env=b.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True)
  raise AssertionError('native trust accepted substituted IDL bytes')
 except subprocess.CalledProcessError:results.append('actual_native_rejects_substituted_idl_hash')
 finally:idl.write_bytes(saved_idl)
 release_args=launcher.arguments(common+['--release'])
 release=ArchiveFixtureChallenger(release_args)
 assert release.binary==ROOT/'services/challenger/target/release/examples/legacy_archive_fixture'
 try:release.prepare()
 finally:release.close()
 assert release.report['build_profile']=='release'
 assert release.report['binary_sha256']==backend.digest(release.binary)
 assert {'services/challenger/src/journal.rs','services/challenger/src/scan.rs'}<=set(release.report['source_sha256'])
 results.append('explicit_release_selection_and_actual_binary_source_hashes')
 c=ArchiveFixtureChallenger(a)
 c.prepare()
 try:
  c.sql('BEGIN; SET TRANSACTION READ WRITE; UPDATE public.pools SET accepting=accepting WHERE false; ROLLBACK',reader=True)
  raise AssertionError('reader obtained write authority')
 except backend.Failure:results.append('actual_reader_rejects_write_even_readonly_default_disabled')
 c.close()
 journal=a.output/'journal/journal.json';saved=journal.read_bytes();journal.unlink()
 try:
  prepare();raise AssertionError('missing journal accepted')
 except (FileNotFoundError,backend.Failure):results.append('missing_journal_refused')
 journal.write_bytes(saved)
 cluster=args.output/'cluster.json';value=json.loads(cluster.read_bytes());changed=dict(value);changed['system_identifier']=str(int(value['system_identifier'])+1);backend.save(cluster,changed)
 try:
  prepare();raise AssertionError('different cluster accepted')
 except backend.Failure:results.append('substituted_cluster_pin_refused')
 backend.save(cluster,value)
 identity=a.output/'identity.json';saved=identity.read_bytes();identity.unlink()
 try:
  prepare();raise AssertionError('lost identity accepted')
 except backend.Failure:results.append('lost_identity_refused')
 identity.write_bytes(saved)
 prepare();results.append('restored_identity_and_journal_reopen')
 saved_backend_identity=(args.output/'identity.json').read_bytes()
 bad=json.loads(saved_backend_identity);bad['manifest_hash']='00'*32
 backend.save(args.output/'identity.json',bad)
 try:
  prepare();raise AssertionError('manifest identity changed')
 except backend.Failure:results.append('changed_manifest_identity_refused')
 (args.output/'identity.json').write_bytes(saved_backend_identity)
 saved_cluster=cluster.read_bytes();cluster.unlink()
 try:
  prepare();raise AssertionError('missing DB identity accepted')
 except FileNotFoundError:results.append('missing_cluster_identity_refused')
 cluster.write_bytes(saved_cluster)
 c=prepare()
 c.sql('GRANT UPDATE ON public.pools TO '+launcher.READER)
 try:
  prepare();raise AssertionError('existing role with write grant accepted')
 except backend.Failure:results.append('existing_excess_reader_authority_refused')
 assert c.sql("SELECT has_table_privilege('"+launcher.READER+"','public.pools','UPDATE')")=='t'
 c.sql('REVOKE UPDATE ON public.pools FROM '+launcher.READER)
 prepare()
 # Child fixture emits a canary instead of any actual RPC or secret.
 fake=p/'fake-challengerd'
 fake.write_text('#!'+sys.executable+'\nimport json,signal,sys,time\n'+
  'signal.signal(signal.SIGINT,lambda *_:sys.exit(0))\n'+
  'print('+repr(json.dumps({k:0 for k in launcher.METRICS}))+',flush=True)\n'+
  "print('private-canary-must-never-be-logged',file=sys.stderr,flush=True)\n"+
  'time.sleep(60)\n')
 fake.chmod(0o700)
 c=prepare();c.binary=fake;c.args.mode='serve';c.args.max_seconds=1
 try:c.serve()
 finally:assert c.close()
 log=(a.output/'runtime-log.jsonl').read_text()
 assert 'private-canary-must-never-be-logged' not in log and '"metrics"' in log
 assert c.child.poll()==0
 results.append('bounded_child_stop_and_sanitized_metrics_log')
 a.mode='prepare'
 assert launcher.sanitized_metric(b'{"rpc":"https://secret.invalid/key"}') is None
 assert launcher.sanitized_metric(json.dumps({k:None for k in launcher.METRICS})) is not None
 results.append('log_allowlist_rejects_unknown_string_fields')
 assert all(backend.digest(ROOT/name)==digest for name,digest in fixture['input_sha256'].items())
 assert all(backend.digest(args.deployment/name)==digest for name,digest in fixture['output_sha256'].items())
 results.append('original_inputs_and_disposable_fixture_pins_unchanged')
 print(json.dumps({'passed':True,'checks':results,'fixture':fixture,'scope':'disposable local PG and explicit legacy archive fixture init/status only; no network or fee key read'}))
finally:
 pathlib.Path.read_bytes=original if 'original' in locals() else pathlib.Path.read_bytes
 assert b.close()
 tmp.cleanup()
