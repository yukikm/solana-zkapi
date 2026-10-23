"""Read-only inventory of already-installed tools for isolated API acceptance."""
import os
from pathlib import Path
import re
import shutil
import subprocess


def inspect_tools(root):
    root = Path(root)
    found, errors, versions = {}, [], {}
    specs = {
        'node': ('ZKAPI_NODE', [root / 'target/i08-toolchain/bin/node', *sorted((root / 'target/toolchains').glob('node-v24.22.1-*/bin/node')), 'node'], ['--version'], 'v24.22.1'),
        'npm': ('ZKAPI_NPM', [root / 'target/i08-toolchain/bin/npm', 'npm'], ['--version'], '11.19.1'),
        'go': ('ZKAPI_GO', [root / 'target/toolchains/go/bin/go', 'go'], ['version'], 'go1.25.0'),
        'sbf': ('ZKAPI_SBF', [root / 'target/toolchains/sbf/bin/cargo-build-sbf', 'cargo-build-sbf'], ['--version'], 'cargo-build-sbf 4.1.0'),
        'rustc': (None, ['rustc'], ['--version'], 'rustc 1.90.0'),
        'cargo': (None, ['cargo'], ['--version'], 'cargo 1.90.0'),
        'tar': ('ZKAPI_GNU_TAR', ['gtar', 'tar'], ['--version'], 'GNU tar'),
        'python': (None, ['python3'], ['--version'], 'Python 3.11+'),
        **{name: (None, [name], ['--version'], 'PostgreSQL') for name in ['initdb', 'pg_ctl', 'psql']},
    }
    node_candidates = specs['node'][1]
    node = shutil.which(os.environ.get('ZKAPI_NODE', str(node_candidates[0])))
    # Even `rustup toolchain list` checks repository override components when
    # determining the active toolchain. An explicit selection avoids that
    # installation side effect; all later binaries are resolved below.
    environment = {**os.environ, 'GOTOOLCHAIN': 'local', 'RUSTUP_TOOLCHAIN': '1.90.0'}
    if node:
        environment['PATH'] = str(Path(node).parent) + os.pathsep + environment.get('PATH', '')
    try:
        installed = subprocess.check_output(['rustup','toolchain','list'], env=environment, text=True, timeout=15)
        rust_installed = any(line.split()[0].startswith('1.90.0-') for line in installed.splitlines() if line.split())
    except (OSError,subprocess.SubprocessError):
        rust_installed = False
    for name, (override, candidates, flags, expected) in specs.items():
        if name in ('rustc','cargo') and not rust_installed:
            errors.append({'tool':name,'required':expected,'guidance':'Install Rust 1.90.0 separately; tool inspection never installs it'})
            continue
        candidates = [os.environ[override]] if override and override in os.environ else candidates
        if name in ('rustc', 'cargo'):
            # A proxy such as ~/.cargo/bin/rustc reads rust-toolchain.toml and
            # can install missing components even for --version. An explicit
            # installed toolchain lookup does not activate those overrides.
            try:
                candidates = [subprocess.check_output(['rustup', 'which', '--toolchain', '1.90.0', name],
                              env=environment, text=True, stderr=subprocess.STDOUT, timeout=15).strip()]
            except (OSError, subprocess.SubprocessError):
                errors.append({'tool':name,'required':expected,'guidance':'Repair the installed Rust 1.90.0 toolchain separately; tool inspection never installs it'})
                continue
        failures = []
        for candidate in candidates:
            executable = shutil.which(str(candidate), path=environment.get('PATH'))
            if not executable:
                continue
            try:
                value = subprocess.check_output([executable, *flags], env=environment, text=True, stderr=subprocess.STDOUT, timeout=15).strip()
                matches = value == expected if name in ['node', 'npm'] else expected in value
                if name == 'sbf':
                    matches = matches and 'platform-tools v1.54' in value
                if name == 'python':
                    version = re.fullmatch(r'Python 3\.(\d+)\.\d+', value)
                    matches = version is not None and int(version[1]) >= 11
                if not matches:
                    failures.append(value.splitlines()[0])
                    continue
                found[name], versions[name] = str(Path(executable).absolute()), value
                break
            except (OSError, subprocess.SubprocessError):
                failures.append('could not execute installed tool')
        if name not in found:
            errors.append({'tool': name, 'required': expected, 'observed': failures,
                           'guidance': 'Install the documented pinned tool separately' + (f' or set {override}' if override else '')})
    try:
        if not rust_installed: raise OSError('pinned Rust is not installed')
        targets = subprocess.check_output(['rustup', 'target', 'list', '--installed', '--toolchain', '1.90.0'], env=environment, text=True, timeout=15)
        if 'wasm32-unknown-unknown' not in targets.splitlines():
            errors.append({'tool': 'Rust WASM target', 'required': 'wasm32-unknown-unknown'})
    except (OSError, subprocess.SubprocessError):
        errors.append({'tool': 'Rust WASM target', 'required': 'rustup with wasm32-unknown-unknown'})
    # The SBF version banner describes its default toolchain even if no compiler
    # is installed. Check the pinned install location used by install_sbf_tools.sh.
    platform = Path.home() / '.cache/solana/v1.54/platform-tools'
    platform_files = ['rust/bin/rustc', 'rust/bin/cargo', 'llvm/bin/clang', 'llvm/bin/llvm-objcopy', 'llvm/bin/llvm-readelf']
    missing = [name for name in platform_files if not os.access(platform / name, os.X_OK)]
    if missing:
        errors.append({'tool': 'SBF platform-tools', 'required': 'installed v1.54', 'missing': missing,
                       'guidance': 'Install the documented pinned platform-tools separately; acceptance never installs them'})
    else:
        try:
            version = subprocess.check_output([platform / 'rust/bin/rustc', '--version'], env=environment,
                                              text=True, stderr=subprocess.STDOUT, timeout=15).strip()
            if version.split()[:2] not in [['rustc', '1.89.0'], ['rustc', '1.89.0-dev']]:
                raise OSError('platform compiler mismatch')
            versions['sbf-platform-rustc'] = version
            found['sbf_rustc'] = str(platform / 'rust/bin/rustc')
            found['sbf_cargo'] = str(platform / 'rust/bin/cargo')
        except (OSError, subprocess.SubprocessError):
            errors.append({'tool': 'SBF platform-tools compiler', 'required': 'v1.54 rustc 1.89.0'})
    return {'schema': 1, 'passed': not errors, 'tools': versions, 'executables': found, 'requirements': errors,
            'networkActions': 0, 'providerActions': 0, 'transactionActions': 0, 'serviceActions': 0}


def sbf_build_invocation(inventory, manifest, output, environment):
    """Use installed platform binaries without modifying the user's rustup links."""
    if not inventory['passed']:
        raise ValueError('a complete installed-tool inventory is required before SBF execution')
    selected = inventory['executables']
    # --skip-tools-install only suppresses downloads. Without this separate
    # override flag cargo-build-sbf can uninstall/relink host Solana toolchains.
    command = [selected['sbf'], '--offline', '--skip-tools-install', '--no-rustup-override',
               '--manifest-path', str(manifest), '--tools-version', 'v1.54', '--arch', 'v0',
               '--features', 'sbf-entrypoint', '--sbf-out-dir', str(output), '--', '--locked', '--offline']
    stage_environment = {**environment, 'RUSTC': selected['sbf_rustc'], 'CARGO': selected['sbf_cargo'],
                         'PATH': str(Path(selected['sbf_cargo']).parent) + os.pathsep + environment.get('PATH', ''),
                         'CARGO_NET_OFFLINE': 'true'}
    return command, stage_environment
