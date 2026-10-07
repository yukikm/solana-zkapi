"""Disposable synthetic ledgers only; no actual snapshot, approval or network."""
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
import provider_detached_budget as detached
import provider_supplemental_budget as supplemental
import test_provider_supplemental_budget as original_fixtures


def reserve_child(directory, snapshot, approval, pin, request, auth_hash, queue):
    # Test data cannot be installed root-owned; production CLI has no override.
    with patch.object(detached, 'read_root_owned_snapshot', supplemental.read_private):
        try:
            r = detached.DetachedBudget(directory, snapshot, approval, pin).reserve(request, auth_hash)
            queue.put((True, r['newly_reserved']))
        except (old.Failure, OSError):
            queue.put((False, False))


class DetachedBudgetTests(unittest.TestCase):
    def setUp(self):
        original_fixtures.SupplementalBudgetTests.setUp(self)
        self.original_directory = self.directory
        self.snapshot = self.root / 'history.json'
        self.history = detached.export_history(self.original_directory, self.plan)
        old.atomic(self.snapshot, old.canonical(self.history))
        self.directory = self.root / 'new-authority'
        self.directory.mkdir(mode=0o700)
        old.atomic(self.directory / 'budget.lock', b'')
        self.reader = patch.object(detached, 'read_root_owned_snapshot', supplemental.read_private)
        self.reader.start(); self.addCleanup(self.reader.stop)
        self.authorization = detached.prepare_proposal(self.directory, self.snapshot, self.deployment)
        self.authorization['approval'] = {'approved': True, 'reference': 'SYNTHETIC UNIT TEST ONLY', 'date': '2026-10-07'}
        self.bind()

    def bind(self):
        raw = old.canonical(self.authorization)
        old.atomic(self.authorization_path, raw)
        self.pin = old.sha(raw)
        if hasattr(self, 'snapshot'):
            self.budget = detached.DetachedBudget(self.directory, self.snapshot, self.authorization_path, self.pin)

    def reserve(self, request=None, auth_hash=None, allow_new=True):
        return self.budget.reserve(request or self.request, auth_hash or self.digest, allow_new=allow_new)

    def unchanged_original(self):
        for name, raw in self.original.items(): self.assertEqual((self.original_directory / name).read_bytes(), raw)

    def test_export_is_read_only_exact_and_new_authority_has_no_legacy_files(self):
        anchor, requests, hashes = detached.history(self.snapshot.read_bytes())
        self.assertIn(self.legacy_request, requests); self.assertIn('ef' * 32, hashes)
        self.assertEqual(anchor['state_sha256'], old.sha(self.original['budget-state.json']))
        self.budget.initialize(); self.reserve()
        self.unchanged_original()
        self.assertFalse((self.directory / 'budget-state.json').exists())
        self.assertFalse((self.directory / 'budget-identity.json').exists())
        self.assertEqual(self.snapshot.read_bytes(), old.canonical(self.history))

    def test_active_only_seven_caps_and_exact_current_recovery(self):
        self.budget.initialize()
        initial = self.budget.status()
        self.assertEqual(initial['budget_micro_usdc'], '7000000')
        self.assertEqual(initial['reserved_requests'], 0)
        self.assertEqual(initial['historical_snapshot'], {'live': False, 'original_capacity_transferred_micro_usdc': '0'})
        with self.assertRaisesRegex(old.Failure, 'suspended'): self.reserve(allow_new=False)
        self.reserve()
        for i in range(6): self.reserve(str(uuid.uuid4()), format(i, '02x') * 32)
        with self.assertRaisesRegex(old.Failure, 'exhausted'): self.reserve(str(uuid.uuid4()), 'dc' * 32)
        self.assertFalse(self.reserve(allow_new=False)['newly_reserved'])
        full = self.budget.status()
        self.assertEqual(full['remaining_micro_usdc'], '0'); self.assertEqual(full['remaining_requests'], 0)
        self.assertFalse(full['refunds_supported']); self.assertFalse(full['inference_replays_supported'])
        self.unchanged_original()

    def test_all_historical_auth_recovery_and_collisions_are_rejected(self):
        self.budget.initialize()
        for request, auth_hash in [(self.legacy_request, 'ef' * 32), (self.legacy_request, 'aa' * 32),
                                   (str(uuid.uuid4()), 'ef' * 32), (self.legacy_proxy, 'ba' * 32)]:
            for allow_new in (True, False):
                with self.assertRaisesRegex(old.Failure, 'original authority'): self.reserve(request, auth_hash, allow_new)
        self.assertEqual(self.budget.status()['remaining_requests'], 7)
        self.unchanged_original()

    def test_new_row_collisions_and_corruption_refuse(self):
        self.budget.initialize(); self.reserve()
        for request, auth_hash in [(self.request, 'ac' * 32), (str(uuid.uuid4()), self.digest)]:
            with self.assertRaises(old.Failure): self.reserve(request, auth_hash)
        state = self.budget.paths(self.authorization)[1]
        raw = state.read_bytes()
        for change in ({'max_cost_micro_usdc': '1'}, {'profile_sha256': 'ff' * 32}, {'state': 'refunded'}):
            data = json.loads(raw); data['reservations'][0].update(change); old.atomic(state, old.canonical(data))
            with self.assertRaises(old.Failure): self.reserve()
        data = json.loads(raw); data['reservations'] *= 8; old.atomic(state, old.canonical(data))
        with self.assertRaises((old.Failure, OSError)): self.budget.status()

    def test_no_constructor_initialization_and_reuse_or_second_grant_refuses(self):
        self.assertEqual({p.name for p in self.directory.iterdir()}, {'budget.lock'})
        with self.assertRaises((old.Failure, OSError)): self.reserve()
        self.budget.initialize()
        with self.assertRaises(old.Failure): self.budget.initialize()
        self.authorization['grant_id'] = str(uuid.uuid4()); self.bind()
        with self.assertRaises(old.Failure): self.budget.initialize()
        with self.assertRaises((old.Failure, OSError)): self.budget.status()

    def test_partial_initialization_permanently_refuses_reset(self):
        real = old.atomic; calls = 0
        def fail_after_marker(path, data, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2: raise OSError('synthetic interruption')
            real(path, data, **kwargs)
        with patch.object(old, 'atomic', side_effect=fail_after_marker):
            with self.assertRaises(OSError): self.budget.initialize()
        with self.assertRaises(old.Failure): self.budget.initialize()
        with self.assertRaises((old.Failure, OSError)): self.budget.status()

    def test_snapshot_mutation_and_wrong_authority_or_policy_refuse(self):
        original = json.loads(json.dumps(self.authorization))
        for section, field, value in [('history', 'snapshot_sha256', 'ab' * 32), ('history', 'reserved_requests', 999),
                ('authority', 'directory_inode', 0), ('deployment', 'cap_micro_usdc', '7000000'),
                ('deployment', 'session_ttl_seconds', 120), ('approval', 'approved', False)]:
            self.authorization = json.loads(json.dumps(original)); self.authorization[section][field] = value; self.bind()
            with self.assertRaises(old.Failure): self.budget.initialize()
        self.authorization = original; self.bind(); self.budget.initialize()
        old.atomic(self.snapshot, self.snapshot.read_bytes() + b'\n')
        with self.assertRaises(old.Failure): self.reserve()

    def test_snapshot_consistency_rejects_mutated_original_raw_bytes(self):
        for key in ('identity_json', 'state_json'):
            changed = json.loads(json.dumps(self.history)); changed[key] += '\n'
            with self.assertRaises(old.Failure): detached.history(old.canonical(changed))
        changed = json.loads(json.dumps(self.history)); changed['summary']['reserved_micro_usdc'] = '0'
        with self.assertRaises(old.Failure): detached.history(old.canonical(changed))

    def test_local_original_can_evolve_without_new_authority_claiming_live_aggregate(self):
        self.budget.initialize()
        # The independent original campaign may admit an old lower-cap case.
        # AWS has a point-in-time blacklist, not shared live state/fencing.
        old.atomic(self.original_directory / 'budget-state.json', self.original['budget-state.json'] + b'\n')
        self.reserve()
        self.assertEqual(self.budget.status()['reserved_micro_usdc'], '1000000')
        self.assertFalse(self.budget.status()['historical_snapshot']['live'])

    def test_local_clone_lock_replacement_and_extra_index_entry_refuse(self):
        self.budget.initialize()
        clone = self.root / 'clone'; shutil.copytree(self.directory, clone)
        with self.assertRaises(old.Failure): detached.DetachedBudget(clone, self.snapshot, self.authorization_path, self.pin).status()
        index = self.directory / 'grants/index.json'; data = json.loads(index.read_bytes()); data['grants'] *= 2
        old.atomic(index, old.canonical(data))
        with self.assertRaises(old.Failure): self.budget.status()
        lock = self.directory / 'budget.lock'; lock.rename(self.directory / 'old-lock'); old.atomic(lock, b'')
        with self.assertRaises(old.Failure): self.reserve()

    def test_uncertain_fsync_consumes_once_and_never_acknowledges_until_resynced(self):
        self.budget.initialize(); real = os.fsync; calls = 0
        with patch('os.fsync', side_effect=OSError('before replacement')):
            with self.assertRaises(OSError): self.reserve()
        self.assertEqual(self.budget.status()['remaining_requests'], 7)
        def uncertain(fd):
            nonlocal calls
            calls += 1
            if calls == 2: raise OSError('uncertain directory commit')
            real(fd)
        with patch('os.fsync', side_effect=uncertain):
            with self.assertRaises(OSError): self.reserve()
        self.assertEqual(self.budget.status()['remaining_requests'], 6)
        with patch('os.fsync', side_effect=OSError('still uncertain')):
            with self.assertRaises(OSError): self.reserve(allow_new=False)
        self.assertFalse(self.reserve(allow_new=False)['newly_reserved'])

    def test_concurrent_duplicates_and_last_slot_serialize(self):
        self.budget.initialize(); ctx = multiprocessing.get_context('spawn'); queue = ctx.Queue()
        def run(rows):
            children = [ctx.Process(target=reserve_child, args=(self.directory, self.snapshot, self.authorization_path, self.pin, r, h, queue)) for r, h in rows]
            for child in children: child.start()
            results = [queue.get(timeout=20) for _ in children]
            for child in children: child.join(20); self.assertEqual(child.exitcode, 0)
            return results
        results = run([(self.request, self.digest)] * 3)
        self.assertTrue(all(r[0] for r in results)); self.assertEqual(sum(r[1] for r in results), 1)
        for i in range(5): self.reserve(str(uuid.uuid4()), format(i, '02x') * 32)
        results = run([(str(uuid.uuid4()), format(i + 10, '02x') * 32) for i in range(3)])
        self.assertEqual(sum(r[0] for r in results), 1); self.assertEqual(self.budget.status()['remaining_requests'], 0)

    def test_production_reader_rejects_runtime_owned_or_symlinked_snapshot(self):
        self.reader.stop()
        with self.assertRaises(old.Failure): detached.read_root_owned_snapshot(self.snapshot)
        alias = self.root / 'alias'; alias.symlink_to(self.snapshot)
        with self.assertRaises(old.Failure): detached.read_root_owned_snapshot(alias)

    def test_status_redacts_history_and_cli_cannot_take_legacy_plan(self):
        self.budget.initialize(); self.reserve()
        output = io.StringIO()
        with patch('sys.argv', ['helper', 'status', '--state-dir', str(self.directory), '--history-snapshot', str(self.snapshot),
                   '--authorization', str(self.authorization_path), '--authorization-sha256', self.pin]), \
                patch('socket.socket', side_effect=AssertionError('network forbidden')), contextlib.redirect_stdout(output):
            self.assertEqual(detached.main(), 0)
        encoded = output.getvalue()
        for private in (self.request, self.digest, self.legacy_request, str(self.root), 'approval', 'reservations'):
            self.assertNotIn(private, encoded)
        output = io.StringIO()
        with patch('sys.argv', ['helper', 'status', '--state-dir', str(self.directory), '--plan', 'PRIVATE']), contextlib.redirect_stdout(output):
            self.assertEqual(detached.main(), 1)
        self.assertNotIn('PRIVATE', output.getvalue()); self.assertFalse(json.loads(output.getvalue())['auth_forward_allowed'])


if __name__ == '__main__': unittest.main()
