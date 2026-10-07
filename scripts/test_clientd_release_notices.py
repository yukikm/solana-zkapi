"""Notice collection regressions using disposable, synthetic package contents."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from collect_clientd_release_notices import collect_rust_package, copy_required, dependency_ids, native_platform, notice_files


class NoticeTests(unittest.TestCase):
    def test_required_runtime_notice_cannot_be_missing_or_empty(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            for exists in [False, True]:
                if exists:
                    (root / 'LICENSE').write_text('')
                with self.assertRaisesRegex(ValueError, 'required runtime notice'):
                    copy_required(root / 'LICENSE', root / 'out/LICENSE')
            (root / 'LICENSE').write_bytes(b'Complete synthetic notice\nsecond paragraph\n')
            copy_required(root / 'LICENSE', root / 'out/LICENSE')
            self.assertEqual((root / 'LICENSE').read_bytes(), (root / 'out/LICENSE').read_bytes())

    def test_dependency_closure_excludes_dev_only_and_retains_build_dependencies(self):
        metadata = {'resolve': {'root': 'root', 'nodes': [
            {'id': 'root', 'deps': [{'pkg': 'normal', 'dep_kinds': [{'kind': None}]}, {'pkg': 'build', 'dep_kinds': [{'kind': 'build'}]}, {'pkg': 'test', 'dep_kinds': [{'kind': 'dev'}]}]},
            {'id': 'normal', 'deps': []}, {'id': 'build', 'deps': []}, {'id': 'test', 'deps': []}]}}
        self.assertEqual(dependency_ids(metadata), {'root', 'normal', 'build'})

    def fixture(self, root, name, source=None, license=None):
        directory = root / name
        directory.mkdir(parents=True)
        (directory / 'Cargo.toml').write_text('[package]\nname="synthetic"\n')
        return {'name': 'synthetic', 'version': '1.0.0', 'manifest_path': str(directory / 'Cargo.toml'), 'source': source, 'license': license}, directory

    def test_upstream_declaration_is_not_reassigned_repository_copyright(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            (root / 'LICENSE').write_text('Synthetic repository ownership\n')
            package, source = self.fixture(root, 'vendor/ethereum-zkapi/protocol/crate', license='MIT OR Apache-2.0')
            record = collect_rust_package(package, root, root / 'out', {'prover'})
            self.assertTrue(record['declaration_only'])
            self.assertEqual(record['license_declaration'], 'MIT OR Apache-2.0')
            self.assertFalse((root / 'out/project-LICENSE').exists())
            self.assertEqual((root / 'out/declarations/Cargo.toml').read_bytes(), (source / 'Cargo.toml').read_bytes())

    def test_repository_owned_crate_requires_and_preserves_root_license(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            package, _ = self.fixture(root, 'crates/owned')
            with self.assertRaisesRegex(ValueError, 'required runtime notice'):
                collect_rust_package(package, root, root / 'out', {'prover'})
            (root / 'LICENSE').write_text('Synthetic repository ownership\n')
            record = collect_rust_package(package, root, root / 'out', {'prover'})
            self.assertFalse(record['declaration_only'])
            self.assertIsNone(record['license_declaration'])
            self.assertEqual((root / 'out/project-LICENSE').read_bytes(), (root / 'LICENSE').read_bytes())

    def test_dependency_without_declaration_or_notice_fails_closed(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            package, _ = self.fixture(root, 'registry/package', source='registry+synthetic')
            with self.assertRaisesRegex(ValueError, 'no license declaration or file'):
                collect_rust_package(package, root, root / 'out', {'prover'})

    def test_nested_notices_are_preserved_but_build_output_is_excluded(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            package, source = self.fixture(root, 'registry/package', source='registry+synthetic', license='MIT')
            (source / 'third_party').mkdir()
            (source / 'third_party/NOTICE').write_text('Synthetic supplied attribution\n')
            (source / 'target').mkdir()
            (source / 'target/LICENSE').write_text('Not a dependency source file\n')
            self.assertEqual(notice_files(source), [source / 'third_party/NOTICE'])
            record = collect_rust_package(package, root, root / 'out', {'prover'})
            self.assertFalse(record['declaration_only'])
            self.assertEqual((root / 'out/files/third_party/NOTICE').read_bytes(), (source / 'third_party/NOTICE').read_bytes())

    def test_macos_minimum_is_derived_from_every_installed_binary(self):
        def otool(args):
            version = '13.5' if args[-1].endswith('/node') else '11.0'
            return 'Load command 1\n cmd LC_BUILD_VERSION\n minos ' + version + '\n sdk 27.0\nLoad command 2\n cmd LC_SYMTAB\n'
        with patch('collect_clientd_release_notices.platform.system', return_value='Darwin'), patch('collect_clientd_release_notices.platform.machine', return_value='arm64'), patch('collect_clientd_release_notices.command', side_effect=otool):
            result = native_platform(Path('/synthetic/install'))
        self.assertEqual(result['minimum_os_version'], '13.5')
        self.assertEqual(len(result['binary_minimum_os_versions']), 4)


if __name__ == '__main__':
    unittest.main()
