#!/usr/bin/env python3
"""Explicit dependency-fetch stage. Installs no toolchain and starts no service.

Run only after installing the pinned tools. Ordinary onboarding uses offline
caches and never invokes this preparation command automatically.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from general_api_tools import inspect_tools
from sdk_consumer_lock import materialize, sha

ROOT = Path(__file__).resolve().parents[1]


def main():
    inventory = inspect_tools(ROOT)
    if not inventory['passed']:
        raise SystemExit(json.dumps(inventory, indent=2))
    tools = inventory['executables']
    environment = {**os.environ, 'PATH': str(Path(tools['node']).parent) + os.pathsep + os.environ.get('PATH', ''),
                   'GOTOOLCHAIN': 'local', 'RUSTUP_TOOLCHAIN': '1.90.0', 'RUSTC': tools['rustc'], 'CARGO': tools['cargo']}
    environment.pop('CARGO_NET_OFFLINE', None)
    environment.pop('GOPROXY', None)
    out = ROOT/'target/general-api-dependencies'
    out.mkdir(parents=True, exist_ok=True, mode=0o700)
    run = Path(tempfile.mkdtemp(prefix='run-', dir=out))

    def command(args, cwd=ROOT):
        subprocess.run(list(map(str,args)),cwd=cwd,env=environment,check=True)

    command([tools['npm'],'ci','--ignore-scripts','--no-audit','--no-fund'])
    manifests = ['Cargo.toml','services/control/Cargo.toml','services/indexer/Cargo.toml','services/challenger/Cargo.toml',
                 'apps/clientd/prover/Cargo.toml','apps/clientd/companion/Cargo.toml','tests/svm/Cargo.toml','programs/zkapi-vault/Cargo.toml']
    for manifest in manifests:
        command([tools['cargo'],'fetch','--locked','--manifest-path',manifest])
    command([tools['go'],'-C',ROOT/'apps/clientd','mod','download'])
    command([tools['npm'],'pack','--workspace','@zkapi/solana-sdk','--pack-destination',run])
    version=json.loads((ROOT/'packages/sdk/package.json').read_text())['version']
    archive=run/f'zkapi-solana-sdk-{version}.tgz'
    locks={}
    for kind in ['sdk-consumer','clientd-runtime']:
        destination=run/kind
        destination.mkdir(mode=0o700)
        shutil.copyfile(archive,destination/archive.name)
        locks[kind]=materialize(destination,destination/archive.name,kind)
        command([tools['npm'],'ci','--ignore-scripts','--no-audit','--no-fund',*(['--omit=dev'] if kind=='clientd-runtime' else [])],destination)
    locks['cargo']={str(Path(p).with_name('Cargo.lock')):sha(ROOT/Path(p).with_name('Cargo.lock')) for p in manifests}
    locks['go']={'go.mod':sha(ROOT/'apps/clientd/go.mod')}
    report={'schema':1,'scope':'dependency cache preparation only','tools':inventory['tools'],'locks':locks,
            'providerActions':0,'transactionActions':0,'serviceActions':0}
    (run/'inventory.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'prepared':True,'inventory':str(run/'inventory.json')}))


if __name__ == '__main__':
    main()
