import unittest
from pathlib import Path

from check_dispatcher_storage_binding import check_binding


class DispatcherStorageBindingTests(unittest.TestCase):
    def test_current_state_mismatch_and_preserving_original_claims(self):
        config = {'claims_directory': '/srv/zka/dispatcher'}
        migrated = '[Service]\nReadWritePaths=/srv/zka/state-20261021/dispatcher\n'
        with self.assertRaisesRegex(ValueError, 'outside service writable'):
            check_binding(config, [migrated])
        check_binding(config, [migrated, '[Service]\nReadWritePaths=/srv/zka/dispatcher\n'])
        self.assertEqual(config, {'claims_directory': '/srv/zka/dispatcher'})

    def test_reset_prefix_confusion_and_inaccessible_paths_fail(self):
        config = {'claims_directory': '/srv/zka/dispatcher'}
        for unit in ['ReadWritePaths=/srv/zka/dispatch',
                     'ReadWritePaths=/srv/zka\nReadWritePaths=',
                     'ReadWritePaths=/srv/zka\nInaccessiblePaths=-/srv/zka/dispatcher']:
            with self.assertRaises(ValueError):
                check_binding(config, ['[Service]\n' + unit])
        with self.assertRaises(ValueError):
            check_binding({'claims_directory': '/srv/zka/../dispatcher'}, ['[Service]\nReadWritePaths=/srv'])

    def test_published_unit_runs_storage_check_in_service_sandbox(self):
        root = Path(__file__).resolve().parents[1]
        unit = (root / 'deploy/public-devnet/systemd/zka-control.service').read_text()
        check_binding({'claims_directory': '/srv/zka/dispatcher'}, [unit])
        self.assertIn('ExecStartPre=/opt/zkapi/bin/dispatcherd /srv/zka/runtime/dispatcher.json --check-storage', unit)
        self.assertIn('ProtectSystem=strict', unit)
        self.assertIn('User=zka-runtime', unit)


if __name__ == '__main__':
    unittest.main()
