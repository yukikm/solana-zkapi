#!/usr/bin/env python3
"""Synthetic-only tests; never loads actual public or private evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('redaction', Path(__file__).with_name('check_public_redaction.py'))
redaction = importlib.util.module_from_spec(spec)
spec.loader.exec_module(redaction)


class Checks(unittest.TestCase):
    def test_known_forms_report_only_rule_and_line(self):
        token = 'zkc1.11111111-1111-4111-8111-111111111111.' + 'A' * 43
        text = json.dumps({'raw': token, 'key': 'sk-proj-' + 'B' * 30,
                           'rpc': 'https://public.invalid/?api-key=' + 'C' * 20,
                           'private_key': [1] * 64,
                           'authorization': {'request_id': 'public-id', 'control_secret_hash': 'hash', 'quote_hash': 'hash'}})
        result = redaction.scan_text(text, True)
        rules = {x['rule'] for x in result}
        self.assertTrue({'raw_session_token', 'provider_key', 'url_credential_query', 'secret_field_value', 'raw_authorization_object'} <= rules)
        output = json.dumps(result)
        for sensitive in (token, 'B' * 30, 'C' * 20, 'public-id'):
            self.assertNotIn(sensitive, output)
        self.assertEqual(redaction.scan_text('{malformed', True), [{'line': 1, 'rule': 'invalid_json'}])

    def test_public_hashes_pins_placeholders_are_not_secrets(self):
        value = {'manifest_hash': 'a' * 64, 'wallet_public_key': 'Abcd', 'private_inputs_read': False,
                 'api_key': '[REDACTED]', 'rpc': 'https://api.devnet.solana.com',
                 'source': 'https://example.com/docs?v=2', 'release_gates_passed': []}
        self.assertEqual(redaction.scan_text(json.dumps(value), True), [])
        self.assertEqual(redaction.scan_text('line1\n-----BEGIN PRIVATE KEY-----')[0]['line'], 2)

    def test_inputs_stay_in_public_tree_and_never_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / 'docs/evidence'; base.mkdir(parents=True)
            public = base / 'results.json'; public.write_text('{}')
            private = Path(directory) / '.env'; private.write_text('DO_NOT_READ')
            self.assertEqual(redaction.public_files([str(public)], base), [public])
            with self.assertRaises(ValueError): redaction.public_files([str(private)], base)
            link = base / 'alias.json'; link.symlink_to(private)
            with self.assertRaises(ValueError): redaction.public_files([str(link)], base)
            with self.assertRaises(ValueError): redaction.public_files([str(base)], base)
            link.unlink(); folder = base / 'private-config'; folder.mkdir(); (folder / 'test.json').write_text('{}')
            with self.assertRaises(ValueError): redaction.public_files([str(base)], base)


if __name__ == '__main__':
    unittest.main()
