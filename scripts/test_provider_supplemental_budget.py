"""Temporary fixtures only: no actual campaign, approval, private state or network."""
import contextlib
import io
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import unittest
import uuid
from unittest.mock import patch

import provider_acceptance as old
import provider_supplemental_budget as supplement
from provider_demo_budget import DemoBudget
import test_provider_demo_budget as demo_fixtures


def reserve_process(directory, plan, authorization, pin, request_id, digest, queue):
    try:
        value = supplement.SupplementalBudget(Path(directory), plan, Path(authorization), pin).reserve(request_id, digest)
        queue.put((True, value['newly_reserved']))
    except (old.Failure, OSError):
        queue.put((False, False))


class SupplementalBudgetTests(unittest.TestCase):
    def setUp(self):
        demo_fixtures.DemoBudgetTests.setUp(self)
        self.root = self.root.resolve(); self.directory = self.directory.resolve()
        # All three historical row kinds must remain readable and byte-stable.
        old.Budget(self.directory, self.plan).reserve('openai-chat-plain')
        self.legacy_proxy = str(uuid.uuid4())
        self.budget.reserve_demo('openai-chat-plain', self.legacy_proxy, str(uuid.uuid4()))
        self.legacy_request = str(uuid.uuid4())
        self.budget.reserve_direct_demo('openrouter-direct-plain', self.legacy_request, 'ef' * 32)
        self.deployment = {**{key: format(i, '02x') * 32 for i, key in enumerate(
            ('profile_sha256', 'manifest_sha256', 'bundle_sha256', 'sdk_sha256', 'native_sha256', 'tariff_sha256'), 1)},
            'mode': 'direct_openrouter', 'provider': 'openrouter', 'model': 'fixture-model',
            'cap_micro_usdc': '1000000', 'session_ttl_seconds': 60, 'max_output_tokens': 128}
        self.authorization = supplement.prepare_proposal(self.directory, self.plan, self.deployment)
        self.authorization['approval'] = {'approved': True, 'reference': 'SYNTHETIC UNIT TEST ONLY', 'date': '2026-10-07'}
        self.authorization_path = self.root / 'approval.json'
        self.bind()
        self.original = {name: (self.directory / name).read_bytes() for name in ('budget-state.json', 'budget-identity.json')}

    def bind(self):
        raw = old.canonical(self.authorization)
        old.atomic(self.authorization_path, raw)
        self.pin = old.sha(raw)
        self.supp = supplement.SupplementalBudget(self.directory, self.plan, self.authorization_path, self.pin)

    def initialize(self):
        self.supp.initialize()

    def reserve(self, request=None, digest=None, allow_new=True):
        return self.supp.reserve(request or self.request, digest or self.digest, allow_new=allow_new)

    def test_explicit_initialization_preserves_original_bytes_and_redacts_status(self):
        self.initialize()
        self.assertTrue(self.reserve()['newly_reserved'])
        status = self.supp.status()
        self.assertEqual(status['budget_micro_usdc'], '17000000')
        self.assertEqual(status['reserved_micro_usdc'], '2000006')
        self.assertEqual(status['reserved_requests'], 4)
        self.assertEqual(status['supplemental_remaining_requests'], 6)
        self.assertFalse(status['refunds_supported']); self.assertFalse(status['inference_replays_supported'])
        encoded = json.dumps(status)
        for secret in (self.request, self.digest, self.legacy_request, self.legacy_proxy, 'reservations', 'approval'):
            self.assertNotIn(secret, encoded)
        for name, raw in self.original.items(): self.assertEqual((self.directory / name).read_bytes(), raw)

    def test_proposal_and_validation_are_read_only_and_unapproved_cannot_initialize(self):
        before = sorted(p.name for p in self.directory.iterdir())
        proposal = supplement.prepare_proposal(self.directory, self.plan, self.deployment)
        self.assertFalse(proposal['approval']['approved'])
        with self.supp.locked(): self.supp.authorization()
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), before)
        self.authorization = proposal; self.bind()
        with self.assertRaises(old.Failure): self.initialize()
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), before)

    def test_missing_duplicate_substituted_and_additional_grants_fail_closed(self):
        with self.assertRaises((old.Failure, OSError)): self.supp.status()
        self.initialize()
        with self.assertRaises(old.Failure): self.initialize()
        index = self.supp.extensions / 'index.json'; raw = index.read_bytes()
        for value in ({'schema': 1, 'grants': []}, {'schema': 1, 'grants': [self.supp.identity(self.authorization)] * 2}):
            old.atomic(index, old.canonical(value))
            with self.assertRaises(old.Failure): self.reserve()
        old.atomic(index, raw)
        extra = self.supp.extensions / ('fe' * 32); extra.mkdir(mode=0o700)
        with self.assertRaises(old.Failure): self.reserve()
        extra.rmdir()
        self.authorization['grant_id'] = str(uuid.uuid4()); self.bind()
        with self.assertRaises((old.Failure, OSError)): self.reserve()

    def test_partial_initialization_never_resets_or_admits(self):
        real = old.atomic
        count = 0
        def fail_second(path, data, **kwargs):
            nonlocal count
            count += 1
            if count == 2: raise OSError('simulated crash')
            return real(path, data, **kwargs)
        with patch.object(old, 'atomic', side_effect=fail_second):
            with self.assertRaises(OSError): self.initialize()
        with self.assertRaises(old.Failure): self.initialize()
        with self.assertRaises((old.Failure, OSError)): self.reserve()

    def test_seven_caps_no_reclamation_and_exact_recovery_while_suspended(self):
        self.initialize()
        with self.assertRaisesRegex(old.Failure, 'suspended'): self.reserve(allow_new=False)
        self.reserve()
        for i in range(6): self.reserve(str(uuid.uuid4()), format(i, '02x') * 32)
        self.assertEqual(self.supp.status()['supplemental_remaining_requests'], 0)
        with self.assertRaisesRegex(old.Failure, 'exhausted'): self.reserve(str(uuid.uuid4()), 'dc' * 32)
        retry = self.reserve(allow_new=False)
        self.assertFalse(retry['newly_reserved']); self.assertTrue(retry['auth_forward_allowed'])
        self.assertEqual(self.supp.status()['reserved_requests'], 10)

    def test_uuid_and_exact_auth_hash_deduplicate_across_both_ledgers(self):
        self.initialize(); self.reserve()
        for request, digest in ((self.request, 'bc' * 32), (str(uuid.uuid4()), self.digest),
                (self.legacy_request, self.digest), (str(uuid.uuid4()), 'ef' * 32), (self.legacy_proxy, 'cd' * 32)):
            with self.assertRaises(old.Failure): self.reserve(request, digest)
        recovered = self.reserve(self.legacy_request, 'ef' * 32, allow_new=False)
        self.assertEqual(recovered['reservation_source'], 'original')
        self.assertFalse(recovered['newly_reserved'])
        for name, raw in self.original.items(): self.assertEqual((self.directory / name).read_bytes(), raw)

    def test_changed_original_pin_profile_scope_or_authority_refuses(self):
        for section, field, value in [('original', 'state_sha256', 'ff' * 32), ('original', 'identity_sha256', 'ff' * 32),
                ('original', 'plan_sha256', 'ff' * 32), ('authority', 'directory_inode', 0),
                ('deployment', 'cap_micro_usdc', '1'), ('deployment', 'session_ttl_seconds', 300),
                ('deployment', 'profile_sha256', 'invalid'), ('deployment', 'mode', 'proxy')]:
            before = json.loads(json.dumps(self.authorization))
            self.authorization[section][field] = value; self.bind()
            with self.assertRaises(old.Failure): self.initialize()
            self.authorization = before
        self.bind(); self.initialize()
        old.atomic(self.directory / 'budget-state.json', self.original['budget-state.json'] + b'\n')
        with self.assertRaises(old.Failure): self.reserve()

    def test_local_directory_clone_lock_replacement_and_symlinks_refuse(self):
        self.initialize()
        clone = self.root / 'clone'; shutil.copytree(self.directory, clone)
        cloned = supplement.SupplementalBudget(clone, self.plan, self.authorization_path, self.pin)
        with self.assertRaises(old.Failure): cloned.reserve(self.request, self.digest)
        alias = self.root / 'alias'; alias.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(old.Failure): supplement.SupplementalBudget(alias, self.plan, self.authorization_path, self.pin)
        lock = self.directory / 'budget.lock'; lock.rename(self.directory / 'old-lock')
        old.atomic(lock, b'new lock')
        with self.assertRaises(old.Failure): self.reserve()

    def test_concurrent_duplicates_and_exhaustion_hold_one_parent_lock(self):
        self.initialize()
        ctx = multiprocessing.get_context('spawn'); queue = ctx.Queue()
        children = [ctx.Process(target=reserve_process, args=(str(self.directory), self.plan, str(self.authorization_path), self.pin,
                                                             self.request, self.digest, queue)) for _ in range(4)]
        for child in children: child.start()
        result = [queue.get(timeout=20) for _ in children]
        for child in children: child.join(20); self.assertEqual(child.exitcode, 0)
        self.assertTrue(all(allowed for allowed, _ in result)); self.assertEqual(sum(new for _, new in result), 1)
        for i in range(5): self.reserve(str(uuid.uuid4()), format(i, '02x') * 32)
        children = [ctx.Process(target=reserve_process, args=(str(self.directory), self.plan, str(self.authorization_path), self.pin,
                                                             str(uuid.uuid4()), format(i + 10, '02x') * 32, queue)) for i in range(3)]
        for child in children: child.start()
        result = [queue.get(timeout=20) for _ in children]
        for child in children: child.join(20); self.assertEqual(child.exitcode, 0)
        self.assertEqual(sum(allowed for allowed, _ in result), 1)
        self.assertEqual(self.supp.status()['supplemental_remaining_requests'], 0)

    def test_uncertain_fsync_never_acknowledges_and_retry_retains_capacity(self):
        self.initialize(); real = os.fsync; calls = 0
        with patch('os.fsync', side_effect=OSError('before durable replacement')):
            with self.assertRaises(OSError): self.reserve()
        self.assertEqual(self.supp.status()['supplemental_remaining_requests'], 7)
        def fail_directory(fd):
            nonlocal calls
            calls += 1
            if calls == 2: raise OSError('uncertain commit')
            real(fd)
        with patch('os.fsync', side_effect=fail_directory):
            with self.assertRaises(OSError): self.reserve()
        self.assertEqual(self.supp.status()['supplemental_remaining_requests'], 6)
        with patch('os.fsync', side_effect=OSError('still uncertain')):
            with self.assertRaises(OSError): self.reserve(allow_new=False)
        self.assertFalse(self.reserve(allow_new=False)['newly_reserved'])
        self.assertEqual(self.supp.status()['supplemental_remaining_requests'], 6)

    def test_corrupt_count_grant_row_and_world_readable_authorization_refuse(self):
        self.initialize(); self.reserve()
        raw = self.supp.state_path.read_bytes(); original = json.loads(raw)
        for update in ({'max_cost_micro_usdc': '1'}, {'profile_sha256': 'ff' * 32}, {'grant_sha256': 'ff' * 32}, {'state': 'refunded'}):
            state = json.loads(raw); state['reservations'][0].update(update)
            old.atomic(self.supp.state_path, old.canonical(state))
            with self.assertRaises(old.Failure): self.reserve()
        original['reservations'] *= 8; old.atomic(self.supp.state_path, old.canonical(original))
        with self.assertRaises(old.Failure): self.reserve()
        old.atomic(self.supp.state_path, raw)
        self.authorization_path.chmod(0o644)
        with self.assertRaises(old.Failure): self.reserve()

    def test_cli_failure_is_redacted_and_status_performs_no_network(self):
        planfile = self.root / 'plan.json'; planfile.write_bytes(old.canonical(self.plan))
        self.initialize()
        def command(command, *extra):
            output = io.StringIO()
            with patch('sys.argv', ['helper', command, '--plan', str(planfile), '--state-dir', str(self.directory),
                       '--authorization', str(self.authorization_path), '--authorization-sha256', self.pin, *extra]), \
                    patch('socket.socket', side_effect=AssertionError('network forbidden')), contextlib.redirect_stdout(output):
                code = supplement.main()
            return code, json.loads(output.getvalue())
        self.assertEqual(command('status')[0], 0)
        code, result = command('reserve', '--request-id', 'PRIVATE', '--auth-sha256', 'PRIVATE')
        self.assertEqual(code, 1); self.assertFalse(result['auth_forward_allowed'])
        self.assertNotIn('PRIVATE', json.dumps(result)); self.assertNotIn(str(self.root), json.dumps(result))


if __name__ == '__main__': unittest.main()
