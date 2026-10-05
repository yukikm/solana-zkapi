#!/usr/bin/env python3
"""Exercise IDL contract drift using mutations of the generated artifact."""
import copy
import json
import unittest

from check_vault_idl import ROOT, validate


class AccountContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.idl = json.loads((ROOT / "docs/contracts/zkapi_vault.json").read_text())

    def groups(self):
        for index, instruction in enumerate(self.idl["instructions"]):
            yield (index, None), instruction["accounts"]
            for position, item in enumerate(instruction["accounts"]):
                if "accounts" in item:
                    yield (index, position), item["accounts"]

    def mutated_group(self, location):
        idl = copy.deepcopy(self.idl)
        instruction, nested = location
        group = idl["instructions"][instruction]["accounts"]
        if nested is not None:
            group = group[nested]["accounts"]
        return idl, group

    def test_buffer_wire_mutations_are_rejected(self):
        for name in ("create_payload", "append_payload", "seal_payload", "close_payload", "execute_payload"):
            idl = copy.deepcopy(self.idl)
            instruction = next(i for i in idl["instructions"] if i["name"] == name)
            if instruction["args"]:
                instruction["args"][0]["type"] = "u64" if name == "append_payload" else "u16"
            else:
                instruction["args"].append({"name": "unexpected", "type": "u8"})
            with self.subTest(name=name), self.assertRaisesRegex(AssertionError, "buffer wire differs"):
                validate(idl)

    def test_generated_idl_passes(self):
        validate(self.idl)

    def test_compact_wire_field_order_names_and_types_are_enforced(self):
        original = next(i for i in self.idl["instructions"] if i["name"] == "deposit_compact_v1")
        for position in range(len(original["args"])):
            for mutation in ("name", "type", "order"):
                idl = copy.deepcopy(self.idl)
                instruction = next(i for i in idl["instructions"] if i["name"] == "deposit_compact_v1")
                args = instruction["args"]
                if mutation == "name":
                    args[position]["name"] = "unexpected"
                elif mutation == "type":
                    args[position]["type"] = "u8"
                else:
                    other = (position + 1) % len(args)
                    args[position], args[other] = args[other], args[position]
                with self.subTest(position=position, mutation=mutation), self.assertRaisesRegex(AssertionError, "compact wire differs"):
                    validate(idl)

    def test_every_signer_and_writable_bit_is_enforced(self):
        for location, group in self.groups():
            for position, item in enumerate(group):
                if "accounts" in item:
                    continue
                for flag in ("signer", "writable"):
                    with self.subTest(location=location, account=item["name"], flag=flag):
                        idl, changed = self.mutated_group(location)
                        changed[position][flag] = not item.get(flag, False)
                        with self.assertRaisesRegex(AssertionError, f"{flag} differs"):
                            validate(idl)

    def test_adjacent_account_swaps_are_rejected(self):
        for location, group in self.groups():
            for position in range(len(group) - 1):
                with self.subTest(location=location, position=position):
                    idl, changed = self.mutated_group(location)
                    changed[position:position + 2] = changed[position:position + 2][::-1]
                    with self.assertRaisesRegex(AssertionError, "account order/name differs"):
                        validate(idl)

    def test_missing_or_extra_accounts_are_rejected(self):
        for location, _ in self.groups():
            for extra in (False, True):
                with self.subTest(location=location, extra=extra):
                    idl, changed = self.mutated_group(location)
                    if extra:
                        changed.append({"name": "unexpected"})
                    else:
                        changed.pop()
                    with self.assertRaisesRegex(AssertionError, "account count differs"):
                        validate(idl)

    def test_fixed_program_address_changes_are_rejected(self):
        for location, group in self.groups():
            for position, item in enumerate(group):
                if "address" not in item:
                    continue
                with self.subTest(location=location, account=item["name"]):
                    idl, changed = self.mutated_group(location)
                    changed[position]["address"] = "changed-program"
                    with self.assertRaisesRegex(AssertionError, "fixed address differs"):
                        validate(idl)


if __name__ == "__main__":
    unittest.main()
