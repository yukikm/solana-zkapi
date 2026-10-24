#!/usr/bin/env python3
"""Prepare reviewed recovery-only host and CloudFront updates; never deploy them."""
import argparse
import base64
import copy
import gzip
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    'server.mjs': 'services/recovery/server.mjs',
    'store.mjs': 'services/recovery/store.mjs',
    'zka-recovery.service': 'deploy/recovery/zka-recovery.service',
    'recovery.json': 'deploy/recovery/config.example.json',
    'nginx-http.conf': 'deploy/recovery/nginx-http.conf.example',
    'nginx-location.conf': 'deploy/recovery/nginx-location.conf.example',
}

HOST_SCRIPT = r'''
import base64,gzip,hashlib,json,os,pathlib,pwd,shutil,subprocess,tempfile,time
bundle=json.loads(gzip.decompress(base64.b64decode('PAYLOAD')))
def run(*args): return subprocess.check_output(args,text=True).strip()
assert run('/opt/zkapi/node/bin/node','--version')=='v24.22.1'
assert run('findmnt','-no','TARGET','/srv/zka')=='/srv/zka'
assert shutil.disk_usage('/srv/zka').free > 2*1024*1024*1024
assert os.getuid()==0
files={name:base64.b64decode(item['base64']) for name,item in bundle['files'].items()}
for name,data in files.items(): assert hashlib.sha256(data).hexdigest()==bundle['files'][name]['sha256']
release=pathlib.Path('/opt/zkapi/recovery/releases')/bundle['revision']
assert not release.is_symlink()
release.mkdir(parents=True,exist_ok=True,mode=0o755)
for name in ('server.mjs','store.mjs'):
 target=release/name
 if target.exists(): assert not target.is_symlink() and target.read_bytes()==files[name]
 else:
  with target.open('xb') as f: f.write(files[name]); f.flush(); os.fsync(f.fileno())
  target.chmod(0o644)
try: identity=pwd.getpwnam('zka-recovery')
except KeyError:
 subprocess.check_call(['useradd','--system','--home-dir','/nonexistent','--shell','/sbin/nologin','zka-recovery'])
 identity=pwd.getpwnam('zka-recovery')
state=pathlib.Path('/srv/zka/recovery')
assert not state.is_symlink()
if state.exists():
 assert state.is_dir() and state.stat().st_uid==identity.pw_uid and state.stat().st_mode & 0o077==0
else:
 state.mkdir(mode=0o700); os.chown(state,identity.pw_uid,identity.pw_gid)
config_directory=pathlib.Path('/etc/zkapi-recovery')
assert not config_directory.is_symlink()
if config_directory.exists():
 assert config_directory.is_dir() and config_directory.stat().st_uid==0 and config_directory.stat().st_gid==identity.pw_gid and config_directory.stat().st_mode & 0o777==0o750
else:
 config_directory.mkdir(mode=0o750); os.chown(config_directory,0,identity.pw_gid)
config=config_directory/'recovery.json'
if config.exists():
 assert not config.is_symlink() and config.read_bytes()==files['recovery.json']
 assert config.stat().st_uid==0 and config.stat().st_gid==identity.pw_gid and config.stat().st_mode & 0o777==0o640
else:
 with config.open('xb') as f: f.write(files['recovery.json']); f.flush(); os.fsync(f.fileno())
 os.chown(config,0,identity.pw_gid); config.chmod(0o640)
backup=pathlib.Path('/srv/zka/recovery-deploy-backups')/(time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+'-'+bundle['revision'][:12])
backup.mkdir(parents=True,mode=0o700); backup.parent.chmod(0o700)
nginx=pathlib.Path('/etc/nginx/conf.d/zkapi.conf')
original=nginx.read_text()
begin='# BEGIN ZKAPI CLIENT RECOVERY\n'; end='# END ZKAPI CLIENT RECOVERY\n'
if begin in original:
 assert original.count(begin)==1 and original.count(end)==1
 start=original.index(begin); finish=original.index(end,start)+len(end)
 plain=original[:start]+original[finish:]
else:
 assert end not in original
 plain=original
anchor='    location / { return 404; }'
assert plain.count(anchor)==1
proposed=plain.replace(anchor,begin+files['nginx-location.conf'].decode()+end+anchor)
unit=pathlib.Path('/etc/systemd/system/zka-recovery.service')
zones=pathlib.Path('/etc/nginx/conf.d/00-zkapi-recovery-limits.conf')
current=pathlib.Path('/opt/zkapi/recovery/current')
assert not current.exists() or current.is_symlink()
previous=os.readlink(current) if current.is_symlink() else None
was_active=subprocess.run(['systemctl','is-active','--quiet','zka-recovery.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
was_enabled=subprocess.run(['systemctl','is-enabled','--quiet','zka-recovery.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
(backup/'previous-release.json').write_text(json.dumps({'target':previous}))
before={p:p.read_bytes() if p.exists() else None for p in (nginx,unit,zones)}
for path,data in before.items():
 if data is not None: (backup/path.name).write_bytes(data)
def replace(path,data):
 fd,name=tempfile.mkstemp(prefix=path.name+'.',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
  os.chmod(name,0o644); os.replace(name,path)
 finally:
  if os.path.exists(name): os.unlink(name)
def point(target):
 temporary=current.parent/('current.'+str(os.getpid()))
 os.symlink(target,temporary); os.replace(temporary,current)
try:
 replace(unit,files['zka-recovery.service']); replace(zones,files['nginx-http.conf']); replace(nginx,proposed.encode())
 point('releases/'+bundle['revision'])
 subprocess.check_call(['systemd-analyze','verify',str(unit)])
 subprocess.check_call(['nginx','-t'])
 subprocess.check_call(['systemctl','daemon-reload'])
 subprocess.check_call(['systemctl','enable','zka-recovery.service'])
 subprocess.check_call(['systemctl','restart','zka-recovery.service'])
 for attempt in range(20):
  try:
   ready=json.loads(run('curl','--silent','--show-error','--fail','http://127.0.0.1:4176/recovery/v1/health'))
   assert ready=={'ready':True}; break
  except Exception:
   if attempt==19: raise
   time.sleep(0.25)
 subprocess.check_call(['systemctl','reload','nginx'])
except BaseException:
 if not was_enabled: subprocess.run(['systemctl','disable','zka-recovery.service'],check=False)
 for path,data in before.items():
  if data is None: path.unlink(missing_ok=True)
  else: replace(path,data)
 if previous is None: current.unlink(missing_ok=True)
 else: point(previous)
 subprocess.run(['systemctl','daemon-reload'],check=False)
 if was_active: subprocess.run(['systemctl','restart','zka-recovery.service'],check=False)
 else: subprocess.run(['systemctl','stop','zka-recovery.service'],check=False)
 if subprocess.run(['nginx','-t'],check=False).returncode==0: subprocess.run(['systemctl','reload','nginx'],check=False)
 raise
print(json.dumps({'recovery_ready':True,'revision':bundle['revision'],'file_sha256':{name:bundle['files'][name]['sha256'] for name in ('server.mjs','store.mjs')},'backup_directory':str(backup),'financial_services_restarted':False}))
'''


