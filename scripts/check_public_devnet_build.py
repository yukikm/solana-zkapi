#!/usr/bin/env python3
"""Exercise actual Vault build guards with public artifacts only; never deploy."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from public_devnet_profile import FILES, PROFILE_FIELDS, ROOT, read_public_profile, sha


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--second-profile', required=True, type=Path)
    parser.add_argument('--second-sha256', required=True)
    args = parser.parse_args()
    first = read_public_profile(args.profile, args.sha256)
    second = read_public_profile(args.second_profile, args.second_sha256)
    independent = ('state_key', 'clearance_key', 'quote_public_key', 'receipt_public_key')
    assert all(first[key] != second[key] for key in independent)
    assert first['tree_proof_artifacts']['vk_hash'] != second['tree_proof_artifacts']['vk_hash']
    fixture = json.loads((ROOT / 'tests/fixtures/layout2/profile.json').read_bytes())
    fixture_inputs = json.loads((ROOT / 'tests/fixtures/crypto/withdrawal-signed.json').read_bytes())['public_inputs']
    os.umask(0o077)
    results = [{'name':'independent_os_random_generations_have_distinct_all_role_and_tree_keys','passed':True}]
    with tempfile.TemporaryDirectory(prefix='public-build-check-', dir=ROOT/'target') as temporary:
        directory = Path(temporary)
        def reset():
            for name in (*FILES, 'public-profile.json'):
                shutil.copyfile(args.profile/name, directory/name)
        def rehash(public):
            circuit = {key:public[key] for key in PROFILE_FIELDS}
            circuit['circuit_profile_hash'] = sha(json.dumps(circuit,sort_keys=True,separators=(',',':')).encode())
            public['circuit_profile_hash'] = circuit['circuit_profile_hash']
            encoded=json.dumps(circuit,sort_keys=True,indent=2).encode()
            (directory/'profile.json').write_bytes(encoded)
            public['artifact_hashes']['profile.json']=sha(encoded)
            encoded=json.dumps(public,sort_keys=True,indent=2).encode()
            (directory/'public-profile.json').write_bytes(encoded)
            return sha(encoded)
        def check(name, *, expected=None, public_hash=None, legacy=False, no_profile=False):
            environment = dict(os.environ)
            for key in ('ZKAPI_PUBLIC_DEVNET_PROFILE','ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256','ZKAPI_ALLOW_LEGACY_DEVNET_FIXTURES'):
                environment.pop(key,None)
            # Public, synthetic addresses for host build validation only.
            environment.update(ZKAPI_DEVNET_PROGRAM_ID='9ZKaPRLwKibNaMpsz46iC7bpHQ9RoHsBbRuBFTBaHSp2',
                               ZKAPI_DEVNET_INITIALIZER='8qbHbw2BbbTHBW1sbeqakYXV5RKr6cF9sXByS3DxqroS')
            if not no_profile:
                environment.update(ZKAPI_PUBLIC_DEVNET_PROFILE=str(directory),
                                   ZKAPI_PUBLIC_DEVNET_PROFILE_SHA256=public_hash or sha((directory/'public-profile.json').read_bytes()))
            if legacy: environment['ZKAPI_ALLOW_LEGACY_DEVNET_FIXTURES']='1'
            result=subprocess.run(['cargo','check','--locked','--manifest-path','programs/zkapi-vault/Cargo.toml',
                                   '--no-default-features','--features','devnet'],cwd=ROOT,env=environment,
                                  stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=300)
            output=result.stdout.decode(errors='replace')
            if expected is None:
                assert result.returncode==0, name+' failed: '+output[-2500:]
            else:
                assert result.returncode!=0 and expected in output, name+' unexpected result: '+output[-2500:]
            results.append({'name':name,'passed':True,'expected_exit':'success' if expected is None else 'rejection'})
        reset();check('fresh_profile_actual_host_build')
        check('independent_descriptor_pin_mismatch',public_hash='00'*32,expected='independent public profile hash mismatch')
        public=json.loads((directory/'public-profile.json').read_bytes())
        public['state_key']={'x':fixture_inputs[4],'y':fixture_inputs[5]};rehash(public)
        check('fixture_state_key_even_with_rehashed_descriptor',expected='public fixture signing keys forbidden')
        reset();public=json.loads((directory/'public-profile.json').read_bytes())
        public['clearance_key']=public['state_key'];rehash(public)
        check('duplicate_signing_roles',expected='public fixture signing keys forbidden')
        reset();public=json.loads((directory/'public-profile.json').read_bytes())
        public['tree_proof_artifacts']['vk_hash']=fixture['tree_proof_artifacts']['vk_hash'];rehash(public)
        check('deterministic_tree_vk_even_with_rehashed_profile',expected='public deterministic tree fixture forbidden')
        reset();public=json.loads((directory/'public-profile.json').read_bytes())
        shutil.copyfile(args.second_profile/'tree.pk',directory/'tree.pk')
        changed=sha((directory/'tree.pk').read_bytes());public['artifact_hashes']['tree.pk']=changed
        public['tree_proof_artifacts']['pk_hash']=changed;rehash(public)
        check('individually_valid_other_setup_pk_with_wrong_vk',expected='tree PK/VK correspondence')
        reset();check('public_and_legacy_modes_cannot_mix',legacy=True,expected='public and legacy devnet profiles are mutually exclusive')
        check('devnet_without_explicit_profile_refused',no_profile=True,expected='devnet requires a fresh public profile or explicit legacy fixture opt-in')
        check('explicit_legacy_profile_remains_buildable',no_profile=True,legacy=True)
    print(json.dumps({'passed':True,'scope':'fresh offline host build and expected-failure public cryptographic pin checks; no SBF execution or chain transactions',
                      'count':len(results),'checks':results,'public_profile_sha256':args.sha256,
                      'second_public_profile_sha256':args.second_sha256,'production_eligible':False},indent=2))


if __name__=='__main__': main()
