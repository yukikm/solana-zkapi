#!/usr/bin/env python3
"""Offline, explicitly approved seven-cap supplement to an existing campaign.

No network, inference, refunds or automatic initialization. The authorization's
exact digest must be installed independently after approval. A local record is
not proof of human consent; the operator is responsible for that approval.
"""
import argparse
from contextlib import contextmanager
from datetime import date
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import uuid

import provider_acceptance as old
from provider_demo_budget import DemoBudget

CAP = 1_000_000
COUNT = 7
MATRIX = ['B-01', 'B-02', 'B-03', 'N-01', 'N-02', 'N-03', 'N-04']
MARKER = 'supplemental-identity.json'


def digest(value):
    old.require(type(value) is str and re.fullmatch('[0-9a-f]{64}', value), 'pinned digest required')


def read_private(path):
    old.private(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        old.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                    and info.st_mode & 0o077 == 0 and 0 < info.st_size <= 1_048_576, 'private input invalid')
        raw = stream.read(1_048_577)
    old.require(0 < len(raw) <= 1_048_576, 'private input size invalid')
    return raw


def parse(raw):
    return json.loads(raw, object_pairs_hook=old.strict_object,
                      parse_constant=lambda _: (_ for _ in ()).throw(old.Failure('invalid JSON')))


