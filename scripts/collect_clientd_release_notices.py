#!/usr/bin/env python3
"""Collect exact installed-toolchain and locked-package notices without relabeling ownership."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess

NOTICE = re.compile(r'^(?:licen[cs]e|copying|notice|copyright|authors|patents)(?:[._-]|$)', re.I)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def copy_required(source, destination):
    source = Path(source)
    if not source.is_file() or source.stat().st_size == 0:
        raise ValueError('required runtime notice is unavailable: ' + str(source))
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    return {'path': destination.name, 'sha256': digest(destination)}


def notice_files(directory):
    """Registry archives are closed package roots; do not search local build outputs."""
    directory = Path(directory)
    result = []
    for root, directories, names in os.walk(directory):
        directories[:] = [name for name in directories if name not in {'target', '.git', 'node_modules'}]
        for name in names:
            path = Path(root) / name
            if path.is_file() and NOTICE.match(name):
                result.append(path)
    return sorted(result)


def dependency_ids(metadata):
    nodes = {node['id']: node for node in metadata['resolve']['nodes']}
    pending = [metadata['resolve']['root']]
    visited = set()
    while pending:
        identifier = pending.pop()
        if identifier in visited:
            continue
        visited.add(identifier)
        for dependency in nodes[identifier]['deps']:
            if any(kind['kind'] != 'dev' for kind in dependency['dep_kinds']):
                pending.append(dependency['pkg'])
    return visited


def collect_rust_package(package, project, destination, binaries):
    package_root = Path(package['manifest_path']).parent.resolve()
    project = Path(project).resolve()
    upstream = project / 'vendor/ethereum-zkapi'
    local = package.get('source') is None
    project_owned = local and package_root.is_relative_to(project) and not package_root.is_relative_to(upstream)
    declared = package.get('license')
    files = notice_files(package_root)
    if package.get('license_file'):
        path = Path(package['license_file'])
        path = path if path.is_absolute() else package_root / path
        if not path.resolve().is_relative_to(package_root):
            raise ValueError('license file is outside its Rust package')
        if path not in files:
            files.append(path)
    if project_owned:
        # Root license applies only to this repository's own code. It never
        # substitutes for the separate vendored protocol's Cargo declarations.
        copy_required(project / 'LICENSE', destination / 'project-LICENSE')
        license_basis = 'repository LICENSE; original package declaration retained separately'
    else:
        if not declared and not files:
            raise ValueError('Rust dependency has no license declaration or file: ' + package['name'])
        license_basis = 'upstream package declaration and supplied files'
    copied = []
    for path in sorted(set(files)):
        relative = path.relative_to(package_root)
        target = destination / 'files' / relative
        copy_required(path, target)
        copied.append({'path': str(target.relative_to(destination)), 'sha256': digest(target)})
    # Exact declaration evidence is useful when a published crate omits texts.
    for name in ['Cargo.toml', 'Cargo.toml.orig', '.cargo_vcs_info.json']:
        path = package_root / name
        if path.is_file():
            copy_required(path, destination / 'declarations' / name)
    if project_owned:
        copied.append({'path': 'project-LICENSE', 'sha256': digest(destination / 'project-LICENSE')})
    return {'name': package['name'], 'version': package['version'],
            'license_declaration': declared, 'license_basis': license_basis,
            'source': package.get('source') or ('repository:' + str(package_root.relative_to(project)) if package_root.is_relative_to(project) else 'local package'),
            'repository': package.get('repository'), 'binaries': sorted(binaries),
            'notice_files': copied, 'declaration_only': not copied,
            'manifest_sha256': digest(package_root / 'Cargo.toml')}


def native_platform(stage):
    system, machine = platform.system().lower(), platform.machine().lower()
    value = {'os': system, 'architecture': machine}
    if system == 'darwin':
        minimums = {}
        for name in ['node', 'clientd', 'zkapi-client-prover', 'zkapi-client-verify']:
            raw = command(['otool', '-l', str(stage / 'bin' / name)])
            # LC_BUILD_VERSION uses minos. Older Mach-O files use LC_VERSION_MIN_MACOSX.
            blocks = re.split(r'Load command \d+', raw)
            versions = [match.group(1) for block in blocks if 'LC_BUILD_VERSION' in block or 'LC_VERSION_MIN_MACOSX' in block
                        for match in [re.search(r'^\s*(?:minos|version)\s+(\d+\.\d+(?:\.\d+)?)\s*$', block, re.M)] if match]
            if not versions:
                raise ValueError('native minimum macOS version is missing: ' + name)
            minimums[name] = max(versions, key=lambda version: tuple(map(int, version.split('.'))))
        value['binary_minimum_os_versions'] = minimums
        value['minimum_os_version'] = max(minimums.values(), key=lambda version: tuple(map(int, version.split('.'))))
    return value


def collect(project, stage, node, go):
    project, stage, node = Path(project).resolve(), Path(stage).resolve(), Path(node).resolve()
    notices = stage / 'share/zkapi-clientd/third-party'
    if notices.exists():
        raise ValueError('notice output already exists; retain the previous collection')
    notices.mkdir(parents=True)
    copy_required(project / 'LICENSE', stage / 'LICENSE')
    node_version = command([str(node), '--version'])
    if node_version != 'v' + (project / '.node-version').read_text().strip():
        raise ValueError('notice collection requires the pinned Node executable')
    node_license = node.parent.parent / 'LICENSE'
    copy_required(node_license, notices / 'node/LICENSE')
    go_root = Path(command([str(go), 'env', 'GOROOT']))
    for name in ['LICENSE', 'PATENTS']:
        copy_required(go_root / name, notices / 'go' / name)
    # Standard-library vendored components carry their own supplied notices.
    for path in notice_files(go_root / 'src/vendor'):
        copy_required(path, notices / 'go/src/vendor' / path.relative_to(go_root / 'src/vendor'))
    rust_version = command(['rustc', '-vV'])
    host = next(line.split(': ', 1)[1] for line in rust_version.splitlines() if line.startswith('host: '))
    rust_root = Path(command(['rustc', '--print', 'sysroot']))
    copy_required(rust_root / 'share/doc/rust/COPYRIGHT-library.html', notices / 'rust-toolchain/COPYRIGHT-library.html')
    # The vendored crates inherit their declaration from this exact workspace.
    upstream_declaration = notices / 'upstream/protocol-workspace-Cargo.toml'
    copy_required(project / 'vendor/ethereum-zkapi/protocol/rust/Cargo.toml', upstream_declaration)
    resolved, uses, manifests = {}, {}, {}
    for binary, manifest in [('zkapi-client-prover', 'apps/clientd/prover/Cargo.toml'), ('zkapi-client-verify', 'apps/clientd/companion/Cargo.toml')]:
        metadata = json.loads(command(['cargo', 'metadata', '--locked', '--offline', '--filter-platform', host, '--format-version', '1', '--manifest-path', manifest], cwd=project))
        selected = dependency_ids(metadata)
        manifests[binary] = {'cargo_lock_sha256': digest(project / Path(manifest).with_name('Cargo.lock')),
                            'resolved_package_count': len(selected)}
        for package in metadata['packages']:
            if package['id'] in selected:
                resolved[package['id']] = package
                uses.setdefault(package['id'], set()).add(binary)
    rust_records, text_references = [], {}
    for identifier, package in sorted(resolved.items()):
        name = re.sub(r'[^a-zA-Z0-9._-]', '_', package['name'] + '-' + package['version']) + '-' + hashlib.sha256(identifier.encode()).hexdigest()[:8]
        destination = notices / 'rust' / name
        record = collect_rust_package(package, project, destination, uses[identifier])
        record['directory'] = str(destination.relative_to(notices))
        rust_records.append(record)
        if package['name'] == 'anyhow':
            for license_name, filename in [('MIT', 'LICENSE-MIT'), ('Apache-2.0', 'LICENSE-APACHE')]:
                path = destination / 'files' / filename
                if path.is_file():
                    text_references[license_name] = {'path': str(path.relative_to(notices)), 'origin': 'anyhow ' + package['version'], 'sha256': digest(path)}
    if set(text_references) != {'MIT', 'Apache-2.0'}:
        raise ValueError('locally sourced reference license texts are missing')
    npm_records = []
    installed_lock = json.loads((stage / 'package-lock.json').read_text())
    for location, locked in sorted(installed_lock['packages'].items()):
        path = stage / location
        if not location.startswith('node_modules/') or not path.is_dir():
            continue
        package = json.loads((path / 'package.json').read_text())
        files = notice_files(path)
        declaration = package.get('license') or package.get('licenses')
        if not declaration and not files:
            raise ValueError('installed npm dependency has no license declaration or file: ' + location)
        npm_records.append({'name': package['name'], 'version': package['version'], 'location': location,
                            'license_declaration': declaration, 'integrity': locked.get('integrity'),
                            'notice_files': [{'path': str(file.relative_to(stage)), 'sha256': digest(file)} for file in files],
                            'declaration_only': not files})
    result = {'schema': 1, 'scope': 'installed Node, Go and Rust standard library, current-host locked Rust normal/build dependency graph, installed npm packages',
              'platform': native_platform(stage), 'toolchains': {'node': node_version, 'go': command([str(go), 'version']), 'rust': rust_version},
              'rust_manifests': manifests, 'rust': rust_records, 'npm': npm_records,
              'upstream_workspace_declaration': {'path': str(upstream_declaration.relative_to(notices)), 'sha256': digest(upstream_declaration)},
              'reference_license_texts': text_references,
              'declaration_only_rust': [record['name'] + '@' + record['version'] for record in rust_records if record['declaration_only']],
              'declaration_only_npm': [record['name'] + '@' + record['version'] for record in npm_records if record['declaration_only']]}
    (notices / 'dependencies.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    (notices / 'README.txt').write_text(
        'Exact supplied license and notice files are preserved with resolved dependency declarations.\n'
        'Node LICENSE is the complete file from the matching installed Node distribution. Go LICENSE/PATENTS and supplied standard-library vendor notices are retained.\n'
        'Rust COPYRIGHT-library.html comes from the actual compiler sysroot and covers the bundled standard library.\n'
        'Rust records include normal/build dependency closure for the current host; this conservative inventory is not a binary-level inclusion analysis.\n'
        'declaration_only entries supplied a license declaration but no license text file in their package source. Exact Cargo declarations are retained.\n'
        'The vendored zkapi-core, zkapi-proof and zkapi-types Cargo manifests declare MIT OR Apache-2.0; the separate zkapi-clientd MIT notice is not assigned to them.\n'
        'reference_license_texts point to complete MIT/Apache-2.0 texts supplied by the named local dependency. Its copyright notice is preserved as that source\'s notice, not assigned to declaration-only packages or upstream code.\n'
        'The repository LICENSE is copied only for repository-owned Rust packages and does not relicense third-party code.\n'
        'Installed npm notices remain at their original node_modules paths and are indexed with their hashes.\n')
    return {'notice_index': str((notices / 'dependencies.json').relative_to(stage)), 'rust_packages': len(rust_records), 'npm_packages': len(npm_records),
            'declaration_only_rust': result['declaration_only_rust'], 'declaration_only_npm': result['declaration_only_npm'], 'platform': result['platform']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--stage', type=Path, required=True)
    parser.add_argument('--node', type=Path, required=True)
    parser.add_argument('--go', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(collect(args.project, args.stage, args.node, args.go), indent=2))


if __name__ == '__main__':
    main()
