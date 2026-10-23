#!/usr/bin/env python3
"""Assemble the current OS clientd with an externally pinnable full-file manifest.
No production signature or other-OS support is claimed by a local build.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
from collect_clientd_release_notices import collect as collect_release_notices
from sdk_consumer_lock import materialize, reviewed
from clientd_release_provenance import BUILD_INPUTS_PATH, COPIED_FILES, source_snapshot

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=ROOT / 'target/i08-clientd/distribution')
parser.add_argument('--offline', action='store_true', help='Use prepared Cargo, Go and npm dependency caches only')
parser.add_argument('--prover', type=Path, help='Explicit already built native prover artifact')
parser.add_argument('--verifier', type=Path, help='Explicit already built native verifier artifact')
args = parser.parse_args()
if bool(args.prover) != bool(args.verifier):
    parser.error('--prover and --verifier must be supplied together')
reviewed('clientd-runtime')
OUT = args.output.expanduser().resolve()
GO = os.environ.get('ZKAPI_GO', shutil.which('go') or str(ROOT / 'target/toolchains/go/bin/go'))
NODE = os.environ.get('ZKAPI_NODE', shutil.which('node') or '')
node_version = subprocess.check_output([NODE, '--version'], text=True).strip()
if node_version != 'v' + (ROOT / '.node-version').read_text().strip():
    raise SystemExit('pinned Node version required')
go_version = subprocess.check_output([GO, 'version'], text=True).strip()
if ' go1.25.0 ' not in go_version:
    raise SystemExit('pinned Go 1.25.0 required')
if not (ROOT / 'LICENSE').is_file():
    raise SystemExit('repository license must be selected before packaging a release')
if OUT.exists():
    raise SystemExit('distribution already exists; choose a clean target by removing this generated output explicitly')
source_before = source_snapshot()
OUT.mkdir(parents=True, mode=0o700)
(OUT / 'bin').mkdir()
subprocess.run([GO, '-C', str(ROOT / 'apps/clientd'), 'build', '-trimpath', '-buildvcs=false', '-ldflags=-buildid=', '-o', str(OUT / 'bin/clientd'), './cmd/clientd'], check=True, env={**os.environ,'GOTOOLCHAIN':'local', **({'GOPROXY':'off'} if args.offline else {})})
if not args.prover:
    for manifest in ['apps/clientd/companion/Cargo.toml', 'apps/clientd/prover/Cargo.toml']:
        subprocess.run(['cargo','build','--release','--locked',*(['--offline'] if args.offline else []),'--manifest-path',manifest],cwd=ROOT,check=True)
for source, target in [(NODE,'bin/node'),(args.verifier or 'apps/clientd/companion/target/release/zkapi-client-verify','bin/zkapi-client-verify'),(args.prover or 'apps/clientd/prover/target/release/zkapi-client-prover','bin/zkapi-client-prover')]:
    path=Path(source); path=path if path.is_absolute() else ROOT/path
    shutil.copy2(path,OUT/target)
# Install the compiled SDK tarball exactly as a separate repository would.
# This removes source-tree/workspace and browser demo dependencies at runtime.
npm = os.environ.get('ZKAPI_NPM') or shutil.which('npm')
if not npm or not shutil.which(npm):
    raise RuntimeError('Set ZKAPI_NPM to the pinned npm 11.19.1 executable')
npm = str(Path(shutil.which(npm)).absolute())
pack_dir = OUT / 'vendor'
pack_dir.mkdir(exist_ok=True)
packed = subprocess.run([npm, 'pack', *(['--offline'] if args.offline else []), '--workspace', '@zkapi/solana-sdk', '--pack-destination', str(pack_dir), '--json'], cwd=ROOT, text=True, capture_output=True, check=True, env={**os.environ, 'PATH':str(Path(NODE).parent)+os.pathsep+os.environ.get('PATH','')})
# npm prepack can precede its JSON result with lifecycle output.
pack_result = json.loads(packed.stdout[packed.stdout.index('[\n'):])
archive = 'vendor/' + pack_result[0]['filename']
# The production graph is a reviewed fixture. Never npm install/resolve it.
source_lock_bytes = (ROOT / 'package-lock.json').read_bytes()
lock_evidence = materialize(OUT, OUT / archive, 'clientd-runtime')
lock_before = (OUT / 'package-lock.json').read_bytes()
npm_env = {**os.environ, 'PATH':str(Path(NODE).parent)+os.pathsep+os.environ.get('PATH','')}
if subprocess.check_output([npm,'--version'],env=npm_env,text=True).strip() != '11.19.1':
    raise RuntimeError('pinned npm 11.19.1 required')
try:
    subprocess.run([npm, 'ci', *(['--offline'] if args.offline else []), '--ignore-scripts', '--bin-links=false', '--omit=dev', '--no-audit', '--no-fund'], cwd=OUT, check=True, env=npm_env)
except subprocess.CalledProcessError as error:
    raise RuntimeError('Native dependency cache unavailable or reviewed installation failed; prepare caches from the documented native fixture before offline acceptance') from error
if (OUT / 'package-lock.json').read_bytes() != lock_before:
    raise RuntimeError('npm changed the reviewed native production lock')
for source in COPIED_FILES:
    destination=OUT/source;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/source,destination)
# npm creates command shims as symlinks; pin their actual bytes so the installed
# verifier can reject all symlinks, including resolution-shadowing additions.
for path in OUT.rglob('*'):
    if path.is_symlink():
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise RuntimeError('unsupported directory symlink in npm installation')
        data = resolved.read_bytes()
        mode = resolved.stat().st_mode
        path.unlink()
        path.write_bytes(data)
        path.chmod(mode & 0o777)
notices = collect_release_notices(ROOT, OUT, Path(NODE), Path(GO))
if source_snapshot() != source_before:
    raise RuntimeError('source inputs changed during native build; partial installation retained, no release manifest issued')
build_inputs = {'schema': 1, 'scope': 'Exact source bytes before and after this native distribution build',
                'source_sha256': source_before, 'source_inputs_unchanged': True,
                'build_host': {'os': platform.system().lower(), 'architecture': platform.machine().lower(),
                               'os_version': platform.mac_ver()[0] if platform.system() == 'Darwin' else platform.release()},
                'sdk_tarball_sha256': hashlib.sha256((OUT / archive).read_bytes()).hexdigest(), 'dependency_lock': lock_evidence, 'offline': args.offline,
                'node_version': node_version, 'go_version': go_version}
build_inputs_path = OUT / BUILD_INPUTS_PATH
build_inputs_path.parent.mkdir(parents=True, exist_ok=True)
build_inputs_path.write_text(json.dumps(build_inputs, indent=2, sort_keys=True) + '\n')
for path in [OUT,*OUT.rglob('*')]:
    os.chmod(path,0o700 if path.is_dir() or os.access(path,os.X_OK) else 0o600)
files={str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.rglob('*')) if p.is_file()}
manifest={'schema':1,'platform':platform.platform(),'upstream':'045b444ea1b52538d1b40273c7cb6ed09468a052','files':files}
path=OUT/'release.json';path.write_text(json.dumps(manifest,indent=2)+'\n');path.chmod(0o600)
result={'distribution':str(path),'distribution_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'node':str(OUT/'bin/node'),'node_sha256':files['bin/node'],'runtime':str(OUT/'apps/clientd/runtime.ts'),'runtime_sha256':files['apps/clientd/runtime.ts'],'node_version':node_version,'go_version':go_version,'production_signed':False,'source_lock_sha256':hashlib.sha256(source_lock_bytes).hexdigest(),'installed_lock_sha256':files['package-lock.json'],'sdk_tarball_sha256':files[archive]}
result['dependency_lock'] = lock_evidence
result['offline'] = args.offline
result['notices'] = notices
result['build_inputs'] = {'path': BUILD_INPUTS_PATH, 'sha256': files[BUILD_INPUTS_PATH], 'source_inputs_unchanged': True}
(OUT.parent/'distribution-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
