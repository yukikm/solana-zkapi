//! Fail if the real SDK-signed/SBF-executed history is missing or mismatched.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{error::Error, fs};
use zkapi_indexer::{
    discriminator,
    rpc::decode_finalized_block,
    snapshot::{field, parse_key},
    Indexer,
};
fn main() -> Result<(), Box<dyn Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("usage: verify_history <sdk-svm-history.json>")?;
    let raw = fs::read(path)?;
    let report: Value = serde_json::from_slice(&raw)?;
    let scenarios = report["scenarios"].as_array().ok_or("scenarios missing")?;
    if scenarios.len() != 4 {
        return Err("expected four real SBF scenarios".into());
    }
    let mut results = Vec::new();
    for scenario in scenarios {
        let blocks = scenario["blocks"].as_array().ok_or("blocks missing")?;
        let first = decode_finalized_block(
            blocks[0]["slot"].as_u64().ok_or("slot")?,
            &blocks[0]["block"],
        )?;
        let initialize = first
            .transactions
            .iter()
            .flat_map(|tx| tx.instructions.iter())
            .find(|ix| {
                ix.data
                    .starts_with(&discriminator("global", "initialize_pool"))
            })
            .ok_or("initialize missing")?;
        let mut baseline = Indexer::new(initialize.program, initialize.accounts[0]);
        let mut recovered = baseline.clone();
        let mut failed = 0;
        let mut snapshots = 0;
        let mut paths = 0;
        for entry in blocks {
            if entry["finalized"] != true {
                return Err("fixture finality flag".into());
            }
            let slot = entry["slot"].as_u64().ok_or("slot")?;
            let block = decode_finalized_block(slot, &entry["block"])?;
            let prior = baseline.replay_state().ok();
            failed += block.transactions.iter().filter(|tx| !tx.succeeded).count();
            baseline.apply_block(&block)?;
            let mut missing = entry["block"].clone();
            for tx in missing["transactions"]
                .as_array_mut()
                .ok_or("transactions")?
            {
                tx["meta"]["logMessages"] = Value::Null;
            }
            recovered.apply_block(&decode_finalized_block(slot, &missing)?)?;
            let current = baseline.replay_state()?;
            assert_eq!(current, recovered.replay_state()?);
            if block.transactions.iter().all(|tx| !tx.succeeded) {
                let prior = prior.ok_or("failed initial block")?;
                assert_eq!(prior.sequence, current.sequence);
                assert_eq!(prior.root, current.root);
                assert_eq!(prior.active, current.active);
                assert_eq!(prior.pending, current.pending);
            }
            // This test checks API gating and exact snapshot round trips. Runtime
            // independently observes accounts; a self-observation is not RPC trust.
            baseline.reconcile(&current)?;
            recovered.reconcile(&current)?;
            let bytes = baseline.snapshot_bytes()?;
            let restored =
                Indexer::restore_snapshot(&bytes, Sha256::digest(&bytes).into(), &recovered)?;
            assert_eq!(restored.snapshot_bytes()?, bytes);
            snapshots += 1;
            for id in current.active.keys() {
                let p = restored.path(*id)?;
                assert_eq!(p.snapshot.root, field(current.root));
                paths += 1;
            }
            for id in current.pending.keys() {
                assert_eq!(restored.zero_path(*id)?.leaf, field([0; 32]));
                paths += 1;
            }
            assert_eq!(parse_key(&baseline.root()?.pool)?, initialize.accounts[0]);
        }
        let state = baseline.replay_state()?;
        let expected = &scenario["expected"];
        assert_eq!(expected["root"], field(state.root));
        assert_eq!(expected["sequence"], state.sequence.to_string());
        assert_eq!(expected["next_note_id"], state.next_note_id.to_string());
        assert_eq!(
            expected["outstanding_deposits"],
            state.outstanding_deposits.to_string()
        );
        results.push(json!({"name":scenario["name"],"blocks":blocks.len(),"failed_transactions_ignored":failed,"snapshot_roundtrips":snapshots,"paths_checked":paths,"sequence":state.sequence,"next_note_id":state.next_note_id,"root":field(state.root),"missing_logs_replay_equal":true}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"source_sha256":hex::encode(Sha256::digest(raw)),"scope":"real SDK-signed v0 / local SBF history replay; missing-log replay and API snapshot/path checks; no live RPC finality or live wallet claim","scenarios":results})
        )?
    );
    Ok(())
}