def sync_path(path, directory=False):
    old.private(path, directory)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class SupplementalBudget:
    def __init__(self, directory, plan, authorization_path, authorization_sha256):
        # Do not mkdir, create a lock or initialize any budget in the constructor.
        self.directory = Path(directory)
        old.require(self.directory.is_absolute() and self.directory.resolve() == self.directory, 'canonical campaign authority required')
        old.private(self.directory, True)
        self.plan = plan
        self.authorization_path = Path(authorization_path)
        digest(authorization_sha256)
        self.authorization_sha256 = authorization_sha256
        self.extensions = self.directory / 'extensions'
        self.grant_dir = self.extensions / authorization_sha256
        self.state_path = self.grant_dir / 'reservations.json'

    @contextmanager
    def locked(self):
        lock = self.directory / 'budget.lock'
        old.private(lock)
        fd = os.open(lock, os.O_RDWR | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            old.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                        and info.st_mode & 0o077 == 0, 'campaign lock invalid')
            fcntl.flock(fd, fcntl.LOCK_EX)
            old.require((info.st_dev, info.st_ino) == (lock.stat().st_dev, lock.stat().st_ino), 'campaign lock replaced')
            yield
        finally:
            os.close(fd)

    def authority(self):
        directory = self.directory.stat()
        lock = (self.directory / 'budget.lock').stat()
        return {'path': str(self.directory), 'directory_device': directory.st_dev, 'directory_inode': directory.st_ino,
                'lock_device': lock.st_dev, 'lock_inode': lock.st_ino}

    def authorization(self):
        raw = read_private(self.authorization_path)
        old.require(old.sha(raw) == self.authorization_sha256, 'supplemental authorization digest mismatch')
        a = parse(raw)
        old.fields(a, ['schema', 'grant_id', 'approval', 'original', 'authority', 'deployment', 'max_requests', 'budget_micro_usdc', 'matrix'])
        old.require(type(a['schema']) is int and a['schema'] == 1, 'supplemental authorization schema invalid')
        DemoBudget.demo_ids(a['grant_id'], a['grant_id'])
        old.fields(a['approval'], ['approved', 'reference', 'date'])
        approval = a['approval']
        old.require(approval['approved'] is True and type(approval['reference']) is str
                    and 0 < len(approval['reference']) <= 500 and approval['reference'].strip() and approval['reference'].isascii()
                    and all(32 <= ord(c) <= 126 for c in approval['reference']), 'explicit supplemental approval required')
        old.require(type(approval['date']) is str and re.fullmatch(r'\d{4}-\d{2}-\d{2}', approval['date']), 'approval date invalid')
        date.fromisoformat(approval['date'])
        old.fields(a['original'], ['plan_sha256', 'identity_sha256', 'state_sha256'])
        for value in a['original'].values(): digest(value)
        old.fields(a['authority'], ['path', 'directory_device', 'directory_inode', 'lock_device', 'lock_inode'])
        old.require(a['authority'] == self.authority(), 'campaign authority changed; no cloned capacity')
        d = a['deployment']
        old.fields(d, ['profile_sha256', 'manifest_sha256', 'bundle_sha256', 'sdk_sha256', 'native_sha256', 'tariff_sha256',
                       'mode', 'provider', 'model', 'cap_micro_usdc', 'session_ttl_seconds', 'max_output_tokens'])
        for key in ('profile_sha256', 'manifest_sha256', 'bundle_sha256', 'sdk_sha256', 'native_sha256', 'tariff_sha256'): digest(d[key])
        old.require(d['mode'] == 'direct_openrouter' and d['provider'] == 'openrouter'
                    and type(d['model']) is str and 0 < len(d['model']) <= 200 and d['model'] != '*'
                    and all(33 <= ord(c) <= 126 for c in d['model'])
                    and d['cap_micro_usdc'] == str(CAP) and type(d['session_ttl_seconds']) is int and d['session_ttl_seconds'] == 60
                    and type(d['max_output_tokens']) is int and d['max_output_tokens'] == 128, 'supplemental deployment policy invalid')
        old.require(type(a['max_requests']) is int and a['max_requests'] == COUNT
                    and a['budget_micro_usdc'] == str(CAP * COUNT) and a['matrix'] == MATRIX, 'supplemental scope invalid')
        old.require(a['original']['plan_sha256'] == old.sha(old.canonical(self.plan)), 'original plan anchor changed')
        marker = read_private(self.directory / 'budget-identity.json')
        state = read_private(self.directory / 'budget-state.json')
        old.require(old.sha(marker) == a['original']['identity_sha256'] and old.sha(state) == a['original']['state_sha256'],
                    'original campaign anchor changed; preserve and reconcile')
        legacy = object.__new__(DemoBudget)
        legacy.directory, legacy.plan = self.directory, self.plan
        original_data, original_total = legacy.load()
        return a, raw, original_data, original_total

    def identity(self, authorization):
        return {'schema': 1, 'authorization_sha256': self.authorization_sha256,
                'grant_id': authorization['grant_id'], 'original': authorization['original'], 'authority': authorization['authority']}

    def initialize(self):
        with self.locked():
            a, raw, _, _ = self.authorization()
            marker = self.directory / MARKER
            old.require(not marker.exists() and not marker.is_symlink() and not self.extensions.exists()
                        and not self.extensions.is_symlink(), 'supplement already present or partial; no reset')
            # Permanent intent marker precedes all directory/state creation. Any
            # interruption leaves an occupied namespace that init cannot erase.
            identity = self.identity(a)
            old.atomic(marker, old.canonical(identity))
            self.extensions.mkdir(mode=0o700)
            self.grant_dir.mkdir(mode=0o700)
            old.atomic(self.grant_dir / 'authorization.json', raw)
            old.atomic(self.state_path, old.canonical({'identity': identity, 'reservations': []}))
            old.atomic(self.extensions / 'index.json', old.canonical({'schema': 1, 'grants': [identity]}))
            self.sync()
            return {'schema': 1, 'initialized': True, 'authorization_sha256': self.authorization_sha256,
                    'funding_actions': 0, 'inference_actions': 0}

    def sync(self):
        # Re-sync every new identity and ancestor before acknowledging a send,
        # including after a previous process lost its persistence acknowledgement.
        for path in (self.directory / MARKER, self.extensions / 'index.json', self.grant_dir / 'authorization.json', self.state_path):
            sync_path(path)
        for path in (self.grant_dir, self.extensions, self.directory): sync_path(path, True)

    def load(self):
        a, raw, legacy, legacy_total = self.authorization()
        old.private(self.extensions, True)
        old.private(self.grant_dir, True)
        old.require({p.name for p in self.extensions.iterdir()} == {'index.json', self.authorization_sha256}
                    and {p.name for p in self.grant_dir.iterdir()} == {'authorization.json', 'reservations.json'},
                    'missing, additional or partial supplemental grant')
        identity = self.identity(a)
        old.require(parse(read_private(self.directory / MARKER)) == identity
                    and parse(read_private(self.extensions / 'index.json')) == {'schema': 1, 'grants': [identity]}
                    and read_private(self.grant_dir / 'authorization.json') == raw, 'supplemental grant substituted')
        data = parse(read_private(self.state_path))
        old.fields(data, ['identity', 'reservations'])
        old.require(data['identity'] == identity and type(data['reservations']) is list and len(data['reservations']) <= COUNT,
                    'supplemental ledger identity or count invalid')
        requests = {item['request_id'] for item in legacy['reservations'] if 'request_id' in item}
        hashes = {item['authorization_sha256'] for item in legacy['reservations'] if 'authorization_sha256' in item}
        total = 0
        for row in data['reservations']:
            old.fields(row, ['request_id', 'authorization_sha256', 'grant_sha256', 'profile_sha256', 'manifest_sha256',
                             'tariff_sha256', 'max_cost_micro_usdc', 'state'])
            DemoBudget.direct_ids(row['request_id'], row['authorization_sha256'])
            old.require(row == self.row(a, row['request_id'], row['authorization_sha256'])
                        and row['request_id'] not in requests and row['authorization_sha256'] not in hashes,
                        'supplemental reservation changed or duplicated')
            requests.add(row['request_id']); hashes.add(row['authorization_sha256']); total += CAP
        old.require(total <= CAP * COUNT, 'supplemental budget exceeded')
        return a, data, total, legacy, legacy_total

    def row(self, a, request_id, authorization_sha256):
        return {'request_id': request_id, 'authorization_sha256': authorization_sha256, 'grant_sha256': self.authorization_sha256,
                **{key: a['deployment'][key] for key in ('profile_sha256', 'manifest_sha256', 'tariff_sha256')},
                'max_cost_micro_usdc': str(CAP), 'state': 'reserved_no_automatic_replay'}

    def reserve(self, request_id, authorization_sha256, *, allow_new=True):
        old.require(type(allow_new) is bool, 'explicit admission policy required')
        DemoBudget.direct_ids(request_id, authorization_sha256)
        with self.locked():
            a, data, total, legacy, _ = self.load()
            historical = [r for r in legacy['reservations'] if r.get('request_id') == request_id or r.get('authorization_sha256') == authorization_sha256]
            if historical:
                old.require(len(historical) == 1 and historical[0].get('kind') == 'explicit_direct_demo'
                            and historical[0].get('request_id') == request_id and historical[0].get('authorization_sha256') == authorization_sha256,
                            'request or AUTH already bound in original campaign')
                # Do not rewrite even identical original bytes.
                sync_path(self.directory / 'budget-identity.json')
                sync_path(self.directory / 'budget-state.json')
                self.sync()
                return self.receipt(request_id, authorization_sha256, False, 'original')
            row = self.row(a, request_id, authorization_sha256)
            matching = [r for r in data['reservations'] if r['request_id'] == request_id or r['authorization_sha256'] == authorization_sha256]
            old.require(not matching or matching == [row], 'request or AUTH already bound in supplement')
            if not matching:
                old.require(allow_new, 'new supplemental admission suspended')
                old.require(len(data['reservations']) < COUNT and total + CAP <= CAP * COUNT, 'supplemental budget exhausted')
                data['reservations'].append(row)
                old.atomic(self.state_path, old.canonical(data))
            self.sync()
            return self.receipt(request_id, authorization_sha256, not matching, 'supplement')

    def receipt(self, request_id, authorization_sha256, newly_reserved, source):
        return {'schema': 1, 'request_id': request_id, 'authorization_sha256': authorization_sha256,
                'grant_sha256': self.authorization_sha256, 'reserved_micro_usdc': str(CAP), 'newly_reserved': newly_reserved,
                'reservation_source': source, 'auth_forward_allowed': True, 'inference_replays_supported': False}

    def status(self):
        with self.locked():
            a, data, total, legacy, legacy_total = self.load()
            original_cap = int(self.plan['budget_micro_usdc'])
            return {'schema': 1, 'authorization_sha256': self.authorization_sha256,
                    'budget_micro_usdc': str(original_cap + CAP * COUNT), 'reserved_micro_usdc': str(legacy_total + total),
                    'remaining_micro_usdc': str(original_cap + CAP * COUNT - legacy_total - total),
                    'max_requests': self.plan['max_requests'] + COUNT, 'reserved_requests': len(legacy['reservations']) + len(data['reservations']),
                    'remaining_requests': self.plan['max_requests'] + COUNT - len(legacy['reservations']) - len(data['reservations']),
                    'supplemental_remaining_requests': COUNT - len(data['reservations']), 'request_max_cost_micro_usdc': str(CAP),
                    'refunds_supported': False, 'inference_replays_supported': False}


