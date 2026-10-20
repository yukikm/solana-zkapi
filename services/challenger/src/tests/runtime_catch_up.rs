//! Synthetic read-only RPC replay; no proof, provider or transaction sender.
use super::*;
use axum::{routing::post, Json, Router};
use std::sync::{Arc, Mutex};
use zkapi_indexer::FinalizedBlock;

fn block(slot: u64) -> FinalizedBlock {
    FinalizedBlock {
        finalized: true,
        slot,
        parent_slot: slot - 1,
        blockhash: sha(&slot.to_le_bytes()),
        previous_blockhash: sha(&(slot - 1).to_le_bytes()),
        block_time: 3_000_000_000 + slot,
        transactions: vec![],
    }
}

struct Fixture {
    _directory: tempfile::TempDir,
    config: Config,
    fault: Arc<Mutex<Option<(u64, &'static str)>>>,
    omitted_ranges: Arc<Mutex<usize>>,
    ranges: Arc<Mutex<Vec<(u64, u64)>>>,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Fixture {
    async fn new(retained: u64, max_blocks: usize) -> Self {
        let (trust, manifest) = crate::tests::trust_and_manifest();
        let fault = Arc::new(Mutex::new(None::<(u64, &'static str)>));
        let omitted_ranges = Arc::new(Mutex::new(0usize));
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let route = {
            let fault = fault.clone();
            let omitted_ranges = omitted_ranges.clone();
            let ranges = ranges.clone();
            post(move |Json(body): Json<Value>| {
                let fault = *fault.lock().unwrap();
                let omitted_ranges = omitted_ranges.clone();
                let ranges = ranges.clone();
                async move {
                    let result = match body["method"].as_str().unwrap() {
                        "getBlocks" => {
                            let start = body["params"][0].as_u64().unwrap();
                            let end = body["params"][1].as_u64().unwrap();
                            ranges.lock().unwrap().push((start, end));
                            let mut omitted = omitted_ranges.lock().unwrap();
                            let missing = *omitted > 0;
                            *omitted = omitted.saturating_sub(1);
                            json!((start..=end)
                                .filter(|slot| !missing || *slot != end)
                                .collect::<Vec<_>>())
                        }
                        "getBlock" => {
                            let slot = body["params"][0].as_u64().unwrap();
                            if fault == Some((slot, "fetch")) {
                                return Json(json!({"jsonrpc":"2.0","id":body["id"],
                                    "error":{"code":-32004,"message":"fixture unavailable"}}));
                            }
                            let b = block(slot);
                            let mut value = json!({
                                "blockhash":zkapi_indexer::snapshot::key(b.blockhash),
                                "previousBlockhash":zkapi_indexer::snapshot::key(b.previous_blockhash),
                                "parentSlot":b.parent_slot,"blockTime":b.block_time,
                                "transactions":[]
                            });
                            if fault == Some((slot, "decode")) {
                                value["blockTime"] = json!("invalid");
                            } else if fault == Some((slot, "replay")) {
                                value["parentSlot"] = json!(slot - 2);
                            }
                            value
                        }
                        _ => panic!("only archive reads are allowed"),
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
                .unwrap();
        });
        let directory = tempfile::tempdir().unwrap();
        let manifest_path = directory.path().join("manifest.json");
        std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let config = Config {
            manifest: manifest_path,
            manifest_sha256: hex::encode(trust.manifest_hash),
            devnet: None,
            rpc_url: format!("http://{address}"),
            database_dsn_file: directory.path().join("absent-dsn"),
            start_slot: 1,
            journal_directory: directory.path().join("journal"),
            tree_pk: directory.path().join("absent-pk"),
            node: "/absent/node".into(),
            transport_bridge: directory.path().join("absent-bridge"),
            transport_bridge_sha256: "00".repeat(32),
            fee_key_file: directory.path().join("absent-fee-key"),
            payer: zkapi_indexer::snapshot::key([7; 32]),
            poll_seconds: 1,
            alert_sink_directory: None,
            priority_fee: None,
            archive_batch: Some(ArchiveBatchPolicy {
                rpc_concurrency: None,
                max_blocks,
                max_bytes: 32 * 1024 * 1024,
            }),
        };
        drop(Journal::initialize(&config.journal_directory, trust.pool()).unwrap());
        Journal::migrate_v1_to_segmented(&config.journal_directory, trust.pool()).unwrap();
        let mut journal = Journal::open(&config.journal_directory, trust.pool()).unwrap();
        journal
            .append_archive_batch((1..=retained).map(block).collect())
            .unwrap();
        drop(journal);
        Self {
            _directory: directory,
            config,
            fault,
            omitted_ranges,
            ranges,
            server,
        }
    }

    fn assert_prefix(&self, runtime: &Runtime, last: u64) {
        let mut expected = Scanner::new(self.config.trust().unwrap());
        let expected_blocks: Vec<_> = (1..=last).map(block).collect();
        for block in &expected_blocks {
            expected.apply_finalized(block).unwrap();
        }
        // Compare the complete retained history and full replay checkpoint,
        // not just the cursor. No failed block or poisoned candidate may leak.
        assert_eq!(
            runtime.scanner.checkpoint_bytes().unwrap(),
            expected.checkpoint_bytes().unwrap()
        );
        let mut persisted = Vec::new();
        runtime
            .journal
            .replay_archive(|block| {
                persisted.push(block.clone());
                Ok(())
            })
            .unwrap();
        assert_eq!(persisted, expected_blocks);
        assert_eq!(runtime.journal.archive_tail().unwrap().slot, last);
    }
}

#[tokio::test]
async fn empty_recovery_does_not_contact_rpc_or_change_retained_history() {
    let fixture = Fixture::new(64, 64).await;
    let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
    let before = runtime.scanner.checkpoint_bytes().unwrap();
    // This fixture only permits archive reads. Even a genesis request fails.
    assert_eq!(runtime.recover().await.unwrap(), 0);
    assert_eq!(runtime.recover().await.unwrap(), 0);
    assert_eq!(runtime.rpc.usage()["attempts"], json!({}));
    assert_eq!(runtime.scanner.checkpoint_bytes().unwrap(), before);
    fixture.assert_prefix(&runtime, 64);
    assert_eq!(runtime.journal.jobs().count(), 0);
}

#[tokio::test]
async fn failed_archive_persistence_stops_rpc_until_reopen_and_preserves_committed_prefix() {
    let fixture = Fixture::new(64, 4).await;
    let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
    let head = fixture.config.journal_directory.join("journal.json");
    let retained_head = fixture.config.journal_directory.join("retained-head.json");
    let original = std::fs::read(&head).unwrap();
    // Fail after the fetched chunk is published but before its head can commit.
    // Retain the original head; the failed chunk must remain an unused orphan.
    std::fs::rename(&head, &retained_head).unwrap();
    std::fs::create_dir(&head).unwrap();
    assert!(runtime.catch_up_to(72).await.is_err());
    fixture.assert_prefix(&runtime, 64);
    assert_eq!(
        runtime.rpc.usage()["attempts"],
        json!({"getBlocks":1,"getBlock_full":4})
    );
    std::fs::remove_dir(&head).unwrap();
    std::fs::rename(&retained_head, &head).unwrap();
    let attempts = runtime.rpc.usage()["attempts"].clone();
    for _ in 0..3 {
        assert!(matches!(
            runtime.catch_up_to(72).await,
            Err(Error::Conflict(
                "journal requires reopen after failed persistence"
            ))
        ));
        assert!(matches!(
            runtime.scan().await,
            Err(Error::Conflict(
                "journal requires reopen after failed persistence"
            ))
        ));
        assert_eq!(runtime.rpc.usage()["attempts"], attempts);
        assert_eq!(std::fs::read(&head).unwrap(), original);
        fixture.assert_prefix(&runtime, 64);
    }
    drop(runtime);
    let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
    fixture.assert_prefix(&runtime, 64);
    runtime.catch_up_to(72).await.unwrap();
    fixture.assert_prefix(&runtime, 72);
    assert_eq!(runtime.journal.jobs().count(), 0);
}

#[tokio::test]
async fn unavailable_archive_storage_stops_rpc_before_fetch_without_poisoning_history() {
    let fixture = Fixture::new(64, 64).await;
    let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
    let archive = fixture.config.journal_directory.join("archive-v2");
    let retained = fixture.config.journal_directory.join("retained-archive");
    let head = fixture.config.journal_directory.join("journal.json");
    let original = std::fs::read(&head).unwrap();
    std::fs::rename(&archive, &retained).unwrap();
    for _ in 0..3 {
        assert!(runtime.scan().await.is_err());
        assert!(runtime.catch_up_to(68).await.is_err());
        assert_eq!(runtime.rpc.usage()["attempts"], json!({}));
        assert_eq!(std::fs::read(&head).unwrap(), original);
    }
    std::fs::rename(&retained, &archive).unwrap();
    fixture.assert_prefix(&runtime, 64);
    // No persistence was attempted. Once storage is available, the unchanged
    // handle can resume from the same durable cursor without a reset.
    runtime.catch_up_to(68).await.unwrap();
    fixture.assert_prefix(&runtime, 68);
}

#[tokio::test]
async fn missing_finalized_tail_retries_only_suffix_at_the_original_target() {
    let fixture = Fixture::new(64, 64).await;
    *fixture.omitted_ranges.lock().unwrap() = 2;
    let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
    runtime.catch_up_to(68).await.unwrap();
    assert_eq!(
        *fixture.ranges.lock().unwrap(),
        vec![(65, 68), (68, 68), (68, 68)]
    );
    fixture.assert_prefix(&runtime, 68);
}

#[tokio::test]
async fn persistent_missing_tail_expires_and_preserves_restart_prefix() {
    let fixture = Fixture::new(64, 64).await;
    *fixture.omitted_ranges.lock().unwrap() = usize::MAX;
    let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
    let start = Instant::now();
    assert!(runtime
        .catch_up_with_tail_wait(68, Duration::from_millis(300))
        .await
        .is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
    fixture.assert_prefix(&runtime, 67);
    drop(runtime);
    *fixture.omitted_ranges.lock().unwrap() = 0;
    let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
    runtime.catch_up_to(68).await.unwrap();
    fixture.assert_prefix(&runtime, 68);
}

#[tokio::test(flavor = "current_thread")]
async fn catch_up_clones_retained_history_per_batch_not_per_block() {
    for (max_blocks, rpc_concurrency) in [(64, None), (256, Some(8)), (256, Some(16))] {
        let retained = 4096;
        let mut fixture = Fixture::new(retained, max_blocks).await;
        fixture
            .config
            .archive_batch
            .as_mut()
            .unwrap()
            .rpc_concurrency = rpc_concurrency;
        let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
        crate::scan::CLONE_COUNT.with(|count| count.set(0));
        let tip = retained + 2 * max_blocks as u64;
        runtime.catch_up_to(tip).await.unwrap();
        // One staged Scanner per RPC range, plus one installation per durable
        // batch. The previous implementation additionally copied all 4096+
        // retained digest entries for each of the 128/512 new blocks.
        assert_eq!(crate::scan::CLONE_COUNT.with(|count| count.get()), 3);
        fixture.assert_prefix(&runtime, tip);
    }
}

#[tokio::test(flavor = "current_thread")]
async fn catch_up_failure_rebuilds_exact_successful_prefix_without_poisoning_restart() {
    for fault in ["fetch", "decode", "replay"] {
        // Exercise an error before the first commit and after a full commit;
        // each leaves two successful blocks in the uncommitted suffix.
        for (offset, rpc_concurrency) in [(3, None), (67, None), (3, Some(8)), (67, Some(16))] {
            let retained = 64;
            let mut fixture = Fixture::new(retained, 64).await;
            fixture
                .config
                .archive_batch
                .as_mut()
                .unwrap()
                .rpc_concurrency = rpc_concurrency;
            let failed_slot = retained + offset;
            *fixture.fault.lock().unwrap() = Some((failed_slot, fault));
            let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
            let tip = retained + 130;
            assert!(runtime.catch_up_to(tip).await.is_err());
            fixture.assert_prefix(&runtime, failed_slot - 1);
            drop(runtime);
            let mut runtime = Runtime::open(fixture.config.clone(), false).unwrap();
            fixture.assert_prefix(&runtime, failed_slot - 1);
            // Fail again with an empty suffix, then retry the SAME Runtime.
            // A semantic replay error must not leave its Scanner latched.
            assert!(runtime.catch_up_to(tip).await.is_err());
            fixture.assert_prefix(&runtime, failed_slot - 1);
            *fixture.fault.lock().unwrap() = None;
            runtime.catch_up_to(tip).await.unwrap();
            fixture.assert_prefix(&runtime, tip);
        }
    }
}
