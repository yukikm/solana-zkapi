#!/usr/bin/env python3
"""Local Git fixtures for historical evidence binding; no public network used."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import check_evidence as checker


def sha(data):
    return hashlib.sha256(data).hexdigest()


class HistoricalEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / 'repository'
        self.root.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Evidence fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('config', 'core.hooksPath', '/dev/null')
        self.report_path = self.root / 'docs/evidence/implementation-results.json'
        self.report_path.parent.mkdir(parents=True)
        self.artifact = b'original historical source\n' * 6000
        (self.root / 'artifact.txt').write_bytes(self.artifact)
        self.write_report({'artifact.txt': sha(self.artifact)})
        self.source = self.commit('historical source')
        self.write_pin(self.source)

    def git(self, *arguments, root=None):
        environment = checker.git_environment()
        # Only the fixture's explicit local shallow-clone fetch needs transport.
        # The validator retains its empty transport allowlist.
        environment['GIT_ALLOW_PROTOCOL'] = 'file'
        return subprocess.check_output(
            ['git', '-C', str(root or self.root), *arguments],
            stderr=subprocess.DEVNULL, env=environment,
        )

    def commit(self, message):
        self.git('add', '--all')
        self.git('commit', '-q', '-m', message)
        return self.git('rev-parse', 'HEAD').decode().strip()

    def write_report(self, artifacts):
        self.report_path.write_text(json.dumps({'artifact_sha256': artifacts}) + '\n')

    def write_pin(self, source, root=None):
        root = root or self.root
        report = root / 'docs/evidence/implementation-results.json'
        (root / checker.SOURCE_PIN).write_text(json.dumps({
            'schema': 1, 'report_path': report.relative_to(root).as_posix(),
            'report_sha256': sha(report.read_bytes()), 'source_commit': source,
        }) + '\n')

    def state(self):
        files = {p.relative_to(self.root).as_posix(): sha(p.read_bytes())
                 for p in self.root.rglob('*') if p.is_file() and '.git' not in p.parts}
        return (self.git('rev-parse', 'HEAD'), self.git('show-ref'),
                (self.root / '.git/index').read_bytes(), files)

    def test_real_blobs_pass_without_changing_index_head_refs_or_files(self):
        before = self.state()
        result = checker.verify(self.root)
        self.assertEqual(result['artifacts_verified'], 1)
        self.assertEqual(result['source_commit'], self.source)
        self.assertEqual(self.state(), before)

    def test_current_source_changes_and_removal_do_not_relabel_historical_evidence(self):
        (self.root / 'artifact.txt').write_text('current code has changed\n')
        self.assertEqual(checker.verify(self.root)['artifacts_verified'], 1)
        (self.root / 'artifact.txt').unlink()
        self.assertEqual(checker.verify(self.root)['artifacts_verified'], 1)

    def test_corrupt_current_report_fails_even_if_json_is_equivalent(self):
        self.report_path.write_bytes(self.report_path.read_bytes() + b' ')
        with self.assertRaisesRegex(checker.VerificationError, 'report SHA-256 mismatch'):
            checker.verify(self.root)

    def test_repinning_modified_current_report_does_not_bypass_historical_report_join(self):
        self.report_path.write_bytes(self.report_path.read_bytes() + b' ')
        self.write_pin(self.source)
        with self.assertRaisesRegex(checker.VerificationError, 'historical artifact SHA-256 mismatch: docs/'):
            checker.verify(self.root)

    def test_wrong_existing_source_fails_artifact_hash(self):
        (self.root / 'artifact.txt').write_text('different historical bytes\n')
        self.write_pin(self.commit('different source'))
        with self.assertRaisesRegex(checker.VerificationError, 'historical artifact SHA-256 mismatch: artifact.txt'):
            checker.verify(self.root)

    def test_missing_source_commit_is_actionable_and_does_not_fetch(self):
        self.write_pin('1' * 40)
        before = self.state()
        with self.assertRaisesRegex(checker.VerificationError, 'fetch that exact commit.*never uses the network'):
            checker.verify(self.root)
        self.assertEqual(self.state(), before)

    def test_missing_blob_fails_without_current_file_fallback(self):
        object_id = self.git('rev-parse', self.source + ':artifact.txt').decode().strip()
        (self.root / '.git/objects' / object_id[:2] / object_id[2:]).unlink()
        with self.assertRaisesRegex(checker.VerificationError, 'historical Git blob unavailable'):
            checker.verify(self.root)

    def test_path_traversal_and_batch_protocol_injection_are_rejected(self):
        for name in ('../outside', '/absolute', 'a/../artifact.txt', 'a//b',
                     './artifact.txt', 'a\\b', 'artifact.txt\nHEAD', 'a\0b'):
            with self.subTest(name=name):
                self.write_report({name: sha(self.artifact)})
                self.write_pin(self.source)
                with self.assertRaisesRegex(checker.VerificationError, 'repository-relative'):
                    checker.verify(self.root)

    def test_regular_executable_blob_is_supported(self):
        os.chmod(self.root / 'artifact.txt', 0o755)
        self.write_pin(self.commit('executable source'))
        self.assertEqual(checker.verify(self.root)['artifacts_verified'], 1)

    def test_historical_symlink_is_rejected(self):
        (self.root / 'link').symlink_to('artifact.txt')
        self.write_report({'link': sha(b'artifact.txt')})
        self.write_pin(self.commit('symlink is not an artifact'))
        with self.assertRaisesRegex(checker.VerificationError, 'regular Git blob'):
            checker.verify(self.root)

    def test_historical_gitlink_is_rejected(self):
        self.git('update-index', '--add', '--cacheinfo', '160000,' + self.source + ',module')
        self.write_report({'module': sha(b'not a regular file')})
        # git add --all can remove the intentionally index-only gitlink.
        self.git('add', 'docs/evidence/implementation-results.json')
        self.git('commit', '-q', '-m', 'gitlink is not an artifact')
        self.write_pin(self.git('rev-parse', 'HEAD').decode().strip())
        with self.assertRaisesRegex(checker.VerificationError, 'regular Git blob'):
            checker.verify(self.root)

    def test_current_report_symlink_is_rejected(self):
        saved = self.report_path.with_name('saved-report.json')
        self.report_path.rename(saved)
        self.report_path.symlink_to(saved.name)
        with self.assertRaisesRegex(checker.VerificationError, 'must not be a symlink'):
            checker.verify(self.root)

    def test_duplicate_json_fields_are_rejected(self):
        self.report_path.write_text('{"artifact_sha256":{},"artifact_sha256":{}}')
        self.write_pin(self.source)
        with self.assertRaisesRegex(checker.VerificationError, 'duplicate JSON field'):
            checker.verify(self.root)

    def test_validator_disables_git_transports_and_lazy_fetch(self):
        environment = checker.git_environment()
        self.assertEqual(environment['GIT_NO_LAZY_FETCH'], '1')
        self.assertEqual(environment['GIT_ALLOW_PROTOCOL'], '')
        result = subprocess.run(['git', 'ls-remote', self.root.as_uri()],
                                env=environment, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"transport 'file' not allowed", result.stderr)

    def test_shallow_checkout_requires_explicit_pinned_fetch(self):
        self.commit('later checkout with source pin')
        clone = Path(self.temporary.name) / 'shallow'
        subprocess.run(['git', 'clone', '-q', '--no-local', '--depth=1',
                        self.root.as_uri(), str(clone)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with self.assertRaisesRegex(checker.VerificationError, 'pinned historical source commit unavailable'):
            checker.verify(clone)
        self.git('fetch', '--no-tags', '--depth=1', 'origin', self.source, root=clone)
        self.assertEqual(checker.verify(clone)['artifacts_verified'], 1)


if __name__ == '__main__':
    unittest.main()
