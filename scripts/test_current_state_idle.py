#!/usr/bin/env python3
"""Verify idle RPC costs and monitoring/dashboard state in disposable PostgreSQL.

Requires initdb/pg_ctl/cargo on PATH and the local SBF chain export produced by
scripts/run_i05.sh. Never opens an existing database or public RPC/provider.
Logs remain under ignored target/current-state-idle/.
"""
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "target/current-state-idle"


def main():
    for tool in ("initdb", "pg_ctl", "cargo"):
        if not shutil.which(tool):
            raise SystemExit(f"required tool on PATH: {tool}")
    if not (ROOT / "target/i05/chain.json").is_file():
        raise SystemExit("missing local SBF export; run bash scripts/run_i05.sh first")
    OUT.mkdir(parents=True, exist_ok=True)
    env = {
        k: v for k, v in os.environ.items()
        if not k.startswith("PG")
        and k not in ("DATABASE_URL", "ZKAPI_TEST_DATABASE_URL", "ZKAPI_TEST_SEPARATE_DISPATCHER")
    }
    env["RAYON_NUM_THREADS"] = "4"
    with (OUT / "test.log").open("w") as log:
        def run(args):
            log.write("$ " + " ".join(args) + "\n")
            log.flush()
            subprocess.run(args, cwd=ROOT, env=env, stdout=log, stderr=log, check=True)

        with tempfile.TemporaryDirectory(prefix="zkapi-current-idle-", dir="/tmp") as tmp:
            work = Path(tmp)
            data, sock = work / "data", work / "socket"
            sock.mkdir()
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            run(["initdb", "-D", str(data), "-U", "current_test",
                 "--no-locale", "--encoding=UTF8", "--auth=trust"])
            started = False
            try:
                run(["pg_ctl", "-D", str(data), "-l", str(work / "postgres.log"),
                     "-o", f"-k {sock} -h '' -p {port}", "-w", "start"])
                started = True
                env["ZKAPI_TEST_DATABASE_URL"] = (
                    f"host={sock} port={port} user=current_test dbname=postgres"
                )
                run(["cargo", "test", "--locked", "--manifest-path",
                     "services/control/Cargo.toml", "--test", "provider_http_runtime",
                     "current_state_idle_recovery_and_monitoring_make_zero_rpc_calls",
                     "--", "--ignored", "--nocapture", "--test-threads=1"])
                run(["cargo", "test", "--locked", "--manifest-path",
                     "services/control/Cargo.toml", "--test", "operations_runtime",
                     "dashboard_acl_redaction_and_restore_witness",
                     "--", "--ignored", "--nocapture", "--test-threads=1"])
            finally:
                if started:
                    run(["pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop"])
    print("PASS: idle recovery/monitoring use zero RPC; invalid owner health fails closed; real request checks stay fresh")
    print("PASS: dashboard reports current-state age and independent slot lag without fabricated measurements")
    print(f"Local test log: {OUT / 'test.log'}")


if __name__ == "__main__":
    main()
