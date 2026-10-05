//! Replay the actual SDK-signed / SBF-executed compact deposit archive.
//! Archive slot finality is a local fixture, not a public RPC acceptance claim.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{error::Error, fs};
use zkapi_indexer::{discriminator, rpc::decode_finalized_block, snapshot::field, Indexer};

fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: verify_compact_history SDK_HISTORY_JSON")?;
    let raw = fs::read(path)?;
    let report: Value = serde_json::from_slice(&raw)?;
    let blocks = report["blocks"].as_array().ok_or("blocks missing")?;
    assert_eq!(blocks.len(), 3);
    let decode =
        |value: &Value| decode_finalized_block(value["slot"].as_u64().unwrap(), &value["block"]);
    let init = decode(&blocks[0])?;
    let instruction = init
        .transactions
        .iter()
        .flat_map(|tx| &tx.instructions)
        .find(|ix| {
            ix.data
                .starts_with(&discriminator("global", "initialize_pool"))
        })
        .ok_or("missing real initializer")?;
    let mut baseline = Indexer::new(instruction.program, instruction.accounts[0]);
    let mut missing_logs = baseline.clone();
    let mut failed = 0;
    for (cut, block) in blocks.iter().enumerate() {
        let block = decode(block)?;
        failed += block.transactions.iter().filter(|tx| !tx.succeeded).count();
        baseline.apply_block(&block)?;
        let mut missing = blocks[cut].clone();
        for tx in missing["block"]["transactions"].as_array_mut().unwrap() {
            tx["meta"]["logMessages"] = Value::Null;
        }
        missing_logs.apply_block(&decode(&missing)?)?;
        let current = baseline.replay_state()?;
        assert_eq!(missing_logs.replay_state()?, current);
        baseline.reconcile(&current)?;
        missing_logs.reconcile(&current)?;
        let snapshot = baseline.snapshot_bytes()?;
        let restored =
            Indexer::restore_snapshot(&snapshot, Sha256::digest(&snapshot).into(), &missing_logs)?;
        assert_eq!(restored.snapshot_bytes()?, snapshot);
        // A new process replays the accepted prefix, then reaches the same cut.
        let mut restarted = Indexer::new(instruction.program, instruction.accounts[0]);
        for entry in &blocks[..=cut] {
            restarted.apply_block(&decode(entry)?)?;
        }
        assert_eq!(restarted.replay_state()?, current);
    }
    let final_state = baseline.replay_state()?;
    assert_eq!(report["expected"]["root"], field(final_state.root));
    assert_eq!(report["expected"]["sequence"], final_state.sequence);
    assert_eq!(report["expected"]["next_note_id"], final_state.next_note_id);
    assert_eq!(
        report["expected"]["outstanding_deposits"],
        final_state.outstanding_deposits
    );
    assert_eq!(baseline.path(0)?, missing_logs.path(0)?);
    assert_eq!(failed, 1);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "status":"pass","source_sha256":hex::encode(Sha256::digest(raw)),
            "scope":"actual SDK compact transaction / real local SBF; synthetic finalized slots",
            "blocks":blocks.len(),"failed_transactions_ignored":failed,
            "snapshot_roundtrips":blocks.len(),"restart_cuts":blocks.len(),
            "missing_logs_replay_equal":true,"sequence":final_state.sequence,
            "next_note_id":final_state.next_note_id,"root":field(final_state.root)
        }))?
    );
    Ok(())
}
