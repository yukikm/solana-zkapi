#!/usr/bin/env python3
"""Temporary ledgers only. No actual budget, provider credential or network."""
import contextlib
import io
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

import provider_acceptance as old
import provider_demo_budget as demo
from test_provider_acceptance import fixture


def direct_process(directory, plan, request_id, digest, queue):
    try:
        row = demo.DemoBudget(Path(directory), plan).reserve_direct_demo('openrouter-direct-plain', request_id, digest)
        queue.put((True, row['newly_reserved']))
    except old.Failure:
        queue.put((False, False))


class DemoBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='direct-demo-budget-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.plan = fixture(self.root)
        self.plan['max_requests'] = 18
        self.plan['cases'][0]['id'] = 'openai-chat-plain'
        direct_tariff = {**self.plan['models'][0]['tariff'], 'provider': 'openrouter', 'model': '*',
                         'pricing_basis': 'provider_reported_usd', 'rates': []}
        del direct_tariff['tariff_hash']
        direct_tariff['tariff_hash'] = old.sha(old.canonical(direct_tariff))
        self.plan['models'].append({'profile': None, 'tariff': direct_tariff, 'sources': self.plan['models'][0]['sources']})
        for stream in (False, True):
            self.plan['cases'].append({**self.plan['cases'][0], 'id': 'openrouter-direct-' + ('sse' if stream else 'plain'),
                                      'mode': 'direct_openrouter', 'provider': 'openrouter', 'stream': stream,
                                      'max_cost_micro_usdc': '1000000'})
        self.directory = self.root / 'budget'
        old.Budget(self.directory, self.plan).initialize()
        self.budget = demo.DemoBudget(self.directory, self.plan)
        self.request = str(uuid.uuid4())
        self.digest = 'ab' * 32

    def reserve(self, template='openrouter-direct-plain', request=None, digest=None):
        return self.budget.reserve_direct_demo(template, request or self.request, digest or self.digest)

    def test_pinned_existing_campaign_and_prior_rows_remain_unchanged(self):
        old.Budget(self.directory, self.plan).reserve('openai-chat-plain')
        old.Budget(self.directory, self.plan).reserve_demo('openai-chat-plain', str(uuid.uuid4()), str(uuid.uuid4()))
        before = self.budget.status()
        marker = (self.directory / 'budget-identity.json').read_bytes()
        plan = old.canonical(self.plan)
        result = self.reserve()
        self.assertTrue(result['newly_reserved'])
        self.assertTrue(result['auth_forward_allowed'])
        self.assertFalse(result['inference_replays_supported'])
        self.assertNotIn('operation_id', result)
        self.assertNotIn('send_authorized_once', result)
        after = self.budget.status()
        self.assertEqual(after['reservations'][:-1], before['reservations'])
        self.assertEqual(after['identity'], before['identity'])
        self.assertEqual(after['reserved_micro_usdc'], '1000006')
        self.assertEqual((self.directory / 'budget-identity.json').read_bytes(), marker)
        self.assertEqual(old.canonical(self.plan), plan)
        # The compatibility helper still supports existing fixed OpenAI policy.
        self.budget.reserve_demo('openai-chat-plain', str(uuid.uuid4()), str(uuid.uuid4()))
        self.assertEqual(self.budget.status()['reserved_micro_usdc'], '1000009')

    def test_only_exact_auth_retry_is_idempotent_across_restart(self):
        self.reserve()
        before = (self.directory / 'budget-state.json').read_bytes()
        reopened = demo.DemoBudget(self.directory, self.plan)
        again = reopened.reserve_direct_demo('openrouter-direct-plain', self.request, self.digest)
        self.assertFalse(again['newly_reserved'])
        self.assertTrue(again['auth_forward_allowed'])
        self.assertEqual((self.directory / 'budget-state.json').read_bytes(), before)
        for template, digest in [('openrouter-direct-sse', self.digest), ('openrouter-direct-plain', 'cd' * 32)]:
            with self.assertRaisesRegex(old.Failure, 'different AUTH or template'):
                reopened.reserve_direct_demo(template, self.request, digest)
        self.assertEqual((self.directory / 'budget-state.json').read_bytes(), before)
        self.reserve(request=str(uuid.uuid4()))
        self.assertEqual(self.budget.status()['reserved_micro_usdc'], '2000000')

    def test_admission_suspension_preserves_only_exact_auth_recovery(self):
        before = (self.directory / 'budget-state.json').read_bytes()
        with self.assertRaisesRegex(old.Failure, 'admission suspended'):
            self.budget.reserve_direct_demo('openrouter-direct-plain', self.request, self.digest, allow_new=False)
        self.assertEqual((self.directory / 'budget-state.json').read_bytes(), before)
        self.reserve()
        before = (self.directory / 'budget-state.json').read_bytes()
        result = self.budget.reserve_direct_demo('openrouter-direct-plain', self.request, self.digest, allow_new=False)
        self.assertFalse(result['newly_reserved'])
        self.assertTrue(result['auth_forward_allowed'])
        with self.assertRaisesRegex(old.Failure, 'different AUTH'):
            self.budget.reserve_direct_demo('openrouter-direct-plain', self.request, 'cd' * 32, allow_new=False)
        with self.assertRaisesRegex(old.Failure, 'admission suspended'):
            self.budget.reserve_direct_demo('openrouter-direct-plain', str(uuid.uuid4()), self.digest, allow_new=False)
        self.assertEqual((self.directory / 'budget-state.json').read_bytes(), before)

    def test_same_lock_serializes_exact_and_conflicting_concurrent_auth(self):
        ctx = multiprocessing.get_context('spawn')
        queue = ctx.Queue()
        children = [ctx.Process(target=direct_process, args=(str(self.directory), self.plan, self.request, self.digest, queue)) for _ in range(4)]
        for child in children:
            child.start()
        outcomes = [queue.get(timeout=20) for _ in children]
        for child in children:
            child.join(20)
            self.assertEqual(child.exitcode, 0)
        self.assertTrue(all(allowed for allowed, _ in outcomes))
        self.assertEqual(sum(new for _, new in outcomes), 1)
        self.assertEqual(len(self.budget.status()['reservations']), 1)
        children = [ctx.Process(target=direct_process, args=(str(self.directory), self.plan, self.request, digest, queue)) for digest in [self.digest, 'ef' * 32]]
        for child in children:
            child.start()
        outcomes = [queue.get(timeout=20) for _ in children]
        for child in children:
            child.join(20)
            self.assertEqual(child.exitcode, 0)
        self.assertEqual(sum(allowed for allowed, _ in outcomes), 1)
        self.assertEqual(sum(new for _, new in outcomes), 0)

    def test_original_money_and_request_caps_apply_to_new_sessions(self):
        for name, limit in [('money', '1000000'), ('count', '10000000')]:
            plan = json.loads(json.dumps(self.plan))
            plan['budget_micro_usdc'] = limit
            plan['max_requests'] = 1 if name == 'count' else 18
            directory = self.root / name
            old.Budget(directory, plan).initialize()
            budget = demo.DemoBudget(directory, plan)
            budget.reserve_direct_demo('openrouter-direct-plain', self.request, self.digest)
            with self.assertRaisesRegex(old.Failure, 'budget exhausted'):
                budget.reserve_direct_demo('openrouter-direct-sse', str(uuid.uuid4()), '12' * 32)
            self.assertFalse(budget.reserve_direct_demo('openrouter-direct-plain', self.request, self.digest)['newly_reserved'])
            self.assertEqual(len(budget.status()['reservations']), 1)

    def test_uncertain_fsync_never_authorizes_before_durable_retry(self):
        original_fsync, calls = os.fsync, 0
        def fail_directory(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('synthetic fsync failure')
            return original_fsync(fd)
        with patch('os.fsync', side_effect=fail_directory):
            with self.assertRaises(OSError):
                self.reserve()
        self.assertEqual(self.budget.status()['reserved_micro_usdc'], '1000000')
        with patch('os.fsync', side_effect=OSError('synthetic repeated failure')):
            with self.assertRaises(OSError):
                self.reserve()
        self.assertFalse(self.reserve()['newly_reserved'])
        self.assertEqual(len(self.budget.status()['reservations']), 1)

    def test_bad_ids_templates_caps_and_mixed_proxy_sessions_fail_closed(self):
        before = (self.directory / 'budget-state.json').read_bytes()
        for template, request, digest in [('openai-chat-plain', self.request, self.digest),
                ('openrouter-direct-plain', 'invalid', self.digest), ('openrouter-direct-plain', self.request, 'AA' * 32)]:
            with self.assertRaises(old.Failure):
                self.budget.reserve_direct_demo(template, request, digest)
            self.assertEqual((self.directory / 'budget-state.json').read_bytes(), before)
        self.budget.reserve_demo('openai-chat-plain', self.request, str(uuid.uuid4()))
        with self.assertRaisesRegex(old.Failure, 'different AUTH'):
            self.reserve()
        self.reserve(request=str(uuid.uuid4()))
        saved = old.read_json(self.directory / 'budget-state.json')
        for field, value in [('max_cost_micro_usdc', '1'), ('template_case_id', 'openai-chat-plain'),
                             ('authorization_sha256', 'invalid'), ('request_id', self.request),
                             ('kind', 'explicit_demo'), ('operation_id', str(uuid.uuid4())), ('state', 'completed')]:
            changed = json.loads(json.dumps(saved))
            changed['reservations'][-1][field] = value
            old.atomic(self.directory / 'budget-state.json', old.canonical(changed))
            with self.assertRaises(old.Failure):
                self.budget.status()
        old.atomic(self.directory / 'budget-state.json', old.canonical(saved))

    def test_copied_historical_ten_row_budget_remains_readable_and_append_only(self):
        # Frozen regression input copied into an isolated owner-only directory.
        root = Path(__file__).resolve().parents[1]
        plan = old.read_json(root / 'config/provider-acceptance.i10.json')
        evidence = old.read_json(root / 'tests/fixtures/provider/historical-budget.json')
        self.assertEqual(len(evidence['reservations']), 10)
        self.assertEqual(sum(int(row['max_cost_micro_usdc']) for row in evidence['reservations']), 2154216)
        directory = self.root / 'historical-copy'
        old.make_private(directory)
        old.atomic(directory / 'budget-identity.json', old.canonical(evidence['identity']))
        old.atomic(directory / 'budget-state.json', old.canonical({k: evidence[k] for k in ('identity', 'reservations')}))
        budget = demo.DemoBudget(directory, plan)
        self.assertEqual({k: budget.status()[k] for k in ('identity', 'reservations')}, evidence)
        budget.reserve_direct_demo('openrouter-direct-plain', self.request, self.digest)
        latest = budget.status()
        self.assertEqual(latest['reservations'][:10], evidence['reservations'])
        self.assertEqual(latest['reserved_micro_usdc'], '3154216')
        self.assertEqual(latest['remaining_micro_usdc'], '6845784')
        # Frozen native acceptance rejects new kinds; compatibility readers must
        # use this helper. It never silently ignores their consumed capacity.
        with self.assertRaises(old.Failure):
            old.Budget(directory, plan).status()

    def test_cli_has_no_initialize_and_accepts_no_operation_id_for_direct(self):
        planfile = self.root / 'plan.json'
        planfile.write_bytes(old.canonical(self.plan))
        def command(extra):
            output = io.StringIO()
            with patch('sys.argv', ['provider_demo_budget.py', *extra, '--plan', str(planfile), '--state-dir', str(self.directory)]), \
                    patch('socket.socket', side_effect=AssertionError('network forbidden')), contextlib.redirect_stdout(output):
                code = demo.main()
            return code, json.loads(output.getvalue())
        args = ['reserve-direct-demo', '--case', 'openrouter-direct-sse', '--request-id', self.request, '--authorization-sha256', self.digest]
        self.assertEqual(command(args + ['--operation-id', str(uuid.uuid4())])[0], 1)
        self.assertEqual(command(args[:-2])[0], 1)
        self.assertTrue(command(args)[1]['newly_reserved'])
        self.assertFalse(command(args)[1]['newly_reserved'])
        self.assertEqual(command(['budget-status'])[1]['reserved_micro_usdc'], '1000000')
        with self.assertRaisesRegex(old.Failure, 'existing immutable'):
            self.budget.initialize()


if __name__ == '__main__':
    unittest.main()
