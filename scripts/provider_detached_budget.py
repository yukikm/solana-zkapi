#!/usr/bin/env python3
"""One explicitly approved NEW seven-cap authority; legacy history is read-only.

No legacy capacity transfer, legacy recovery, automatic initialization, network
or distributed fencing. The snapshot is a historical collision blacklist only.
"""
import argparse
from contextlib import contextmanager
from datetime import date, datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import stat
import uuid

import provider_acceptance as old
from provider_demo_budget import DemoBudget
from provider_supplemental_budget import CAP, COUNT, MATRIX, digest, parse, read_private, sync_path

POLICY = 'new_grant_only_no_original_capacity_transfer'
MARKER = 'detached-grant-identity.json'


@contextmanager
def existing_lock(directory):
    old.require(directory.is_absolute() and directory.resolve() == directory, 'canonical authority required')
    old.private(directory, True)
    path = directory / 'budget.lock'
    old.private(path)
    fd = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        old.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
                    'invalid existing authority lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        old.require((info.st_dev, info.st_ino) == (path.stat().st_dev, path.stat().st_ino), 'authority lock replaced')
        yield
    finally:
        os.close(fd)


def authority(directory):
    d, lock = directory.stat(), (directory / 'budget.lock').stat()
    return {'path': str(directory), 'directory_device': d.st_dev, 'directory_inode': d.st_ino,
            'lock_device': lock.st_dev, 'lock_inode': lock.st_ino}


def export_history(directory, plan):
    """Read an existing original ledger under its existing lock; write nothing."""
    directory = Path(directory)
    with existing_lock(directory):
        reader = object.__new__(DemoBudget)
        reader.directory, reader.plan = directory, plan
        data, total = reader.load()
        identity, state = read_private(directory / 'budget-identity.json'), read_private(directory / 'budget-state.json')
        old.require(parse(state) == data, 'original state changed while locked')
        return {'schema': 1, 'kind': 'historical_budget_snapshot',
                'captured_at': datetime.now(timezone.utc).isoformat(), 'plan': plan,
                'identity_json': identity.decode('utf8'), 'state_json': state.decode('utf8'),
                'original': {'plan_sha256': old.sha(old.canonical(plan)), 'identity_sha256': old.sha(identity), 'state_sha256': old.sha(state)},
                'summary': {'budget_micro_usdc': plan['budget_micro_usdc'], 'reserved_micro_usdc': str(total),
                            'reserved_requests': len(data['reservations'])}}


def read_root_owned_snapshot(path):
    """Deployment inputs are root-owned, non-writable by the non-root runtime.

    All ancestors must also be root-owned and non-writable by group/other, so
    the runtime cannot replace the file by renaming its parent. Root remains a
    trusted administrator. Unit fixtures replace this reader, not this policy.
    """
    path = Path(path)
    old.require(os.getuid() != 0 and path.is_absolute() and path.resolve() == path, 'non-root read-only snapshot placement required')
    for parent in path.parents:
        info = parent.lstat()
        old.require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o022 == 0,
                    'snapshot ancestor is not protected')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        old.require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_mode & 0o027 == 0
                    and 0 < info.st_size <= 4_194_304 and not os.access(path, os.W_OK), 'snapshot is not read-only private input')
        raw = stream.read(4_194_305)
    old.require(len(raw) <= 4_194_304, 'snapshot too large')
    return raw


