#!/usr/bin/env python3
"""Apply design DDL and exercise constraints in a disposable, socket-only PostgreSQL.
Requires local initdb/pg_ctl/psql. Does not connect to an existing database.
This is a contract smoke test, not the I05/G2 runtime or concurrency test.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
for binary in ("initdb", "pg_ctl", "psql"):
    if not shutil.which(binary):
        raise SystemExit("Missing local PostgreSQL binary: " + binary)

def run(args):
    result = subprocess.run(args, text=True, capture_output=True, env=ENV)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()

# Do not inherit libpq service or remote database configuration.
ENV = {k:v for k,v in os.environ.items() if not k.startswith("PG")}
with tempfile.TemporaryDirectory(prefix="zkapi-ddl-", dir="/tmp") as folder:
    work = Path(folder)
    data, socket = work/"data", work/"sock"
    socket.mkdir()
    started = False
    try:
        run(["initdb", "-D", str(data), "-U", "zkapi_design", "--no-locale", "--encoding=UTF8", "--auth=trust"])
        run(["pg_ctl", "-D", str(data), "-l", str(work/"postgres.log"),
             "-o", f"-F -k {socket} -h '' -p 55491", "-w", "start"])
        started = True
        psql = ["psql", "-X", "-h", str(socket), "-p", "55491", "-U", "zkapi_design",
                "-d", "postgres", "-v", "ON_ERROR_STOP=1"]
        version = run(psql + ["-Atc", "SHOW server_version"])
        run(psql + ["-f", str(ROOT/"docs/contracts/ledger.sql")])
        output = run(psql + ["-f", str(ROOT/"scripts/ledger_contract_checks.sql")])
        print("PASS: design DDL applied to disposable PostgreSQL " + version)
        print(output)
        print("NOT RUN: concurrent service writers, real fencing, signer/provider recovery, G2.")
    finally:
        if started:
            run(["pg_ctl", "-D", str(data), "-m", "immediate", "-w", "stop"])
