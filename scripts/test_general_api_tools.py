"""Read-only tool inventory contracts; filesystem and subprocesses are mocked."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from general_api_tools import inspect_tools, sbf_build_invocation


ROOT = Path('/fixture/checkout')
HOME = Path('/fixture/user')
PLATFORM = HOME / '.cache/solana/v1.54/platform-tools'
PLATFORM_FILES = [
    'rust/bin/rustc', 'rust/bin/cargo', 'llvm/bin/clang',
    'llvm/bin/llvm-objcopy', 'llvm/bin/llvm-readelf',
]
PINNED_VERSIONS = {
    'node': 'v24.22.1\n',
    'npm': '11.19.1\n',
    'go': 'go version go1.25.0 fixture/arm64\n',
    'cargo-build-sbf': 'cargo-build-sbf 4.1.0\nplatform-tools v1.54\n',
    'rustc': 'rustc 1.90.0 (fixture 2025-09-18)\n',
    'cargo': 'cargo 1.90.0 (fixture 2025-09-18)\n',
    'gtar': 'tar (GNU tar) 1.35\n',
    'tar': 'tar (GNU tar) 1.35\n',
    'python3': 'Python 3.12.0\n',
    'initdb': 'initdb (PostgreSQL) 16.9\n',
    'pg_ctl': 'pg_ctl (PostgreSQL) 16.9\n',
    'psql': 'psql (PostgreSQL) 16.9\n',
}
FLAGS = {name: ['--version'] for name in PINNED_VERSIONS}
FLAGS['go'] = ['version']


class ToolInventoryTests(unittest.TestCase):
    def setUp(self):
        self.versions = dict(PINNED_VERSIONS)
        self.available = set(self.versions)
        self.rust_toolchains = '1.90.0-aarch64-apple-darwin (default)\n'
        self.rust_targets = 'aarch64-apple-darwin\nwasm32-unknown-unknown\n'
        self.platform_version = 'rustc 1.89.0 (fixture)\n'
        self.platform_files = {PLATFORM / name for name in PLATFORM_FILES}
        self.calls = []
        self.accesses = []
        self.custom_executables = {}
        self.start_patch(patch.dict(os.environ, {'PATH': '/fixture/bin'}, clear=True))
        self.start_patch(patch.object(Path, 'home', return_value=HOME))
        self.start_patch(patch.object(Path, 'glob', return_value=[]))
        self.start_patch(patch('general_api_tools.shutil.which', side_effect=self.which))
        self.start_patch(patch('general_api_tools.os.access', side_effect=self.access))
        self.start_patch(patch('general_api_tools.subprocess.check_output', side_effect=self.probe))

    def start_patch(self, patcher):
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def which(self, executable, path=None):
        name = Path(executable).name
        if executable in self.custom_executables:
            return self.custom_executables[executable]
        if executable.startswith('/fixture/installed-rust/bin/') and name in self.available:
            return executable
        if name in self.available:
            return '/fixture/bin/' + name
        return None

    def access(self, path, mode):
        self.assertEqual(mode, os.X_OK)
        self.accesses.append(Path(path))
        return Path(path) in self.platform_files

    def probe(self, command, **options):
        command = [str(part) for part in command]
        self.calls.append(command)
        self.assertEqual(options['timeout'], 15)
        self.assertTrue(options['text'])
        self.assertEqual(options['env']['GOTOOLCHAIN'], 'local')
        self.assertEqual(options['env']['RUSTUP_TOOLCHAIN'], '1.90.0')
        # Only these read-only commands are accepted. An attempted installation,
        # download, rustup proxy fallback, build or unexpected probe fails here.
        if command == ['rustup', 'toolchain', 'list']:
            if isinstance(self.rust_toolchains, Exception):
                raise self.rust_toolchains
            return self.rust_toolchains
        if command == ['rustup', 'target', 'list', '--installed', '--toolchain', '1.90.0']:
            return self.rust_targets
        if command[:4] == ['rustup', 'which', '--toolchain', '1.90.0'] and command[4] in ['rustc', 'cargo']:
            return '/fixture/installed-rust/bin/' + command[4] + '\n'
        if command == [str(PLATFORM / 'rust/bin/rustc'), '--version']:
            return self.platform_version
        name = Path(command[0]).name
        if name in ['rustc', 'cargo']:
            self.assertEqual(command[0], '/fixture/installed-rust/bin/' + name,
                             'rustup proxies may auto-install missing components under repository overrides')
        self.assertIn(name, FLAGS, 'unexpected external command')
        self.assertEqual(command[1:], FLAGS[name], 'non-inventory tool action')
        self.assertIn(name, self.available)
        return self.versions[name]

    def requirements(self, result):
        return {item['tool']: item for item in result['requirements']}

    def assert_read_only(self, result):
        for key in ['networkActions', 'providerActions', 'transactionActions', 'serviceActions']:
            self.assertEqual(result[key], 0)
        self.assertEqual(self.accesses, [PLATFORM / name for name in PLATFORM_FILES])

    def test_correct_pinned_fixture_passes_and_reports_exact_executables(self):
        for compiler in ['rustc 1.89.0 (fixture)', 'rustc 1.89.0-dev (fixture)']:
            with self.subTest(platform_compiler=compiler):
                self.accesses.clear()
                self.platform_version = compiler
                result = inspect_tools(ROOT)
                self.assertTrue(result['passed'])
                self.assertEqual(result['schema'], 1)
                self.assertEqual(result['requirements'], [])
                self.assertEqual(result['executables']['node'], '/fixture/bin/node')
                self.assertEqual(result['executables']['sbf'], '/fixture/bin/cargo-build-sbf')
                self.assertEqual(len(result['executables']), 13)
                self.assertEqual(result['executables']['sbf_rustc'], str(PLATFORM / 'rust/bin/rustc'))
                self.assertEqual(result['executables']['sbf_cargo'], str(PLATFORM / 'rust/bin/cargo'))
                self.assertEqual(result['executables']['rustc'], '/fixture/installed-rust/bin/rustc')
                self.assertEqual(result['executables']['cargo'], '/fixture/installed-rust/bin/cargo')
                self.assertEqual(result['tools']['sbf-platform-rustc'], compiler)
                self.assert_read_only(result)

    def test_missing_pinned_rust_never_invokes_rustup_proxies_or_installs(self):
        self.rust_toolchains = 'stable-aarch64-apple-darwin (default)\n1.91.0-aarch64-apple-darwin\n'
        result = inspect_tools(ROOT)
        requirements = self.requirements(result)
        self.assertFalse(result['passed'])
        self.assertEqual(set(requirements), {'rustc', 'cargo', 'Rust WASM target'})
        self.assertNotIn(['/fixture/bin/rustc', '--version'], self.calls)
        self.assertNotIn(['/fixture/bin/cargo', '--version'], self.calls)
        self.assertNotIn(['rustup', 'target', 'list', '--installed', '--toolchain', '1.90.0'], self.calls)
        self.assertIn('never installs', requirements['rustc']['guidance'])
        self.assert_read_only(result)

    def test_unavailable_rustup_also_avoids_proxy_toolchain_download(self):
        for failure in [FileNotFoundError('not installed'), subprocess.TimeoutExpired('rustup', 15)]:
            with self.subTest(failure=type(failure).__name__):
                self.calls.clear()
                self.accesses.clear()
                self.rust_toolchains = failure
                result = inspect_tools(ROOT)
                self.assertFalse(result['passed'])
                self.assertTrue({'rustc', 'cargo', 'Rust WASM target'} <= set(self.requirements(result)))
                self.assertNotIn(['/fixture/bin/rustc', '--version'], self.calls)
                self.assertNotIn(['/fixture/bin/cargo', '--version'], self.calls)
                self.assert_read_only(result)

    def test_sbf_version_banner_cannot_hide_missing_platform_cache(self):
        self.platform_files.remove(PLATFORM / 'llvm/bin/llvm-readelf')
        result = inspect_tools(ROOT)
        self.assertFalse(result['passed'])
        self.assertIn('sbf', result['executables'])
        self.assertIn('platform-tools v1.54', result['tools']['sbf'])
        requirements = self.requirements(result)
        self.assertEqual(set(requirements), {'SBF platform-tools'})
        self.assertEqual(requirements['SBF platform-tools']['missing'], ['llvm/bin/llvm-readelf'])
        self.assertNotIn([str(PLATFORM / 'rust/bin/rustc'), '--version'], self.calls)
        self.assertIn('never installs', requirements['SBF platform-tools']['guidance'])
        self.assert_read_only(result)

    def test_platform_cache_with_wrong_compiler_is_rejected(self):
        self.platform_version = 'rustc 1.90.0 (wrong platform tools)'
        result = inspect_tools(ROOT)
        self.assertFalse(result['passed'])
        self.assertEqual(set(self.requirements(result)), {'SBF platform-tools compiler'})
        self.assertNotIn('sbf-platform-rustc', result['tools'])
        self.assert_read_only(result)

    def test_all_missing_tools_are_reported_together_without_external_execution(self):
        self.available.clear()
        self.platform_files.clear()
        self.rust_toolchains = ''
        result = inspect_tools(ROOT)
        self.assertFalse(result['passed'])
        self.assertEqual(set(self.requirements(result)), {
            'node', 'npm', 'go', 'sbf', 'rustc', 'cargo', 'tar', 'python',
            'initdb', 'pg_ctl', 'psql', 'Rust WASM target', 'SBF platform-tools',
        })
        self.assertEqual(result['tools'], {})
        self.assertEqual(result['executables'], {})
        self.assertEqual(self.calls, [['rustup', 'toolchain', 'list']])
        self.assert_read_only(result)

    def test_version_and_wasm_mismatches_are_aggregated_with_other_tools_found(self):
        self.versions['node'] = 'v24.18.0\n'
        self.versions['npm'] = '11.19.1-unreviewed\n'
        self.versions['cargo-build-sbf'] = 'cargo-build-sbf 4.1.0\nplatform-tools v1.53\n'
        self.rust_targets = 'aarch64-apple-darwin\n'
        result = inspect_tools(ROOT)
        self.assertFalse(result['passed'])
        requirements = self.requirements(result)
        self.assertEqual(set(requirements), {'node', 'npm', 'sbf', 'Rust WASM target'})
        self.assertTrue(requirements['node']['observed'])
        self.assertTrue(requirements['npm']['observed'])
        self.assertTrue(requirements['sbf']['observed'])
        self.assertIn('go', result['executables'])
        self.assertIn('rustc', result['executables'])
        self.assert_read_only(result)

    def test_explicit_missing_override_never_falls_back_to_available_default(self):
        os.environ['ZKAPI_NODE'] = '/custom/pinned/node'
        self.custom_executables['/custom/pinned/node'] = None
        result = inspect_tools(ROOT)
        self.assertFalse(result['passed'])
        self.assertEqual(set(self.requirements(result)), {'node'})
        self.assertNotIn(['/fixture/bin/node', '--version'], self.calls)
        self.assertNotIn('node', result['executables'])
        self.assert_read_only(result)

    def test_installed_rust_with_missing_wasm_never_activates_repository_override(self):
        self.rust_targets = 'aarch64-apple-darwin\n'
        result = inspect_tools(ROOT)
        self.assertFalse(result['passed'])
        self.assertEqual(set(self.requirements(result)), {'Rust WASM target'})
        for name in ['rustc', 'cargo']:
            self.assertIn(['rustup', 'which', '--toolchain', '1.90.0', name], self.calls)
            self.assertIn(['/fixture/installed-rust/bin/' + name, '--version'], self.calls)
            self.assertNotIn(['/fixture/bin/' + name, '--version'], self.calls)
        self.assert_read_only(result)

    def test_sbf_build_uses_installed_platform_only_for_its_own_stage(self):
        inventory = inspect_tools(ROOT)
        inventory['executables']['sbf'] = '/custom/reviewed-sbf'
        environment = {'PATH': '/fixture/host-tools', 'CARGO_NET_OFFLINE': 'true', 'RAYON_NUM_THREADS': '4'}
        original = dict(environment)
        command, stage = sbf_build_invocation(inventory, ROOT / 'programs/zkapi-vault/Cargo.toml', ROOT / 'target/new-sbf', environment)
        self.assertEqual(command[0], '/custom/reviewed-sbf')
        for flag in ['--no-rustup-override', '--skip-tools-install', '--offline', '--locked']:
            self.assertIn(flag, command)
        self.assertEqual(command[-3:], ['--', '--locked', '--offline'])
        self.assertEqual(command[command.index('--tools-version') + 1], 'v1.54')
        self.assertEqual(stage['RUSTC'], str(PLATFORM / 'rust/bin/rustc'))
        self.assertEqual(stage['CARGO'], str(PLATFORM / 'rust/bin/cargo'))
        self.assertEqual(stage['PATH'], str(PLATFORM / 'rust/bin') + os.pathsep + original['PATH'])
        self.assertEqual(stage['RAYON_NUM_THREADS'], '4')
        self.assertEqual(environment, original, 'other build stages must retain their pinned host tools')
        self.assertEqual(os.environ['PATH'], '/fixture/bin')
        with self.assertRaisesRegex(ValueError, 'complete installed-tool inventory'):
            sbf_build_invocation({**inventory, 'passed': False}, 'manifest', 'output', environment)


class DependencyPreparationTests(unittest.TestCase):
    def test_dependency_fetch_retains_exact_installed_rust_binaries(self):
        import prepare_general_api_dependencies as preparation
        tools = {name: '/fixture/installed/bin/' + name for name in ['node', 'npm', 'go', 'rustc', 'cargo']}
        inventory = {'passed': True, 'executables': tools, 'tools': {}}
        with tempfile.TemporaryDirectory(prefix='zkapi-dependency-test-') as directory:
            root = Path(directory)
            package = root / 'packages/sdk/package.json'
            package.parent.mkdir(parents=True)
            package.write_text('{"version":"0.0.0-test"}')
            with (patch.object(preparation, 'ROOT', root),
                  patch.object(preparation, 'inspect_tools', return_value=inventory),
                  patch.object(preparation.subprocess, 'run') as run,
                  patch.object(preparation.shutil, 'copyfile'),
                  patch.object(preparation, 'materialize', return_value={}),
                  patch.object(preparation, 'sha', return_value='0' * 64),
                  patch('builtins.print')):
                preparation.main()
            fetches = [call for call in run.call_args_list if call.args[0][1] == 'fetch']
            self.assertEqual(len(fetches), 8)
            for call in fetches:
                self.assertEqual(call.args[0][0], tools['cargo'])
                self.assertIn('--locked', call.args[0])
                self.assertEqual(call.kwargs['env']['RUSTC'], tools['rustc'])
                self.assertEqual(call.kwargs['env']['CARGO'], tools['cargo'])
                self.assertEqual(call.kwargs['env']['RUSTUP_TOOLCHAIN'], '1.90.0')


if __name__ == '__main__':
    unittest.main()
