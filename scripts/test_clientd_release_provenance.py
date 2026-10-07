"""Release/source joins against disposable repositories; no financial inputs."""
import hashlib
from pathlib import Path
import subprocess
import tempfile
import unittest

from clientd_release_provenance import VENDOR, verify_committed_sources


def digest(value):
    return hashlib.sha256(value).hexdigest()


class ReleaseSourceTests(unittest.TestCase):
    def git(self, directory, *args):
        return subprocess.check_output(['git', '-c', 'user.name=Fixture', '-c',
                                        'user.email=fixture@example.invalid', *args],
                                       cwd=directory, stderr=subprocess.PIPE).decode().strip()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='zkapi-release-source-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git(self.root, 'init', '-q')
        self.vendor = self.root / VENDOR
        self.vendor.mkdir(parents=True)
        self.git(self.vendor, 'init', '-q')
        (self.vendor / 'protocol.rs').write_bytes(b'upstream fixture\n')
        self.git(self.vendor, 'add', 'protocol.rs')
        self.git(self.vendor, 'commit', '-qm', 'Fixture upstream')
        self.upstream = self.git(self.vendor, 'rev-parse', 'HEAD')
        (self.root / 'runtime.ts').write_bytes(b'local fixture\n')
        self.git(self.root, 'add', 'runtime.ts')
        self.git(self.root, 'update-index', '--add', '--cacheinfo', '160000,' + self.upstream + ',' + VENDOR)
        self.git(self.root, 'commit', '-qm', 'Fixture build source')
        self.revision = self.git(self.root, 'rev-parse', 'HEAD')
        self.snapshot = {'runtime.ts': digest(b'local fixture\n'),
                         VENDOR + '/protocol.rs': digest(b'upstream fixture\n'),
                         'gitlink:' + VENDOR: self.upstream}

    def test_exact_superproject_and_upstream_sources_pass(self):
        verify_committed_sources(self.snapshot, self.revision, self.root)

    def test_existing_commit_with_other_runtime_bytes_is_rejected(self):
        self.snapshot['runtime.ts'] = digest(b'newer build source\n')
        with self.assertRaisesRegex(ValueError, 'differs from recorded build inputs'):
            verify_committed_sources(self.snapshot, self.revision, self.root)

    def test_dirty_upstream_bytes_cannot_claim_the_original_gitlink(self):
        self.snapshot[VENDOR + '/protocol.rs'] = digest(b'changed upstream source\n')
        with self.assertRaisesRegex(ValueError, 'differs from recorded build inputs'):
            verify_committed_sources(self.snapshot, self.revision, self.root)

    def test_other_upstream_gitlink_is_rejected(self):
        self.snapshot['gitlink:' + VENDOR] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'upstream gitlink differ'):
            verify_committed_sources(self.snapshot, self.revision, self.root)

    def test_uncommitted_build_input_cannot_claim_an_older_commit(self):
        self.snapshot['new-runtime.ts'] = digest(b'new source\n')
        with self.assertRaisesRegex(ValueError, 'missing a regular source file'):
            verify_committed_sources(self.snapshot, self.revision, self.root)

    def test_unsafe_paths_are_rejected_before_git_reads(self):
        for name in ('../outside', '/absolute', 'file\nother', 'a//b'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'invalid source snapshot entry'):
                verify_committed_sources({**self.snapshot, name: digest(b'data')}, self.revision, self.root)


if __name__ == '__main__':
    unittest.main()
