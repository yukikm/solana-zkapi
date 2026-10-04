#!/usr/bin/env python3
"""Assemble the current OS clientd with an externally pinnable full-file manifest.
No production signature or other-OS support is claimed by a local build.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'target/i08-clientd/distribution'
GO = os.environ.get('ZKAPI_GO', shutil.which('go') or str(ROOT / 'target/toolchains/go/bin/go'))
NODE = os.environ.get('ZKAPI_NODE', shutil.which('node') or '')
if OUT.exists():
    raise SystemExit('distribution already exists; choose a clean target by removing this generated output explicitly')
OUT.mkdir(parents=True, mode=0o700)
(OUT / 'bin').mkdir()
subprocess.run([GO, '-C', str(ROOT / 'apps/clientd'), 'build', '-trimpath', '-buildvcs=false', '-ldflags=-buildid=', '-o', str(OUT / 'bin/clientd'), './cmd/clientd'], check=True, env={**os.environ,'GOTOOLCHAIN':'local'})
for manifest in ['apps/clientd/companion/Cargo.toml', 'apps/clientd/prover/Cargo.toml']:
    subprocess.run(['cargo','build','--release','--locked','--manifest-path',manifest],cwd=ROOT,check=True)
for source, target in [(NODE,'bin/node'),('apps/clientd/companion/target/release/zkapi-client-verify','bin/zkapi-client-verify'),('apps/clientd/prover/target/release/zkapi-client-prover','bin/zkapi-client-prover')]:
    path=Path(source); path=path if path.is_absolute() else ROOT/path
    shutil.copy2(path,OUT/target)
for source in ['packages/sdk/src','node_modules']:
    shutil.copytree(ROOT/source,OUT/source,symlinks=False,ignore=shutil.ignore_patterns('.cache'))
for source in ['apps/clientd/runtime.ts','apps/clientd/go.mod','apps/clientd/companion/Cargo.lock','apps/clientd/prover/Cargo.lock','package.json','package-lock.json','packages/sdk/package.json','vendor/ethereum-zkapi/zkapi-clientd/LICENSE']:
    destination=OUT/source;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/source,destination)
for path in [OUT,*OUT.rglob('*')]:
    os.chmod(path,0o700 if path.is_dir() or os.access(path,os.X_OK) else 0o600)
files={str(p.relative_to(OUT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(OUT.rglob('*')) if p.is_file()}
manifest={'schema':1,'platform':platform.platform(),'upstream':'045b444ea1b52538d1b40273c7cb6ed09468a052','files':files}
path=OUT/'release.json';path.write_text(json.dumps(manifest,indent=2)+'\n');path.chmod(0o600)
result={'distribution':str(path),'distribution_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'node':str(OUT/'bin/node'),'node_sha256':files['bin/node'],'runtime':str(OUT/'apps/clientd/runtime.ts'),'runtime_sha256':files['apps/clientd/runtime.ts'],'node_version':subprocess.check_output([NODE,'--version'],text=True).strip(),'go_version':subprocess.check_output([GO,'version'],text=True).strip(),'production_signed':False}
(OUT.parent/'distribution-result.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