def history(raw):
    s = parse(raw)
    old.fields(s, ['schema', 'kind', 'captured_at', 'plan', 'identity_json', 'state_json', 'original', 'summary'])
    old.require(type(s['schema']) is int and s['schema'] == 1 and s['kind'] == 'historical_budget_snapshot', 'snapshot schema invalid')
    old.require(type(s['captured_at']) is str and datetime.fromisoformat(s['captured_at']).tzinfo is not None, 'snapshot time invalid')
    for key in ('identity_json', 'state_json'):
        old.require(type(s[key]) is str and 0 < len(s[key].encode('utf8')) <= 1_048_576, 'snapshot original bytes invalid')
    plan, identity, state = s['plan'], parse(s['identity_json']), parse(s['state_json'])
    # The exporter uses the original full validator. Runtime authenticates the
    # approved snapshot, then checks identity/count/amount/collision joins only;
    # it never needs old pricing-source files or a writable legacy directory.
    expected = {'schema': 1, 'campaign_id': plan['campaign_id'], 'plan_sha256': old.sha(old.canonical(plan)),
                'budget_micro_usdc': plan['budget_micro_usdc'], 'max_requests': plan['max_requests']}
    old.require(identity == expected, 'historical identity mismatch')
    old.fields(state, ['identity', 'reservations'])
    old.require(state['identity'] == expected and type(state['reservations']) is list
                and type(plan['max_requests']) is int and 0 < plan['max_requests'] <= 1000
                and len(state['reservations']) <= plan['max_requests'], 'historical state mismatch')
    original = {'plan_sha256': expected['plan_sha256'], 'identity_sha256': old.sha(s['identity_json'].encode('utf8')),
                'state_sha256': old.sha(s['state_json'].encode('utf8'))}
    old.require(s['original'] == original, 'historical byte anchors mismatch')
    requests, hashes, cases, total = set(), set(), set(), 0
    for row in state['reservations']:
        old.require(type(row) is dict and type(row['case_id']) is str and row['case_id'] not in cases
                    and row['state'] == 'reserved_no_automatic_replay', 'historical reservation invalid')
        cases.add(row['case_id'])
        total += old.uint(row['max_cost_micro_usdc'], old.MAX_BUDGET, True)
        if 'request_id' in row:
            DemoBudget.demo_ids(row['request_id'], row['request_id'])
            old.require(row['request_id'] not in requests, 'historical request duplicated')
            requests.add(row['request_id'])
        if 'authorization_sha256' in row:
            digest(row['authorization_sha256'])
            old.require(row['authorization_sha256'] not in hashes, 'historical AUTH duplicated')
            hashes.add(row['authorization_sha256'])
    original_cap = old.uint(plan['budget_micro_usdc'], old.MAX_BUDGET, True)
    old.require(total <= original_cap and s['summary'] == {'budget_micro_usdc': str(original_cap),
                'reserved_micro_usdc': str(total), 'reserved_requests': len(cases)}, 'historical summary mismatch')
    anchor = {'snapshot_sha256': old.sha(raw), **original, 'reserved_requests': len(cases), 'reserved_micro_usdc': str(total)}
    return anchor, requests, hashes


def validate_policy(a):
    old.fields(a['approval'], ['approved', 'reference', 'date'])
    p = a['approval']
    old.require(p['approved'] is True and type(p['reference']) is str and 0 < len(p['reference']) <= 500
                and p['reference'].strip() and all(32 <= ord(c) <= 126 for c in p['reference']), 'explicit approval required')
    old.require(type(p['date']) is str and len(p['date']) == 10 and date.fromisoformat(p['date']).isoformat() == p['date'], 'approval date invalid')
    d = a['deployment']
    old.fields(d, ['profile_sha256', 'manifest_sha256', 'bundle_sha256', 'sdk_sha256', 'native_sha256', 'tariff_sha256',
                   'mode', 'provider', 'model', 'cap_micro_usdc', 'session_ttl_seconds', 'max_output_tokens'])
    for key in ('profile_sha256', 'manifest_sha256', 'bundle_sha256', 'sdk_sha256', 'native_sha256', 'tariff_sha256'): digest(d[key])
    old.require(d['mode'] == 'direct_openrouter' and d['provider'] == 'openrouter'
                and type(d['model']) is str and 0 < len(d['model']) <= 200 and d['model'] != '*'
                and all(33 <= ord(c) <= 126 for c in d['model']) and d['cap_micro_usdc'] == str(CAP)
                and type(d['session_ttl_seconds']) is int and d['session_ttl_seconds'] == 60
                and type(d['max_output_tokens']) is int and d['max_output_tokens'] == 128, 'deployment policy invalid')
    old.require(type(a['max_requests']) is int and a['max_requests'] == COUNT and a['budget_micro_usdc'] == str(CAP * COUNT)
                and a['matrix'] == MATRIX and a['policy'] == POLICY, 'new grant scope invalid')


