"""Keep circuit dependency drift checks independent of unrelated workspace packages."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from check_i02_source_lock import PINNED_LOCK, WORKSPACE_LOCK, dependency_closure, verify


REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index'
OTHER_SOURCE = 'git+https://example.invalid/proof-lib?rev=abc#abc'


def fixture():
    return {
        'version': 4,
        'package': [
            {'name': 'zkapi-tree-prover', 'version': '0.1.0',
             'dependencies': ['proof-lib', 'utility-lib']},
            {'name': 'proof-lib', 'version': '1.0.0', 'source': REGISTRY,
             'checksum': '1' * 64, 'dependencies': ['field-lib']},
            {'name': 'field-lib', 'version': '1.0.0', 'source': REGISTRY,
             'checksum': '2' * 64},
            {'name': 'utility-lib', 'version': '1.0.0', 'source': REGISTRY,
             'checksum': '3' * 64},
            {'name': 'rpc-metrics', 'version': '0.1.0'},
        ],
    }


def package(lock, name):
    return next(value for value in lock['package'] if value['name'] == name)


def write_lock(path, lock):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"version = {lock['version']}"]
    for value in lock['package']:
        lines.append('\n[[package]]')
        lines.extend(f'{key} = {json.dumps(item)}' for key, item in value.items())
    path.write_text('\n'.join(lines) + '\n')


class SourceLockTests(unittest.TestCase):
    def verify_pair(self, current, pinned=None):
        with tempfile.TemporaryDirectory(prefix='zkapi-lock-test-') as directory:
            root = Path(directory)
            write_lock(root / PINNED_LOCK, fixture() if pinned is None else pinned)
            write_lock(root / WORKSPACE_LOCK, current)
            return verify(root)

    def test_transitive_closure_excludes_unrelated_packages(self):
        self.assertEqual(set(dependency_closure(fixture())), {
            ('zkapi-tree-prover', '0.1.0', ''),
            ('proof-lib', '1.0.0', REGISTRY),
            ('field-lib', '1.0.0', REGISTRY),
            ('utility-lib', '1.0.0', REGISTRY),
        })
        self.assertEqual(self.verify_pair(fixture()), 4)

    def test_unrelated_package_add_update_and_removal_are_accepted(self):
        for change in ('add', 'update', 'remove'):
            with self.subTest(change=change):
                current = fixture()
                if change == 'add':
                    current['package'].append({'name': 'dashboard', 'version': '2.0.0'})
                elif change == 'update':
                    package(current, 'rpc-metrics')['version'] = '2.0.0'
                else:
                    current['package'].remove(package(current, 'rpc-metrics'))
                self.assertEqual(self.verify_pair(current), 4)

    def test_package_and_dependency_order_are_not_semantic_changes(self):
        current = fixture()
        current['package'].reverse()
        package(current, 'zkapi-tree-prover')['dependencies'].reverse()
        self.assertEqual(self.verify_pair(current), 4)

    def test_unrelated_version_can_require_qualified_dependency_references(self):
        current = fixture()
        extra = copy.deepcopy(package(current, 'proof-lib'))
        extra['version'] = '2.0.0'
        current['package'].append(extra)
        package(current, 'zkapi-tree-prover')['dependencies'][0] = 'proof-lib 1.0.0'
        self.assertEqual(self.verify_pair(current), 4)

    def test_unrelated_source_can_require_qualified_dependency_references(self):
        current = fixture()
        extra = copy.deepcopy(package(current, 'proof-lib'))
        extra['source'] = OTHER_SOURCE
        current['package'].append(extra)
        package(current, 'zkapi-tree-prover')['dependencies'][0] = (
            f'proof-lib 1.0.0 ({REGISTRY})')
        self.assertEqual(self.verify_pair(current), 4)

    def test_reachable_package_changes_are_rejected(self):
        for name in ('proof-lib', 'field-lib'):
            for key, value in [('version', '2.0.0'), ('source', OTHER_SOURCE),
                               ('checksum', 'f' * 64)]:
                with self.subTest(package=name, field=key):
                    current = fixture()
                    package(current, name)[key] = value
                    with self.assertRaises(ValueError):
                        self.verify_pair(current)

    def test_missing_reachable_checksum_is_rejected(self):
        current = fixture()
        del package(current, 'field-lib')['checksum']
        with self.assertRaises(ValueError):
            self.verify_pair(current)

    def test_lock_format_change_is_rejected(self):
        current = fixture()
        current['version'] = 5
        with self.assertRaisesRegex(ValueError, 'lock format changed'):
            self.verify_pair(current)

    def test_added_or_removed_reachable_edges_are_rejected(self):
        for change in ('add-root-edge', 'add-transitive-edge', 'remove-transitive-edge'):
            with self.subTest(change=change):
                current = fixture()
                if change == 'add-root-edge':
                    package(current, 'zkapi-tree-prover')['dependencies'].append('rpc-metrics')
                elif change == 'add-transitive-edge':
                    package(current, 'proof-lib')['dependencies'].append('rpc-metrics')
                else:
                    del package(current, 'proof-lib')['dependencies']
                with self.assertRaises(ValueError):
                    self.verify_pair(current)

    def test_missing_dependency_is_rejected(self):
        current = fixture()
        current['package'].remove(package(current, 'field-lib'))
        with self.assertRaises(ValueError):
            dependency_closure(current)

    def test_ambiguous_dependency_version_or_source_is_rejected(self):
        for field, value in [('version', '2.0.0'), ('source', OTHER_SOURCE)]:
            with self.subTest(field=field):
                current = fixture()
                extra = copy.deepcopy(package(current, 'proof-lib'))
                extra[field] = value
                current['package'].append(extra)
                with self.assertRaises(ValueError):
                    dependency_closure(current)

    def test_duplicate_package_identity_is_rejected(self):
        current = fixture()
        current['package'].append(copy.deepcopy(package(current, 'proof-lib')))
        with self.assertRaises(ValueError):
            dependency_closure(current)

    def test_missing_or_ambiguous_prover_root_is_rejected(self):
        for change in ('missing', 'ambiguous'):
            with self.subTest(change=change):
                current = fixture()
                root = package(current, 'zkapi-tree-prover')
                if change == 'missing':
                    current['package'].remove(root)
                else:
                    extra = copy.deepcopy(root)
                    extra['version'] = '0.2.0'
                    current['package'].append(extra)
                with self.assertRaises(ValueError):
                    dependency_closure(current)

    def test_malformed_dependency_reference_is_rejected(self):
        for reference in ('', 'proof-lib 1.0.0 extra', 'proof-lib 1.0.0 (unterminated'):
            with self.subTest(reference=reference):
                current = fixture()
                package(current, 'zkapi-tree-prover')['dependencies'] = [reference]
                with self.assertRaises(ValueError):
                    dependency_closure(current)


if __name__ == '__main__':
    unittest.main()
