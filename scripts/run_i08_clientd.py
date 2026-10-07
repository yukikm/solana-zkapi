#!/usr/bin/env python3
"""Current-platform clientd runtime, distribution integrity and real Vault checks."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import time

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'target/i08-clientd'
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'runtime-report.json').unlink(missing_ok=True)
(OUT/'distribution-result.json').unlink(missing_ok=True)
GO=os.environ.get('ZKAPI_GO',shutil.which('go') or str(ROOT/'target/toolchains/go/bin/go'))
NODE=os.environ.get('ZKAPI_NODE',shutil.which('node') or '')
commands=[]
env={**os.environ,'GOTOOLCHAIN':'local','ZKAPI_GO':GO,'ZKAPI_NODE':NODE}
def run(name,args):
    start=time.monotonic();p=subprocess.run(args,cwd=ROOT,env=env,text=True,capture_output=True)
    output=p.stdout+p.stderr;(OUT/(name+'.log')).write_text(output);print(output,end='',flush=True)
    commands.append({'argv':args,'exit_code':p.returncode,'seconds':round(time.monotonic()-start,3)})
    p.check_returncode();return output
start=time.monotonic()
node=run('node-version',[NODE,'--version']).strip()
if node!='v'+(ROOT/'.node-version').read_text().strip():raise RuntimeError('pinned Node required')
go=run('go-version',[GO,'version']).strip()
if 'go1.25.0 ' not in go:raise RuntimeError('pinned Go required')
run('gofmt',[str(Path(GO).resolve().with_name('gofmt')),'-l','apps/clientd/cmd','apps/clientd/internal'])
if (OUT/'gofmt.log').read_text().strip():raise RuntimeError('Go formatting changed')
gotests=run('go-tests',[GO,'-C','apps/clientd','test','-race','-count=1','-json','./...'])
rows=[json.loads(x) for x in gotests.splitlines() if x.startswith('{')]
if any(x['Action'] in ['skip','fail'] for x in rows):raise RuntimeError('Go tests failed or skipped')
count=sum(x['Action']=='pass' and 'Test'in x for x in rows)
run('sdk-build',[NODE,'packages/sdk/build.mjs'])
run('runtime-types',[NODE,'node_modules/typescript/bin/tsc','--noEmit','-p','apps/clientd/tsconfig.json'])
sdk=run('client-tests',[NODE,'--test','--test-reporter=tap','packages/sdk/test/clientd.test.ts','packages/sdk/test/control.test.ts'])
if re.search(r'^# (fail|skipped) [1-9]',sdk,re.M):raise RuntimeError('SDK tests failed/skipped')
distribution=OUT/'distribution'
if distribution.exists():shutil.rmtree(distribution) # generated exclusively by this runner
run('distribution',['python3','scripts/build_clientd_distribution.py'])
sbf=run('go-sdk-sbf',[NODE,'--test','--test-reporter=tap','packages/sdk/test/clientd-sbf.ts'])
if '# pass 1'not in sbf or '# fail 0'not in sbf or '# skipped 0'not in sbf:raise RuntimeError('SBF integration not complete')
svm_match=re.search(r'Go→SDK→native→Vault: (\d+) signed tx, max (\d+) CU / (\d+) bytes',sbf)
if not svm_match:raise RuntimeError('actual Vault transaction measurements missing')
svm=dict(zip(['transactions','max_cu','max_transaction_bytes'],map(int,svm_match.groups())))
if svm['max_cu']>1_000_000 or svm['max_transaction_bytes']>1232:raise RuntimeError('actual Vault bounds exceeded')
files=[p for root in ['apps/clientd/cmd','apps/clientd/internal','packages/sdk/src'] for p in (ROOT/root).rglob('*') if p.is_file()]
files += [ROOT/p for p in ['apps/clientd/runtime.ts','apps/clientd/go.mod','apps/clientd/tsconfig.json','scripts/run_i08_clientd.py','scripts/build_clientd_distribution.py','packages/sdk/test/clientd.test.ts','packages/sdk/test/clientd-sbf.ts','package-lock.json']]
report={'passed':True,'scope':'I08 local Go frontend, same encrypted SDK lifecycle, SOCKS5 remote DNS/fail closed, passphrase custody, whole-install hash pin, native proof and actual Vault','date_jst':'2026-10-04','os':platform.platform(),'node':node,'go':go,'commands':commands,'tests':{'go_with_subtests':count,'sdk':int(re.search(r'^# pass (\d+)$',sdk,re.M)[1]),'go_sdk_actual_sbf':1},'elapsed_seconds':round(time.monotonic()-start,3),'artifact_sha256':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()for p in files},'distribution':json.loads((OUT/'distribution-result.json').read_text()),'svm':svm,'release_gates_passed':[],'live_provider':False,'live_tor':False,'public_rpc':False,'production_native_signature':False}
(OUT/'runtime-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':True,'tests':report['tests'],'elapsed_seconds':report['elapsed_seconds']}))