class DetachedBudget:
    def __init__(self, directory, snapshot_path, authorization_path, authorization_sha256):
        self.directory, self.snapshot_path, self.authorization_path = Path(directory), Path(snapshot_path), Path(authorization_path)
        old.require(self.directory.is_absolute() and self.directory.resolve() == self.directory, 'canonical new authority required')
        old.private(self.directory, True)
        digest(authorization_sha256)
        self.authorization_sha256 = authorization_sha256
        self.grants = self.directory / 'grants'

    def authorization(self):
        raw = read_private(self.authorization_path)
        old.require(old.sha(raw) == self.authorization_sha256, 'authorization pin mismatch')
        a = parse(raw)
        old.fields(a, ['schema', 'kind', 'grant_id', 'approval', 'history', 'authority', 'deployment',
                       'max_requests', 'budget_micro_usdc', 'matrix', 'policy'])
        old.require(type(a['schema']) is int and a['schema'] == 2 and a['kind'] == 'detached_supplemental_grant', 'grant schema invalid')
        DemoBudget.demo_ids(a['grant_id'], a['grant_id'])
        validate_policy(a)
        old.require(a['authority'] == authority(self.directory), 'new grant authority changed')
        anchor, requests, hashes = history(read_root_owned_snapshot(self.snapshot_path))
        old.require(a['history'] == anchor, 'historical snapshot substituted')
        return a, raw, requests, hashes

    def identity(self, a):
        return {'schema': 2, 'kind': 'detached_supplemental_grant', 'grant_id': a['grant_id'], 'policy': POLICY,
                'authorization_sha256': self.authorization_sha256, 'history': a['history'], 'authority': a['authority']}

    def paths(self, a):
        grant = self.grants / a['grant_id']
        return grant, grant / 'reservations.json'

    def sync(self, a):
        grant, state = self.paths(a)
        for p in (self.directory / MARKER, self.grants / 'index.json', grant / 'authorization.json', state): sync_path(p)
        for p in (grant, self.grants, self.directory): sync_path(p, True)

    def initialize(self):
        with existing_lock(self.directory):
            a, raw, _, _ = self.authorization()
            old.require({p.name for p in self.directory.iterdir()} == {'budget.lock'}, 'new authority occupied or partial; no reset')
            identity = self.identity(a)
            # Marker consumes this authority before creating any grant state.
            old.atomic(self.directory / MARKER, old.canonical(identity))
            self.grants.mkdir(mode=0o700)
            grant, state = self.paths(a)
            grant.mkdir(mode=0o700)
            old.atomic(grant / 'authorization.json', raw)
            old.atomic(state, old.canonical({'identity': identity, 'reservations': []}))
            old.atomic(self.grants / 'index.json', old.canonical({'schema': 2, 'grants': [identity]}))
            self.sync(a)
            return {'schema': 2, 'initialized': True, 'authorization_sha256': self.authorization_sha256,
                    'original_capacity_transferred_micro_usdc': '0', 'funding_actions': 0, 'inference_actions': 0}

    def row(self, a, request, auth_hash):
        return {'request_id': request, 'authorization_sha256': auth_hash, 'grant_sha256': self.authorization_sha256,
                **{key: a['deployment'][key] for key in ('profile_sha256', 'manifest_sha256', 'tariff_sha256')},
                'max_cost_micro_usdc': str(CAP), 'state': 'reserved_no_automatic_replay'}

    def load(self):
        a, raw, historical_requests, historical_hashes = self.authorization()
        grant, state = self.paths(a)
        old.private(self.grants, True); old.private(grant, True)
        old.require({p.name for p in self.directory.iterdir()} == {'budget.lock', MARKER, 'grants'}
                    and {p.name for p in self.grants.iterdir()} == {'index.json', a['grant_id']}
                    and {p.name for p in grant.iterdir()} == {'authorization.json', 'reservations.json'}, 'unknown or partial grant state')
        identity = self.identity(a)
        old.require(parse(read_private(self.directory / MARKER)) == identity
                    and parse(read_private(self.grants / 'index.json')) == {'schema': 2, 'grants': [identity]}
                    and read_private(grant / 'authorization.json') == raw, 'grant identity replaced')
        data = parse(read_private(state))
        old.fields(data, ['identity', 'reservations'])
        old.require(data['identity'] == identity and type(data['reservations']) is list and len(data['reservations']) <= COUNT,
                    'grant reservation count or identity invalid')
        requests, hashes = set(historical_requests), set(historical_hashes)
        for row in data['reservations']:
            DemoBudget.direct_ids(row['request_id'], row['authorization_sha256'])
            old.require(row == self.row(a, row['request_id'], row['authorization_sha256'])
                        and row['request_id'] not in requests and row['authorization_sha256'] not in hashes, 'reservation collision or mutation')
            requests.add(row['request_id']); hashes.add(row['authorization_sha256'])
        return a, data, historical_requests, historical_hashes

    def reserve(self, request, auth_hash, *, allow_new=True):
        old.require(type(allow_new) is bool, 'explicit admission policy required')
        DemoBudget.direct_ids(request, auth_hash)
        with existing_lock(self.directory):
            a, data, historical_requests, historical_hashes = self.load()
            old.require(request not in historical_requests and auth_hash not in historical_hashes, 'historical AUTH belongs to original authority')
            row = self.row(a, request, auth_hash)
            matches = [r for r in data['reservations'] if r['request_id'] == request or r['authorization_sha256'] == auth_hash]
            old.require(not matches or matches == [row], 'request or AUTH already bound')
            if not matches:
                old.require(allow_new, 'new grant admission suspended')
                old.require(len(data['reservations']) < COUNT, 'new grant exhausted')
                data['reservations'].append(row)
                old.atomic(self.paths(a)[1], old.canonical(data))
            self.sync(a)
            return {'schema': 2, 'request_id': request, 'authorization_sha256': auth_hash,
                    'grant_sha256': self.authorization_sha256, 'reserved_micro_usdc': str(CAP), 'newly_reserved': not matches,
                    'reservation_source': 'active_detached_grant', 'auth_forward_allowed': True, 'inference_replays_supported': False}

    def status(self):
        with existing_lock(self.directory):
            a, data, _, _ = self.load()
            count = len(data['reservations'])
            return {'schema': 2, 'authorization_sha256': self.authorization_sha256, 'budget_scope': 'active_detached_grant',
                    'budget_micro_usdc': str(CAP * COUNT), 'reserved_micro_usdc': str(count * CAP), 'remaining_micro_usdc': str((COUNT - count) * CAP),
                    'max_requests': COUNT, 'reserved_requests': count, 'remaining_requests': COUNT - count,
                    'supplemental_remaining_requests': COUNT - count, 'request_max_cost_micro_usdc': str(CAP),
                    'historical_snapshot': {'live': False, 'original_capacity_transferred_micro_usdc': '0'},
                    'refunds_supported': False, 'inference_replays_supported': False}


