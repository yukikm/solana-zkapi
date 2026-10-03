//! I05 control/signerd signatures consumed by the actual Anchor Vault ELF.
#![allow(dead_code, deprecated, clippy::result_large_err)]
#[path = "../vault_support.rs"]
mod support;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{instruction::AccountMeta, pubkey::Pubkey, signature::Signer};
use std::{fs, path::Path};
use support::*;
use zkapi_layout2::Operation;
use zkapi_vault::{Note, TreeState};

fn upload(w: &mut World, fixture: &Value, op: Operation, nonce: u8, name: &str) {
    let body = payload(fixture, op);
    let nonce = [nonce; 32];
    let uploader = w.attacker.pubkey();
    let buffer = Pubkey::find_program_address(
        &[b"payload", w.pool.as_ref(), uploader.as_ref(), &nonce],
        &w.id,
    )
    .0;
    let digest: [u8; 32] = Sha256::digest(&body).into();
    let mut args = vec![op as u8];
    args.extend((body.len() as u32).to_le_bytes());
    args.extend(digest);
    args.extend(nonce);
    args.extend((NOW + 3600).to_le_bytes());
    w.run(
        &format!("{name}/create"),
        vec![
            AccountMeta::new(buffer, false),
            AccountMeta::new_readonly(w.pool, false),
            AccountMeta::new_readonly(uploader, true),
            AccountMeta::new(uploader, true),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
        ],
        data("create_payload", &args),
        Expect::Ok,
    )
    .unwrap();
    let accounts = vec![
        AccountMeta::new(buffer, false),
        AccountMeta::new_readonly(w.pool, false),
        AccountMeta::new_readonly(uploader, true),
    ];
    for (i, part) in body.chunks(700).enumerate() {
        let mut args = ((i * 700) as u32).to_le_bytes().to_vec();
        args.extend((part.len() as u32).to_le_bytes());
        args.extend(part);
        w.run(
            &format!("{name}/append/{i}"),
            accounts.clone(),
            data("append_payload", &args),
            Expect::Ok,
        )
        .unwrap();
    }
    w.run(
        &format!("{name}/seal"),
        accounts,
        data("seal_payload", &[]),
        Expect::Ok,
    )
    .unwrap();
    let mut accounts = vec![
        AccountMeta::new(buffer, false),
        AccountMeta::new_readonly(uploader, true),
        AccountMeta::new(uploader, false),
    ];
    let n = (op == Operation::Close)
        .then(|| field(&fixture["auth"]["withdrawal"]["public_inputs"][11]));
    accounts.extend(w.financial(0, n, Some(op)));
    w.run(
        &format!("{name}/execute"),
        accounts,
        data("execute_payload", &digest),
        Expect::Ok,
    )
    .unwrap();
    assert!(w.svm.get_account(&buffer).is_none_or(|a| a.lamports == 0));
}
fn rpc_account(w: &World, key: Pubkey) -> Value {
    let a = w.svm.get_account(&key).unwrap();
    json!({"owner":a.owner.to_string(),"executable":a.executable,"lamports":a.lamports,"data":[STANDARD.encode(a.data),"base64"]})
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let target = root.join("target/i05");
    fs::create_dir_all(&target).unwrap();
    let elf_path = std::env::var("ZKAPI_VAULT_ELF").unwrap_or_else(|_| {
        root.join("target/i04-sbf/zkapi_vault.so")
            .display()
            .to_string()
    });
    let elf = fs::read(&elf_path).expect("build the real I04 Vault ELF first");
    let fixture = read(root.join("tests/fixtures/vault/genesis-a.json"));
    let mut w = World::new(&elf);
    w.initialize(&fixture);
    upload(&mut w, &fixture, Operation::Deposit, 71, "I05/deposit");
    let tree = w.state::<TreeState>(w.tree);
    let chain = json!({"scope":"actual Anchor Vault initialized and deposited through v0 buffer; local LiteSVM RPC fixture", "pool":w.pool.to_string(),"pool_account":rpc_account(&w,w.pool),"tree_account":rpc_account(&w,w.tree),"root":{"pool":w.pool.to_string(),"root":format!("0x{}",hex::encode(tree.root)),"slot":"100","blockhash":bs58::encode([1;32]).into_string(),"sequence":tree.sequence.to_string(),"next_note_id":tree.next_note_id.to_string()},"elf_sha256":hex::encode(Sha256::digest(&elf))});
    fs::write(
        target.join("chain.json"),
        serde_json::to_vec_pretty(&chain).unwrap(),
    )
    .unwrap();
    if std::env::args().any(|x| x == "--export") {
        upload(
            &mut w,
            &fixture,
            Operation::Close,
            72,
            "I05/exit-fixture-close",
        );
        let n = field(&fixture["auth"]["withdrawal"]["public_inputs"][11]);
        fs::write(target.join("exit-fixture.json"),serde_json::to_vec_pretty(&json!({"scope":"actual Anchor Vault tombstone created by close through v0 buffer", "address":w.exit(&n).to_string(),"nullifier":format!("0x{}",hex::encode(n)),"account":rpc_account(&w,w.exit(&n))})).unwrap()).unwrap();
        println!("exported real PoolConfig/TreeState after buffer deposit and real ExitNullifier after buffer close");
        return;
    }
    let next = read(target.join("settled-vault.json"));
    let balance = next["balance"].as_u64().unwrap();
    assert!(balance < DEPOSIT, "test must exercise nonzero settlement");
    upload(
        &mut w,
        &next,
        Operation::Close,
        72,
        "I05/new-signer-mutual-close",
    );
    assert_eq!(w.amount(w.destination), balance);
    assert_eq!(w.amount(w.treasury), DEPOSIT - balance);
    assert_eq!(w.amount(w.vault), 0);
    assert_eq!(w.state::<Note>(w.note(0)).status, 3);
    assert_eq!(w.state::<TreeState>(w.tree).outstanding_deposits, 0);
    let n = field(&next["auth"]["withdrawal"]["public_inputs"][11]);
    fs::write(target.join("exit.json"),serde_json::to_vec_pretty(&json!({"address":w.exit(&n).to_string(),"nullifier":format!("0x{}",hex::encode(n)),"account":rpc_account(&w,w.exit(&n))})).unwrap()).unwrap();
    let result = json!({"scope":"I05 real Postgres/control/separate signer result -> new WP + existing matching tree proof -> real SBF v0 buffer", "elf_sha256":hex::encode(Sha256::digest(&elf)),"settled_fixture_sha256":hex::encode(Sha256::digest(fs::read(target.join("settled-vault.json")).unwrap())),"balance_micro":balance,"treasury_micro":DEPOSIT-balance,"cases":w.rows});
    fs::write(
        target.join("svm-results.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
    println!("PASS I05 actual new-signer Vault withdrawal: {balance} micro to user, {} micro to treasury",DEPOSIT-balance);
}
