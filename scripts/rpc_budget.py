#!/usr/bin/env python3
"""Offline steady-state estimate for one archive writer and its local follower.

No RPC, configuration mutation, billing changes, throttling or spending grant.
The estimate is not a hard limit: retries, catch-up and user traffic need headroom.
"""
import argparse
from decimal import Decimal, ROUND_CEILING
import json


def estimate(*, blocks_per_second, archive_credits, days=31, poll_seconds=10,
             account_batches=1, control_processes=1, backlog_blocks=0,
             extra_credits_per_day=0, budget=10_000_000, reserve_percent=20):
    rate = Decimal(str(blocks_per_second))
    if not rate.is_finite() or rate < 0:
        raise ValueError('blocks_per_second must be finite and nonnegative')
    integers = (archive_credits, days, poll_seconds, account_batches,
                control_processes, backlog_blocks, extra_credits_per_day,
                budget, reserve_percent)
    if any(type(value) is not int for value in integers):
        raise ValueError('counts, credits and intervals must be integers')
    if not (archive_credits >= 1 and 1 <= days <= 366 and 1 <= poll_seconds <= 10
            and account_batches >= 1 and control_processes >= 0 and backlog_blocks >= 0
            and extra_credits_per_day >= 0 and budget > 0 and 0 <= reserve_percent < 100):
        raise ValueError('invalid estimate parameters')
    seconds = days * 86400
    cycles = (seconds + poll_seconds - 1) // poll_seconds
    blocks = int((rate * seconds).to_integral_value(rounding=ROUND_CEILING))
    # One range per warm writer poll (conservative even at a stationary tip).
    # Both readers independently verify accounts and a block anchor. Control
    # startup reads two genesis values and primary Pool per recovery cycle.
    requests = {
        'getBlock_full': blocks + backlog_blocks,
        'getBlock_anchor': 2 * cycles,
        'getBlocks': cycles,
        'getMultipleAccounts': 2 * account_batches * cycles,
        'getGenesisHash': (1 + 2 * control_processes) * cycles,
        'getAccountInfo': control_processes * cycles,
    }
    credits = {
        method: count * (archive_credits if method.startswith('getBlock') else 1)
        for method, count in requests.items()
    }
    credits['additional_traffic_allowance'] = extra_credits_per_day * days
    total = sum(credits.values())
    target = budget * (100 - reserve_percent) // 100
    return {
        'schema': 1,
        'assumptions': {
            'days': days, 'produced_blocks_per_second': str(rate),
            'archive_credits_per_request': archive_credits,
            'poll_seconds': poll_seconds, 'account_batches': account_batches,
            'control_processes': control_processes, 'backlog_blocks': backlog_blocks,
            'extra_credits_per_day': extra_credits_per_day,
            'all_configured_rpc_origins_counted_against_one_budget': True,
        },
        'requests': requests, 'credits': credits,
        'estimated_credits': total, 'budget': budget,
        'reserve_percent': reserve_percent, 'target_after_reserve': target,
        'remaining_credits': budget - total,
        'full_history_floor_credits': (blocks + backlog_blocks) * archive_credits,
        'status': ('within_target' if total <= target else
                   'insufficient_headroom' if total <= budget else 'over_budget'),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--blocks-per-second', required=True,
                        help='measured produced-block rate, not the slot rate')
    parser.add_argument('--archive-credits', type=int, required=True,
                        help='credits per getBlock/getBlocks request; verify account billing')
    for name, default in [('days', 31), ('poll-seconds', 10), ('account-batches', 1),
                          ('control-processes', 1), ('backlog-blocks', 0),
                          ('extra-credits-per-day', 0), ('budget', 10_000_000),
                          ('reserve-percent', 20)]:
        parser.add_argument('--' + name, type=int, default=default)
    try:
        result = estimate(**vars(parser.parse_args()))
    except (ValueError, ArithmeticError) as error:
        parser.error(str(error))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
