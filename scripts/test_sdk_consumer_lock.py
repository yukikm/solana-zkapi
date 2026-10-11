"""Reviewed dependency fixture regression tests; no network or financial state."""
import copy
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

from sdk_consumer_lock import ROOT, materialize, reviewed


class ConsumerLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='zkapi-lock-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.root = self.path/'source'
        for name in ['package-lock.json','packages/sdk/package.json',*[f'tests/fixtures/{kind}/{file}' for kind in ['sdk-consumer','clientd-runtime'] for file in ['package.json','package-lock.json']]]:
            destination=self.root/name;destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,destination)
        self.consumer=self.path/'consumer';self.consumer.mkdir()
        self.archive=self.consumer/'fresh-sdk.tgz'
        metadata=(self.root/'packages/sdk/package.json').read_bytes()
        with tarfile.open(self.archive,'w:gz') as archive:
            info=tarfile.TarInfo('package/package.json');info.size=len(metadata);archive.addfile(info,io.BytesIO(metadata))

    def test_only_local_artifact_fields_change(self):
        for kind in ['sdk-consumer','clientd-runtime']:
            destination=self.path/kind;destination.mkdir();artifact=destination/'sdk.tgz';shutil.copyfile(self.archive,artifact)
            package,lock,_=reviewed(kind,root=self.root)
            evidence=materialize(destination,artifact,kind,root=self.root)
            actual=json.loads((destination/'package-lock.json').read_text())
            actual['packages']['']['dependencies']['@zkapi/solana-sdk']=lock['packages']['']['dependencies']['@zkapi/solana-sdk']
            for key in ['version','resolved','integrity']:
                actual['packages']['node_modules/@zkapi/solana-sdk'][key]=lock['packages']['node_modules/@zkapi/solana-sdk'][key]
            self.assertEqual(actual,lock)
            self.assertEqual(len(evidence['materialized_lock_sha256']),64)
            with self.assertRaisesRegex(ValueError,'already exists'):
                materialize(destination,artifact,kind,root=self.root)

    def test_source_dependency_and_pin_drift_rejected(self):
        path=self.root/'package-lock.json';original=json.loads(path.read_text())
        for key in ['version','resolved','integrity']:
            changed=copy.deepcopy(original);changed['packages']['node_modules/bs58'][key]='drift';path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError,'pin drifted'):
                materialize(self.consumer,self.archive,root=self.root)
        path.write_text(json.dumps(original))
        package_path=self.root/'packages/sdk/package.json';package=json.loads(package_path.read_text());package['dependencies']['bs58']='7.0.0';package_path.write_text(json.dumps(package))
        with self.assertRaisesRegex(ValueError,'declarations drifted'):
            materialize(self.consumer,self.archive,root=self.root)
        self.assertFalse((self.consumer/'package-lock.json').exists())

    def test_runtime_graph_and_esbuild_platform_missing_rejected(self):
        path=self.root/'tests/fixtures/sdk-consumer/package-lock.json';original=json.loads(path.read_text())
        for name in ['node_modules/bs58','node_modules/@esbuild/darwin-arm64']:
            changed=copy.deepcopy(original);del changed['packages'][name];path.write_text(json.dumps(changed))
            with self.assertRaisesRegex(ValueError,'graph drifted|platform dependency missing'):
                reviewed(root=self.root)
        path.write_text(json.dumps(original))

    def test_missing_offline_cache_fails_without_lock_mutation(self):
        materialize(self.consumer,self.archive,root=self.root)
        before=(self.consumer/'package-lock.json').read_bytes()
        env={**os.environ,'npm_config_registry':'http://127.0.0.1:1','npm_config_fetch_retries':'0'}
        if os.environ.get('ZKAPI_NODE'):
            env['PATH']=str(Path(os.environ['ZKAPI_NODE']).parent)+os.pathsep+env['PATH']
        result=subprocess.run(['npm','ci','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',str(self.path/'empty-cache')],cwd=self.consumer,env=env,capture_output=True,text=True,timeout=45)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('ENOTCACHED',result.stderr)
        self.assertEqual((self.consumer/'package-lock.json').read_bytes(),before)


if __name__=='__main__':unittest.main()