def aws(*arguments):
    return json.loads(subprocess.check_output(['aws', *arguments, '--region', 'us-east-1', '--output', 'json'], text=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-revision', required=True)
    parser.add_argument('--account', required=True)
    parser.add_argument('--distribution', default='E15IZENBVMXFQS')
    parser.add_argument('--instance', default='i-0f4a9f48d2839a39f')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--working-tree-preview', action='store_true', help='Preparation only; output is marked NON_DEPLOYABLE until source is committed')
    args = parser.parse_args()
    revision = subprocess.check_output(['git', 'rev-parse', args.source_revision + '^{commit}'], cwd=ROOT, text=True).strip()
    assert aws('sts', 'get-caller-identity')['Account'] == args.account
    bundle = {'revision': revision, 'files': {}}
    for name, relative in FILES.items():
        data = (ROOT / relative).read_bytes()
        if not args.working_tree_preview:
            committed = subprocess.check_output(['git', 'show', revision + ':' + relative], cwd=ROOT)
            assert data == committed, 'Working bytes differ from the specified commit: ' + relative
        bundle['files'][name] = {'base64': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest()}
    current = aws('cloudfront', 'get-distribution-config', '--id', args.distribution)
    before = current['DistributionConfig']
    api = next(item for item in before['CacheBehaviors']['Items'] if item['PathPattern'] == '/zkapi/v1/*')
    assert api['TargetOriginId'] == 'api'
    policy = aws('cloudfront', 'get-cache-policy', '--id', api['CachePolicyId'])['CachePolicy']['CachePolicyConfig']
    assert all(policy[key] == 0 for key in ('MinTTL', 'DefaultTTL', 'MaxTTL'))
    origin = aws('cloudfront', 'get-origin-request-policy', '--id', api['OriginRequestPolicyId'])['OriginRequestPolicy']['OriginRequestPolicyConfig']
    assert origin['HeadersConfig']['HeaderBehavior'] == 'whitelist'
    assert set(['Authorization', 'Origin', 'Content-Type', 'Access-Control-Request-Method', 'Access-Control-Request-Headers']).issubset(origin['HeadersConfig']['Headers']['Items'])
    desired = copy.deepcopy(api); desired['PathPattern'] = '/recovery/v1/*'
    proposed = copy.deepcopy(before)
    entries = proposed['CacheBehaviors']['Items']
    matching = [item for item in entries if item['PathPattern'] == desired['PathPattern']]
    if matching:
        assert len(matching) == 1 and matching[0] == desired, 'Existing recovery behavior differs; review before replacing'
    else:
        entries.insert(0, desired); proposed['CacheBehaviors']['Quantity'] = len(entries)
    assert [item for item in proposed['CacheBehaviors']['Items'] if item['PathPattern'] != '/recovery/v1/*'] == [item for item in before['CacheBehaviors']['Items'] if item['PathPattern'] != '/recovery/v1/*']
    args.output.mkdir(parents=True, exist_ok=False)
    args.output.chmod(0o700)
    packed = base64.b64encode(gzip.compress(json.dumps(bundle).encode(), mtime=0)).decode()
    host = HOST_SCRIPT.replace('PAYLOAD', packed)
    if args.working_tree_preview:
        host = "raise RuntimeError('NON_DEPLOYABLE working-tree preview: commit reviewed source and prepare again')\n" + host
    parameters = {'commands': ["python3 - <<'ZKAPI_RECOVERY_DEPLOY'\n" + host + "\nZKAPI_RECOVERY_DEPLOY"], 'executionTimeout': ['120']}
    (args.output / 'ssm-parameters.json').write_text(json.dumps(parameters))
    (args.output / 'cloudfront-before.json').write_text(json.dumps(current, indent=2) + '\n')
    (args.output / 'cloudfront-proposed.json').write_text(json.dumps(proposed, indent=2) + '\n')
    report = {'source_revision': revision, 'deployable': not args.working_tree_preview, 'account': args.account, 'instance': args.instance, 'distribution': args.distribution,
              'etag': current['ETag'], 'cloudfront_change_needed': not matching, 'endpoint': 'https://d366buuvadnp3.cloudfront.net/recovery/v1',
              'source_files': {name: item['sha256'] for name, item in bundle['files'].items()}, 'ssm_parameters_bytes': (args.output / 'ssm-parameters.json').stat().st_size}
    (args.output / 'plan.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
