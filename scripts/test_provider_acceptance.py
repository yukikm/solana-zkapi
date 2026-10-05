#!/usr/bin/env python3
"""Offline tests only: synthetic credentials/rates; no provider or wallet inputs."""
import contextlib
import io
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import provider_acceptance as p


def fixture(directory):
    source = directory / 'source.txt'
    source.write_text('Synthetic offline model limits/prices, not provider evidence.\n')
    tariff = {'version': '1', 'provider': 'openai', 'model': 'offline-fixture',
              'pricing_basis': 'fixed_usage_rates', 'valid_from': '1', 'valid_until': '9999999999',
              'operator_fee_micro_usdc': '0', 'rates': [
                  {'unit': unit, 'nano_usdc_numerator': str(rate), 'unit_denominator': '1'}
                  for unit, rate in [('cache_read_tokens', 1), ('input_tokens', 2), ('output_tokens', 3)]]}
    tariff['tariff_hash'] = p.sha(p.canonical(tariff))
    return {'schema': 1, 'campaign_id': 'offline-test', 'budget_micro_usdc': '10000000',
            'usd_usdc_ratio': '1:1', 'max_requests': 3, 'max_output_tokens': 64,
            'models': [{'profile': {'provider': 'openai', 'model': 'offline-fixture',
                                  'endpoints': ['chat_completions', 'responses'], 'context_tokens': 1000,
                                  'max_output_tokens': 64, 'cache_mode': 'inclusive_read'},
                        'tariff': tariff, 'sources': [{'url': 'https://docs.example.invalid/test',
                            'retrieved_at': '2026-10-05T00:00:00Z', 'file': source.name,
                            'sha256': p.sha(source.read_bytes())}]}],
            'cases': [{'id': 'plain', 'mode': 'proxy', 'provider': 'openai', 'model': 'offline-fixture',
                       'endpoint': 'chat_completions', 'stream': False, 'tools': False,
                       'max_output_tokens': 64, 'max_cost_micro_usdc': '3', 'session_ttl_seconds': 60}]}


