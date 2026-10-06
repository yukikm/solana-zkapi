#!/usr/bin/env python3
"""Offline integration check: existing public devnet artifacts + fresh local PG only.
Never reads a user key or calls RPC. Does not alter existing backend/fixtures."""
import argparse, importlib.util, json, os, pathlib, sys, tempfile, traceback, subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
import run_i10_devnet_backend as backend
import run_i10_devnet_challenger as launcher
os.umask(0o077)
os.environ['SOLANA_DEVNET_RPC']='https://primary.invalid'
os.environ['SOLANA_DEVNET_SECONDARY_RPC']='https://secondary.invalid'
tmp=tempfile.TemporaryDirectory(prefix='i10-ch-',dir='/tmp')
p=pathlib.Path(tmp.name).resolve()
backend.private_directory(p/'backend')
args=argparse.Namespace(output=p/'backend',deployment=ROOT/'target/i10-devnet-vault',program=ROOT/'target/i10-devnet-sbf/zkapi_vault.so',env_file=p/'no-env-file',indexer='http://127.0.0.1:18883',port=19887,pg_port=55496,local_adapter=True,no_build=True,mode='check-local',allow_legacy_devnet_fixtures=True)
b=backend.Backend(args)
results=[]
try:
 b.prepare();b.start_local()
 fee=p/'fee-path-never-read.json';fee.write_text('not a key')
 common=['prepare','--deployment',str(args.deployment),'--backend',str(args.output),'--output',str(p/'challenger'),'--fee-key-file',str(fee),'--no-build']
 a=launcher.arguments(common)
 backend.private_directory(a.output)
 def prepare():
  c=launcher.Challenger(a)
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
 release_args=launcher.arguments(common+['--release'])
 release=launcher.Challenger(release_args)
 assert release.binary==ROOT/'services/challenger/target/release/challengerd'
 try:release.prepare()
 finally:release.close()
 assert release.report['build_profile']=='release'
 assert release.report['binary_sha256']==backend.digest(release.binary)
 assert {'services/challenger/src/journal.rs','services/challenger/src/scan.rs'}<=set(release.report['source_sha256'])
 results.append('explicit_release_selection_and_actual_binary_source_hashes')
 c=launcher.Challenger(a)
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
 print(json.dumps({'passed':True,'checks':results,'scope':'disposable local PG and native init/status only; no network or fee key read'}))
finally:
 pathlib.Path.read_bytes=original if 'original' in locals() else pathlib.Path.read_bytes
 assert b.close()
 tmp.cleanup()
