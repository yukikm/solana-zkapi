#!/usr/bin/env python3
"""Check fresh I03 runtime reports and ELF identities; never infer release gates."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return json.loads((ROOT / name).read_text())


def main():
    report = read("docs/evidence/I03-svm-results.json")
    rows = report["rows"]
    assert report["cases"] == len(rows) >= 350
    assert report["successful_transactions"] == sum(row["ok"] for row in rows)
    assert report["rejected_transactions"] == sum(not row["ok"] for row in rows) >= 160
    assert report["max_cu"] == max(row["cu"] for row in rows) <= 1_000_000
    assert report["max_transaction_bytes"] == max(row["transaction_bytes"] for row in rows) <= 1232
    assert report["production_eligible"] is False
    assert report["i04_buffer_lifecycle_verified"] is False
    for row in rows:
        assert row["ok"] == (row["expected"] == "Ok"), row["case"]
        assert not any(error in (row["error"] or "") for error in (
            "ComputationalBudgetExceeded", "ProgramFailedToComplete", "ProgramEnvironmentSetupFailure",
        )), row["case"]
    cases = {row["case"]: row for row in rows}
    for name in (
        "rollback/close-second-transfer-frozen", "rollback/finalize-second-transfer-frozen",
        "boundary/tree-full-sentinel", "boundary/reject-liability-overflow",
        "initialize/reject-valid-swapped-role-keys", "initialize/reject-valid-unpinned-state-key",
    ):
        assert cases[name]["ok"] is False, name
    for directory, key in (("i03-sbf", "elf_sha256"), ("i03-sbf-wrong", "wrong_vk_elf_sha256")):
        assert hashlib.sha256((ROOT / f"target/{directory}/zkapi_vault.so").read_bytes()).hexdigest() == report[key]
    assert report["elf_sha256"] != report["wrong_vk_elf_sha256"]
    parity = read("docs/evidence/I03-parity.json")
    assert parity["passed"] is True and parity["real_proofs_both"] is True
    assert len(parity["scenarios"]) == 7 and parity["compared_states"] == 27
    assert len(parity["rejections"]) == 14
    evm = read("docs/evidence/I03-evm-results.json")
    assert evm["passed"] >= 11 and evm["failed"] == 0
    assert evm["real_proofs"] is True and evm["mock_adapter"] is False
    print(f"PASS: {len(rows)} real SBF results, two ELF hashes, CU/bytes and EVM parity evidence")
    print("NOT ESTABLISHED: I04 upload/wallet lifecycle, production setup, G1–G4 release readiness")


if __name__ == "__main__":
    main()
