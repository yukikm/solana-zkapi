"""Offline secret-pipe helper regressions; every key/passphrase is synthetic."""
import base64
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('clientd_secrets', Path(__file__).with_name('clientd_secrets.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SecretPipeTests(unittest.TestCase):
    def invoke(self, arguments, prompts):
        output = io.StringIO()
        with patch('sys.argv', ['clientd_secrets', *arguments]), patch.object(module.getpass, 'getpass', side_effect=prompts), contextlib.redirect_stdout(output):
            module.main()
        return json.loads(output.getvalue())

    def test_existing_wallet_seed_goes_only_to_pipe(self):
        with tempfile.TemporaryDirectory() as directory:
            wallet = Path(directory) / 'wallet.json'
            wallet.write_text(json.dumps(list(range(64))))
            wallet.chmod(0o600)
            before = wallet.read_bytes()
            value = self.invoke(['--initialize', '--wallet', str(wallet)], ['fixture passphrase only'] * 2)
            self.assertEqual(base64.b64decode(value['wallet_seed_base64']), bytes(range(32)))
            self.assertTrue(value['initialize_key'])
            self.assertEqual(wallet.read_bytes(), before)

    def test_restart_omits_initialization_and_wallet(self):
        value = self.invoke([], ['fixture passphrase only'])
        self.assertEqual(value, {'passphrase': 'fixture passphrase only'})

    def test_unsafe_wallet_is_rejected_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            wallet = Path(directory) / 'wallet.json'
            wallet.write_text(json.dumps(list(range(64))))
            wallet.chmod(0o644)
            with self.assertRaises(ValueError):
                self.invoke(['--wallet', str(wallet)], ['fixture passphrase only'])

    def test_missing_confirmation_or_short_passphrase_rejected(self):
        with self.assertRaises(ValueError):
            self.invoke(['--initialize'], ['fixture passphrase only', 'different passphrase'])
        with self.assertRaises(ValueError):
            self.invoke([], ['short'])

    def test_terminal_secret_output_refused(self):
        with patch('sys.argv', ['clientd_secrets']), patch('sys.stdout.isatty', return_value=True), self.assertRaises(ValueError):
            module.main()


if __name__ == '__main__':
    unittest.main()
