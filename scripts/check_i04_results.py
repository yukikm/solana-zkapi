#!/usr/bin/env python3
"""Validate fresh local I04 runtime artifacts and preserve release gate limits."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return json.loads((ROOT / name).read_text())


def sha(name):
    return hashlib.sha256((ROOT / name).read_bytes()).hexdigest()


def main():
    buffer = read("docs/evidence/I04-buffer-svm-results.json")
    regression = read("target/i04/i03-regression/I03-svm-results.json")
    sdk = read("target/i04/sdk-svm-history.json")
    indexer = read("target/i04/indexer-results.json")
    elf = sha("target/i04-sbf/zkapi_vault.so")
    for report, minimum in ((buffer, 161), (regression, 366)):
        rows = report["rows"]
        assert report["elf_sha256"] == elf
        assert report["cases"] == len(rows) >= minimum
        assert report["successful_transactions"] == sum(row["ok"] for row in rows)
        assert report["rejected_transactions"] == sum(not row["ok"] for row in rows)
        assert report["max_cu"] == max(row["cu"] for row in rows) <= 1_000_000
        assert report["max_transaction_bytes"] == max(row["transaction_bytes"] for row in rows) <= 1232
        for row in rows:
            assert row["ok"] == (row["expected"] == "Ok"), row["case"]
            assert not any(error in (row["error"] or "") for error in (
                "ComputationalBudgetExceeded", "ProgramFailedToComplete", "ProgramEnvironmentSetupFailure",
            )), row["case"]
    assert regression["wrong_vk_elf_sha256"] == sha("target/i04-sbf-wrong/zkapi_vault.so") != elf
    assert sdk["elf_sha256"] == elf
    assert sdk["production_eligible"] is False and sdk["live_wallet_verified"] is False
    assert sdk["live_rpc_finality_verified"] is False
    assert {s["name"] for s in sdk["scenarios"]} == {"close", "challenge", "finalize", "expiry"}
    rows = [row for scenario in sdk["scenarios"] for row in scenario["rows"]]
    assert all(row["ok"] == row["expected_ok"] for row in rows)
    assert sdk["max_cu"] == max(row["cu"] for row in rows) <= 1_000_000
    assert sdk["max_transaction_bytes"] == max(row["transaction_bytes"] for row in rows) <= 1232
    assert indexer["source_sha256"] == sha("target/i04/sdk-svm-history.json")
    assert len(indexer["scenarios"]) == 4
    for scenario in indexer["scenarios"]:
        assert scenario["missing_logs_replay_equal"] is True
        assert scenario["failed_transactions_ignored"] >= 1
        assert scenario["snapshot_roundtrips"] == scenario["blocks"]
        assert scenario["paths_checked"] > 0
    # Existing state/event behavior remains identical to the historical I03 trace.
    for suffix in ("traces", "rejections"):
        assert read(f"target/i04/i03-regression/I03-svm-{suffix}.json") == read(f"docs/evidence/I03-svm-{suffix}.json")
    summary = {
        "date_jst": "2026-10-04",
        "scope": "local test-key/mint real SBF and signed-v0 transport, synthetic finalized envelopes, indexer replay",
        "buffer_transactions": buffer["cases"], "buffer_rejected": buffer["rejected_transactions"],
        "i03_regression_transactions": regression["cases"], "i03_state_traces_unchanged": True,
        "sdk_transactions": len(rows), "sdk_scenarios": 4,
        "max_cu": max(buffer["max_cu"], regression["max_cu"], sdk["max_cu"]),
        "max_transaction_bytes": max(buffer["max_transaction_bytes"], regression["max_transaction_bytes"], sdk["max_transaction_bytes"]),
        "indexer": indexer, "elf_sha256": elf,
        "wrong_vk_elf_sha256": regression["wrong_vk_elf_sha256"],
        "source_artifacts": {name: sha(name) for name in [
            "docs/evidence/I04-buffer-svm-results.json", "target/i04/sdk-svm-history.json",
            "target/i04/indexer-results.json", "target/i04/i03-regression/I03-svm-results.json"]},
        "live_wallet_verified": False, "live_rpc_finality_verified": False,
        "hosted_ci_verified": False, "g1_passed": False, "production_eligible": False,
    }
    (ROOT / "docs/evidence/I04-summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(f"PASS: {buffer['cases']} buffer + {regression['cases']} regression + {len(rows)} SDK/SBF transactions; indexer logs/no-logs replay")
    print("NOT ESTABLISHED: live wallet/cluster, hosted CI, production setup or G1-G4 release readiness")


if __name__ == "__main__":
    main()