def reserve_process(directory, plan, queue):
    try:
        p.Budget(Path(directory), plan).reserve('plain')
        queue.put(True)
    except p.Failure:
        queue.put(False)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='provider-offline-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = fixture(self.root)
        self.env = {'ZKAPI_PROVIDER_BUDGET_MICRO_USDC': '10000000'}

    def test_no_keys_is_zero_network_incomplete(self):
        with patch('socket.socket', side_effect=AssertionError('network forbidden')):
            result = p.preflight(self.plan, self.env, self.root)
        self.assertEqual(result['network_requests'], 0)
        self.assertFalse(result['ready_for_native_config_validation'])
        self.assertFalse(result['provider_credentials_verified'])
        self.assertFalse(result['g3_passed'])
        self.assertEqual(result['missing_environment_fields'], ['ZKAPI_OPENAI_API_KEY'])

    def test_empty_template_stays_read_only_and_cannot_pin_empty_configuration(self):
        self.plan['models'] = []
        self.plan['cases'] = []
        self.assertFalse(p.preflight(self.plan, self.env, self.root)['ready_for_native_config_validation'])
        out = self.root / 'empty'
        out.mkdir(mode=0o700)
        with self.assertRaisesRegex(p.Failure, 'empty template'):
            p.preflight(self.plan, self.env, self.root, out)
        with self.assertRaisesRegex(p.Failure, 'empty template'):
            p.Budget(out, self.plan).initialize()
        self.assertFalse((out / 'providers.json').exists())
        self.assertFalse((out / 'budget-identity.json').exists())

    def test_environment_whitelist_literal_no_execution_and_no_secret_output(self):
        envfile = self.root / '.env'
        envfile.write_text('WALLET_PRIVATE_KEY_PATH=/do/not/read\nSOLANA_DEVNET_RPC=https://secret.invalid\n'
                           'ZKAPI_PROVIDER_BUDGET_MICRO_USDC=10000000\n'
                           'ZKAPI_OPENAI_API_KEY="fixture-secret-canary-$(false)"\n')
        envfile.chmod(0o600)
        env = p.load_environment(envfile, {})
        self.assertNotIn('WALLET_PRIVATE_KEY_PATH', env)
        self.assertNotIn('SOLANA_DEVNET_RPC', env)
        self.assertEqual(env['ZKAPI_OPENAI_API_KEY'], 'fixture-secret-canary-$(false)')
        report = p.preflight(self.plan, env, self.root)
        self.assertNotIn('fixture-secret', json.dumps(report))
        self.assertNotIn('secret.invalid', json.dumps(report))

    def test_prepare_private_immutable_files_input_untouched(self):
        key = self.root / 'provided.key'
        key.write_bytes(b'offline-secret-canary')
        key.chmod(0o600)
        original = key.read_bytes()
        env = {**self.env, 'ZKAPI_OPENAI_API_KEY_FILE': str(key)}
        out = self.root / 'prepared'
        out.mkdir(mode=0o700)
        with patch('socket.socket', side_effect=AssertionError('network forbidden')):
            first = p.preflight(self.plan, env, self.root, out)
            p.preflight(self.plan, env, self.root, out)
        self.assertTrue(first['ready_for_native_config_validation'])
        self.assertFalse(first['provider_credentials_verified'])
        self.assertEqual(key.read_bytes(), original)
        for target in [out / 'credentials/openai.credential', out / 'providers.json', out / 'tariffs.json']:
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('offline-secret', json.dumps(first))
        providers = p.read_json(out / 'providers.json')
        self.assertIsNone(providers['proxy'][0]['local_test_base'])
        key.write_bytes(b'new-credential')
        with self.assertRaisesRegex(p.Failure, 'persistent configuration changed'):
            p.preflight(self.plan, env, self.root, out)

    def test_conflicting_insecure_or_whitespace_credentials_reject(self):
        key = self.root / 'key'
        key.write_bytes(b'fixture-key')
        key.chmod(0o644)
        for env in [{'ZKAPI_OPENAI_API_KEY': 'a', 'ZKAPI_OPENAI_API_KEY_FILE': str(key)},
                    {'ZKAPI_OPENAI_API_KEY_FILE': str(key)}, {'ZKAPI_OPENAI_API_KEY': 'has space'},
                    {'ZKAPI_OPENAI_API_KEY': 'has\nnewline'}]:
            with self.assertRaises(p.Failure):
                p.credentials(env)
        key.chmod(0o600)
        symlink = self.root / 'link'
        symlink.symlink_to(key)
        with self.assertRaises(p.Failure):
            p.credentials({'ZKAPI_OPENAI_API_KEY_FILE': str(symlink)})

    def test_metadata_preflight_does_not_read_file_credential(self):
        key = self.root / 'key'
        key.write_bytes(b'fixture-key')
        key.chmod(0o600)
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('credential read forbidden')):
            result = p.credentials({'ZKAPI_OPENAI_API_KEY_FILE': str(key)})
        self.assertFalse(result['openai']['credential_contents_verified'])

    def test_strict_plan_limits_and_source_integrity(self):
        self.assertEqual(p.validate_plan(self.plan, self.root)['planned_max_micro_usdc'], '3')
        variants = []
        for field, value in [('max_cost_micro_usdc', '2'), ('max_output_tokens', 65),
                             ('endpoint', 'count_tokens'), ('mode', 'unknown')]:
            changed = json.loads(json.dumps(self.plan))
            changed['cases'][0][field] = value
            variants.append(changed)
        changed = json.loads(json.dumps(self.plan))
        changed['budget_micro_usdc'] = '10000001'
        variants.append(changed)
        changed = json.loads(json.dumps(self.plan))
        changed['models'][0]['tariff']['rates'][0]['nano_usdc_numerator'] = '10000'
        variants.append(changed)
        for changed in variants:
            with self.assertRaises(p.Failure):
                p.validate_plan(changed, self.root)
        (self.root / 'source.txt').write_text('changed')
        with self.assertRaisesRegex(p.Failure, 'saved source hash'):
            p.validate_plan(self.plan, self.root)

    def test_budget_before_send_reopen_no_refund_and_unknown_no_replay(self):
        budget = p.Budget(self.root / 'budget', self.plan)
        budget.initialize()
        result = budget.reserve('plain')
        self.assertTrue(result['send_authorized_once'])
        reopened = p.Budget(self.root / 'budget', self.plan)
        reopened.initialize()
        self.assertEqual(reopened.status()['reserved_micro_usdc'], '3')
        with self.assertRaisesRegex(p.Failure, 'no automatic replay'):
            reopened.reserve('plain')
        self.assertFalse(reopened.status()['refunds_supported'])

    def test_concurrent_reservations_allow_only_one_sender(self):
        directory = self.root / 'budget'
        p.Budget(directory, self.plan).initialize()
        context = multiprocessing.get_context('spawn')
        queue = context.Queue()
        children = [context.Process(target=reserve_process, args=(str(directory), self.plan, queue)) for _ in range(4)]
        for child in children:
            child.start()
        outcomes = [queue.get(timeout=20) for _ in children]
        for child in children:
            child.join(20)
            self.assertEqual(child.exitcode, 0)
        self.assertEqual(sum(outcomes), 1)
        self.assertEqual(p.Budget(directory, self.plan).status()['reserved_micro_usdc'], '3')

    def test_missing_substituted_or_partial_budget_never_reinitializes(self):
        directory = self.root / 'budget'
        budget = p.Budget(directory, self.plan)
        budget.initialize()
        saved = (directory / 'budget-state.json').read_bytes()
        (directory / 'budget-state.json').unlink()
        with self.assertRaises((p.Failure, FileNotFoundError)):
            budget.initialize()
        p.atomic(directory / 'budget-state.json', saved)
        changed = json.loads(json.dumps(self.plan))
        changed['campaign_id'] = 'different'
        with self.assertRaises(p.Failure):
            p.Budget(directory, changed).initialize()
        (directory / 'budget-state.json').write_bytes(b'{"identity":')
        with self.assertRaises(Exception):
            budget.reserve('plain')

    def test_persistence_failure_never_authorizes_send(self):
        directory = self.root / 'budget'
        budget = p.Budget(directory, self.plan)
        budget.initialize()
        with patch('os.fsync', side_effect=OSError('synthetic disk fault')):
            with self.assertRaises(OSError):
                budget.reserve('plain')
        self.assertEqual(budget.status()['reserved_micro_usdc'], '0')

    def test_post_rename_fsync_failure_keeps_conservative_reservation(self):
        budget = p.Budget(self.root / 'budget', self.plan)
        budget.initialize()
        original, calls = os.fsync, 0
        def fail_directory_once(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('synthetic directory fsync failure')
            return original(fd)
        with patch('os.fsync', side_effect=fail_directory_once):
            with self.assertRaises(OSError):
                budget.reserve('plain')
        self.assertEqual(budget.status()['reserved_micro_usdc'], '3')
        with self.assertRaisesRegex(p.Failure, 'no automatic replay'):
            budget.reserve('plain')

    def test_direct_roles_and_oa_pins_are_not_inference_key_substitutes(self):
        tariff = {'version': '1', 'provider': 'oa', 'model': '*', 'pricing_basis': 'provider_reported_usd',
                  'valid_from': '1', 'valid_until': '9999999999', 'rates': [], 'operator_fee_micro_usdc': '0'}
        tariff['tariff_hash'] = p.sha(p.canonical(tariff))
        self.plan['models'][0].update(profile=None, tariff=tariff)
        self.plan['cases'][0].update(mode='direct_oa', provider='oa', model='provider-model')
        result = p.preflight(self.plan, {**self.env, 'ZKAPI_OPENAI_API_KEY': 'fixture'}, self.root)
        self.assertIn('ZKAPI_OA_ORGANIZATION_KEY', result['missing_environment_fields'])
        self.assertIn('ZKAPI_OA_VERIFIER_BASE', result['missing_environment_fields'])
        self.plan['cases'][0]['session_ttl_seconds'] = 61
        with self.assertRaises(p.Failure):
            p.validate_plan(self.plan, self.root)

    def test_selected_profiles_keep_one_parent_budget_and_only_copy_selected_credentials(self):
        other = json.loads(json.dumps(self.plan['models'][0]))
        other['profile']['provider'] = 'openrouter'
        other['profile']['endpoints'] = ['chat_completions']
        other['tariff']['provider'] = 'openrouter'
        other['tariff']['tariff_hash'] = p.sha(p.canonical({k: v for k, v in other['tariff'].items() if k != 'tariff_hash'}))
        self.plan['models'].append(other)
        self.plan['cases'].extend([{**self.plan['cases'][0], 'id': 'responses', 'endpoint': 'responses'},
                                   {**self.plan['cases'][0], 'id': 'router', 'provider': 'openrouter'}])
        state = self.root / 'global'
        budget = p.Budget(state, self.plan)
        budget.initialize()
        marker = (state / 'budget-identity.json').read_bytes()
        untouched = (state / 'budget-state.json').read_bytes()
        env = {**self.env, 'ZKAPI_OPENAI_API_KEY': 'offline-fixture',
               'ZKAPI_OPENROUTER_API_KEY_FILE': '/must-not-be-opened/unconfigured-key'}
        with patch('socket.socket', side_effect=AssertionError('network forbidden')):
            for profile, case in [('openai-native', 'responses'), ('openai-ui', 'plain')]:
                report = p.preflight(self.plan, env, self.root, state, 'openai', [case], profile)
                directory = state / 'configurations' / profile
                self.assertTrue(report['ready_for_native_config_validation'])
                self.assertEqual(report['plan_sha256'], p.sha(p.canonical(self.plan)))
                self.assertEqual(report['selected_requests'], 1)
                self.assertEqual(report['selection']['case_ids'], [case])
                self.assertEqual(set(report['credentials']), {'openai'})
                self.assertEqual(len(p.read_json(directory / 'tariffs.json')), 1)
                self.assertEqual(p.read_json(directory / 'providers.json')['proxy'][0]['provider'], 'openai')
                self.assertEqual({x.name for x in (directory / 'credentials').iterdir()}, {'openai.credential'})
                self.assertFalse((directory / 'budget-state.json').exists())
                self.assertEqual((directory / 'selection.json').stat().st_mode & 0o777, 0o600)
                p.preflight(self.plan, env, self.root, state, 'openai', [case], profile)
        self.assertEqual((state / 'budget-state.json').read_bytes(), untouched)
        budget.reserve('responses')
        budget.reserve('plain')
        self.assertEqual(budget.status()['reserved_micro_usdc'], '6')
        self.assertEqual((state / 'budget-identity.json').read_bytes(), marker)
        with self.assertRaisesRegex(p.Failure, 'no automatic replay'):
            p.Budget(state, self.plan).reserve('plain')
        with self.assertRaisesRegex(p.Failure, 'persistent configuration changed'):
            p.preflight(self.plan, env, self.root, state, 'openai', ['responses'], 'openai-ui')

    def test_selectors_reject_unknown_wrong_role_duplicate_and_unsafe_profile(self):
        for role, ids, name in [(None, ['plain'], None), (None, None, 'x'), ('missing', None, None),
                               ('openai', ['missing'], None), ('openai', ['plain', 'plain'], None),
                               ('openai', [], None), ('openrouter', ['plain'], None),
                               ('openai', None, '../escape'), ('openai', None, ''), ('openai', None, 'UPPER')]:
            with self.assertRaises(p.Failure):
                p.select_profile(self.plan, role, ids, name)
        self.plan['cases'].append({**self.plan['cases'][0], 'id': 'second'})
        selection, execution = p.select_profile(self.plan, 'openai', ['second', 'plain'])
        self.assertEqual(selection['profile'], 'openai')
        self.assertEqual(selection['case_ids'], ['plain', 'second'])
        self.assertEqual([c['id'] for c in execution['cases']], ['plain', 'second'])
        self.assertEqual(self.plan['cases'][0]['id'], 'plain')

    def test_cli_selection_and_existing_single_case_reserve_share_parent_identity(self):
        planfile = self.root / 'plan.json'
        planfile.write_text(json.dumps(self.plan))
        directory = self.root / 'global'
        p.Budget(directory, self.plan).initialize()
        def command(args):
            output = io.StringIO()
            with patch('sys.argv', ['provider_acceptance.py', *args, '--plan', str(planfile), '--state-dir', str(directory)]), \
                    patch.object(p, 'load_environment', return_value={**self.env, 'ZKAPI_OPENAI_API_KEY': 'offline-fixture'}), \
                    contextlib.redirect_stdout(output):
                code = p.main()
            return code, json.loads(output.getvalue())
        code, preflight = command(['preflight', '--role', 'openai', '--profile', 'openai-native', '--case', 'plain'])
        self.assertEqual(code, 0)
        self.assertEqual(preflight['selection']['case_ids'], ['plain'])
        code, reserved = command(['reserve', '--case', 'plain'])
        self.assertEqual(code, 0)
        self.assertEqual(reserved['plan_sha256'], preflight['selection']['parent_plan_sha256'])
        before = (directory / 'budget-state.json').read_bytes()
        self.assertEqual(command(['reserve', '--case', 'plain', '--case', 'plain'])[0], 1)
        self.assertEqual(command(['budget-init', '--role', 'openai'])[0], 1)
        self.assertEqual((directory / 'budget-state.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
