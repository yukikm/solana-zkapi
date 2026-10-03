//! Actual SDK-signed transactions executed by the real Vault ELF. No seeded buffers.
#![allow(dead_code, deprecated, clippy::result_large_err)]
#[path = "../vault_support.rs"]
mod support;
use anchor_lang::AnchorDeserialize;
use base64::{engine::general_purpose::STANDARD, Engine};
use litesvm::types::TransactionMetadata;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_sdk::{
    clock::Clock,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    message::{v0, VersionedMessage},
    signature::Signer,
    transaction::VersionedTransaction,
};
use std::{collections::BTreeMap, fs, path::Path, process::Command};
use support::*;
use zkapi_vault::{Note, PendingWithdrawal, TreeState, VaultTransitionV1};

fn signed(w: &World, instructions: &[Instruction]) -> VersionedTransaction {
    let msg = v0::Message::try_compile(
        &w.payer.pubkey(),
        instructions,
        &[],
        w.svm.latest_blockhash(),
    )
    .unwrap();
    let needs_uploader = msg.account_keys[..msg.header.num_required_signatures as usize]
        .contains(&w.attacker.pubkey());
    let mut signers = vec![&w.payer];
    if needs_uploader {
        signers.push(&w.attacker);
    }
    VersionedTransaction::try_new(VersionedMessage::V0(msg), &signers).unwrap()
}
fn decompile(tx: &VersionedTransaction) -> Vec<Instruction> {
    let VersionedMessage::V0(msg) = &tx.message else {
        panic!("SDK must use v0")
    };
    assert!(msg.address_table_lookups.is_empty(), "ALT-free baseline");
    msg.instructions
        .iter()
        .map(|ix| Instruction {
            program_id: msg.account_keys[ix.program_id_index as usize],
            accounts: ix
                .accounts
                .iter()
                .map(|index| {
                    let i = *index as usize;
                    let signer = i < msg.header.num_required_signatures as usize;
                    let writable = if signer {
                        i < (msg.header.num_required_signatures
                            - msg.header.num_readonly_signed_accounts)
                            as usize
                    } else {
                        i < msg.account_keys.len()
                            - msg.header.num_readonly_unsigned_accounts as usize
                    };
                    AccountMeta {
                        pubkey: msg.account_keys[i],
                        is_signer: signer,
                        is_writable: writable,
                    }
                })
                .collect(),
            data: ix.data.clone(),
        })
        .collect()
}
fn rpc_transaction(
    tx: &VersionedTransaction,
    meta: &TransactionMetadata,
    error: Option<String>,
) -> Value {
    let VersionedMessage::V0(msg) = &tx.message else {
        panic!("v0")
    };
    let instructions: Vec<_> = msg.instructions.iter().map(|ix| json!({
        "programIdIndex":ix.program_id_index,"accounts":ix.accounts,"data":bs58::encode(&ix.data).into_string()
    })).collect();
    let inner: Vec<_> = meta
        .inner_instructions
        .iter()
        .enumerate()
        .filter(|(_, list)| !list.is_empty())
        .map(|(index, list)| {
            let items: Vec<_> = list.iter().map(|ix| json!({
            "programIdIndex":ix.instruction.program_id_index,"accounts":ix.instruction.accounts,
            "data":bs58::encode(&ix.instruction.data).into_string(),"stackHeight":ix.stack_height
        })).collect();
            json!({"index":index,"instructions":items})
        })
        .collect();
    json!({"version":0,"transaction":{"signatures":tx.signatures.iter().map(ToString::to_string).collect::<Vec<_>>(),
        "message":{"header":{"numRequiredSignatures":msg.header.num_required_signatures,
            "numReadonlySignedAccounts":msg.header.num_readonly_signed_accounts,
            "numReadonlyUnsignedAccounts":msg.header.num_readonly_unsigned_accounts},
            "accountKeys":msg.account_keys.iter().map(ToString::to_string).collect::<Vec<_>>(),
            "recentBlockhash":msg.recent_blockhash.to_string(),"instructions":instructions,"addressTableLookups":[]}},
        "meta":{"err":error,"logMessages":meta.logs,"innerInstructions":inner,
            "loadedAddresses":{"writable":[],"readonly":[]},"computeUnitsConsumed":meta.compute_units_consumed}})
}
fn execute(
    w: &mut World,
    name: &str,
    tx: VersionedTransaction,
    expect_ok: bool,
    blocks: &mut Vec<Value>,
    rows: &mut Vec<Value>,
) {
    let bytes = bincode::serialize(&tx).unwrap();
    assert!(
        bytes.len() <= 1232,
        "{name}: transaction too large: {}",
        bytes.len()
    );
    tx.verify_and_hash_message()
        .expect("SDK Ed25519 signatures must verify");
    let result = w.svm.send_transaction(tx.clone());
    let (ok, meta, error) = match &result {
        Ok(m) => (true, m, None),
        Err(e) => (false, &e.meta, Some(format!("{:?}", e.err))),
    };
    assert_eq!(ok, expect_ok, "{name}: {result:?}");
    assert!(
        meta.compute_units_consumed <= 1_000_000,
        "{name}: compute budget"
    );
    let slot = blocks.len() as u64 + 1;
    let hash = bs58::encode(Sha256::digest(format!("I04-local-block-{slot}"))).into_string();
    let previous = blocks
        .last()
        .map(|b| b["block"]["blockhash"].as_str().unwrap().to_owned())
        .unwrap_or_else(|| bs58::encode([0; 32]).into_string());
    let now = w.svm.get_sysvar::<Clock>().unix_timestamp;
    blocks.push(json!({"slot":slot,"finalized":true,"block":{"blockhash":hash,"previousBlockhash":previous,
        "parentSlot":slot-1,"blockHeight":slot,"blockTime":now,"transactions":[rpc_transaction(&tx,meta,error.clone())]}}));
    rows.push(
        json!({"case":name,"ok":ok,"expected_ok":expect_ok,"cu":meta.compute_units_consumed,
        "transaction_bytes":bytes.len(),"signature":tx.signatures[0].to_string(),"error":error,
        "transaction_base64":STANDARD.encode(bytes),"logs":meta.logs}),
    );
}
fn account_snapshot(w: &World) -> Value {
    let tree = w.state::<TreeState>(w.tree);
    let mut keys = vec![w.pool, w.tree];
    for id in 0..tree.next_note_id {
        keys.push(w.note(u32::try_from(id).unwrap()));
        keys.push(w.pending(u32::try_from(id).unwrap()));
    }
    let mut values = serde_json::Map::new();
    for key in keys {
        if let Some(account) = w.svm.get_account(&key) {
            values.insert(
                key.to_string(),
                json!({"owner": account.owner.to_string(),
                "executable": account.executable, "lamports": account.lamports,
                "data": [STANDARD.encode(account.data), "base64"]}),
            );
        }
    }
    Value::Object(values)
}
fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let elf = fs::read(root.join("target/i04-sbf/zkapi_vault.so")).expect("build I04 ELF");
    let fixture = read(root.join("tests/fixtures/vault/a.json"));
    let mut scenarios = Vec::new();
    for scenario in ["close", "challenge", "finalize", "expiry"] {
        let mut w = World::new(&elf);
        let mut blocks = Vec::new();
        let mut rows = Vec::new();
        let mut checkpoints = Vec::new();
        let init = signed(
            &w,
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),
                Instruction {
                    program_id: w.id,
                    accounts: w.init_accounts(),
                    data: w.init_data(&fixture),
                },
            ],
        );
        execute(&mut w, "initialize", init, true, &mut blocks, &mut rows);
        let output = Command::new("node")
            .current_dir(&root)
            .arg("packages/sdk/test/sbf-transactions.ts")
            .args([
                "--blockhash",
                &w.svm.latest_blockhash().to_string(),
                "--scenario",
                scenario,
            ])
            .output()
            .expect("SDK fixture generator");
        assert!(
            output.status.success(),
            "SDK fixture generator: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let generated: Value = serde_json::from_slice(&output.stdout).expect("SDK generator JSON");
        let mut fault_injected = false;
        let mut coverage = BTreeMap::<String, usize>::new();
        for row in generated["transactions"].as_array().unwrap() {
            let name = row["name"].as_str().unwrap();
            let now = row["unix_timestamp"]
                .as_str()
                .unwrap()
                .parse::<i64>()
                .unwrap();
            w.clock(now);
            let raw = STANDARD.decode(row["base64"].as_str().unwrap()).unwrap();
            let tx: VersionedTransaction = bincode::deserialize(&raw).unwrap();
            let instructions = decompile(&tx);
            let is_transition = instructions.iter().any(|ix| {
                ix.program_id == w.id
                    && ["execute_payload", "finalize_escape"]
                        .iter()
                        .any(|name| ix.data.starts_with(&disc(&format!("global:{name}"))))
            });
            let commands: Vec<_> = instructions
                .iter()
                .filter(|ix| ix.program_id == w.id)
                .map(|ix| {
                    [
                        "create_payload",
                        "append_payload",
                        "seal_payload",
                        "execute_payload",
                        "close_payload",
                        "finalize_escape",
                    ]
                    .into_iter()
                    .find(|name| ix.data.starts_with(&disc(&format!("global:{name}"))))
                    .expect("unexpected SDK Vault instruction")
                    .to_owned()
                })
                .collect();
            if !fault_injected
                && instructions.iter().any(|i| {
                    i.program_id == w.id && i.data.starts_with(&disc("global:execute_payload"))
                })
            {
                let before = w.svm.get_account(&w.tree).unwrap();
                let mut failing = instructions;
                failing.push(solana_sdk::system_instruction::transfer(
                    &w.payer.pubkey(),
                    &w.attacker.pubkey(),
                    u64::MAX,
                ));
                let signed_fault = signed(&w, &failing);
                execute(
                    &mut w,
                    "rollback/after-vault-event",
                    signed_fault,
                    false,
                    &mut blocks,
                    &mut rows,
                );
                assert_eq!(w.svm.get_account(&w.tree).unwrap(), before);
                assert!(
                    rows.last().unwrap()["logs"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|line| line.as_str().unwrap().starts_with("Program data: ")),
                    "failed transaction should contain event log"
                );
                fault_injected = true;
            }
            execute(
                &mut w,
                name,
                tx,
                row["expected_ok"].as_bool().unwrap(),
                &mut blocks,
                &mut rows,
            );
            if row["expected_ok"] == true {
                for command in commands {
                    *coverage.entry(command).or_default() += 1;
                }
            }
            if is_transition && row["expected_ok"] == true {
                checkpoints.push(
                    json!({"name": name, "slot": blocks.len(), "accounts": account_snapshot(&w)}),
                );
            }
        }
        let tree = w.state::<TreeState>(w.tree);
        // Fixed scenario expectations prevent an empty/truncated SDK generator
        // from passing by comparing replay to its own incomplete final state.
        assert!(
            fault_injected,
            "{scenario}: post-Vault rollback was not exercised"
        );
        let (expected_ops, sequence, next_id, outstanding, buffers, finalizes) = match scenario {
            "close" => (vec![0, 1], 2, 1, 0, 2, 0),
            "challenge" => (vec![0, 0, 2, 3], 4, 2, DEPOSIT * 2, 4, 0),
            "finalize" => (vec![0, 2, 4], 3, 1, 0, 2, 1),
            "expiry" => (vec![0, 5], 2, 1, 0, 2, 0),
            _ => unreachable!(),
        };
        for command in ["create_payload", "seal_payload", "execute_payload"] {
            assert_eq!(
                coverage.get(command).copied().unwrap_or(0),
                buffers,
                "{scenario}: {command} coverage"
            );
        }
        assert!(coverage.get("append_payload").copied().unwrap_or(0) >= buffers);
        assert_eq!(
            coverage.get("finalize_escape").copied().unwrap_or(0),
            finalizes
        );
        let emitted: Vec<VaultTransitionV1> = rows
            .iter()
            .filter(|r| r["ok"] == true)
            .flat_map(|r| r["logs"].as_array().unwrap())
            .filter_map(|line| line.as_str().unwrap().strip_prefix("Program data: "))
            .filter_map(|raw| {
                let bytes = STANDARD.decode(raw).unwrap();
                bytes
                    .starts_with(&disc("event:VaultTransitionV1"))
                    .then(|| VaultTransitionV1::try_from_slice(&bytes[8..]).unwrap())
            })
            .collect();
        assert_eq!(
            emitted.iter().map(|e| e.op).collect::<Vec<_>>(),
            expected_ops
        );
        assert_eq!(tree.sequence, sequence);
        assert_eq!(tree.next_note_id, next_id);
        assert_eq!(tree.outstanding_deposits, outstanding);
        assert_eq!(w.amount(w.vault), outstanding);
        assert_eq!(
            w.state::<Note>(w.note(0)).status,
            if scenario == "challenge" { 1 } else { 3 }
        );
        if scenario == "challenge" {
            assert_eq!(w.state::<Note>(w.note(1)).status, 1);
            let ab = read(root.join("tests/fixtures/vault/a-with-b.json"));
            assert_eq!(tree.root, field(&ab["trees"][2]["public_inputs"][2]));
        } else {
            assert_eq!(tree.root, field(&fixture["trees"][0]["public_inputs"][1]));
        }
        if matches!(scenario, "challenge" | "finalize") {
            assert!(!w.state::<PendingWithdrawal>(w.pending(0)).exists);
        }
        let (destination, treasury) = match scenario {
            "close" | "finalize" => (BALANCE, DEPOSIT - BALANCE),
            "expiry" => (0, DEPOSIT),
            _ => (0, 0),
        };
        assert_eq!(w.amount(w.destination), destination);
        assert_eq!(w.amount(w.treasury), treasury);
        assert_eq!(rows.iter().filter(|r| r["ok"] == false).count(), 1);

        scenarios.push(json!({"name":scenario,"blocks":blocks,"rows":rows,"checkpoints":checkpoints,"final_accounts":account_snapshot(&w),"asserted_instruction_coverage":coverage,"asserted_event_ops":expected_ops,
            "expected":{"root":format!("0x{}",hex::encode(tree.root)),"sequence":tree.sequence.to_string(),
                "next_note_id":tree.next_note_id.to_string(),"outstanding_deposits":tree.outstanding_deposits.to_string()}}));
    }
    let max_cu = scenarios
        .iter()
        .flat_map(|s| s["rows"].as_array().unwrap())
        .map(|r| r["cu"].as_u64().unwrap())
        .max()
        .unwrap();
    let max_bytes = scenarios
        .iter()
        .flat_map(|s| s["rows"].as_array().unwrap())
        .map(|r| r["transaction_bytes"].as_u64().unwrap())
        .max()
        .unwrap();
    let report = json!({"scope":"SDK-signed v0 bytes -> actual Vault ELF in LiteSVM; synthetic finalized block envelopes for indexer tests",
        "elf_sha256":hex::encode(Sha256::digest(&elf)),"production_eligible":false,"live_wallet_verified":false,
        "live_rpc_finality_verified":false,"max_cu":max_cu,"max_transaction_bytes":max_bytes,"scenarios":scenarios});
    fs::create_dir_all(root.join("target/i04")).unwrap();
    fs::write(
        root.join("target/i04/sdk-svm-history.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "PASS: SDK v0 / real SBF, {} scenarios, max {} CU / {} bytes",
        4, max_cu, max_bytes
    );
}
