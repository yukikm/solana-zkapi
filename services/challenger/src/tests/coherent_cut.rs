//! Existing actual-SBF archive, served by a local RPC fixture. Tests account-cut
//! timing/durable replay; it does not send any transaction or regenerate inputs.
use super::*;
use axum::{routing::post, Json, Router};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct CutMode {
    tip: u64,
    captured: u64,
    fault: &'static str,
}
#[tokio::test]
#[ignore = "reads existing I04 SBF archive; focused run requires target/i04/sdk-svm-history.json"]
async fn rpc_daemon_advancing_cut_preserves_archive_and_same_cut_pool_validation() {
    check_archive_batches(None, false).await;
}
#[tokio::test]
#[ignore = "reads existing I04 SBF archive; focused run requires target/i04/sdk-svm-history.json"]
async fn rpc_daemon_larger_archive_batch_preserves_prefix_recovery_and_account_cut() {
    check_archive_batches(
        Some(runtime::ArchiveBatchPolicy {
            rpc_concurrency: None,
            max_blocks: 256,
            max_bytes: 32 * 1024 * 1024,
        }),
        false,
    )
    .await;
}
#[tokio::test]
#[ignore = "reads existing I04 SBF archive; focused run requires target/i04/sdk-svm-history.json"]
async fn rpc_daemon_segmented_archive_preserves_cut_failure_prefix_and_restart() {
    check_archive_batches(None, true).await;
}
fn open_new_fixture(config: runtime::Config, segmented: bool) -> runtime::Runtime {
    if segmented {
        let pool = config.trust().unwrap().pool();
        drop(Journal::initialize(&config.journal_directory, pool).unwrap());
        let original = std::fs::read(config.journal_directory.join("journal.json")).unwrap();
        let report = Journal::migrate_v1_to_segmented(&config.journal_directory, pool).unwrap();
        assert_eq!(report.format_version, 2);
        assert_eq!(report.archive_blocks, 0);
        assert_eq!(
            std::fs::read(config.journal_directory.join("legacy-v1.json")).unwrap(),
            original
        );
        runtime::Runtime::open(config, false).unwrap()
    } else {
        runtime::Runtime::open(config, true).unwrap()
    }
}
async fn check_archive_batches(policy: Option<runtime::ArchiveBatchPolicy>, segmented: bool) {
    let batch = policy.unwrap_or_default();
    let boundary = batch.max_blocks as u64;
    let final_slot = boundary * 2 + 2;
    let failed_slot = boundary + 3;
    let large_end = if policy.is_some() { 24 } else { 20 };
    let byte_observation = large_end + 1;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let history: Value = serde_json::from_slice(
        &std::fs::read(root.join("target/i04/sdk-svm-history.json")).unwrap(),
    )
    .unwrap();
    let mut scenario = history["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "challenge")
        .unwrap()
        .clone();
    let cut = scenario["checkpoints"][2].clone();
    assert_eq!(cut["slot"], 15);
    // Extend the captured Pending cut with quiet synthetic blocks so this
    // fixture crosses two durable batch boundaries without changing state.
    let blocks = scenario["blocks"].as_array_mut().unwrap();
    blocks.retain(|block| block["slot"].as_u64().unwrap() <= 16);
    for slot in 17u64..=final_slot {
        let previous = blocks.last().unwrap()["block"]["blockhash"].clone();
        blocks.push(json!({"slot":slot,"block":{"blockhash":zkapi_indexer::snapshot::key(sha(&slot.to_le_bytes())),
            "previousBlockhash":previous,"parentSlot":slot-1,"blockTime":3_000_000_000u64,"transactions":[]}}));
    }
    let (trust, manifest) = trust_and_manifest();
    let mode = Arc::new(Mutex::new(CutMode {
        tip: 15,
        captured: 16,
        fault: "none",
    }));
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let completions = Arc::new(Mutex::new(Vec::<u64>::new()));
    let journal_path = Arc::new(Mutex::new(None::<std::path::PathBuf>));
    let durable_at_fetch = Arc::new(Mutex::new(Vec::<(u64, u64)>::new()));
    let route = {
        let mode = mode.clone();
        let calls = calls.clone();
        let completions = completions.clone();
        let genesis = trust.pool.genesis_hash.clone();
        let journal_path = journal_path.clone();
        let durable_at_fetch = durable_at_fetch.clone();
        post(move |Json(body): Json<Value>| {
            let mode = mode.lock().unwrap().clone();
            let calls = calls.clone();
            let completions = completions.clone();
            let scenario = scenario.clone();
            let cut = cut.clone();
            let genesis = genesis.clone();
            let journal_path = journal_path.clone();
            let durable_at_fetch = durable_at_fetch.clone();
            async move {
                calls.lock().unwrap().push(body.clone());
                if mode.fault == "fetch" && body["method"] == "getBlock" {
                    let slot = body["params"][0].as_u64().unwrap();
                    tokio::time::sleep(std::time::Duration::from_millis((5 - slot) * 15)).await;
                    completions.lock().unwrap().push(slot);
                    if slot == 3 {
                        return Json(
                            json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32004,"message":"fixture unavailable"}}),
                        );
                    }
                }
                let result = match body["method"].as_str().unwrap() {
                    "getGenesisHash" => json!(genesis),
                    "getSlot" => json!(mode.tip),
                    "getBlocks" => json!(scenario["blocks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|b| b["slot"].as_u64().unwrap())
                        .filter(|s| *s >= body["params"][0].as_u64().unwrap()
                            && *s <= body["params"][1].as_u64().unwrap()
                            && !(mode.fault == "tail" && *s == 16))
                        .collect::<Vec<_>>()),
                    "getBlock" => {
                        assert_eq!(body["params"][1]["commitment"], "finalized");
                        assert_eq!(body["params"][1]["maxSupportedTransactionVersion"], 1);
                        let mut block = scenario["blocks"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|b| b["slot"] == body["params"][0])
                            .unwrap()["block"]
                            .clone();
                        let slot = body["params"][0].as_u64().unwrap();
                        if [byte_observation, boundary + 1, boundary * 2 + 1].contains(&slot) {
                            if let Some(path) = journal_path.lock().unwrap().as_ref() {
                                let saved: Value =
                                    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                                let last = match saved["state"]["version"].as_u64().unwrap() {
                                    1 => saved["state"]["archive"]
                                        .as_array()
                                        .and_then(|a| a.last())
                                        .and_then(|b| b["slot"].as_u64())
                                        .unwrap_or(0),
                                    2 => saved["segmented"]["tail"]["last_slot"]
                                        .as_u64()
                                        .unwrap_or(0),
                                    _ => panic!("unexpected journal format"),
                                };
                                durable_at_fetch.lock().unwrap().push((slot, last));
                            }
                        }
                        if slot == failed_slot {
                            match mode.fault {
                                "fetch67" => {
                                    return Json(
                                        json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32004,"message":"fixture unavailable"}}),
                                    )
                                }
                                "decode67" => block["blockTime"] = json!("invalid"),
                                "replay67" => block["parentSlot"] = json!(failed_slot - 2),
                                _ => {}
                            }
                        }
                        if mode.fault == "large" && (17..=large_end).contains(&slot) {
                            let program = zkapi_indexer::snapshot::key([91; 32]);
                            block["transactions"] = json!([{"version":"legacy","transaction":{"signatures":[scenario["blocks"][0]["block"]["transactions"][0]["transaction"]["signatures"][0]],"message":{"accountKeys":[program],"instructions":[{"programIdIndex":0,"accounts":[],"data":""}]}},"meta":{"err":null,"innerInstructions":[],"logMessages":[format!("Program {program} invoke [1]"),format!("Program data: {}",STANDARD.encode(vec![7u8;2_200_000])),format!("Program {program} success")]}}]);
                        }
                        if mode.fault == "header"
                            && body["params"][1]["transactionDetails"] == "none"
                        {
                            block["blockhash"] = json!(zkapi_indexer::snapshot::key([91; 32]));
                        }
                        block
                    }
                    "getMultipleAccounts" => {
                        assert_eq!(body["params"][1]["commitment"], "finalized");
                        let mut values: Vec<Value> = body["params"][0]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|k| cut["accounts"][k.as_str().unwrap()].clone())
                            .collect();
                        // This PoolConfig is part of the same bank. A separate
                        // getAccountInfo is deliberately not implemented.
                        let mut pool = STANDARD
                            .decode(values[0]["data"][0].as_str().unwrap())
                            .unwrap();
                        pool[355] = 1;
                        if mode.fault == "mint" {
                            pool[42] ^= 1;
                        }
                        values[0]["data"][0] = STANDARD.encode(pool).into();
                        if mode.fault == "owner" {
                            values[0]["owner"] = json!(zkapi_indexer::snapshot::key([91; 32]));
                        }
                        if mode.fault == "sequence" {
                            let mut tree = STANDARD
                                .decode(values[1]["data"][0].as_str().unwrap())
                                .unwrap();
                            tree[50] ^= 1;
                            values[1]["data"][0] = STANDARD.encode(tree).into();
                        }
                        json!({"context":{"slot":mode.captured},"value":values})
                    }
                    _ => panic!("separate account reads or unrelated RPC are forbidden"),
                };
                Json(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))
            }
        })
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route("/", route))
            .await
            .unwrap()
    });
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("manifest.json");
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let config = runtime::Config {
        manifest: path,
        manifest_sha256: hex::encode(trust.manifest_hash),
        devnet: None,
        rpc_url: format!("http://{address}"),
        database_dsn_file: dir.path().join("absent-dsn"),
        start_slot: 1,
        journal_directory: dir.path().join("journal"),
        tree_pk: dir.path().join("absent-pk"),
        node: "/absent/node".into(),
        transport_bridge: dir.path().join("absent-bridge"),
        transport_bridge_sha256: "00".repeat(32),
        fee_key_file: dir.path().join("absent-fee-key"),
        payer: zkapi_indexer::snapshot::key([7; 32]),
        poll_seconds: 1,
        alert_sink_directory: None,
        priority_fee: None,
        archive_batch: policy,
    };
    if policy.is_none() {
        assert!(serde_json::to_value(&config)
            .unwrap()
            .get("archive_batch")
            .is_none());
    }
    let mut invalid = config.clone();
    invalid.archive_batch = Some(runtime::ArchiveBatchPolicy {
        rpc_concurrency: None,
        max_blocks: 257,
        max_bytes: 1,
    });
    assert!(runtime::Runtime::open(invalid, true).is_err());
    assert!(!config.journal_directory.exists());
    let mut daemon = open_new_fixture(config.clone(), segmented);
    let view = daemon.scan().await.unwrap();
    assert_eq!(view.slot(), 16);
    assert_eq!(view.pending().count(), 1);
    assert!(view.paused);
    assert_eq!(daemon.journal.archive_tail().unwrap().slot, 16);
    assert!(calls
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["method"] == "getMultipleAccounts" && v["params"][1]["minContextSlot"] == 15));
    drop(daemon);
    *mode.lock().unwrap() = CutMode {
        tip: 16,
        captured: 16,
        fault: "none",
    };
    calls.lock().unwrap().clear();
    let mut daemon = runtime::Runtime::open(config.clone(), false).unwrap();
    // Cold replay must retain the exact historical clock used by challenge
    // fee/expiry planning, while health reads only the authenticated tail.
    let tail = daemon.journal.archive_tail().unwrap();
    assert_eq!(tail.slot, 16);
    assert_eq!(daemon.journal.archive_len(), 16);
    let mut count = 0;
    daemon
        .journal
        .replay_archive(|block| {
            assert_eq!(
                daemon.journal.archive_block_time(block.slot)?,
                Some(block.block_time)
            );
            count += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(count, 16);
    assert_eq!(daemon.journal.archive_block_time(0).unwrap(), None);
    assert_eq!(daemon.journal.archive_block_time(17).unwrap(), None);
    let summary = runtime::metrics(&daemon.journal, tail.block_time + 17);
    assert_eq!(summary.finalized_slot, Some(16));
    assert_eq!(summary.finalized_lag_seconds, Some(17));
    // The fallible borrowed visitor propagates a latched shutdown before a
    // later block is applied. This read cannot advance the durable head.
    let before_replay = std::fs::read(config.journal_directory.join("journal.json")).unwrap();
    let mut visited = 0;
    let interrupted = daemon.journal.replay_archive(|_| {
        visited += 1;
        if visited == 2 {
            Err(crate::Error::Interrupted)
        } else {
            Ok(())
        }
    });
    assert!(matches!(interrupted, Err(crate::Error::Interrupted)));
    assert_eq!(visited, 2);
    assert_eq!(
        std::fs::read(config.journal_directory.join("journal.json")).unwrap(),
        before_replay
    );
    assert_eq!(daemon.scan().await.unwrap().state, view.state);
    assert!(!calls
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["method"] == "getBlocks"));
    for fault in ["header", "mint", "owner", "sequence"] {
        mode.lock().unwrap().fault = fault;
        assert!(daemon.scan().await.is_err(), "accepted {fault}");
    }
    *mode.lock().unwrap() = CutMode {
        tip: 16,
        captured: 15,
        fault: "none",
    };
    assert!(daemon.scan().await.is_err(), "regressed account capture");
    drop(daemon);
    // Escape at 15 introduces Pending after inventory 14. Persist the replay,
    // reject its incomplete capture, then recover with the advanced inventory.
    *mode.lock().unwrap() = CutMode {
        tip: 14,
        captured: 15,
        fault: "none",
    };
    let mut changed = config.clone();
    changed.journal_directory = dir.path().join("inventory-journal");
    let mut daemon = open_new_fixture(changed.clone(), segmented);
    assert!(
        daemon.scan().await.is_err(),
        "new Pending inventory was not captured"
    );
    assert_eq!(daemon.journal.archive_tail().unwrap().slot, 15);
    drop(daemon);
    *mode.lock().unwrap() = CutMode {
        tip: 15,
        captured: 15,
        fault: "none",
    };
    calls.lock().unwrap().clear();
    let mut daemon = runtime::Runtime::open(changed, false).unwrap();
    let recovered = daemon.scan().await.unwrap();
    assert_eq!(recovered.pending().count(), 1);
    assert_eq!(recovered.slot(), 15);
    assert!(!calls
        .lock()
        .unwrap()
        .iter()
        .any(|v| v["method"] == "getBlocks"));
    drop(daemon);
    // A captured bank cannot be published if its archive tail is unavailable.
    *mode.lock().unwrap() = CutMode {
        tip: 15,
        captured: 16,
        fault: "tail",
    };
    let mut changed = config.clone();
    changed.journal_directory = dir.path().join("tail-journal");
    let mut daemon = open_new_fixture(changed, segmented);
    assert!(daemon.scan().await.is_err());
    assert_eq!(daemon.journal.archive_tail().unwrap().slot, 15);
    mode.lock().unwrap().fault = "none";
    assert_eq!(daemon.scan().await.unwrap().slot(), 16);
    drop(daemon);
    // Out-of-order successful reads after a failed slot are never committed.
    // Restart must resume exactly after the durably applied successful prefix.
    *mode.lock().unwrap() = CutMode {
        tip: 15,
        captured: 16,
        fault: "fetch",
    };
    let mut changed = config.clone();
    changed.journal_directory = dir.path().join("prefix-journal");
    let mut daemon = open_new_fixture(changed.clone(), segmented);
    assert!(daemon.scan().await.is_err());
    assert_eq!(*completions.lock().unwrap(), vec![4, 3, 2, 1]);
    let mut replayed_slots = Vec::new();
    daemon
        .journal
        .replay_archive(|block| {
            replayed_slots.push(block.slot);
            Ok(())
        })
        .unwrap();
    assert_eq!(replayed_slots, vec![1, 2]);
    drop(daemon);
    calls.lock().unwrap().clear();
    mode.lock().unwrap().fault = "none";
    let mut daemon = runtime::Runtime::open(changed, false).unwrap();
    assert_eq!(daemon.scan().await.unwrap().slot(), 16);
    {
        let recorded_calls = calls.lock().unwrap();
        assert_eq!(
            recorded_calls
                .iter()
                .find(|call| call["method"] == "getBlocks")
                .unwrap()["params"][0],
            3
        );
        assert!(!recorded_calls
            .iter()
            .any(|call| call["method"] == "getBlock" && call["params"][0].as_u64().unwrap() < 3));
    }
    drop(daemon);
    // Each failure after the first batch retains exactly the healthy prefix,
    // including replay errors that poison only their discarded candidate.
    for fault in ["fetch67", "decode67", "replay67"] {
        *mode.lock().unwrap() = CutMode {
            tip: final_slot,
            captured: final_slot,
            fault,
        };
        let mut changed = config.clone();
        changed.journal_directory = dir.path().join(fault);
        *journal_path.lock().unwrap() = Some(changed.journal_directory.join("journal.json"));
        durable_at_fetch.lock().unwrap().clear();
        let mut daemon = open_new_fixture(changed.clone(), segmented);
        assert!(daemon.scan().await.is_err());
        assert_eq!(daemon.journal.archive_tail().unwrap().slot, failed_slot - 1);
        assert!(durable_at_fetch
            .lock()
            .unwrap()
            .contains(&(boundary + 1, boundary)));
        calls.lock().unwrap().clear();
        mode.lock().unwrap().fault = "none";
        if fault == "replay67" {
            // Retry this same Runtime: an invalid candidate must not poison
            // the successfully committed prefix Scanner.
            assert_eq!(daemon.scan().await.unwrap().slot(), final_slot);
        }
        drop(daemon);
        let mut daemon = runtime::Runtime::open(changed, false).unwrap();
        let view = daemon.scan().await.unwrap();
        assert_eq!(view.slot(), final_slot);
        assert_eq!(view.pending().count(), 1);
        assert_eq!(daemon.journal.archive_tail().unwrap().slot, final_slot);
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .find(|r| r["method"] == "getBlocks")
                .unwrap()["params"][0],
            failed_slot
        );
    }
    // Foreign event payloads cross each configured byte trigger before its block bound.
    // Their exact bytes remain in the archive; the financial state is unchanged.
    *mode.lock().unwrap() = CutMode {
        tip: byte_observation,
        captured: byte_observation,
        fault: "large",
    };
    let mut changed = config.clone();
    changed.journal_directory = dir.path().join("byte-trigger");
    *journal_path.lock().unwrap() = Some(changed.journal_directory.join("journal.json"));
    durable_at_fetch.lock().unwrap().clear();
    let mut daemon = open_new_fixture(changed.clone(), segmented);
    assert_eq!(daemon.scan().await.unwrap().slot(), byte_observation);
    assert!(durable_at_fetch
        .lock()
        .unwrap()
        .contains(&(byte_observation, large_end - 1)));
    let mut inspected = 0;
    daemon
        .journal
        .replay_archive(|block| {
            if block.slot > 16 && block.slot <= large_end {
                assert_eq!(
                    block.transactions[0].instructions[0].events[0],
                    vec![7; 2_200_000]
                );
                inspected += 1;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(inspected, large_end - 16);
    drop(daemon);
    mode.lock().unwrap().fault = "none";
    let mut daemon = runtime::Runtime::open(changed, false).unwrap();
    assert_eq!(daemon.scan().await.unwrap().slot(), byte_observation);
    drop(daemon);
    // An explicit tiny byte threshold must preserve each larger block alone,
    // not truncate or reject the archive. The financial account cut is equal.
    *mode.lock().unwrap() = CutMode {
        tip: 16,
        captured: 16,
        fault: "none",
    };
    let mut changed = config;
    changed.journal_directory = dir.path().join("oversized-singletons");
    changed.archive_batch = Some(runtime::ArchiveBatchPolicy {
        rpc_concurrency: None,
        max_blocks: 256,
        max_bytes: 1,
    });
    let mut daemon = open_new_fixture(changed.clone(), segmented);
    assert_eq!(daemon.scan().await.unwrap().slot(), 16);
    assert_eq!(daemon.journal.archive_len(), 16);
    drop(daemon);
    let mut daemon = runtime::Runtime::open(changed, false).unwrap();
    assert_eq!(daemon.scan().await.unwrap().slot(), 16);
    server.abort();
}
