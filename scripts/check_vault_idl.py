#!/usr/bin/env python3
"""Validate compiler-generated Anchor wire against the published layout-2 contract."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def account(name, *, writable=False, signer=False, address=None):
    return {"name": name, "writable": writable, "signer": signer, "address": address}


PROGRAM_ACCOUNTS = [
    account("token_program", address="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    account("associated_token_program", address="ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    account("system_program", address="11111111111111111111111111111111"),
]
FINANCIAL_ACCOUNTS = [
    account("pool"),
    account("tree", writable=True),
    account("note", writable=True),
    account("pending", writable=True),
    account("exit", writable=True),
    account("vault_authority"),
    account("mint"),
    account("source", writable=True),
    account("vault", writable=True),
    account("destination_owner"),
    account("destination", writable=True),
    account("treasury_owner"),
    account("treasury", writable=True),
    account("token_owner"),
    account("payer", writable=True, signer=True),
    *PROGRAM_ACCOUNTS,
]
ADMIN_ACCOUNTS = [account("pool", writable=True), account("admin", signer=True)]
INSTRUCTION_ACCOUNTS = {
    "initialize_pool": [
        account("pool", writable=True),
        account("tree", writable=True),
        account("vault_authority"),
        account("mint"),
        account("vault", writable=True),
        account("deployment_authority", signer=True),
        account("admin", signer=True),
        account("payer", writable=True, signer=True),
        *PROGRAM_ACCOUNTS,
    ],
    "deposit": [
        {"name": "financial", "accounts": FINANCIAL_ACCOUNTS},
        account("token_owner_signer", signer=True),
    ],
    "mutual_close": FINANCIAL_ACCOUNTS,
    "initiate_escape": FINANCIAL_ACCOUNTS,
    "challenge_escape": FINANCIAL_ACCOUNTS,
    "finalize_escape": FINANCIAL_ACCOUNTS,
    "claim_expired": FINANCIAL_ACCOUNTS,
    "set_treasury": ADMIN_ACCOUNTS,
    "pause": ADMIN_ACCOUNTS,
    "unpause": ADMIN_ACCOUNTS,
    # Financial follows this prefix as remaining_accounts. I04 must append that
    # list and set token_owner's signer bit for buffered deposits explicitly.
    "execute_payload": [
        account("payload", writable=True),
        account("uploader", signer=True),
        account("rent_payer", writable=True),
    ],
}


def check_accounts(actual, expected, path):
    assert len(actual) == len(expected), f"{path}: account count differs"
    for index, (item, contract) in enumerate(zip(actual, expected, strict=True)):
        label = f"{path}[{index}]/{contract['name']}"
        assert item["name"] == contract["name"], f"{label}: account order/name differs"
        assert ("accounts" in item) == ("accounts" in contract), f"{label}: nesting differs"
        if "accounts" in contract:
            check_accounts(item["accounts"], contract["accounts"], label)
        else:
            for flag in ("writable", "signer"):
                assert item.get(flag, False) is contract[flag], f"{label}: {flag} differs"
            assert item.get("optional", False) is False, f"{label}: account became optional"
            assert item.get("address") == contract["address"], f"{label}: fixed address differs"


def validate(idl):
    instructions = {item["name"]: item for item in idl["instructions"]}
    assert len(instructions) == len(idl["instructions"]), "duplicate instruction name"
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
    assert instructions.keys() == INSTRUCTION_ACCOUNTS.keys()
    for name, expected in lengths.items():
        instruction = instructions[name]
        check_accounts(instruction["accounts"], INSTRUCTION_ACCOUNTS[name], name)
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


def main():
    idl = json.loads((ROOT / "docs/contracts/zkapi_vault.json").read_text())
    validate(idl)
    print(f"PASS: {len(idl['instructions'])} instruction layouts and account metas, fixed errors, account discriminators and event order")
    print("NOT ESTABLISHED: wallet support, buffer lifecycle, production deployment")


if __name__ == "__main__":
    main()
