#!/usr/bin/env python3
"""Disposable local provider processes, private administration and physical WAL failover.
Never contacts an existing database, external provider, KMS or public cluster.
"""
import hashlib,json,os,platform,re,shutil,socket,subprocess,tempfile,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'target/i09-operations';OUT.mkdir(parents=True,exist_ok=True)
ENV={k:v for k,v in os.environ.items() if not k.startswith('PG') and k not in ('DATABASE_URL','ZKAPI_TEST_DATABASE_URL')}
ENV['RAYON_NUM_THREADS']='4'
commands=[];log=OUT/'runtime.log';log.write_text('')
(OUT/'runtime-report.json').unlink(missing_ok=True)
def run(args,capture=False):
    commands.append(args);p=subprocess.run(args,cwd=ROOT,env=ENV,capture_output=True,text=True)
    with log.open('a') as f:f.write('$ '+' '.join(args)+'\n'+p.stdout+p.stderr)
    if not capture or p.returncode:print(p.stdout+p.stderr,end='',flush=True)
    if p.returncode:raise RuntimeError('command failed: '+args[0])
    return p.stdout.strip()
def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
for tool in ('initdb','pg_ctl','psql','pg_basebackup','cargo'):
    if not shutil.which(tool):raise SystemExit('required tool: '+tool)