def prepare_proposal(directory, snapshot_path, deployment):
    directory = Path(directory)
    with existing_lock(directory):
        old.require({p.name for p in directory.iterdir()} == {'budget.lock'}, 'new authority occupied')
        anchor, _, _ = history(read_root_owned_snapshot(snapshot_path))
        return {'schema': 2, 'kind': 'detached_supplemental_grant', 'grant_id': str(uuid.uuid4()),
                'approval': {'approved': False, 'reference': 'UNAPPROVED proposal; record the existing seven-cap authorization after final pin review', 'date': date.today().isoformat()},
                'history': anchor, 'authority': authority(directory), 'deployment': deployment,
                'max_requests': COUNT, 'budget_micro_usdc': str(CAP * COUNT), 'matrix': MATRIX.copy(), 'policy': POLICY}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['export-history', 'prepare-proposal', 'validate-authorization', 'initialize-approved', 'status', 'reserve'])
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--history-snapshot', type=Path)
    parser.add_argument('--deployment', type=Path)
    parser.add_argument('--authorization', type=Path)
    parser.add_argument('--authorization-sha256')
    parser.add_argument('--request-id')
    parser.add_argument('--auth-sha256')
    parser.add_argument('--no-new-reservations', action='store_true')
    args = parser.parse_args()
    try:
        old.require((args.request_id is not None and args.auth_sha256 is not None) if args.command == 'reserve'
                    else args.request_id is None and args.auth_sha256 is None and not args.no_new_reservations, 'command identity mismatch')
        if args.command == 'export-history':
            old.require(args.plan is not None and args.history_snapshot is None and args.deployment is None
                        and args.authorization is None and args.authorization_sha256 is None, 'export arguments invalid')
            plan = old.read_json(args.plan); old.validate_plan(plan, args.plan.resolve().parent)
            result = export_history(args.state_dir, plan)
        else:
            old.require(args.plan is None and args.history_snapshot is not None, 'detached authority requires historical snapshot only')
            if args.command == 'prepare-proposal':
                old.require(args.deployment is not None and args.authorization is None and args.authorization_sha256 is None, 'proposal arguments invalid')
                result = prepare_proposal(args.state_dir, args.history_snapshot, old.read_json(args.deployment))
            else:
                old.require(args.deployment is None and args.authorization is not None and args.authorization_sha256 is not None, 'pinned approval required')
                budget = DetachedBudget(args.state_dir, args.history_snapshot, args.authorization, args.authorization_sha256)
                if args.command == 'validate-authorization':
                    with existing_lock(budget.directory): budget.authorization()
                    result = {'schema': 2, 'valid': True, 'initialized': False, 'authorization_sha256': args.authorization_sha256}
                else:
                    result = budget.initialize() if args.command == 'initialize-approved' else budget.status() if args.command == 'status' else budget.reserve(
                        args.request_id, args.auth_sha256, allow_new=not args.no_new_reservations)
        print(json.dumps(result, indent=2))
        return 0
    except Exception:
        print(json.dumps({'passed': False, 'error': 'detached_budget_unavailable', 'auth_forward_allowed': False}))
        return 1


if __name__ == '__main__': raise SystemExit(main())
