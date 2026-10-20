//! Offline full/projected replay against retained SDK-signed local SBF history.
//! Finalized envelopes are fixtures, not evidence of public cluster finality.
use super::*;
use crate::scan::Scanner;
use zkapi_indexer::{projection::ProjectedBlock, rpc::decode_finalized_block, Transaction};

fn history() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/i04/sdk-svm-history.json");
    serde_json::from_slice(&std::fs::read(path).expect("generate with scripts/run_i04.sh")).unwrap()
}

#[test]
#[ignore = "requires retained SDK-signed local SBF history; no network or financial actions"]
fn projected_scanner_matches_complete_sbf_history_and_restart_at_every_cut() {
    let history = history();
    let (trust, _) = trust_and_manifest();
    let mut total = 0;
    for scenario in history["scenarios"].as_array().unwrap() {
        for without_events in [false, true] {
            let mut full = Scanner::new(trust.clone());
            let mut projected = Scanner::new(trust.clone());
            let mut saved = Vec::new();
            for row in scenario["blocks"].as_array().unwrap() {
                assert_eq!(row["finalized"], true);
                let mut block =
                    decode_finalized_block(row["slot"].as_u64().unwrap(), &row["block"]).unwrap();
                if without_events {
                    for tx in &mut block.transactions {
                        for ix in &mut tx.instructions {
                            ix.events.clear();
                        }
                    }
                }
                let evidence = full.project_finalized(&block).unwrap();
                evidence.verify_source(&block).unwrap();
                let bytes = serde_json::to_vec(&evidence).unwrap();
                let decoded: ProjectedBlock = serde_json::from_slice(&bytes).unwrap();
                projected.apply_projected(&decoded).unwrap();
                assert!(full.projection_equivalent(&projected).unwrap());
                assert_eq!(
                    full.replay_state().unwrap(),
                    projected.replay_state().unwrap()
                );
                // Projected state cannot be written into an old full-history cache.
                assert!(projected.checkpoint_bytes().is_err());
                saved.push(decoded);
                let mut restarted = Scanner::new(trust.clone());
                for block in &saved {
                    restarted.apply_projected(block).unwrap();
                }
                assert!(full.projection_equivalent(&restarted).unwrap());
                let state = full.replay_state().unwrap();
                for cut in scenario["checkpoints"].as_array().unwrap() {
                    if cut["slot"].as_u64() == Some(state.slot) {
                        let account = &cut["accounts"][&trust.pool.pool];
                        let original = full.reconcile(&state, account).unwrap();
                        assert_eq!(original.state, projected.replay_state().unwrap());
                        // Shadow equality is not authority to serve paths or jobs.
                        let mut probe = projected.clone();
                        assert!(probe.reconcile(&state, account).is_err());
                    }
                }
                total += 1;
            }
            let state = full.replay_state().unwrap();
            assert_eq!(scenario["expected"]["sequence"], state.sequence.to_string());
            assert_eq!(
                scenario["expected"]["root"],
                zkapi_indexer::snapshot::field(state.root)
            );
        }
    }
    assert_eq!(total, 106); // 53 real-SBF blocks, both with and without events.
}

#[test]
#[ignore = "requires retained SBF history; foreign traffic is synthetic"]
fn projected_scanner_retains_original_positions_with_foreign_traffic_and_full_cache_resume() {
    let history = history();
    let scenario = history["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "challenge")
        .unwrap();
    let (trust, _) = trust_and_manifest();
    let mut full = Scanner::new(trust.clone());
    let mut projected = Scanner::new(trust.clone());
    let mut resumed = None;
    let mut observed_pending = false;
    for row in scenario["blocks"].as_array().unwrap() {
        let mut block =
            decode_finalized_block(row["slot"].as_u64().unwrap(), &row["block"]).unwrap();
        let foreign = Transaction {
            signature: format!("synthetic-foreign-{}", block.slot),
            succeeded: true,
            instructions: vec![],
        };
        block.transactions.insert(0, foreign);
        block.transactions.push(Transaction {
            signature: format!("synthetic-failed-{}", block.slot),
            succeeded: false,
            instructions: vec![],
        });
        let evidence = full.project_finalized(&block).unwrap();
        assert!(evidence.transactions.iter().all(|tx| tx.original_index > 0));
        projected.apply_projected(&evidence).unwrap();
        if let Some(previous) = &mut resumed {
            let previous: &mut Scanner = previous;
            previous.apply_projected(&evidence).unwrap();
            assert!(full.projection_equivalent(previous).unwrap());
        }
        assert!(full.projection_equivalent(&projected).unwrap());
        let state = full.replay_state().unwrap();
        // Every full-history cut remains restorable with the unchanged cache.
        let bytes = full.checkpoint_bytes().unwrap();
        resumed = Some(
            Scanner::restore_checkpoint(
                trust.clone(),
                &bytes,
                sha(&bytes),
                ArchiveTail {
                    slot: block.slot,
                    blockhash: block.blockhash,
                    block_time: block.block_time,
                },
            )
            .unwrap(),
        );
        for cut in scenario["checkpoints"].as_array().unwrap() {
            if cut["slot"].as_u64() == Some(state.slot) {
                let account = &cut["accounts"][&trust.pool.pool];
                let original = full.reconcile(&state, account).unwrap();
                let mut probe = projected.clone();
                assert!(probe.reconcile(&state, account).is_err());
                for generation in original.generations.values() {
                    assert_eq!(generation.position().unwrap().transaction_index, 1);
                    observed_pending = true;
                }
            }
        }
    }
    assert!(observed_pending);
}