started=time.monotonic()
with tempfile.TemporaryDirectory(prefix='zkapi-i09-ops-',dir='/tmp') as tmp:
    work=Path(tmp);primary=work/'primary';replica=work/'replica';psock=work/'psock';rsock=work/'rsock';psock.mkdir();rsock.mkdir();pport=port();rport=port();running=[]
    def sql(text,standby=False):
        return run(['psql','-X','-h',str(rsock if standby else psock),'-p',str(rport if standby else pport),'-U','i09_test','-d','postgres','-v','ON_ERROR_STOP=1','-Atc',text],True)
    try:
        run(['initdb','-D',str(primary),'-U','i09_test','--no-locale','--encoding=UTF8','--auth=trust'],True)
        with (primary/'postgresql.conf').open('a') as f:f.write("\nwal_level=replica\nmax_wal_senders=5\nfsync=on\nfull_page_writes=on\n")
        run(['pg_ctl','-D',str(primary),'-l',str(work/'primary.log'),'-o',f"-k {psock} -h '' -p {pport}",'-w','start'],True);running.append(primary)
        ENV['ZKAPI_TEST_DATABASE_URL']=f'host={psock} port={pport} user=i09_test dbname=postgres'
        pg_version=sql('SHOW server_version')
        run(['cargo','fmt','--manifest-path','services/control/Cargo.toml','--','--check'])
        run(['cargo','test','--locked','--manifest-path','services/control/Cargo.toml','--test','operations_runtime','--','--include-ignored','--nocapture','--test-threads=1'])
        ENV['ZKAPI_TEST_SEPARATE_DISPATCHER']='1'
        run(['cargo','test','--locked','--manifest-path','services/control/Cargo.toml','--test','provider_http_runtime','--','--include-ignored','--nocapture','--test-threads=1'])
        del ENV['ZKAPI_TEST_SEPARATE_DISPATCHER']
        run(['cargo','test','--locked','--manifest-path','services/control/Cargo.toml','--test','signer_process','--','--include-ignored','--nocapture','--test-threads=1'])
        financial_databases=sql("SELECT datname FROM pg_database WHERE datname LIKE 'zkapi_%' OR datname LIKE 'i07_%' ORDER BY datname").splitlines()
        def financial_cut(standby):
            cut={}
            for database in financial_databases:
                table_query=" UNION ALL ".join(f"SELECT '{table}',count(*)::text,COALESCE(md5(string_agg(row_to_json(t)::text,'' ORDER BY row_to_json(t)::text)),'empty') FROM {table} t" for table in ('pools','tariffs','quotes','nullifier_reservations','sessions','operations','dispatch_attempts','settlements','clearances','provider_evidence','receipts','chain_checkpoints','chain_events','chain_transactions','outbox','control_migrations'))
                cut[database]=run(['psql','-X','-h',str(rsock if standby else psock),'-p',str(rport if standby else pport),'-U','i09_test','-d',database,'-v','ON_ERROR_STOP=1','-Atc',table_query],True)
            return cut
        retained_financial_cut=financial_cut(False)
        # Physical base backup plus continuous streaming WAL. The replica is an
        # independent PostgreSQL process; acknowledged writes use remote_apply.
        run(['pg_basebackup','-D',str(replica),'-d',ENV['ZKAPI_TEST_DATABASE_URL']+' application_name=i09_replica','-X','stream','-R','-c','fast'],True)
        run(['pg_ctl','-D',str(replica),'-l',str(work/'replica.log'),'-o',f"-k {rsock} -h '' -p {rport}",'-w','start'],True);running.append(replica)
        sql("ALTER SYSTEM SET synchronous_standby_names='FIRST 1 (i09_replica)'");sql('SELECT pg_reload_conf()')
        deadline=time.monotonic()+15
        while sql("SELECT count(*) FROM pg_stat_replication WHERE application_name='i09_replica' AND state='streaming' AND sync_state='sync'")!='1':
            if time.monotonic()>deadline:raise RuntimeError('synchronous standby unavailable')
            time.sleep(.1)
        sql("SET synchronous_commit='remote_apply'; CREATE TABLE i09_acknowledged (id integer PRIMARY KEY, digest text NOT NULL); INSERT INTO i09_acknowledged VALUES (1,'ack-reservation-one'),(2,'ack-reservation-two');")
        acknowledged_lsn=sql('SELECT pg_current_wal_flush_lsn()')
        assert sql('SELECT count(*) FROM i09_acknowledged',True)=='2'
        # An acknowledgement cannot complete while the configured synchronous
        # replica is unavailable. Timeout is unknown, never retry permission.
        run(['pg_ctl','-D',str(replica),'-m','fast','-w','stop'],True);running.remove(replica)
        stalled=subprocess.Popen(['psql','-X','-h',str(psock),'-p',str(pport),'-U','i09_test','-d','postgres','-v','ON_ERROR_STOP=1','-Atc',"SET synchronous_commit='remote_apply'; INSERT INTO i09_acknowledged VALUES (3,'uncertain-unacknowledged');"],cwd=ROOT,env=ENV,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        time.sleep(.5);assert stalled.poll() is None,'primary-only ACK must not be possible'
        run(['pg_ctl','-D',str(replica),'-l',str(work/'replica.log'),'-o',f"-k {rsock} -h '' -p {rport}",'-w','start'],True);running.append(replica)
        stdout,stderr=stalled.communicate(timeout=20);assert stalled.returncode==0,stderr
        failover_started=time.monotonic()
        run(['pg_ctl','-D',str(primary),'-m','immediate','-w','stop'],True);running.remove(primary)
        # The old primary is terminated before promotion; it is never restarted.
        run(['pg_ctl','-D',str(replica),'-w','promote'],True)
        assert sql('SELECT pg_is_in_recovery()',True)=='f'
        assert sql('SELECT count(*) FROM i09_acknowledged',True)=='3'
        # All financial DBs created by the process suites were also physically
        # replicated. Their migration history is retained in the promoted node.
        db_count=int(sql("SELECT count(*) FROM pg_database WHERE datname LIKE 'zkapi_%' OR datname LIKE 'i07_%'",True));assert db_count>0
        assert financial_cut(True)==retained_financial_cut,'financial state changed during physical restore'
        failover_seconds=round(time.monotonic()-failover_started,3)
        run(['cargo','clippy','--locked','--manifest-path','services/control/Cargo.toml','--all-targets','--','-D','warnings'])
        assert 'I09_PRIVATE_PROMPT_CANARY' not in log.read_text()
        sources=list((ROOT/'services/control/src').rglob('*.rs'))+list((ROOT/'services/control/tests').rglob('*.rs'))+list((ROOT/'services/control/migrations').glob('*.sql'))+[ROOT/'services/control/Cargo.toml',ROOT/'services/control/Cargo.lock',Path(__file__).resolve(),ROOT/'deploy/operations/monitoring.json']
        source={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(sources)}
        counts=re.findall(r'test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;',log.read_text())
        assert len(counts)==3 and all(int(f)==0 and int(i)==0 for _,f,i in counts)
        report={'test_counts':{'passed':sum(int(p) for p,_,_ in counts),'failed':0,'ignored':0},'scope':'local read-only periodic ledger/finalized-RPC/escrow/fee/signer/challenger collector with fail-closed alerts, process dispatcher/admin, real AES-GCM envelopes with fixture KMS helper, real mTLS signer, isolated restore detection, sign-once recovery and synchronous PostgreSQL physical WAL failover; production infrastructure/cloud-KMS/provider gates unverified','passed':True,'commands':commands,'postgres_version':pg_version,'platform':platform.platform(),'acknowledged_flush_lsn':acknowledged_lsn,'acknowledged_rows_lost':0,'primary_only_ack_blocked':True,'physical_financial_databases_replicated':db_count,'physical_financial_rows_verified':True,'fsync':True,'local_failover_seconds':failover_seconds,'elapsed_seconds':round(time.monotonic()-started,3),'source_sha256':source}
        (OUT/'runtime-report.json').write_text(json.dumps(report,indent=2)+'\n')
    finally:
        for data in reversed(running):run(['pg_ctl','-D',str(data),'-m','immediate','-w','stop'],True)
