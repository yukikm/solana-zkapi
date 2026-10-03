#!/usr/bin/env python3
"""Compare runtime-produced fixed-upstream EVM and real-SBF Vault traces."""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/evidence"
SCENARIOS = (
    "signed_close", "escape_finalize", "historical_challenge", "active_expiry",
    "paused_challenge", "paused_finalize", "paused_expiry",
)
FIELDS = (
    "root", "time", "next_id", "statuses", "active_leaves", "pending_exists",
    "pending_balance", "pending_nullifier", "pending_deadline", "nullifier_used",
    "user_delta", "treasury_delta", "vault_units",
)
REJECTIONS = (
    "paused_deposit", "paused_close", "paused_escape", "escape_proof_for_close",
    "close_proof_for_escape", "stale_root_escape", "finalize_before_deadline",
    "challenge_at_deadline", "repeated_finalize", "rewritten_historical_root",
    "escape_consumed_nullifier", "repeated_challenge", "expiry_before_deadline",
    "repeated_expiry",
)
ERROR_EQUIVALENTS = {
    "InvalidDeploymentBinding": "InvalidBinding",
    "NotPendingWithdrawal": "NotPending",
    "NoteNotExpired": "NotExpired",
}


def load(path):
    return json.loads(path.read_text())


def save(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def collect():
    results = load(ROOT / "target/i03/evm-results.json")
    tests = [result for suite in results.values() for result in suite.get("test_results", {}).values()]
    assert len(tests) >= 10, "expected all real-proof EVM tests"
    assert all(test["status"] == "Success" for test in tests), "EVM test failure"
    directory = ROOT / "target/i03/evm-traces"
    traces = {name: load(directory / f"{name}.json") for name in SCENARIOS}
    rejects = {name: load(directory / f"reject-{name}.json") for name in REJECTIONS}
    save(EVIDENCE / "I03-evm-traces.json", traces)
    save(EVIDENCE / "I03-evm-rejections.json", rejects)
    save(EVIDENCE / "I03-evm-results.json", {
        "upstream_commit": "045b444ea1b52538d1b40273c7cb6ed09468a052",
        "real_proofs": True, "mock_adapter": False,
        "forge_version": "1.3.1", "solc_version": "0.8.28",
        "fixture_sha256": hashlib.sha256((ROOT / "tests/evm-vault/fixtures.json").read_bytes()).hexdigest(),
        "passed": len(tests), "failed": 0,
        "test_results": {name: {"status": test["status"], "gas": test.get("gas", test.get("kind", {}).get("Unit", {}).get("gas"))}
                         for suite in results.values() for name, test in suite.get("test_results", {}).items()},
        "limitations": ["Gas shown is the whole Forge test, not per-transaction settlement gas.",
                        "Test setup only; no production setup or live chain deployment attested."],
    })
    print(f"PASS: collected {len(tests)} EVM tests, {sum(map(len, traces.values()))} states, {len(rejects)} rejection conditions")


def normalized(value):
    if isinstance(value, str) and value.startswith("0x"):
        return value.lower()
    if isinstance(value, list):
        return list(map(normalized, value))
    return value


def compare():
    evm = load(EVIDENCE / "I03-evm-traces.json")
    svm = load(EVIDENCE / "I03-svm-traces.json")
    states = 0
    for name in SCENARIOS:
        assert len(evm[name]) == len(svm[name]), f"{name}: state count differs"
        for index, (left, right) in enumerate(zip(evm[name], svm[name], strict=True)):
            for field in FIELDS:
                assert field in left and field in right, f"{name}/{index}: missing {field}"
                assert normalized(left[field]) == normalized(right[field]), (
                    f"{name}/{index}/{field}: EVM={left[field]!r}, SVM={right[field]!r}")
            states += 1
    evm_rejections = load(EVIDENCE / "I03-evm-rejections.json")
    svm_rejections = load(EVIDENCE / "I03-svm-rejections.json")
    errors = {}
    for name in REJECTIONS:
        left, right = evm_rejections[name], svm_rejections[name]
        assert left["unchanged"] is True and right["unchanged"] is True, name
        assert ERROR_EQUIVALENTS.get(left["error"], left["error"]) == right["error"], f"{name}: error semantics differ ({left}, {right})"
        errors[name] = {"evm": left["error"], "solana": right["error"], "state_unchanged_both": True}
    result = {
        "passed": True, "upstream_commit": "045b444ea1b52538d1b40273c7cb6ed09468a052",
        "real_proofs_both": True, "scenarios": list(SCENARIOS), "compared_states": states,
        "compared_fields": list(FIELDS), "rejections": errors,
        "parameters": {"deposit": 5_000_000, "signed_balance": 4_900_000, "note_ids": [0, 1],
                       "now": 3_000_000_000, "ttl": 2_592_000, "challenge": 86_400},
        "intentional_differences": [
            "One integer unit is 1 gwei native ETH on EVM and 1 micro-USDC on Solana; comparison excludes EVM gas and Solana rent/fees.",
            "EVM proof binds chain 31337, deployed address, and 160-bit destination; Solana proof binds namespace, pool H2F and full destination-owner H2F. Proof bytes are chain-specific.",
            "EVM nextNoteId is u32 and checked increment rejects the maximum u32 ID; Solana uses a u64 counter and permits ID 2^32-1, then TreeFull.",
            "EVM recomputes original Poseidon paths in contract; Solana verifies the additional pinned transition proof for the same hash, leaves, and roots.",
            "Solana enforces account/PDA/ATA/profile/token ownership and records sequence/outstanding deposits; these have no direct EVM storage equivalents and are checked separately.",
            "Initialization follows ADR-0002's single-pool specialization: Solana accepts only the exact role-specific signing-key pair validated canonical/on-curve/in-subgroup/nonidentity at build time; every pool instruction compares the role pins, so even another valid pair or swapped keys is rejected and changing keys requires a new build/new pool. Solana also rejects zero TTL. Upstream accepts arbitrary field-bounded nonzero key pairs and permits zero TTL. These constructor differences are separate from the paired financial traces.",
        ],
        "limits": ["No live network, provider inference, browser, transport, or production ceremony gate is claimed by these local runtime tests.",
                   "Signed use is the genuine non-genesis signed-balance request and withdrawal circuit path; no provider/API inference execution is simulated."],
    }
    save(EVIDENCE / "I03-parity.json", result)
    print(f"PASS: EVM/SBF exact match: {len(SCENARIOS)} traces, {states} states, {len(FIELDS)} fields, {len(REJECTIONS)} rejection conditions")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--collect", action="store_true", help="collect EVM evidence without requiring SVM output yet")
    args = parser.parse_args()
    collect() if args.collect else compare()
