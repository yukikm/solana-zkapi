//! Research-only proof-bound-tag variant. Same fixtures/VK/circuit as baseline.
//! Measures actual SBF, validates state bindings and rollback at 1,000,000 CU.
#[path = "../runner.rs"]
mod runner;
use runner::Runner;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{
    account::Account,
    instruction::{AccountMeta, InstructionError},
    program_pack::Pack,
    pubkey::Pubkey,
    transaction::TransactionError,
};
use std::{fs, path::Path};

fn payload_account(r: &mut Runner, state: &[u8], payload: &[u8]) -> Vec<AccountMeta> {
    let mut accounts = r.accounts(state.to_vec());
    let key = Pubkey::new_unique();
    r.svm
        .set_account(
            key,
            Account {
                lamports: 10_000_000,
                data: payload.to_vec(),
                owner: r.id,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    accounts.push(AccountMeta::new_readonly(key, false));
    accounts
}
fn instruction(root: &Path, op: u8) -> Vec<u8> {
    let mut data = vec![6 + op];
    if op != 0 {
        let name = if op == 1 {
            "withdrawal-signed"
        } else {
            "request-genesis"
        };
        let f: Value = serde_json::from_slice(
            &fs::read(root.join(format!("tests/fixtures/crypto/{name}.json"))).unwrap(),
        )
        .unwrap();
        data.extend(hex::decode(f["proof_wire_hex"].as_str().unwrap()).unwrap());
        for p in f["public_inputs"].as_array().unwrap() {
            data.extend(hex::decode(p.as_str().unwrap().trim_start_matches("0x")).unwrap());
        }
    }
    data
}
fn unchanged(r: &Runner, accounts: &[AccountMeta], state: &[u8]) {
    assert_eq!(r.svm.get_account(&accounts[0].pubkey).unwrap().data, state);
    assert_eq!(r.token_amount(&accounts[1].pubkey), 5_000_000);
    assert_eq!(r.token_amount(&accounts[3].pubkey), 0);
    assert_eq!(r.token_amount(&accounts[4].pubkey), 0);
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let elf_path = std::env::args().nth(1).expect("research ELF path");
    let wrong_path = std::env::args().nth(2).expect("research wrong-VK ELF path");
    let elf = fs::read(&elf_path).unwrap();
    let wrong_elf = fs::read(&wrong_path).unwrap();
    let mut r = Runner::new(&elf, 1_000_000);
    let mut wrong = Runner::new(&wrong_elf, 1_000_000);
    for id in [0, u32::MAX] {
        for op in 0..3u8 {
            let name = format!("proof-bound-tag-{id}-{op}");
            let f: Value = serde_json::from_slice(
                &fs::read(root.join(format!("tests/fixtures/tree/tree-{id}-{op}.json"))).unwrap(),
            )
            .unwrap();
            let fields: Vec<Vec<u8>> = f["public_inputs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| hex::decode(p.as_str().unwrap().trim_start_matches("0x")).unwrap())
                .collect();
            let mut payload = hex::decode(f["proof_wire_hex"].as_str().unwrap()).unwrap();
            for p in &fields {
                payload.extend(p);
            }
            let mut state = fields[1].clone();
            state.extend(id.to_le_bytes());
            state.extend(&fields[6]);
            state.extend(5_000_000u64.to_le_bytes());
            state.extend(4_000_000_000u64.to_le_bytes());
            state.extend(&fields[0]);
            let data = instruction(&root, op);
            let accounts = payload_account(&mut r, &state, &payload);
            let meta = r
                .run(&name, data.clone(), accounts.clone(), Some(true))
                .unwrap();
            assert_eq!(meta.return_data.data, fields[2]);
            assert_eq!(
                &r.svm.get_account(&accounts[0].pubkey).unwrap().data[..32],
                fields[2]
            );
            r.check_transfers(&accounts, 6 + op);
            // A valid proof cannot be replayed after its root has changed.
            let committed = r.svm.get_account(&accounts[0].pubkey).unwrap().data;
            let e = r
                .run(
                    &format!("{name}/stale-root"),
                    data.clone(),
                    accounts.clone(),
                    Some(false),
                )
                .unwrap_err();
            assert_eq!(
                e.err,
                TransactionError::InstructionError(1, InstructionError::Custom(2))
            );
            assert_eq!(
                r.svm.get_account(&accounts[0].pubkey).unwrap().data,
                committed
            );
            r.check_transfers(&accounts, 6 + op);
            // Includes tag, both roots, both leaves, and every other public input.
            for i in 0..11 {
                let mut bad = payload.clone();
                bad[256 + i * 32 + 31] ^= 1;
                let accounts = payload_account(&mut r, &state, &bad);
                let e = r
                    .run(
                        &format!("{name}/public-{i}"),
                        data.clone(),
                        accounts.clone(),
                        Some(false),
                    )
                    .unwrap_err();
                assert_eq!(
                    e.err,
                    TransactionError::InstructionError(1, InstructionError::Custom(1))
                );
                unchanged(&r, &accounts, &state);
            }
            // Valid proof + mismatched state must fail after successful verification.
            for (label, offset) in [
                ("root", 31),
                ("id", 32),
                ("commitment", 67),
                ("deposit", 68),
                ("expiry", 76),
                ("vault", 115),
            ] {
                let mut bad = state.clone();
                bad[offset] ^= 1;
                let accounts = payload_account(&mut r, &bad, &payload);
                let e = r
                    .run(
                        &format!("{name}/state-{label}"),
                        data.clone(),
                        accounts.clone(),
                        Some(false),
                    )
                    .unwrap_err();
                assert_eq!(
                    e.err,
                    TransactionError::InstructionError(1, InstructionError::Custom(2))
                );
                unchanged(&r, &accounts, &bad);
            }
            let accounts = payload_account(&mut r, &state, &payload);
            let e = r
                .run(
                    &format!("{name}/operation"),
                    instruction(&root, (op + 1) % 3),
                    accounts.clone(),
                    Some(false),
                )
                .unwrap_err();
            assert_eq!(
                e.err,
                TransactionError::InstructionError(1, InstructionError::Custom(2))
            );
            unchanged(&r, &accounts, &state);
            if op != 0 {
                let mut bad = data.clone();
                bad[257 + 31] ^= 1;
                let accounts = payload_account(&mut r, &state, &payload);
                r.run(
                    &format!("{name}/authorization-input"),
                    bad,
                    accounts.clone(),
                    Some(false),
                )
                .unwrap_err();
                unchanged(&r, &accounts, &state);
            }
            // Isolate the tree key negative control from request/withdrawal VKs.
            let mut proof = vec![9];
            proof.extend(&payload);
            wrong
                .run(&format!("{name}/wrong-tree-VK"), proof, vec![], Some(false))
                .unwrap_err();
            if id == 0 && op == 1 {
                let accounts = payload_account(&mut r, &state, &payload);
                let mut a = r.svm.get_account(&accounts[4].pubkey).unwrap();
                let mut token = spl_token::state::Account::unpack(&a.data).unwrap();
                token.state = spl_token::state::AccountState::Frozen;
                spl_token::state::Account::pack(token, &mut a.data).unwrap();
                r.svm.set_account(accounts[4].pubkey, a).unwrap();
                let e = r
                    .run(
                        "fallback/second-CPI-failure-rollback",
                        data,
                        accounts.clone(),
                        Some(false),
                    )
                    .unwrap_err();
                assert_eq!(
                    e.err,
                    TransactionError::InstructionError(1, InstructionError::Custom(17))
                );
                assert_eq!(
                    e.meta
                        .inner_instructions
                        .iter()
                        .map(|v| v.len())
                        .sum::<usize>(),
                    2
                );
                unchanged(&r, &accounts, &state);
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&json!({
        "scope":"research only; proof-bound tag; unchanged circuit/fixtures; SBF with real token CPIs; not a production Vault",
        "budget":1_000_000,"elf_path":elf_path,"elf_sha256":hex::encode(Sha256::digest(&elf)),
        "wrong_vk_elf_sha256":hex::encode(Sha256::digest(&wrong_elf)),"cases":r.rows,"wrong_vk_cases":wrong.rows
    })).unwrap());
}
