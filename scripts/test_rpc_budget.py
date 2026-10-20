"""Deterministic cost scenarios; no provider calls or private configuration."""
import unittest
from rpc_budget import estimate


class BudgetTests(unittest.TestCase):
    def test_one_credit_31_day_example_and_safety_margin(self):
        result = estimate(blocks_per_second='2', archive_credits=1)
        self.assertEqual(result['estimated_credits'], 7_767_360)
        self.assertEqual(result['full_history_floor_credits'], 5_356_800)
        self.assertEqual(result['status'], 'within_target')
        faster = estimate(blocks_per_second='2.5', archive_credits=1)
        self.assertEqual(faster['estimated_credits'], 9_106_560)
        self.assertEqual(faster['status'], 'insufficient_headroom')

    def test_longer_poll_does_not_remove_a_single_historical_block(self):
        fast = estimate(blocks_per_second='2', archive_credits=1, poll_seconds=2)
        slow = estimate(blocks_per_second='2', archive_credits=1, poll_seconds=10)
        self.assertEqual(fast['requests']['getBlock_full'], slow['requests']['getBlock_full'])
        self.assertGreater(fast['estimated_credits'], slow['estimated_credits'])

    def test_archival_multiplier_catchup_and_extra_traffic_are_not_hidden(self):
        result = estimate(blocks_per_second='2', archive_credits=10,
                          backlog_blocks=123, extra_credits_per_day=1000)
        self.assertEqual(result['full_history_floor_credits'], (5_356_800 + 123) * 10)
        self.assertEqual(result['credits']['additional_traffic_allowance'], 31_000)
        self.assertEqual(result['status'], 'over_budget')

    def test_multiple_batches_and_control_processes_are_counted(self):
        one = estimate(blocks_per_second='0', archive_credits=1)
        two = estimate(blocks_per_second='0', archive_credits=1,
                       account_batches=2, control_processes=2)
        self.assertEqual(two['estimated_credits'] - one['estimated_credits'], 5 * 267840)

    def test_invalid_rates_and_unsafe_intervals_are_rejected(self):
        for rate in ['-1', 'NaN', 'Infinity']:
            with self.assertRaises(ValueError):
                estimate(blocks_per_second=rate, archive_credits=1)
        for seconds in [0, 11]:
            with self.assertRaises(ValueError):
                estimate(blocks_per_second='2', archive_credits=1, poll_seconds=seconds)


if __name__ == '__main__':
    unittest.main()
