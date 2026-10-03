//! Compare ELF code generation with identical upstream sponge inputs/outputs.
use ark_bn254::Fr;
use litesvm::LiteSVM;
use serde_json::json;
use sha2::{Digest, Sha256};
use solana_compute_budget::compute_budget::ComputeBudget;
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
fn main() {
    let path = std::env::args().nth(1).expect("ELF path");
    let syscall = std::env::args().nth(2).as_deref() == Some("syscall");
    let elf = std::fs::read(&path).unwrap();
    let mut svm = LiteSVM::new()
        .with_transaction_history(0)
        .with_compute_budget(ComputeBudget {
            compute_unit_limit: if syscall { 1_000_000 } else { 100_000_000 },
            ..ComputeBudget::default()
        });
    let id = Pubkey::new_from_array([42; 32]);
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    svm.add_program(id, &elf);
    let mut rows = vec![];
    for n in [0u8, 1, 2, 3, 5, 11] {
        if syscall && n == 0 {
            continue;
        }
        let inputs: Vec<_> = (1..=n).map(|i| Fr::from(i as u64)).collect();
        let mut data = vec![if syscall { 10 } else { 2 }, n];
        for f in &inputs {
            data.extend(zkapi_poseidon::bytes(*f));
        }
        let tx = Transaction::new_signed_with_payer(
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),
                Instruction {
                    program_id: id,
                    accounts: vec![],
                    data,
                },
            ],
            Some(&payer.pubkey()),
            &[&payer],
            svm.latest_blockhash(),
        );
        let meta = svm.send_transaction(tx).unwrap();
        let expected = zkapi_poseidon::bytes(zkapi_poseidon::hash_fields(&inputs));
        if syscall {
            assert_ne!(
                meta.return_data.data, expected,
                "syscall is NOT the same sponge"
            );
        } else {
            assert_eq!(meta.return_data.data, expected);
        }
        rows.push(
            json!({"inputs":n,"cu":meta.compute_units_consumed,"hash":hex::encode(&meta.return_data.data),"upstream_hash":hex::encode(expected),"matches_upstream":meta.return_data.data == expected}),
        );
    }
    println!("{}",serde_json::to_string_pretty(&json!({"elf":path,"sha256":hex::encode(Sha256::digest(&elf)),"scope":if syscall {"standard Poseidon syscall; 1,000,000 CU; incompatible output; all-enabled runtime features"} else {"diagnostic-only compute override; all-enabled runtime features"},"cases":rows})).unwrap());
}
