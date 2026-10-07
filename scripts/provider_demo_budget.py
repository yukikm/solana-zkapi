#!/usr/bin/env python3
"""Offline demo extension over the EXISTING immutable provider budget.

Never initializes or resets a campaign. Direct sessions reserve their complete
key cap before AUTH. Only an identical AUTH may be forwarded again; this grants
no inference retry or refund. Original acceptance source pins remain unchanged.
"""
import argparse
from pathlib import Path
import json
import re
import sys

import provider_acceptance as original


class DemoBudget(original.Budget):
    def initialize(self):
        raise original.Failure('demo requires an existing immutable campaign')

    def direct_case(self, case_id):
        case = next((c for c in self.plan['cases'] if c['id'] == case_id), None)
        original.require(case is not None and case_id in ('openrouter-direct-plain', 'openrouter-direct-sse')
                         and case['mode'] == 'direct_openrouter' and case['provider'] == 'openrouter'
                         and case['endpoint'] == 'chat_completions' and case['tools'] is False
                         and case['stream'] is (case_id == 'openrouter-direct-sse')
                         and case['max_cost_micro_usdc'] == '1000000', 'demo requires a pinned OpenRouter direct template and cap')
        return case

    @staticmethod
    def direct_ids(request_id, authorization_sha256):
        # Reuse the canonical UUID validator without creating an operation ID.
        original.Budget.demo_ids(request_id, request_id)
        original.require(type(authorization_sha256) is str
                         and re.fullmatch(r'[0-9a-f]{64}', authorization_sha256), 'exact AUTH SHA-256 required')

    def load(self):
        marker, state = self.directory / 'budget-identity.json', self.directory / 'budget-state.json'
        original.private(marker)
        original.private(state)
        original.require(original.read_json(marker) == self.identity(), 'budget campaign identity mismatch')
        data = original.read_json(state)
        original.fields(data, ['identity', 'reservations'])
        original.require(data['identity'] == self.identity() and type(data['reservations']) is list, 'budget state identity mismatch')
        seen, sessions, total = set(), set(), 0
        cases = {c['id']: c for c in self.plan['cases']}
        for item in data['reservations']:
            original.require(type(item) is dict, 'invalid budget reservation')
            kind = item.get('kind')
            if kind == 'explicit_direct_demo':
                original.fields(item, ['case_id', 'kind', 'template_case_id', 'request_id', 'authorization_sha256', 'max_cost_micro_usdc', 'state'])
                template = item['template_case_id']
                self.direct_case(template)
                self.direct_ids(item['request_id'], item['authorization_sha256'])
                original.require(item['case_id'] == 'demo-auth-' + item['request_id'], 'invalid direct demo session')
            elif kind == 'explicit_demo':
                original.fields(item, ['case_id', 'kind', 'template_case_id', 'request_id', 'operation_id', 'max_cost_micro_usdc', 'state'])
                template = item['template_case_id']
                self.demo_case(template)
                self.demo_ids(item['request_id'], item['operation_id'])
                original.require(item['case_id'] == 'demo-' + item['operation_id'], 'invalid demo session')
            else:
                original.fields(item, ['case_id', 'max_cost_micro_usdc', 'state'])
                template = item['case_id']
            if kind is not None:
                original.require(item['case_id'] not in cases and item['request_id'] not in sessions, 'invalid or repeated demo session')
                sessions.add(item['request_id'])
            original.require(template in cases and item['case_id'] not in seen
                             and item['state'] == 'reserved_no_automatic_replay'
                             and item['max_cost_micro_usdc'] == cases[template]['max_cost_micro_usdc'], 'invalid budget reservation')
            seen.add(item['case_id'])
            total += original.uint(item['max_cost_micro_usdc'], original.MAX_BUDGET, True)
        original.require(total <= int(self.plan['budget_micro_usdc']) and len(seen) <= self.plan['max_requests'], 'budget exceeded')
        return data, total

    def reserve_direct_demo(self, template_case_id, request_id, authorization_sha256):
        with self.locked():
            data, total = self.load()
            case = self.direct_case(template_case_id)
            self.direct_ids(request_id, authorization_sha256)
            row = {'case_id': 'demo-auth-' + request_id, 'kind': 'explicit_direct_demo',
                   'template_case_id': template_case_id, 'request_id': request_id,
                   'authorization_sha256': authorization_sha256,
                   'max_cost_micro_usdc': case['max_cost_micro_usdc'], 'state': 'reserved_no_automatic_replay'}
            matching = [item for item in data['reservations'] if item.get('request_id') == request_id or item['case_id'] == row['case_id']]
            original.require(not matching or matching == [row], 'demo request already bound to different AUTH or template')
            newly_reserved = not matching
            if newly_reserved:
                original.require(row['case_id'] not in {c['id'] for c in self.plan['cases']}, 'demo identity collides with a planned case')
                original.require(total + int(case['max_cost_micro_usdc']) <= int(self.plan['budget_micro_usdc'])
                                 and len(data['reservations']) < self.plan['max_requests'], 'campaign budget exhausted')
                data['reservations'].append(row)
                total += int(case['max_cost_micro_usdc'])
            # Re-fsync identical state before an exact AUTH retry as well. A
            # prior failed directory fsync must never become send permission
            # merely because its replacement file happens to be readable.
            original.atomic(self.directory / 'budget-state.json', original.canonical(data))
            return {**row, 'reserved_micro_usdc': case['max_cost_micro_usdc'],
                    'remaining_micro_usdc': str(int(self.plan['budget_micro_usdc']) - total),
                    'plan_sha256': self.identity()['plan_sha256'], 'newly_reserved': newly_reserved,
                    'auth_forward_allowed': True, 'inference_replays_supported': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['budget-status', 'reserve-direct-demo', 'reserve-demo', 'reserve'])
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--case')
    parser.add_argument('--request-id')
    parser.add_argument('--operation-id')
    parser.add_argument('--authorization-sha256')
    args = parser.parse_args()
    try:
        plan = original.read_json(args.plan)
        original.validate_plan(plan, args.plan.resolve().parent)
        original.require((args.command == 'budget-status') == (args.case is None), 'reservation requires exactly one case')
        expected = {'reserve-direct-demo': (True, False, True), 'reserve-demo': (True, True, False),
                    'reserve': (False, False, False), 'budget-status': (False, False, False)}[args.command]
        original.require(tuple(value is not None for value in (args.request_id, args.operation_id, args.authorization_sha256)) == expected,
                         'reservation identity arguments mismatch')
        budget = DemoBudget(args.state_dir, plan)
        if args.command == 'reserve-direct-demo':
            result = budget.reserve_direct_demo(args.case, args.request_id, args.authorization_sha256)
        elif args.command == 'reserve-demo':
            result = budget.reserve_demo(args.case, args.request_id, args.operation_id)
        elif args.command == 'reserve':
            result = budget.reserve(args.case)
        else:
            result = budget.status()
        print(json.dumps(result, indent=2))
    except Exception as error:
        print(json.dumps({'passed': False, 'error': str(error) if isinstance(error, original.Failure) else 'offline demo budget failed; values withheld'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
