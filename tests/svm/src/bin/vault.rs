//! I03 acceptance: production Vault handlers loaded as an ELF in LiteSVM.
//! Sealed payload accounts are fixtures at the explicit I03/I04 boundary.
#[path = "../vault_support.rs"]
mod support;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{instruction::AccountMeta, pubkey::Pubkey, signature::Signer};
use std::{collections::BTreeMap, fs, path::Path};
use support::*;
use zkapi_layout2::{Operation, FR_MODULUS, MAX_AMOUNT};
use zkapi_vault::{ExitNullifier, PayloadBuffer, PendingWithdrawal, PoolConfig, TreeState};

fn fresh(elf: &[u8], a: &Value) -> World {
    let mut w = World::new(elf);
    w.initialize(a);
    w
}
fn active(elf: &[u8], a: &Value) -> World {
    let mut w = fresh(elf, a);
    w.execute("setup/deposit", a, Operation::Deposit, Expect::Ok)
        .unwrap();
    w
}
fn pending(elf: &[u8], a: &Value) -> World {
    let mut w = active(elf, a);
    w.execute("setup/escape", a, Operation::Escape, Expect::Ok)
        .unwrap();
    w
}
fn collect(w: World, rows: &mut Vec<Value>) {
    rows.extend(w.rows);
}
fn semantic_rejects(rows: &[Value]) -> Value {
    let keys = [
        "paused_deposit",
        "paused_close",
        "paused_escape",
        "escape_proof_for_close",
        "close_proof_for_escape",
        "stale_root_escape",
        "finalize_before_deadline",
        "challenge_at_deadline",
        "repeated_finalize",
        "rewritten_historical_root",
        "escape_consumed_nullifier",
        "repeated_challenge",
        "expiry_before_deadline",
        "repeated_expiry",
    ];
    let mut result = serde_json::Map::new();
    for key in keys {
        let r = rows
            .iter()
            .find(|r| r["case"] == key)
            .unwrap_or_else(|| panic!("missing EVM rejection {key}"));
        assert_eq!(r["ok"], false);
        let names = [
            "Paused",
            "InvalidBinding",
            "InvalidMint",
            "InvalidTokenAccount",
            "InvalidField",
            "InvalidProof",
            "StaleRoot",
            "StaleNoteId",
            "InvalidExpiry",
            "TreeFull",
            "InvalidBalance",
            "ReplayedNullifier",
            "NoteNotActive",
            "NotPending",
            "ChallengeExpired",
            "ChallengeNotExpired",
            "NotExpired",
            "InvalidBuffer",
            "ArithmeticOverflow",
        ];
        let code = r["expected"]
            .as_str()
            .unwrap()
            .strip_prefix("Error(")
            .unwrap()
            .trim_end_matches(')')
            .parse::<usize>()
            .unwrap();
        result.insert(
            key.into(),
            json!({"error":names[code-6000],"raw_error":r["error"],"unchanged":true}),
        );
    }
    Value::Object(result)
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let elf =
        fs::read(root.join("target/i03-sbf/zkapi_vault.so")).expect("build actual SBF ELF first");
    let fixtures = root.join("tests/fixtures/vault");
    let a = read(fixtures.join("a.json"));
    let ab = read(fixtures.join("a-with-b.json"));
    let ba = read(fixtures.join("b-with-a.json"));
    let other = read(fixtures.join("other-vault.json"));
    let max = read(fixtures.join("max-id.json"));
    let genesis = read(fixtures.join("genesis-a.json"));
    let mut rows = vec![];
    let mut traces = BTreeMap::new();
    let wrong_elf = fs::read(root.join("target/i03-sbf-wrong/zkapi_vault.so"))
        .expect("build wrong-VK SBF ELF fixture");
    {
        let mut w = fresh(&wrong_elf, &a);
        w.execute(
            "wrong-vk/tree-deposit",
            &a,
            Operation::Deposit,
            Expect::Error(6005),
        )
        .unwrap_err();
        collect(w, &mut rows);
        let mut w = active(&elf, &a);
        w.svm.add_program(w.id, &wrong_elf);
        w.execute(
            "wrong-vk/withdrawal-close",
            &a,
            Operation::Close,
            Expect::Error(6005),
        )
        .unwrap_err();
        collect(w, &mut rows);
        let mut w = pending(&elf, &a);
        w.svm.add_program(w.id, &wrong_elf);
        w.execute(
            "wrong-vk/request-challenge",
            &a,
            Operation::Challenge,
            Expect::Error(6005),
        )
        .unwrap_err();
        collect(w, &mut rows);
    }

    // Success traces share exactly the amounts/timestamps/proofs semantics with
    // the fixed upstream EVM Vault trace runner.
    {
        let mut w = fresh(&elf, &a);
        w.snapshot("init", &a);
        w.execute("signed_close/deposit", &a, Operation::Deposit, Expect::Ok)
            .unwrap();
        w.snapshot("deposit", &a);
        let mut body = payload(&a, Operation::Close);
        body[..704].copy_from_slice(&proof(&a["auth"]["escape"]));
        w.execute_body(
            "escape_proof_for_close",
            &a,
            Operation::Close,
            &body,
            Expect::Error(6001),
        )
        .unwrap_err();
        w.execute(
            "signed_close/close-create-both-atas",
            &a,
            Operation::Close,
            Expect::Ok,
        )
        .unwrap();
        w.snapshot("close", &a);
        assert_eq!(w.amount(w.destination), BALANCE);
        assert_eq!(w.amount(w.treasury), DEPOSIT - BALANCE);
        assert_eq!(w.state::<TreeState>(w.tree).outstanding_deposits, 0);
        traces.insert("signed_close", w.traces.clone());
        collect(w, &mut rows);
    }
    for paused in [false, true] {
        let mut w = fresh(&elf, &a);
        w.snapshot("init", &a);
        w.execute(
            "escape_finalize/deposit",
            &a,
            Operation::Deposit,
            Expect::Ok,
        )
        .unwrap();
        w.snapshot("deposit", &a);
        let mut body = payload(&a, Operation::Escape);
        body[..704].copy_from_slice(&proof(&a["auth"]["withdrawal"]));
        w.execute_body(
            "close_proof_for_escape",
            &a,
            Operation::Escape,
            &body,
            Expect::Error(6001),
        )
        .unwrap_err();
        w.execute(
            "escape_finalize/escape-create-pending-and-exit",
            &a,
            Operation::Escape,
            Expect::Ok,
        )
        .unwrap();
        w.snapshot("escape", &a);
        if paused {
            w.admin("pause", &[], Expect::Ok).unwrap();
        }
        w.clock((NOW + CHALLENGE - 1) as i64);
        w.finalize("finalize_before_deadline", 0, Expect::Error(6015))
            .unwrap_err();
        w.clock((NOW + CHALLENGE) as i64);
        w.finalize("escape_finalize/finalize-deadline-equality", 0, Expect::Ok)
            .unwrap();
        w.snapshot("finalize", &a);
        assert!(!w.state::<PendingWithdrawal>(w.pending(0)).exists);
        assert_eq!(w.amount(w.destination), BALANCE);
        w.finalize("repeated_finalize", 0, Expect::Error(6013))
            .unwrap_err();
        traces.insert(
            if paused {
                "paused_finalize"
            } else {
                "escape_finalize"
            },
            w.traces.clone(),
        );
        collect(w, &mut rows);
    }
    for paused in [false, true] {
        let mut w = fresh(&elf, &a);
        w.snapshot("init", &a);
        w.execute("historical/deposit-a", &a, Operation::Deposit, Expect::Ok)
            .unwrap();
        w.snapshot("deposit_a", &a);
        w.execute("historical/deposit-b", &ba, Operation::Deposit, Expect::Ok)
            .unwrap();
        w.snapshot("deposit_b", &a);
        w.execute(
            "stale_root_escape",
            &a,
            Operation::Escape,
            Expect::Error(6006),
        )
        .unwrap_err();
        w.execute("historical/escape-a", &ab, Operation::Escape, Expect::Ok)
            .unwrap();
        w.snapshot("escape", &a);
        if paused {
            w.admin("pause", &[], Expect::Ok).unwrap();
        }
        let mut historical = payload(&ab, Operation::Challenge);
        historical[4..644].copy_from_slice(&proof(&a["auth"]["request"]));
        let p = w.state::<PendingWithdrawal>(w.pending(0));
        let current = w.state::<TreeState>(w.tree).root;
        let request_root = field(&a["auth"]["request"]["public_inputs"][3]);
        assert_ne!(request_root, current);
        assert_ne!(request_root, p.old_root);
        w.clock((NOW + CHALLENGE) as i64);
        w.execute_body(
            "challenge_at_deadline",
            &ab,
            Operation::Challenge,
            &historical,
            Expect::Error(6014),
        )
        .unwrap_err();
        w.clock((NOW + CHALLENGE - 1) as i64);
        let mut rewritten = historical.clone();
        rewritten[4 + 3 * 32..4 + 4 * 32].copy_from_slice(&current);
        w.execute_body(
            "rewritten_historical_root",
            &ab,
            Operation::Challenge,
            &rewritten,
            Expect::Error(6005),
        )
        .unwrap_err();
        w.execute_body(
            "historical/challenge-original-request",
            &ab,
            Operation::Challenge,
            &historical,
            Expect::Ok,
        )
        .unwrap();
        w.snapshot("challenge", &a);
        assert!(!w.state::<PendingWithdrawal>(w.pending(0)).exists);
        let n = field(&a["auth"]["withdrawal"]["public_inputs"][11]);
        assert!(w.state::<ExitNullifier>(w.exit(&n)).consumed);
        w.execute_body(
            "repeated_challenge",
            &ab,
            Operation::Challenge,
            &historical,
            Expect::Error(6013),
        )
        .unwrap_err();
        if paused {
            w.admin("unpause", &[], Expect::Ok).unwrap();
        }
        w.execute(
            "escape_consumed_nullifier",
            &ab,
            Operation::Escape,
            Expect::Error(6011),
        )
        .unwrap_err();
        traces.insert(
            if paused {
                "paused_challenge"
            } else {
                "historical_challenge"
            },
            w.traces.clone(),
        );
        collect(w, &mut rows);
    }
    for paused in [false, true] {
        let mut w = fresh(&elf, &a);
        w.snapshot("init", &a);
        w.execute("expiry/deposit", &a, Operation::Deposit, Expect::Ok)
            .unwrap();
        w.snapshot("deposit", &a);
        if paused {
            w.admin("pause", &[], Expect::Ok).unwrap();
        }
        let expiry = a["expiry"].as_u64().unwrap();
        w.clock((expiry - 1) as i64);
        w.execute(
            "expiry_before_deadline",
            &a,
            Operation::Expiry,
            Expect::Error(6016),
        )
        .unwrap_err();
        w.clock(expiry as i64);
        w.execute("expiry/exact-equality", &a, Operation::Expiry, Expect::Ok)
            .unwrap();
        w.snapshot("expiry", &a);
        assert_eq!(w.amount(w.treasury), DEPOSIT);
        assert_eq!(w.amount(w.destination), 0);
        w.execute(
            "repeated_expiry",
            &a,
            Operation::Expiry,
            Expect::Error(6012),
        )
        .unwrap_err();
        traces.insert(
            if paused {
                "paused_expiry"
            } else {
                "active_expiry"
            },
            w.traces.clone(),
        );
        collect(w, &mut rows);
    }
    // Genesis balance and withdrawal after note expiry preserve upstream policy.
    {
        let mut w = active(&elf, &genesis);
        w.execute(
            "genesis/escape-full-principal",
            &genesis,
            Operation::Escape,
            Expect::Ok,
        )
        .unwrap();
        w.clock((NOW + CHALLENGE) as i64);
        w.finalize("genesis/finalize-full-principal", 0, Expect::Ok)
            .unwrap();
        assert_eq!(w.amount(w.destination), DEPOSIT);
        assert_eq!(w.amount(w.treasury), 0);
        collect(w, &mut rows);
        let mut w = active(&elf, &a);
        w.clock(a["expiry"].as_u64().unwrap() as i64);
        w.execute(
            "withdrawal/after-expiry-still-allowed",
            &a,
            Operation::Close,
            Expect::Ok,
        )
        .unwrap();
        collect(w, &mut rows);
    }
    // pause blocks only new deposits and voluntary exits; administration cannot
    // alter financial sequence and pending payouts use the current treasury.
    {
        let mut w = active(&elf, &a);
        let seq = w.state::<TreeState>(w.tree).sequence;
        w.admin("pause", &[], Expect::Ok).unwrap();
        for (name, fixture, op) in [
            ("paused_deposit", &ba, Operation::Deposit),
            ("paused_close", &a, Operation::Close),
            ("paused_escape", &a, Operation::Escape),
        ] {
            w.execute(name, fixture, op, Expect::Error(6000))
                .unwrap_err();
        }
        assert_eq!(w.state::<TreeState>(w.tree).sequence, seq);
        w.admin("unpause", &[], Expect::Ok).unwrap();
        w.execute("treasury/escape", &a, Operation::Escape, Expect::Ok)
            .unwrap();
        let owner = Pubkey::new_from_array([12; 32]);
        w.admin("set_treasury", owner.as_ref(), Expect::Ok).unwrap();
        w.treasury_owner = owner;
        w.treasury = ata(owner, w.mint);
        w.clock((NOW + CHALLENGE) as i64);
        w.finalize("treasury/pending-uses-new-owner", 0, Expect::Ok)
            .unwrap();
        assert_eq!(w.amount(w.treasury), DEPOSIT - BALANCE);
        w.admin("set_treasury", &[0; 32], Expect::Reject)
            .unwrap_err();
        let accounts = vec![
            AccountMeta::new(w.pool, false),
            AccountMeta::new_readonly(w.attacker.pubkey(), true),
        ];
        w.run(
            "admin/unauthorized",
            accounts,
            data("pause", &[]),
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    // The source owner signs independently from the uploader/fee payer.
    for signed in [false, true] {
        let mut w = fresh(&elf, &a);
        w.source = ata(w.attacker.pubkey(), w.mint);
        w.token(w.source, w.attacker.pubkey(), DEPOSIT);
        let (mut accounts, args, buffer) =
            w.execution(&a, Operation::Deposit, &payload(&a, Operation::Deposit));
        accounts[3 + 13] = AccountMeta::new_readonly(w.attacker.pubkey(), signed);
        let result = w.run(
            if signed {
                "deposit/sponsored-owner-signature"
            } else {
                "deposit/missing-token-owner-signature"
            },
            accounts,
            args,
            if signed { Expect::Ok } else { Expect::Reject },
        );
        if signed {
            result.unwrap();
            assert_eq!(w.amount(w.vault), DEPOSIT);
            assert!(w.svm.get_account(&buffer).is_none_or(|a| a.lamports == 0));
        } else {
            result.unwrap_err();
        }
        collect(w, &mut rows);
    }
    {
        let mut w = fresh(&elf, &a);
        let (mut accounts, args, buffer) =
            w.execution(&a, Operation::Deposit, &payload(&a, Operation::Deposit));
        let recipient = w.attacker.pubkey();
        let before = w.svm.get_account(&recipient).unwrap().lamports;
        let rent = w.svm.get_account(&buffer).unwrap().lamports;
        w.edit_state::<PayloadBuffer>(buffer, |b| b.rent_payer = recipient);
        accounts[2] = AccountMeta::new(recipient, false);
        w.run(
            "buffer/success-returns-exact-rent",
            accounts,
            args,
            Expect::Ok,
        )
        .unwrap();
        assert_eq!(
            w.svm.get_account(&recipient).unwrap().lamports,
            before + rent
        );
        collect(w, &mut rows);
    }
    {
        let mut w = World::new(&elf);
        for key in [w.pool, w.tree] {
            w.svm.airdrop(&key, 1).unwrap();
        }
        w.run(
            "initialize/prefunded-pdas",
            w.init_accounts(),
            w.init_data(&a),
            Expect::Ok,
        )
        .unwrap();
        w.svm.airdrop(&w.note(0), 1).unwrap();
        w.execute(
            "deposit/prefunded-note-pda",
            &a,
            Operation::Deposit,
            Expect::Ok,
        )
        .unwrap();
        let n = field(&a["auth"]["withdrawal"]["public_inputs"][11]);
        for key in [w.pending(0), w.exit(&n)] {
            w.svm.airdrop(&key, 1).unwrap();
        }
        w.execute(
            "escape/prefunded-pending-exit-pdas",
            &a,
            Operation::Escape,
            Expect::Ok,
        )
        .unwrap();
        collect(w, &mut rows);
    }

    // Initialization policy including actual signature/PDA/key checks.
    for case in 0..19 {
        let mut w = World::new(&elf);
        let mut accounts = w.init_accounts();
        let mut args = w.init_data(&a);
        let name = match case {
            0 => {
                accounts[5] = AccountMeta::new_readonly(w.attacker.pubkey(), true);
                "deployment-authority"
            }
            1 => {
                accounts[6] = AccountMeta::new_readonly(w.attacker.pubkey(), true);
                "admin-signature-binding"
            }
            2 => {
                args[8 + 192..8 + 200].fill(0);
                "zero-ttl"
            }
            3 => {
                args[8 + 200..8 + 208].fill(0);
                "zero-challenge"
            }
            4 => {
                args[8 + 208..8 + 216].fill(0);
                "zero-cap"
            }
            5 => {
                args[8 + 208..8 + 216].copy_from_slice(&(MAX_AMOUNT + 1).to_le_bytes());
                "large-cap"
            }
            6 => {
                args[8 + 216..8 + 248].fill(0);
                "zero-admin"
            }
            7 => {
                args[8 + 248..8 + 280].fill(0);
                "zero-treasury"
            }
            8 => {
                args[8 + 64..8 + 128].fill(0);
                "offcurve-state-key"
            }
            9 => {
                args[8 + 128..8 + 192].fill(0);
                "offcurve-clearance-key"
            }
            10 => {
                args[8 + 64..8 + 96].copy_from_slice(&FR_MODULUS);
                "noncanonical-key"
            }
            11 => {
                args[8 + 64..8 + 128].fill(0);
                args[8 + 127] = 1;
                "identity-state-key"
            }
            12 => {
                accounts[0] = AccountMeta::new(Pubkey::new_unique(), false);
                "pool-pda"
            }
            13 => {
                accounts[1] = AccountMeta::new(Pubkey::new_unique(), false);
                "tree-pda"
            }
            14 => {
                accounts[2] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
                "vault-authority-pda"
            }
            15 => {
                accounts[4] = AccountMeta::new(Pubkey::new_unique(), false);
                "vault-ata"
            }
            16 => {
                args[8 + 64..8 + 96].fill(0);
                let mut minus_one = FR_MODULUS;
                minus_one[31] -= 1;
                args[8 + 96..8 + 128].copy_from_slice(&minus_one);
                "torsion-state-key"
            }
            17 => {
                let state = args[8 + 64..8 + 128].to_vec();
                let clearance = args[8 + 128..8 + 192].to_vec();
                args[8 + 64..8 + 128].copy_from_slice(&clearance);
                args[8 + 128..8 + 192].copy_from_slice(&state);
                "valid-swapped-role-keys"
            }
            _ => {
                let x: [u8; 32] = args[8 + 64..8 + 96].try_into().unwrap();
                let negative = zkapi_poseidon::bytes(-zkapi_poseidon::parse(&x).unwrap());
                args[8 + 64..8 + 96].copy_from_slice(&negative);
                "valid-unpinned-state-key"
            }
        };
        w.run(
            &format!("initialize/reject-{name}"),
            accounts,
            args,
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    {
        let mut w = fresh(&elf, &a);
        w.run(
            "initialize/already-exists",
            w.init_accounts(),
            w.init_data(&a),
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }

    // Account identity, SPL mint, canonical ATA, delegate and program guards.
    for case in 0..23 {
        let mut w = fresh(&elf, &a);
        let (mut accounts, args, _) =
            w.execution(&a, Operation::Deposit, &payload(&a, Operation::Deposit));
        let name = match case {
            0 => {
                w.edit(w.mint, |a| a.owner = Pubkey::new_unique());
                "mint-owner"
            }
            1 => {
                w.edit(w.mint, |a| a.data[44] = 9);
                "mint-decimals"
            }
            2 => {
                accounts[3 + 6] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
                "fixed-mint"
            }
            3 => {
                accounts[3 + 15] = AccountMeta::new_readonly(
                    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
                    false,
                );
                "token-2022"
            }
            4 => {
                accounts[3 + 16] =
                    AccountMeta::new_readonly(solana_sdk::system_program::id(), false);
                "ata-program"
            }
            5 => {
                accounts[3 + 5] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
                "vault-authority"
            }
            6 => {
                accounts[3 + 1] = AccountMeta::new(Pubkey::new_unique(), false);
                "tree-pda"
            }
            7 => {
                accounts[3 + 2] = AccountMeta::new(Pubkey::new_unique(), false);
                "note-pda"
            }
            8 => {
                let key = Pubkey::new_unique();
                w.token(key, w.payer.pubkey(), DEPOSIT);
                accounts[3 + 7] = AccountMeta::new(key, false);
                "source-non-ata"
            }
            9 => {
                w.edit_token(w.source, |t| t.owner = Pubkey::new_unique());
                "source-authority"
            }
            10 => {
                w.edit_token(w.source, |t| t.mint = Pubkey::new_unique());
                "source-mint"
            }
            11 => {
                w.edit_token(w.source, |t| {
                    t.delegate = solana_sdk::program_option::COption::Some(Pubkey::new_unique())
                });
                "source-delegate"
            }
            12 => {
                w.edit_token(w.vault, |t| t.owner = Pubkey::new_unique());
                "vault-token-authority"
            }
            13 => {
                w.edit_token(w.vault, |t| {
                    t.delegate = solana_sdk::program_option::COption::Some(Pubkey::new_unique())
                });
                "vault-delegate"
            }
            14 => {
                w.edit_token(w.source, |t| {
                    t.close_authority =
                        solana_sdk::program_option::COption::Some(Pubkey::new_unique())
                });
                "source-close-authority"
            }
            15 => {
                w.edit_token(w.source, |t| t.amount = DEPOSIT - 1);
                "insufficient-source"
            }
            16 => {
                w.edit_token(w.source, |t| {
                    t.state = spl_token::state::AccountState::Frozen
                });
                "frozen-source"
            }
            17 => {
                w.edit(w.tree, |a| a.owner = Pubkey::new_unique());
                "tree-owner"
            }
            18 => {
                w.edit_state::<TreeState>(w.tree, |t| t.bump ^= 1);
                "tree-bump"
            }
            19 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.layout_version = 1);
                "layout-one"
            }
            20 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.circuit_profile_hash[0] ^= 1);
                "profile-hash"
            }
            21 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.tree_backend = 0);
                "tree-backend"
            }
            _ => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.tree_tag_policy = 0);
                "tree-tag-policy"
            }
        };
        w.run(
            &format!("account/reject-{name}"),
            accounts,
            args,
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    // Two-transfer atomicity: destination transfer and first ATA creation must
    // roll back when the subsequent treasury transfer fails with SPL Frozen.
    for finalize in [false, true] {
        let mut w = if finalize {
            pending(&elf, &a)
        } else {
            active(&elf, &a)
        };
        w.token(w.treasury, w.treasury_owner, 0);
        w.edit_token(w.treasury, |t| {
            t.state = spl_token::state::AccountState::Frozen
        });
        assert!(w.svm.get_account(&w.destination).is_none());
        if finalize {
            w.clock((NOW + CHALLENGE) as i64);
            w.finalize(
                "rollback/finalize-second-transfer-frozen",
                0,
                Expect::Error(17),
            )
            .unwrap_err();
        } else {
            w.execute(
                "rollback/close-second-transfer-frozen",
                &a,
                Operation::Close,
                Expect::Error(17),
            )
            .unwrap_err();
        }
        let logs = w.rows.last().unwrap()["logs"].as_array().unwrap();
        assert_eq!(
            logs.iter()
                .filter(|l| l.as_str().unwrap().contains("Instruction: TransferChecked"))
                .count(),
            2,
            "both transfers attempted"
        );
        let transfer_indices: Vec<_> = logs
            .iter()
            .enumerate()
            .filter_map(|(i, l)| {
                l.as_str()
                    .unwrap()
                    .contains("Instruction: TransferChecked")
                    .then_some(i)
            })
            .collect();
        assert!(
            logs[transfer_indices[0] + 1..transfer_indices[1]]
                .iter()
                .any(|l| l.as_str().unwrap() == format!("Program {} success", spl_token::id())),
            "first TransferChecked succeeded before second TransferChecked began"
        );
        assert!(w.svm.get_account(&w.destination).is_none());
        assert_eq!(w.amount(w.vault), DEPOSIT);
        collect(w, &mut rows);
    }
    // Guard payout destinations and permanent nullifier account identities.
    for case in 0..7 {
        let mut w = active(&elf, &a);
        let (mut accounts, args, _) =
            w.execution(&a, Operation::Close, &payload(&a, Operation::Close));
        let name = match case {
            0 => {
                accounts[3 + 9] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
                "destination-binding"
            }
            1 => {
                accounts[3 + 10] = AccountMeta::new(Pubkey::new_unique(), false);
                "destination-ata"
            }
            2 => {
                accounts[3 + 11] = AccountMeta::new_readonly(Pubkey::new_unique(), false);
                "treasury-owner"
            }
            3 => {
                accounts[3 + 12] = AccountMeta::new(Pubkey::new_unique(), false);
                "treasury-ata"
            }
            4 => {
                accounts[3 + 4] = AccountMeta::new(Pubkey::new_unique(), false);
                "exit-pda"
            }
            5 => {
                w.token(w.destination, w.destination_owner, 0);
                w.edit_token(w.destination, |t| {
                    t.delegate = solana_sdk::program_option::COption::Some(Pubkey::new_unique())
                });
                "destination-delegate"
            }
            _ => {
                w.edit_token(w.vault, |t| t.amount = DEPOSIT - 1);
                "vault-insolvency"
            }
        };
        w.run(
            &format!("payout/reject-{name}"),
            accounts,
            args,
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    // Integer and clock edges. The max note ID uses a real matching proof;
    // only the monotonic allocation counter is seeded to its boundary.
    {
        let mut w = fresh(&elf, &a);
        w.edit_state::<TreeState>(w.tree, |t| t.next_note_id = u32::MAX as u64);
        w.execute(
            "boundary/maximum-note-id",
            &max,
            Operation::Deposit,
            Expect::Ok,
        )
        .unwrap();
        assert_eq!(w.state::<TreeState>(w.tree).next_note_id, 1u64 << 32);
        w.execute(
            "boundary/tree-full-sentinel",
            &max,
            Operation::Deposit,
            Expect::Error(6009),
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    for delta in [-1i64, 0, 1] {
        let mut w = fresh(&elf, &a);
        let boundary = a["expiry"].as_u64().unwrap() - a["ttl"].as_u64().unwrap();
        w.clock(boundary as i64 + delta);
        let result = w.execute(
            &format!("boundary/expiry-day-{delta}"),
            &a,
            Operation::Deposit,
            if delta <= 0 {
                Expect::Ok
            } else {
                Expect::Error(6008)
            },
        );
        if delta <= 0 {
            result.unwrap();
        } else {
            result.unwrap_err();
        }
        collect(w, &mut rows);
    }
    for case in 0..12 {
        let mut w = fresh(&elf, &a);
        let mut body = payload(&a, Operation::Deposit);
        let name = match case {
            0 => {
                body[0..4].copy_from_slice(&1u32.to_le_bytes());
                "stale-id"
            }
            1 => {
                body[4] ^= 1;
                "stale-root"
            }
            2 => {
                body[36..44]
                    .copy_from_slice(&(a["expiry"].as_u64().unwrap() - 86400).to_le_bytes());
                "wrong-expiry"
            }
            3 => {
                body[44..76].fill(0);
                "zero-commitment"
            }
            4 => {
                body[44..76].copy_from_slice(&FR_MODULUS);
                "noncanonical-commitment"
            }
            5 => {
                body[76..84].fill(0);
                "zero-amount"
            }
            6 => {
                body[76..84].copy_from_slice(&(MAX_AMOUNT + 1).to_le_bytes());
                "over-max-amount"
            }
            7 => {
                w.clock(-1);
                "negative-clock"
            }
            8 => {
                w.edit_state::<PoolConfig>(w.pool, |p| p.ttl = u64::MAX);
                "ttl-overflow"
            }
            9 => {
                w.edit_state::<TreeState>(w.tree, |t| t.sequence = u64::MAX);
                "sequence-overflow"
            }
            10 => {
                w.edit_state::<TreeState>(w.tree, |t| t.outstanding_deposits = u64::MAX);
                w.edit_token(w.vault, |t| t.amount = u64::MAX);
                "liability-overflow"
            }
            _ => {
                w.edit_token(w.vault, |t| t.amount = u64::MAX);
                "token-balance-overflow"
            }
        };
        w.execute_body(
            &format!("boundary/reject-{name}"),
            &a,
            Operation::Deposit,
            &body,
            Expect::Error(
                [
                    6007, 6006, 6008, 6004, 6004, 6010, 6010, 6018, 6018, 6018, 6018, 14,
                ][case],
            ),
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    {
        let mut w = active(&elf, &a);
        w.edit_state::<PoolConfig>(w.pool, |p| p.challenge = u64::MAX);
        w.execute(
            "boundary/challenge-overflow",
            &a,
            Operation::Escape,
            Expect::Error(6018),
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    // Every tree public field and representative proof coordinates are tested
    // at the real Vault account boundary; mixed valid proofs are separate cases.
    for index in 0..11 {
        let mut w = fresh(&elf, &a);
        let mut body = payload(&a, Operation::Deposit);
        body[84 + index * 32 + 31] ^= 1;
        w.execute_body(
            &format!("proof/tree-public-{index}"),
            &a,
            Operation::Deposit,
            &body,
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    for index in 0..14 {
        let mut w = active(&elf, &a);
        let mut body = payload(&a, Operation::Close);
        body[index * 32 + 31] ^= 1;
        w.execute_body(
            &format!("proof/withdrawal-public-{index}"),
            &a,
            Operation::Close,
            &body,
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    for (tree, index) in [
        (true, 0),
        (true, 63),
        (true, 128),
        (true, 255),
        (false, 0),
        (false, 63),
        (false, 128),
        (false, 255),
    ] {
        let mut w = active(&elf, &a);
        let mut body = payload(&a, Operation::Close);
        let offset = if tree { 704 + 352 } else { 448 };
        body[offset + index] ^= 1;
        w.execute_body(
            &format!(
                "proof/{}-coordinate-{index}",
                if tree { "tree" } else { "withdrawal" }
            ),
            &a,
            Operation::Close,
            &body,
            Expect::Error(6005),
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    for (op, part, fixture) in [
        (Operation::Close, "auth-other-pool", &other),
        (Operation::Close, "auth-other-note", &ba),
        (Operation::Close, "tree-other-pool", &other),
        (Operation::Deposit, "tree-other-pool", &other),
    ] {
        let mut w = if op == Operation::Deposit {
            fresh(&elf, &a)
        } else {
            active(&elf, &a)
        };
        let mut body = payload(&a, op);
        if part.starts_with("auth") {
            body[..704].copy_from_slice(&proof(&fixture["auth"]["withdrawal"]));
        } else {
            let offset = body.len() - 608;
            body[offset..].copy_from_slice(&proof(&fixture["trees"][op.tree_op() as usize]));
        }
        w.execute_body(
            &format!("binding/valid-{part}-{op:?}"),
            &a,
            op,
            &body,
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }
    // Same-root, independently valid proofs must still address the same Note,
    // and a historical request must consume the Pending nullifier exactly.
    {
        let mut w = active(&elf, &a);
        w.execute("binding/setup-b", &ba, Operation::Deposit, Expect::Ok)
            .unwrap();
        let mut body = payload(&ab, Operation::Close);
        body[..704].copy_from_slice(&proof(&ba["auth"]["withdrawal"]));
        assert_eq!(
            ab["auth"]["withdrawal"]["public_inputs"][3],
            ba["auth"]["withdrawal"]["public_inputs"][3]
        );
        w.execute_body(
            "binding/same-root-valid-wp-other-note",
            &ab,
            Operation::Close,
            &body,
            Expect::Error(6001),
        )
        .unwrap_err();
        w.execute("binding/setup-escape-a", &ab, Operation::Escape, Expect::Ok)
            .unwrap();
        for fixture in [&ba, &other] {
            let mut body = payload(&ab, Operation::Challenge);
            body[4..644].copy_from_slice(&proof(&fixture["auth"]["request"]));
            w.execute_body(
                &format!(
                    "binding/valid-request-{}",
                    fixture["name"].as_str().unwrap()
                ),
                &ab,
                Operation::Challenge,
                &body,
                Expect::Reject,
            )
            .unwrap_err();
        }
        for index in 0..12 {
            let mut body = payload(&ab, Operation::Challenge);
            body[4 + index * 32 + 31] ^= 1;
            w.execute_body(
                &format!("proof/request-public-{index}"),
                &ab,
                Operation::Challenge,
                &body,
                Expect::Reject,
            )
            .unwrap_err();
        }
        collect(w, &mut rows);
    }

    // I03 verifies the sealed-buffer consumer contract only. No claims about
    // create/append/seal lifecycle, wallets or RPC transport are made here.
    for case in 0..14 {
        let mut w = fresh(&elf, &a);
        let (mut accounts, mut args, buffer) =
            w.execution(&a, Operation::Deposit, &payload(&a, Operation::Deposit));
        let name = match case {
            0 => {
                args[8] ^= 1;
                "expected-digest"
            }
            1 => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.sealed = false);
                "unsealed"
            }
            2 => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.expires = NOW - 1);
                "expired"
            }
            3 => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.next_offset -= 1);
                "incomplete"
            }
            4 => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.payload[0] ^= 1);
                "payload-digest"
            }
            5 => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.layout_version = 1);
                "layout-one"
            }
            6 => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.op = 5);
                "unknown-operation"
            }
            7 => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.nonce[0] ^= 1);
                "pda-seed"
            }
            8 => {
                accounts[1] = AccountMeta::new_readonly(w.attacker.pubkey(), true);
                "third-party-execute"
            }
            9 => {
                accounts[2] = AccountMeta::new(w.attacker.pubkey(), false);
                "rent-recipient"
            }
            10 => {
                w.edit(buffer, |a| a.owner = solana_sdk::system_program::id());
                "owner"
            }
            11 => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.payload_len -= 1);
                "declared-length"
            }
            12 => {
                args.push(0);
                "execute-trailing-argument"
            }
            _ => {
                w.edit_state::<PayloadBuffer>(buffer, |b| b.expires = NOW);
                "expiry-equality"
            }
        };
        w.run(
            &format!("buffer/reject-{name}"),
            accounts,
            args,
            Expect::Reject,
        )
        .unwrap_err();
        collect(w, &mut rows);
    }

    let successes = rows.iter().filter(|r| r["ok"] == true).count();
    let failures = rows.len() - successes;
    let max_cu = rows
        .iter()
        .map(|r| r["cu"].as_u64().unwrap())
        .max()
        .unwrap();
    let max_bytes = rows
        .iter()
        .map(|r| r["transaction_bytes"].as_u64().unwrap())
        .max()
        .unwrap();
    let report = json!({"scope":"I03 real Vault SBF execution with real proofs and real PDA/ATA/token CPIs; sealed buffer fixture is the explicit I04 boundary",
        "elf_sha256":hex::encode(Sha256::digest(&elf)),"wrong_vk_elf_sha256":hex::encode(Sha256::digest(&wrong_elf)),"program_id":zkapi_vault::ID.to_string(),"transaction_format":"v0 without ALT",
        "cases":rows.len(),"successful_transactions":successes,"rejected_transactions":failures,"max_cu":max_cu,"max_transaction_bytes":max_bytes,
        "production_eligible":false,"i04_buffer_lifecycle_verified":false,"rows":rows});
    fs::write(
        root.join("docs/evidence/I03-svm-rejections.json"),
        serde_json::to_vec_pretty(&semantic_rejects(report["rows"].as_array().unwrap())).unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("docs/evidence/I03-svm-traces.json"),
        serde_json::to_vec_pretty(&traces).unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("docs/evidence/I03-svm-results.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("I03 PASS: {} real SBF transactions, {} rejected, max {} CU, {} bytes; I04 lifecycle remains pending",successes+failures,failures,max_cu,max_bytes);
}
