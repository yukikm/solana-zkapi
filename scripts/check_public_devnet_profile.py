#!/usr/bin/env python3
"""Offline acceptance of a generated profile and adversarial artifact/seed guards."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from public_devnet_profile import (FILES, ROOT, ProfileError, private_role_seeds,
                                  read_public_profile, sha)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    p = read_public_profile(args.profile, args.sha256)
    results = ['authentic_generated_profile_and_all_public_artifacts']
    for name, flags, message in (
        ('backend_missing_profile_fails_before_environment_access', [], 'select a fresh public profile'),
        ('backend_profile_requires_independent_hash', ['--public-devnet-profile', str(args.profile)], 'must be supplied together'),
        ('backend_public_and_legacy_flags_cannot_mix', ['--public-devnet-profile', str(args.profile),
          '--public-devnet-profile-sha256', args.sha256, '--allow-legacy-devnet-fixtures'], 'select a fresh public profile')):
        result = subprocess.run([sys.executable, str(ROOT/'scripts/run_i10_devnet_backend.py'), 'prepare',
                                 '--env-file', '/nonexistent-profile-guard-environment', *flags],
                                capture_output=True, text=True)
        assert result.returncode != 0 and message in result.stderr, name
        results.append(name)
    # Do not load the generated private seeds during these checks. The synthetic
    # seed inputs below have no relationship to any deployed or generated keys.
    with tempfile.TemporaryDirectory(prefix='profile-guard-', dir=ROOT / 'target') as temporary:
        test = Path(temporary)
        for name in (*FILES, 'public-profile.json'):
            shutil.copyfile(args.profile / name, test / name)
        original = (test / 'public-profile.json').read_bytes()
        def rejected(name, action, expected=None):
            action()
            try:
                read_public_profile(test, expected or sha((test / 'public-profile.json').read_bytes()))
            except ProfileError:
                results.append(name)
            else:
                raise AssertionError(name)
            (test / 'public-profile.json').write_bytes(original)
        def public_change(field, value):
            body = json.loads(original); body[field] = value
            (test / 'public-profile.json').write_text(json.dumps(body))
        rejected('independent_descriptor_pin_rejects_tampering', lambda: public_change('kind','other'), args.sha256)
        rejected('relabelled_setup_rejected_even_with_new_descriptor_hash', lambda: public_change('tree_setup','public_deterministic'))
        fixture = json.loads((ROOT / 'tests/fixtures/crypto/withdrawal-signed.json').read_bytes())['public_inputs']
        rejected('fixture_state_signing_key_rejected', lambda: public_change('state_key',{'x':fixture[4],'y':fixture[5]}))
        rejected('fixture_clearance_key_in_state_role_rejected', lambda: public_change('state_key',{'x':fixture[6],'y':fixture[7]}))
        rejected('shared_signing_roles_rejected', lambda: public_change('clearance_key',p['state_key']))
        rejected('shared_ed25519_roles_rejected', lambda: public_change('receipt_public_key',p['quote_public_key']))
        rejected('fixture_ed25519_public_key_rejected', lambda: public_change('quote_public_key','7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9'))
        tree = test / 'tree.vk'; saved = tree.read_bytes(); tree.write_bytes(saved + b'\0')
        rejected('tampered_tree_vk_rejected',lambda:None); tree.write_bytes(saved)
        tree.unlink(); tree.symlink_to(args.profile.resolve() / 'tree.vk')
        rejected('symlink_artifact_rejected',lambda:None); tree.unlink(); tree.write_bytes(saved)
        private = test / 'private'; private.mkdir(mode=0o700)
        for index, role in enumerate(('state','clearance','quote','receipt')):
            path=private / (role+'.seed');path.write_bytes(bytes([90+index])*32);path.chmod(0o600)
        assert len(private_role_seeds(test)) == 4
        results.append('private_role_files_are_explicitly_loaded_without_disclosure')
        for value,name in ((bytes(32),'zero_seed'),((31).to_bytes(32,'big'),'fixture_scalar'),(bytes([11])*32,'fixture_ed25519_seed')):
            path=private/'state.seed';path.write_bytes(value)
            try: private_role_seeds(test)
            except ProfileError: results.append(name+'_rejected')
            else: raise AssertionError(name)
        path.write_bytes(bytes([90])*32);path.chmod(0o644)
        try: private_role_seeds(test)
        except ProfileError: results.append('world_readable_seed_rejected')
        else: raise AssertionError('seed mode')
        path.chmod(0o600);path.unlink();path.symlink_to(private/'clearance.seed')
        try: private_role_seeds(test)
        except ProfileError: results.append('symlink_seed_rejected')
        else: raise AssertionError('seed symlink')
    print(json.dumps({'passed':True,'scope':'fresh offline public-profile identity/tamper and private-file guard checks; no chain or provider calls',
                      'checks':results,'count':len(results),'public_profile_sha256':args.sha256,'production_eligible':False},indent=2))


if __name__ == '__main__': main()
