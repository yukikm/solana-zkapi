//! Interactive LOCAL test adapter for the SDK wallet and the actual Vault ELF.
//! Finality/RPC faults are simulated; every supplied signed v0 is actually run.
#![allow(dead_code, deprecated, clippy::result_large_err)]
#[path = "../vault_support.rs"]
mod support;
use ark_bn254::Fr;
use ark_ff::AdditiveGroup;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use solana_sdk::{
    clock::Clock, message::VersionedMessage, pubkey::Pubkey, transaction::VersionedTransaction,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, Write},
    path::Path,
    str::FromStr,
};
use support::*;
use zkapi_vault::{Note, PendingWithdrawal, TreeState};
fn felt(f: Fr) -> String {
    format!("0x{}", hex::encode(zkapi_poseidon::bytes(f)))
}
fn root_view(w: &World, slot: u64) -> Value {
    let tree = w.state::<TreeState>(w.tree);
    json!({"pool":w.pool.to_string(),"root":format!("0x{}",hex::encode(tree.root)),"slot":slot.to_string(),"blockhash":bs58::encode([1;32]).into_string(),"sequence":tree.sequence.to_string(),"next_note_id":tree.next_note_id.to_string()})
}
fn snapshot(w: &World, id: u32, slot: u64) -> Value {
    let t = w.state::<TreeState>(w.tree);
    let mut levels = BTreeMap::new();
    for i in 0..t.next_note_id as u32 {
        let n = w.state::<Note>(w.note(i));
        if n.status == 1 {
            levels.insert(
                i,
                zkapi_poseidon::leaf(
                    i,
                    zkapi_poseidon::parse(&n.commitment).unwrap(),
                    n.deposit,
                    n.expiry,
                ),
            );
        }
    }
    let mut zero = Fr::ZERO;
    let mut index = id;
    let mut siblings = vec![];
    for _ in 0..32 {
        siblings.push(felt(*levels.get(&(index ^ 1)).unwrap_or(&zero)));
        let parents = levels.keys().map(|k| k / 2).collect::<BTreeSet<_>>();
        let mut next = BTreeMap::new();
        for p in parents {
            next.insert(
                p,
                zkapi_poseidon::node(
                    *levels.get(&(p * 2)).unwrap_or(&zero),
                    *levels.get(&(p * 2 + 1)).unwrap_or(&zero),
                ),
            );
        }
        levels = next;
        zero = zkapi_poseidon::node(zero, zero);
        index >>= 1;
    }
    assert_eq!(
        zkapi_poseidon::bytes(*levels.get(&0).unwrap_or(&zero)),
        t.root
    );
    let mut result = json!({"root":format!("0x{}",hex::encode(t.root)),"siblings":siblings,"slot":slot,"sequence":t.sequence.to_string(),"nextNoteId":t.next_note_id,"clock":w.svm.get_sysvar::<Clock>().unix_timestamp.to_string(),"paused":false,"treasuryOwner":w.treasury_owner.to_string()});
    if w.svm
        .get_account(&w.note(id))
        .is_some_and(|a| !a.data.is_empty())
    {
        let n = w.state::<Note>(w.note(id));
        result["note"] = json!({"note_id":id,"registration_commitment":format!("0x{}",hex::encode(n.commitment)),"deposit_micro_usdc":n.deposit.to_string(),"expiry":n.expiry.to_string(),"status":match n.status {1=>"active",2=>"pending_escape",3=>"closed",_=>panic!()}});
    }
    if w.svm
        .get_account(&w.pending(id))
        .is_some_and(|a| !a.data.is_empty())
    {
        let p = w.state::<PendingWithdrawal>(w.pending(id));
        if p.exists {
            result["pending"] = json!({"nullifier":format!("0x{}",hex::encode(p.nullifier)),"balance_micro_usdc":p.balance.to_string(),"destinationOwner":p.destination_owner.to_string(),"deadline":p.deadline.to_string()});
        }
    }
    result
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let elf = fs::read(root.join("target/i04-sbf/zkapi_vault.so")).unwrap();
    let mut w = World::new(&elf);
    w.initialize(&read(root.join("tests/fixtures/vault/genesis-a.json")));
    let mut slot = 100u64;
    let mut receipts = BTreeMap::<String, Value>::new();
    let mut rows = vec![];
    for line in std::io::stdin().lock().lines() {
        let command: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = match command["kind"].as_str().unwrap() {
            "root" => root_view(&w, slot),
            "path" => {
                let id = command["note_id"].as_u64().unwrap() as u32;
                let view = snapshot(&w, id, slot);
                let leaf = if view["note"]["status"] == "active" {
                    let n = w.state::<Note>(w.note(id));
                    zkapi_poseidon::leaf(
                        id,
                        zkapi_poseidon::parse(&n.commitment).unwrap(),
                        n.deposit,
                        n.expiry,
                    )
                } else {
                    Fr::ZERO
                };
                json!({"snapshot":root_view(&w,slot),"note_id":id.to_string(),"leaf":felt(leaf),"siblings":view["siblings"]})
            }
            "accounts" => {
                let values=command["addresses"].as_array().unwrap().iter().map(|key|{let key=Pubkey::from_str(key.as_str().unwrap()).unwrap();w.svm.get_account(&key).filter(|a|a.lamports>0).map(|a|json!({"owner":a.owner.to_string(),"executable":a.executable,"lamports":a.lamports,"rentEpoch":0,"data":[STANDARD.encode(a.data),"base64"]})).unwrap_or(Value::Null)}).collect::<Vec<_>>();
                json!({"context":{"slot":slot},"value":values})
            }
            "snapshot" => snapshot(
                &w,
                command["note_id"]
                    .as_u64()
                    .unwrap_or(w.state::<TreeState>(w.tree).next_note_id) as u32,
                slot,
            ),
            "clock" => {
                w.clock(command["time"].as_i64().unwrap());
                json!({"ok":true})
            }
            "blockhash" => {
                json!({"blockhash":w.svm.latest_blockhash().to_string(),"lastValidBlockHeight":1000000})
            }
            "receipt" => receipts
                .get(command["signature"].as_str().unwrap())
                .cloned()
                .unwrap_or(Value::Null),
            "buffer" => {
                let address = Pubkey::from_str(command["address"].as_str().unwrap()).unwrap();
                w.svm.get_account(&address).filter(|a|!a.data.is_empty()).map(|a|json!({"address":address.to_string(),"owner":a.owner.to_string(),"data":STANDARD.encode(a.data),"slot":slot})).unwrap_or(Value::Null)
            }
            "send" => {
                let bytes = STANDARD
                    .decode(command["base64"].as_str().unwrap())
                    .unwrap();
                assert!(bytes.len() <= 1232);
                let tx: VersionedTransaction = bincode::deserialize(&bytes).unwrap();
                tx.verify_and_hash_message().unwrap();
                let signature = tx.signatures[0].to_string();
                if !receipts.contains_key(&signature) {
                    let message = STANDARD.encode(tx.message.serialize());
                    let outcome = w.svm.send_transaction(tx.clone());
                    slot += 1;
                    let (err, meta) = match outcome {
                        Ok(meta) => (Value::Null, meta),
                        Err(f) => (serde_json::to_value(f.err).unwrap(), f.meta),
                    };
                    assert!(meta.compute_units_consumed <= 1_000_000);
                    rows.push(json!({"signature":signature,"error":err,"cu":meta.compute_units_consumed,"transaction_bytes":bytes.len(),"logs":meta.logs}));
                    let VersionedMessage::V0(msg) = &tx.message else {
                        panic!("v0 required")
                    };
                    let instructions=msg.instructions.iter().map(|ix|json!({"programIdIndex":ix.program_id_index,"accounts":ix.accounts,"data":bs58::encode(&ix.data).into_string()})).collect::<Vec<_>>();
                    let rpc = json!({"slot":slot,"blockTime":w.svm.get_sysvar::<Clock>().unix_timestamp,"version":0,"transaction":{"signatures":tx.signatures.iter().map(ToString::to_string).collect::<Vec<_>>(),"message":{"header":{"numRequiredSignatures":msg.header.num_required_signatures,"numReadonlySignedAccounts":msg.header.num_readonly_signed_accounts,"numReadonlyUnsignedAccounts":msg.header.num_readonly_unsigned_accounts},"accountKeys":msg.account_keys.iter().map(ToString::to_string).collect::<Vec<_>>(),"recentBlockhash":msg.recent_blockhash.to_string(),"instructions":instructions,"addressTableLookups":[]}},"meta":{"err":err,"fee":5000,"preBalances":[],"postBalances":[],"logMessages":meta.logs,"innerInstructions":[],"loadedAddresses":{"writable":[],"readonly":[]},"computeUnitsConsumed":meta.compute_units_consumed}});
                    receipts.insert(signature.clone(),json!({"signature":signature,"message":message,"err":err,"slot":slot,"rpc":rpc}));
                }
                json!({"signature":signature})
            }
            "report" => {
                let report = json!({"scope":"actual Vault SBF with SDK wallet signed v0 transactions; simulated finality RPC","rows":rows,"max_cu":rows.iter().map(|r|r["cu"].as_u64().unwrap()).max(),"max_transaction_bytes":rows.iter().map(|r|r["transaction_bytes"].as_u64().unwrap()).max(),"vault_micro_usdc":w.amount(w.vault),"destination_micro_usdc":w.svm.get_account(&w.destination).filter(|a|!a.data.is_empty()).map(|_|w.amount(w.destination)).unwrap_or(0),"source_micro_usdc":w.amount(w.source)});
                let name = command["name"].as_str().unwrap_or("wallet");
                assert!(["wallet", "wasm-close", "wasm-escape", "clientd"].contains(&name));
                fs::write(
                    root.join(format!("target/i08-wallet/{name}-sbf-results.json")),
                    serde_json::to_vec_pretty(&report).unwrap(),
                )
                .unwrap();
                report
            }
            _ => panic!("unknown harness command"),
        };
        serde_json::to_writer(std::io::stdout().lock(), &result).unwrap();
        println!();
        std::io::stdout().flush().unwrap();
    }
}
