#!/usr/bin/env python3
"""Validate compiler-generated Anchor wire against the published layout-2 contract."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    idl = json.loads((ROOT / "docs/contracts/zkapi_vault.json").read_text())
    instructions = {item["name"]: item for item in idl["instructions"]}
    definitions = {item["name"]: item["type"] for item in idl["types"]}

    def size(kind):
        if isinstance(kind, str):
            return {"u8": 1, "bool": 1, "u32": 4, "u64": 8, "pubkey": 32}[kind]
        if "array" in kind:
            return size(kind["array"][0]) * kind["array"][1]
        if "defined" in kind:
            item = definitions[kind["defined"]["name"]]
            assert item["kind"] == "struct"
            return sum(size(field["type"]) for field in item["fields"])
        raise AssertionError(f"Variable or unknown wire type: {kind}")

    # Fixed args only; Anchor adds the eight-byte discriminator.
    lengths = {
        "initialize_pool": 280,
        "deposit": 692,
        "mutual_close": 1312,
        "initiate_escape": 1312,
        "challenge_escape": 1252,
        "finalize_escape": 4,
        "claim_expired": 612,
        "set_treasury": 32,
        "pause": 0,
        "unpause": 0,
        "execute_payload": 32,
    }
    assert instructions.keys() == lengths.keys(), instructions.keys()
    for name, expected in lengths.items():
        instruction = instructions[name]
        assert bytes(instruction["discriminator"]) == hashlib.sha256(
            f"global:{name}".encode()
        ).digest()[:8], name
        actual = sum(size(arg["type"]) for arg in instruction["args"])
        assert actual == expected, (name, actual, expected)

    errors = [
        "Paused", "InvalidBinding", "InvalidMint", "InvalidTokenAccount", "InvalidField",
        "InvalidProof", "StaleRoot", "StaleNoteId", "InvalidExpiry", "TreeFull",
        "InvalidBalance", "ReplayedNullifier", "NoteNotActive", "NotPending",
        "ChallengeExpired", "ChallengeNotExpired", "NotExpired", "InvalidBuffer",
        "ArithmeticOverflow",
    ]
    assert [(x["code"], x["name"]) for x in idl["errors"][:19]] == list(
        enumerate(errors, 6000)
    )
    event = definitions["VaultTransitionV1"]
    assert [field["name"] for field in event["fields"]] == [
        "event_version", "pool", "sequence", "op", "note_id", "status", "old_root",
        "new_root", "commitment", "deposit", "expiry", "exit_nullifier",
        "final_balance", "destination_owner", "deadline",
    ]
    assert [field["name"] for field in definitions["TreeUpdate"]["fields"]] == [
        "public", "proof",
    ]
    for account in idl["accounts"]:
        name = account["name"]
        assert bytes(account["discriminator"]) == hashlib.sha256(
            f"account:{name}".encode()
        ).digest()[:8], name
        assert definitions[name]["fields"][0] == {"name": "layout_version", "type": "u8"}
    print(f"PASS: {len(lengths)} instruction layouts, fixed errors, account discriminators and event order")
    print("NOT ESTABLISHED: wallet support, buffer lifecycle, production deployment")


if __name__ == "__main__":
    main()
