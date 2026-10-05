"""Synthetic local child/log checks; no provider, database, config or RPC reads."""
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest

import run_i10_devnet_backend as backend


class PrivateControlDiagnostics(unittest.TestCase):
    def test_real_child_stderr_is_private_and_appends_across_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / 'fixture-control'
            binary.write_text('#!' + sys.executable + '\nimport sys\nsys.stderr.write(\'{"event":"provider_dispatch","http_status":502}\\n\')\n')
            binary.chmod(0o700)
            for _ in range(2):
                child = backend.start_control_process(binary, root / 'absent-config', root, {})
                self.assertEqual(child.wait(timeout=10), 0)
            log = root / 'control.stderr.log'
            self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)
            self.assertEqual(log.read_text().splitlines(), ['{"event":"provider_dispatch","http_status":502}'] * 2)

    def test_nonprivate_symlink_hardlink_and_fifo_logs_are_refused_before_spawn(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); log = root / 'control.stderr.log'
            log.write_text('retained'); log.chmod(0o644)
            with self.assertRaises(backend.Failure): backend.start_control_process(root / 'missing', root / 'missing', root, {})
            self.assertEqual(log.read_text(), 'retained')
            log.unlink(); target = root / 'target'; target.write_text('retained'); target.chmod(0o600)
            log.symlink_to(target)
            with self.assertRaises(OSError): backend.start_control_process(root / 'missing', root / 'missing', root, {})
            self.assertEqual(target.read_text(), 'retained')
            log.unlink(); os.link(target, log)
            with self.assertRaises(backend.Failure): backend.start_control_process(root / 'missing', root / 'missing', root, {})
            self.assertEqual(target.read_text(), 'retained')
            log.unlink(); os.mkfifo(log, 0o600)
            with self.assertRaises(OSError): backend.start_control_process(root / 'missing', root / 'missing', root, {})


if __name__ == '__main__':
    unittest.main()