def prepare_proposal(directory, plan, deployment):
    """Return an unapproved proposal without creating any campaign file.

    Device/inode/path joins fence this local authority only. They are neither
    distributed fencing nor protection against rollback/cloning on other hosts.
    Restores and migration require explicit authority/anchor review.
    """
    budget = SupplementalBudget(directory, plan, Path('/unused'), '00' * 32)
    with budget.locked():
        legacy = object.__new__(DemoBudget)
        legacy.directory, legacy.plan = budget.directory, plan
        legacy.load()
        return {'schema': 1, 'grant_id': str(uuid.uuid4()),
                'approval': {'approved': False, 'reference': 'UNAPPROVED proposal; replace only after explicit approval', 'date': date.today().isoformat()},
                'original': {'plan_sha256': old.sha(old.canonical(plan)),
                             'identity_sha256': old.sha(read_private(budget.directory / 'budget-identity.json')),
                             'state_sha256': old.sha(read_private(budget.directory / 'budget-state.json'))},
                'authority': budget.authority(), 'deployment': deployment, 'max_requests': COUNT,
                'budget_micro_usdc': str(CAP * COUNT), 'matrix': MATRIX.copy()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare-proposal', 'validate-authorization', 'initialize-approved', 'status', 'reserve'])
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--authorization', type=Path)
    parser.add_argument('--authorization-sha256')
    parser.add_argument('--deployment', type=Path, help='Public deployment pins for an UNAPPROVED proposal only')
    parser.add_argument('--request-id')
    parser.add_argument('--auth-sha256')
    parser.add_argument('--no-new-reservations', action='store_true')
    args = parser.parse_args()
    try:
        old.require((args.request_id is not None and args.auth_sha256 is not None) if args.command == 'reserve'
                    else args.request_id is None and args.auth_sha256 is None and not args.no_new_reservations, 'command identity mismatch')
        plan = old.read_json(args.plan)
        old.validate_plan(plan, args.plan.resolve().parent)
        if args.command == 'prepare-proposal':
            old.require(args.deployment is not None and args.authorization is None and args.authorization_sha256 is None,
                        'proposal arguments invalid')
            print(json.dumps(prepare_proposal(args.state_dir, plan, old.read_json(args.deployment)), indent=2))
            return 0
        old.require(args.deployment is None and args.authorization is not None and args.authorization_sha256 is not None,
                    'pinned authorization required')
        budget = SupplementalBudget(args.state_dir, plan, args.authorization, args.authorization_sha256)
        if args.command == 'validate-authorization':
            with budget.locked(): budget.authorization()
            result = {'schema': 1, 'valid': True, 'initialized': False, 'authorization_sha256': args.authorization_sha256}
        else:
            result = budget.initialize() if args.command == 'initialize-approved' else budget.status() if args.command == 'status' else budget.reserve(
                args.request_id, args.auth_sha256, allow_new=not args.no_new_reservations)
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'passed': False, 'error': 'supplemental_budget_unavailable', 'auth_forward_allowed': False}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
