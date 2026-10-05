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
    for slot in 17u64..=130 {
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
                        if [21, 65, 129].contains(&slot) {
                            if let Some(path) = journal_path.lock().unwrap().as_ref() {
                                let saved: Value =
                                    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
                                let last = saved["state"]["archive"]
                                    .as_array()
                                    .and_then(|a| a.last())
                                    .and_then(|b| b["slot"].as_u64())
                                    .unwrap_or(0);
                                durable_at_fetch.lock().unwrap().push((slot, last));
                            }
                        }
                        if slot == 67 {
                            match mode.fault {
                                "fetch67" => {
                                    return Json(
                                        json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32004,"message":"fixture unavailable"}}),
                                    )
                                }
                                "decode67" => block["blockTime"] = json!("invalid"),
                                "replay67" => block["parentSlot"] = json!(65),
                                _ => {}
                            }
                        }
                        if mode.fault == "large" && (17..=20).contains(&slot) {
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
    };
    let mut daemon = runtime::Runtime::open(config.clone(), true).unwrap();
    let view = daemon.scan().await.unwrap();
    assert_eq!(view.slot(), 16);
    assert_eq!(view.pending().count(), 1);
    assert!(view.paused);
    assert_eq!(daemon.journal.archive().last().unwrap().slot, 16);
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
    let mut daemon = runtime::Runtime::open(changed.clone(), true).unwrap();
    assert!(
        daemon.scan().await.is_err(),
        "new Pending inventory was not captured"
    );
    assert_eq!(daemon.journal.archive().last().unwrap().slot, 15);
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
    let mut daemon = runtime::Runtime::open(changed, true).unwrap();
    assert!(daemon.scan().await.is_err());
    assert_eq!(daemon.journal.archive().last().unwrap().slot, 15);
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
    let mut daemon = runtime::Runtime::open(changed.clone(), true).unwrap();
    assert!(daemon.scan().await.is_err());
    assert_eq!(*completions.lock().unwrap(), vec![4, 3, 2, 1]);
    assert_eq!(
        daemon
            .journal
            .archive()
            .iter()
            .map(|block| block.slot)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
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
            tip: 130,
            captured: 130,
            fault,
        };
        let mut changed = config.clone();
        changed.journal_directory = dir.path().join(fault);
        *journal_path.lock().unwrap() = Some(changed.journal_directory.join("journal.json"));
        durable_at_fetch.lock().unwrap().clear();
        let mut daemon = runtime::Runtime::open(changed.clone(), true).unwrap();
        assert!(daemon.scan().await.is_err());
        assert_eq!(daemon.journal.archive().last().unwrap().slot, 66);
        assert!(durable_at_fetch.lock().unwrap().contains(&(65, 64)));
        calls.lock().unwrap().clear();
        mode.lock().unwrap().fault = "none";
        if fault == "replay67" {
            // Retry this same Runtime: an invalid candidate must not poison
            // the successfully committed prefix Scanner.
            assert_eq!(daemon.scan().await.unwrap().slot(), 130);
        }
        drop(daemon);
        let mut daemon = runtime::Runtime::open(changed, false).unwrap();
        let view = daemon.scan().await.unwrap();
        assert_eq!(view.slot(), 130);
        assert_eq!(view.pending().count(), 1);
        assert_eq!(daemon.journal.archive().last().unwrap().slot, 130);
        assert_eq!(
            calls
                .lock()
                .unwrap()
                .iter()
                .find(|r| r["method"] == "getBlocks")
                .unwrap()["params"][0],
            67
        );
    }
    // Four foreign event payloads cross the8MiB byte trigger before64blocks.
    // Their exact bytes remain in the archive; the financial state is unchanged.
    *mode.lock().unwrap() = CutMode {
        tip: 21,
        captured: 21,
        fault: "large",
    };
    let mut changed = config;
    changed.journal_directory = dir.path().join("byte-trigger");
    *journal_path.lock().unwrap() = Some(changed.journal_directory.join("journal.json"));
    durable_at_fetch.lock().unwrap().clear();
    let mut daemon = runtime::Runtime::open(changed.clone(), true).unwrap();
    assert_eq!(daemon.scan().await.unwrap().slot(), 21);
    assert!(durable_at_fetch.lock().unwrap().contains(&(21, 19)));
    for block in &daemon.journal.archive()[16..20] {
        assert_eq!(
            block.transactions[0].instructions[0].events[0],
            vec![7; 2_200_000]
        );
    }
    drop(daemon);
    mode.lock().unwrap().fault = "none";
    let mut daemon = runtime::Runtime::open(changed, false).unwrap();
    assert_eq!(daemon.scan().await.unwrap().slot(), 21);
    server.abort();
}
