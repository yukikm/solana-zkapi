#!/usr/bin/env python3
"""Run current-code I04 regression, restoring only its three historical outputs.

Fresh reports and original-byte backups remain under a unique target directory.
The child process group must stop before any historical evidence is restored.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i10-vault-regression'
EVIDENCE_OUTPUTS = (
    'I02B-reproducibility.json',
    'I04-buffer-svm-results.json',
    'I04-summary.json',
)
ARTIFACTS = (
    'target/i04-sbf/zkapi_vault.so', 'target/i04-sbf-wrong/zkapi_vault.so',
    'target/i04/sdk-svm-history.json', 'target/i04/indexer-results.json',
)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def interrupted(signum, _frame):
    raise InterruptedError(f'regression wrapper received signal {signum}')


def source_snapshot():
    """Guard the runner and its build/test sources, excluding generated targets."""
    paths = {
        ROOT / name for name in (
            'scripts/run_i10_vault_regression.py', 'scripts/run_i04.sh',
            'scripts/check_upstream.py', 'scripts/check_i02_reproducibility.py',
            'scripts/check_i04_results.py', 'scripts/check_vault_idl.py',
            'scripts/test_check_vault_idl.py', 'package.json', 'package-lock.json',
            'rust-toolchain.toml', 'docs/contracts/zkapi_vault.json',
        )
    }
    for name in ('programs/zkapi-vault', 'crates', 'services/indexer',
                 'tests/svm', 'tools/vault-idl', 'packages/sdk'):
        for directory, dirs, files in os.walk(ROOT / name):
            dirs[:] = [d for d in dirs if d not in ('target', 'node_modules', '.git')]
            for filename in files:
                path = Path(directory) / filename
                if path.suffix in ('.rs', '.ts', '.json', '.toml', '.lock'):
                    paths.add(path)
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(paths) if p.is_file()}


def group_exists(pid):
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop_process_group(process):
    """Also kill descendants if the shell exited while they were still alive."""
    result = {'term_sent': False, 'kill_sent': False, 'parent_reaped': False,
              'group_gone': False}
    if group_exists(process.pid):
        try:
            os.killpg(process.pid, signal.SIGTERM)
            result['term_sent'] = True
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while group_exists(process.pid) and time.monotonic() < deadline:
            process.poll()
            time.sleep(0.05)
        if group_exists(process.pid):
            try:
                os.killpg(process.pid, signal.SIGKILL)
                result['kill_sent'] = True
            except ProcessLookupError:
                pass
    process.wait(timeout=5)
    result['parent_reaped'] = True
    deadline = time.monotonic() + 2
    while group_exists(process.pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    result['group_gone'] = not group_exists(process.pid)
    return result


def restore(path, content, mode):
    if content is None:
        path.unlink(missing_ok=True)
        return
    if path.is_file() and path.read_bytes() == content:
        return
    # Atomic replacement avoids truncating history if restoration is interrupted.
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.i10-restore-', delete=False) as output:
        temporary = Path(output.name)
        try:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
            os.chmod(temporary, mode)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    OUT.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='run-', dir=OUT))
    originals = {}
    process = None
    report = {
        'passed': False,
        'scope': 'fresh current-code I04 local Vault/SDK/indexer regression, historical report bytes preserved',
        'release_gates_passed': [],
        'started_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'argv': ['bash', 'scripts/run_i04.sh'], 'timeout_seconds': 1800,
        'fresh_reports': {}, 'historical_outputs': list(EVIDENCE_OUTPUTS),
        'run_directory': str(directory.relative_to(ROOT)), 'errors': [],
    }
    start = time.monotonic()
    start_ns = time.time_ns()
    log = directory / 'runtime.log'
    log.touch()
    try:
        backups = directory / 'historical-originals'
        backups.mkdir()
        for name in EVIDENCE_OUTPUTS:
            path = ROOT / 'docs/evidence' / name
            content = path.read_bytes() if path.is_file() else None
            mode = path.stat().st_mode & 0o777 if content is not None else None
            originals[path] = (content, mode)
            if content is not None:
                (backups / name).write_bytes(content)
        report['source_sha256'] = source_snapshot()
        env = dict(os.environ)
        env['PATH'] = str(ROOT / 'target/toolchains/sbf/bin') + ':' + str(ROOT / 'target/i08-toolchain/bin') + ':/opt/homebrew/opt/gnu-tar/libexec/gnubin:' + env['PATH']
        with log.open('w') as output:
            process = subprocess.Popen(report['argv'], cwd=ROOT, env=env, stdout=output,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            report['exit_code'] = process.wait(timeout=report['timeout_seconds'])
        if report['exit_code'] != 0:
            report['errors'].append({'stage': 'runner', 'exit_code': report['exit_code']})
    except BaseException as error:
        report['errors'].append({'stage': 'runner', 'type': type(error).__name__})
        report['timed_out'] = isinstance(error, subprocess.TimeoutExpired)
        report['interrupted'] = isinstance(error, (KeyboardInterrupt, InterruptedError))
    finally:
        # Finish the bounded cleanup/restoration even after a repeated stop.
        for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(signum, signal.SIG_IGN)
        # Stop descendants BEFORE copying or restoring reports they could write.
        if process is not None:
            try:
                report['process_cleanup'] = stop_process_group(process)
                report.setdefault('exit_code', process.returncode)
                if not report['process_cleanup']['group_gone']:
                    report['errors'].append({'stage': 'cleanup', 'type': 'ProcessGroupStillExists'})
            except BaseException as error:
                report['errors'].append({'stage': 'cleanup', 'type': type(error).__name__})
                # Retry a hard stop even if graceful cleanup was interrupted.
                try:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)
                except BaseException as retry_error:
                    report['errors'].append({'stage': 'cleanup_retry', 'type': type(retry_error).__name__})
        for path, (content, mode) in originals.items():
            try:
                if path.is_file():
                    saved = directory / path.name
                    fresh = path.read_bytes()
                    saved.write_bytes(fresh)
                    report['fresh_reports'][path.name] = {
                        'path': str(saved.relative_to(ROOT)), 'sha256': sha(saved),
                        'changed_from_historical': fresh != content,
                        'written_during_run': path.stat().st_mtime_ns >= start_ns,
                    }
            except BaseException as error:
                report['errors'].append({'stage': 'save_report', 'file': path.name, 'type': type(error).__name__})
            finally:
                try:
                    restore(path, content, mode)
                except BaseException as error:
                    report['errors'].append({'stage': 'restore', 'file': path.name, 'type': type(error).__name__})
        try:
            report['historical_evidence_preserved'] = len(originals) == len(EVIDENCE_OUTPUTS) and all(
                (p.is_file() and p.read_bytes() == content) if content is not None else not p.exists()
                for p, (content, _) in originals.items())
            after = source_snapshot()
            before = report.get('source_sha256', {})
            report['changed_sources'] = sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))
            report['sources_unchanged'] = bool(before) and not report['changed_sources']
            report['artifact_sha256'] = {name: sha(ROOT / name) for name in ARTIFACTS if (ROOT / name).is_file()}
            report['log_sha256'] = sha(log)
        except BaseException as error:
            report['errors'].append({'stage': 'verification', 'type': type(error).__name__})
        report['passed'] = (
            report.get('exit_code') == 0 and not report['errors']
            and report.get('historical_evidence_preserved', False)
            and report.get('sources_unchanged', False)
            and len(report.get('artifact_sha256', {})) == len(ARTIFACTS)
            and all(report['fresh_reports'].get(name, {}).get('written_during_run', False)
                    for name in EVIDENCE_OUTPUTS)
        )
        report['elapsed_seconds'] = round(time.monotonic() - start, 3)
        report['finished_at_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        payload = json.dumps(report, indent=2) + '\n'
        (directory / 'runtime-report.json').write_text(payload)
        (OUT / 'runtime-report.json').write_text(payload)
    print(json.dumps({name: report.get(name) for name in
                      ('passed', 'historical_evidence_preserved', 'elapsed_seconds', 'run_directory')}))
    return 0 if report['passed'] else 130 if report.get('interrupted') else 1


if __name__ == '__main__':
    raise SystemExit(main())
