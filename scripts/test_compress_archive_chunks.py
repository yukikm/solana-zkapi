#!/usr/bin/env python3
"""Synthetic storage conversion tests; no live journal or service actions."""
import gzip
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('compression', Path(__file__).with_name('compress_archive_chunks.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Compression(unittest.TestCase):
    def test_roundtrip_identity_and_repeat(self):
        with tempfile.TemporaryDirectory() as d:
            raw = b'{"retained":"' + b'full-block-payload ' * 4096 + b'"}'
            path = Path(d) / (hashlib.sha256(raw).hexdigest() + '.json')
            path.write_bytes(raw)
            path.chmod(0o600)
            old, new, changed = m.compress_chunk(path)
            self.assertTrue(changed)
            self.assertEqual(old, len(raw))
            self.assertLess(new, old)
            self.assertEqual(m.original_bytes(path.read_bytes()), raw)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(m.compress_chunk(path), (new, new, False))

    def test_corruption_and_symlink_preserve_original(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / ('a' * 64 + '.json')
            path.write_bytes(b'wrong')
            with self.assertRaises(ValueError):
                m.compress_chunk(path)
            self.assertEqual(path.read_bytes(), b'wrong')
            link = Path(d) / ('b' * 64 + '.json')
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                m.compress_chunk(link)
        for raw in [gzip.compress(b'data')[:-1], gzip.compress(b'data') + b'junk', gzip.compress(b'data') * 2]:
            with self.assertRaises((ValueError, EOFError)):
                m.original_bytes(raw)


if __name__ == '__main__':
    unittest.main()
