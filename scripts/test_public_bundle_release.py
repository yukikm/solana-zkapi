import json
from pathlib import Path
import tempfile
import unittest
from check_public_bundle_release import check, sha


class PublicBundleReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bundle = self.root / 'public'
        self.bundle.mkdir()
        files = {}
        for name in ('requestPk.bin', 'NOTICE.txt'):
            data = name.encode()
            (self.bundle / name).write_bytes(data)
            files[name] = {'sha256': sha(data), 'bytes': len(data)}
        raw = json.dumps({'schema': 1, 'files': files}).encode()
        (self.bundle / 'bundle.json').write_bytes(raw)
        self.pin = sha(raw)
        self.review = {'schema': 1, 'bundle_sha256': self.pin, 'reviewer': 'Fixture reviewer',
                       'reviewed_at': '2026-10-07', 'files': {}}
        for name in ('bundle.json', *files):
            self.review['files'][name] = {'sha256': sha((self.bundle / name).read_bytes()), 'decision': 'approved',
                'source': 'https://source.example.com/pinned/file', 'terms': 'https://source.example.com/pinned/LICENSE',
                'notices': ['NOTICE.txt']}
        self.review_path = self.root / 'review.json'

    def run_check(self):
        self.review_path.write_text(json.dumps(self.review))
        return check(self.bundle, self.review_path, self.pin)

    def test_exact_review_records_pass_without_claiming_legal_or_live_acceptance(self):
        result = self.run_check()
        self.assertEqual(result['public_files'], 3)
        self.assertFalse(result['legal_sufficiency_verified'])
        self.assertFalse(result['published'])

    def test_unresolved_or_missing_file_decision_refuses_publication(self):
        self.review['files']['requestPk.bin']['decision'] = 'unresolved'
        with self.assertRaises(ValueError): self.run_check()
        del self.review['files']['requestPk.bin']
        with self.assertRaises(ValueError): self.run_check()

    def test_changed_bytes_or_wrong_bundle_pin_refused(self):
        (self.bundle / 'requestPk.bin').write_bytes(b'changed')
        with self.assertRaises(ValueError): self.run_check()

    def test_unlisted_private_material_and_symlink_refused(self):
        (self.bundle / 'private.json').write_bytes(b'{}')
        with self.assertRaises(ValueError): self.run_check()
        (self.bundle / 'private.json').unlink()
        (self.bundle / 'requestPk.bin').unlink()
        (self.bundle / 'requestPk.bin').symlink_to(self.bundle / 'NOTICE.txt')
        with self.assertRaises(ValueError): self.run_check()

    def test_unretrievable_notices_or_credential_urls_refused(self):
        self.review['files']['requestPk.bin']['notices'] = ['missing.txt']
        with self.assertRaises(ValueError): self.run_check()
        self.review['files']['requestPk.bin']['notices'] = []
        self.review['files']['requestPk.bin']['terms'] = 'https://user:secret@example.com/LICENSE'
        with self.assertRaises(ValueError): self.run_check()

    def descriptor(self, schema, notices):
        raw = json.loads((self.bundle / 'bundle.json').read_bytes())
        raw['schema'] = schema
        raw['notices'] = notices
        self.write_descriptor(raw)

    def write_descriptor(self, raw):
        encoded = json.dumps(raw).encode()
        (self.bundle / 'bundle.json').write_bytes(encoded)
        self.pin = sha(encoded)
        self.review['bundle_sha256'] = self.pin
        self.review['files']['bundle.json']['sha256'] = self.pin

    def test_schema_two_notice_hashes_and_review_records_are_required(self):
        self.descriptor(2, {'license': 'NOTICE.txt'})
        self.assertTrue(self.run_check()['passed'])
        (self.bundle / 'NOTICE.txt').write_bytes(b'changed notice')
        with self.assertRaises(ValueError): self.run_check()

    def test_schema_one_does_not_silently_accept_notice_extension(self):
        self.descriptor(1, {'license': 'NOTICE.txt'})
        with self.assertRaises(ValueError): self.run_check()

    def test_schema_two_notice_paths_duplicates_and_count_are_bounded(self):
        for notices in ({}, {'license': '../NOTICE.txt'}, {'../license': 'NOTICE.txt'},
                        {'a': 'NOTICE.txt', 'b': 'NOTICE.txt'}, {'license': 'missing.txt'},
                        {f'n{i}': 'NOTICE.txt' for i in range(33)}):
            self.descriptor(2, notices)
            with self.assertRaises(ValueError): self.run_check()

    def test_schema_two_notice_size_and_core_collision_refused(self):
        self.descriptor(2, {'license': 'NOTICE.txt'})
        raw = json.loads((self.bundle / 'bundle.json').read_bytes())
        for mutate in (
                lambda d: d['files']['NOTICE.txt'].update(bytes=1024 * 1024 + 1),
                lambda d: d.update(manifest='NOTICE.txt'),
                lambda d: d.update(wasm={'path': 'NOTICE.txt'}),
                lambda d: d.update(artifacts={'additional': {'source': 'NOTICE.txt'}}),
                lambda d: d.update(wasm=[])):
            candidate = json.loads(json.dumps(raw))
            mutate(candidate)
            self.write_descriptor(candidate)
            with self.assertRaises(ValueError): self.run_check()

    def test_schema_two_total_notice_size_is_bounded(self):
        raw = json.loads((self.bundle / 'bundle.json').read_bytes())
        raw.update(schema=2, notices={f'n{i}': f'n{i}.txt' for i in range(5)})
        raw['files'].update({name: {'bytes': 1024 * 1024, 'sha256': '00' * 32}
                             for name in raw['notices'].values()})
        self.write_descriptor(raw)
        with self.assertRaises(ValueError): self.run_check()


if __name__ == '__main__':
    unittest.main()
