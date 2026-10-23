"""Exercise report collection with a synthetic child, without proof or SBF execution."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import run_i10_vault_regression as runner


class ReportCollectionTests(unittest.TestCase):
    def run_synthetic_child(self, source_report='fresh'):
        with tempfile.TemporaryDirectory(prefix='zkapi-regression-wrapper-') as temporary:
            root = Path(temporary)
            originals = {}
            for name in runner.EVIDENCE_OUTPUTS:
                path = root / 'docs/evidence' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                originals[path] = ('historical ' + name).encode()
                path.write_bytes(originals[path])
                os.utime(path, ns=(1, 1))
            for name in runner.ARTIFACTS:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'synthetic artifact')

            def child(*_args, **_kwargs):
                for name, source in runner.FRESH_REPORTS.items():
                    if name == 'source-reproducibility.json' and source_report == 'missing':
                        continue
                    path = root / source
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(json.dumps({'synthetic': name}))
                    timestamp = 1 if name == 'source-reproducibility.json' and source_report == 'stale' else time.time_ns()
                    os.utime(path, ns=(timestamp, timestamp))
                process = mock.Mock()
                process.wait.return_value = 0
                process.returncode = 0
                return process

            output = root / 'target/i10-vault-regression'
            with mock.patch.object(runner, 'ROOT', root), \
                    mock.patch.object(runner, 'OUT', output), \
                    mock.patch.object(runner, 'source_snapshot', return_value={'synthetic': 'unchanged'}), \
                    mock.patch.object(runner, 'stop_process_group', return_value={'group_gone': True}), \
                    mock.patch.object(runner.subprocess, 'Popen', side_effect=child), \
                    mock.patch.object(runner.signal, 'signal'), \
                    redirect_stdout(io.StringIO()):
                code = runner.main()
            report = json.loads((output / 'runtime-report.json').read_text())
            for path, content in originals.items():
                self.assertEqual(path.read_bytes(), content)
            self.assertTrue(report['historical_evidence_preserved'])
            if source_report != 'missing':
                saved = root / report['fresh_reports']['source-reproducibility.json']['path']
                self.assertEqual(json.loads(saved.read_text()), {'synthetic': 'source-reproducibility.json'})
            return code, report

    def test_fresh_target_report_passes_without_rewriting_historical_source_report(self):
        code, report = self.run_synthetic_child()
        self.assertEqual(code, 0)
        self.assertTrue(report['passed'])
        self.assertEqual(set(report['fresh_reports']), set(runner.FRESH_REPORTS))

    def test_missing_target_report_fails(self):
        code, report = self.run_synthetic_child('missing')
        self.assertEqual(code, 1)
        self.assertFalse(report['passed'])

    def test_stale_target_report_fails(self):
        code, report = self.run_synthetic_child('stale')
        self.assertEqual(code, 1)
        self.assertFalse(report['passed'])
        self.assertFalse(report['fresh_reports']['source-reproducibility.json']['written_during_run'])

    def test_source_snapshot_covers_archive_builder_and_lock_inputs(self):
        snapshot = runner.source_snapshot()
        for name in ('scripts/build_i02_source.sh', 'scripts/check_i02_source_lock.py',
                     'tests/fixtures/layout2/source/Cargo.lock', 'Cargo.lock'):
            with self.subTest(path=name):
                self.assertIn(name, snapshot)


if __name__ == '__main__':
    unittest.main()
