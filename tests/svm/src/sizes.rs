//! Actual legacy/v0 serialization with explicit account/signature assumptions.
//! This does not implement I04 buffer lifecycle or claim v1 wallet/RPC support.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{
    compute_budget::ComputeBudgetInstruction,
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    message::{v0, Message, VersionedMessage},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::VersionedTransaction,
};
use std::{fs, path::Path};
fn discriminator(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}
fn record(root: &Path, name: &str, data: Vec<u8>, keys: usize, two_signers: bool) -> Value {
    let payer = Keypair::new();
    let owner = Keypair::new();
    let program = Pubkey::new_unique();
    let mut accounts = vec![AccountMeta::new(payer.pubkey(), true)];
    if two_signers {
        accounts.push(AccountMeta::new(owner.pubkey(), true));
    }
    while accounts.len() < keys {
        accounts.push(AccountMeta::new(Pubkey::new_unique(), false));
    }
    let ix = Instruction {
        program_id: program,
        accounts,
        data,
    };
    let instructions = [
        ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),
        ix.clone(),
    ];
    let signers = if two_signers {
        vec![&payer, &owner]
    } else {
        vec![&payer]
    };
    let mut rows = vec![];
    for (format, message) in [
        (
            "legacy",
            VersionedMessage::Legacy(Message::new(&instructions, Some(&payer.pubkey()))),
        ),
        (
            "v0-no-ALT",
            VersionedMessage::V0(
                v0::Message::try_compile(&payer.pubkey(), &instructions, &[], Hash::default())
                    .unwrap(),
            ),
        ),
    ] {
        let tx = VersionedTransaction::try_new(message, &signers).unwrap();
        let bytes = bincode::serialize(&tx).unwrap();
        assert_eq!(
            bincode::deserialize::<VersionedTransaction>(&bytes).unwrap(),
            tx
        );
        let dir = root.join("target/i02-transactions");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{name}-{format}.bin")), &bytes).unwrap();
        rows.push(json!({"format":format,"bytes":bytes.len(),"fits_1232":bytes.len()<=1232}));
    }
    json!({"case":name,"instruction_data_bytes":ix.data.len(),"instruction_accounts":keys,"signatures":signers.len(),"serialized":rows})
}
pub fn measure(root: &Path) -> Value {
    let mut rows = vec![];
    // Accounts include payer and all explicit CPI/program/config/note accounts;
    // no ALT compression. I03/I04 must update this inventory for the final IDL.
    for (name, prefix, keys, two_signers) in [
        ("deposit", 4 + 32 + 8 + 32 + 8, 10, true),
        ("mutual_close", 448 + 256, 12, false),
        ("initiate_escape", 448 + 256, 9, false),
        ("challenge_escape", 4 + 384 + 256, 8, false),
        ("claim_expired", 4, 9, false),
    ] {
        for (layout, tree_bytes) in [(1, 1024), (2, 352 + 256)] {
            let mut data = discriminator(name).to_vec();
            data.resize(8 + prefix + tree_bytes, 0);
            rows.push(record(
                root,
                &format!("layout{layout}/{name}").replace('/', "-"),
                data,
                keys,
                two_signers,
            ));
        }
        let mut data = discriminator("execute_payload").to_vec();
        data.extend([7; 32]);
        let row = record(
            root,
            &format!("buffer-execute-{name}"),
            data,
            keys + 1,
            two_signers,
        );
        assert!(row["serialized"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["fits_1232"] == true));
        rows.push(row);
    }
    let mut data = discriminator("create_payload").to_vec();
    data.push(1);
    data.extend(4096u32.to_le_bytes());
    data.extend([1; 32]);
    data.extend([2; 32]);
    data.extend(3600u64.to_le_bytes());
    rows.push(record(root, "buffer-create", data, 4, false));
    let mut data = discriminator("append_payload").to_vec();
    data.extend(0u32.to_le_bytes());
    data.extend(900u32.to_le_bytes());
    data.extend([0; 900]);
    let row = record(root, "buffer-append-900", data, 3, false);
    assert!(row["serialized"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["fits_1232"] == true));
    rows.push(row);
    for name in ["seal_payload", "close_payload"] {
        rows.push(record(root, name, discriminator(name).to_vec(), 4, false));
    }
    json!({"scope":"real serialized single-instruction transactions; explicit proposed account inventory, synthetic argument values; no ALT, includes SetComputeUnitLimit(1_000_000); lifecycle not executed", "v1":"not measured: selected runtime/SDK does not support v1; require I04 RPC/wallet validation", "cases":rows})
}
