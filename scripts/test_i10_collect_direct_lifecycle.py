"""Offline bounds/order/redaction tests. No database or provider is contacted."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("i10_collect_direct_lifecycle.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def fixture():
    case = {"passed": True, "case_id": "openrouter-direct-plain", "mode": "direct_openrouter",
            "provider": "openrouter", "http_status": 200, "inference_sends": 1,
            "inference_replays": 0, "signed_successor_verified_by_sdk": True,
            "evidence_kind": "OPENROUTER_USAGE", "stream": False, "charged_micro_usdc": "4",
            "request_id": "6114e9d8-be6d-47ac-a07f-a2a5657ff4e6",
            "operation_id": "b70f77ab-ab0c-459b-a0ee-58016c58ae9f"}
    row = {"id": "1", "recorded_at_epoch": "1000.0", "reference_present": False,
           "disabled_at_epoch": None, "observation_at_epoch": None,
           "observation_usd": None, "observation_nano": None, "observation_kind": None,
           "final_usd": None, "final_nano": None, "final_kind": None, "deleted": False}
    rows = [dict(row)]
    for changes in ({"reference_present": True}, {"disabled_at_epoch": "1002"},
                    {"observation_at_epoch": "1062", "observation_usd": "0.0000033",
                     "observation_nano": "3300", "observation_kind": "OPENROUTER_USAGE"},
                    {"final_usd": "0.0000033", "final_nano": "3300", "final_kind": "OPENROUTER_USAGE"},
                    {"deleted": True}):
        row.update(changes)
        row["id"] = str(len(rows) + 1)
        row["recorded_at_epoch"] = ["1001.0", "1002.0", "1062.5", "1122.5", "1123.0"][len(rows) - 1]
        rows.append(dict(row))
    observed = {"read_only": "on", "role": "i10_provider_reader",
                "sessions": [{"state": "SETTLED", "mode": "direct_openrouter", "provider": "openrouter",
                              "close_requested": True, "cap_micro": "1000000", "charged_nano": "3300",
                              "reserved_nano": "0", "active_operations": 0}],
                "attempts": [{"kind": "DIRECT_ISSUANCE", "send_claimed": True, "finished": True,
                              "fenced": False, "count": "1"}], "checkpoints": rows}
    return case, observed


class CollectorTests(unittest.TestCase):
    def test_complete_plain_and_sse_are_redacted(self):
        for stream in [False, True]:
            case, observed = fixture()
            case.update(case_id="openrouter-direct-sse" if stream else "openrouter-direct-plain", stream=stream)
            case["unselected_credential"] = "PRIVATE_CANARY"
            observed["sessions"][0]["provider_key_ref"] = "PRIVATE_CANARY"
            observed["checkpoints"][0]["raw_metadata"] = {"runtime_key": "PRIVATE_CANARY"}
            report = collector.validate(case, observed)
            self.assertTrue(report["passed"])
            self.assertNotIn("PRIVATE_CANARY", json.dumps(report))
            self.assertNotIn("provider_key_ref", json.dumps(report))

    def test_missing_or_mismatched_lifecycle_facts_fail(self):
        mutations = [
            lambda c, o: o.update(read_only="off"),
            lambda c, o: o.update(role="writer"),
            lambda c, o: o["sessions"].append(dict(o["sessions"][0])),
            lambda c, o: o["sessions"][0].update(state="RECONCILING"),
            lambda c, o: o["sessions"][0].update(charged_nano="5000"),
            lambda c, o: o["sessions"][0].update(reserved_nano="1"),
            lambda c, o: o["attempts"][0].update(count="2"),
            lambda c, o: o["attempts"][0].update(finished=False),
            lambda c, o: o["attempts"][0].update(kind="PROXY_INFERENCE"),
            lambda c, o: o["checkpoints"][2].update(reference_present=False),
            lambda c, o: o["checkpoints"][3].update(observation_at_epoch="1061"),
            lambda c, o: o["checkpoints"][4].update(recorded_at_epoch="1121.99"),
            lambda c, o: o["checkpoints"][4].update(final_usd="0.0000034", final_nano="3400"),
            lambda c, o: o["checkpoints"][4].update(deleted=True),
            lambda c, o: o["checkpoints"].pop(),
            lambda c, o: o["checkpoints"][5].update(final_usd=None, final_nano=None, final_kind=None),
            lambda c, o: o["checkpoints"][5].update(id="1"),
            lambda c, o: o["checkpoints"][3].update(observation_kind="PRIVATE_CANARY"),
            lambda c, o: o["checkpoints"][3].update(observation_usd="NaN"),
            lambda c, o: c.update(charged_micro_usdc="04"),
            lambda c, o: c.update(inference_sends=2),
            lambda c, o: c.update(signed_successor_verified_by_sdk=False),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                case, observed = fixture()
                mutate(case, observed)
                with self.assertRaises(ValueError):
                    collector.validate(case, observed)

    def test_sql_uses_validated_uuid_and_no_raw_secret_projection(self):
        case, _ = fixture()
        sql = collector.query(case["request_id"])
        self.assertIn("DIRECT_RECOVERY_CHECKPOINT", sql)
        self.assertNotIn("SELECT metadata", sql)
        self.assertNotIn("key_ref", sql)
        self.assertNotIn("evidence_digest", sql)
        self.assertNotIn("SELECT *", sql)
        for value in ["' OR true--", case["request_id"].upper(), "00000000-0000-0000-0000-000000000000"]:
            with self.assertRaises(ValueError):
                collector.query(value)

    def test_exact_integer_nano_and_micro_rounding(self):
        case, observed = fixture()
        for row in observed["checkpoints"]:
            for prefix in ("observation_", "final_"):
                if row[prefix + "usd"] is not None:
                    row[prefix + "usd"] = "0.0000030001"
                    row[prefix + "nano"] = "3001"
        observed["sessions"][0]["charged_nano"] = "3001"
        self.assertTrue(collector.validate(case, observed)["passed"])
        observed["checkpoints"][4]["final_nano"] = "3000"
        with self.assertRaises(ValueError):
            collector.validate(case, observed)


if __name__ == "__main__":
    unittest.main()
